import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { AppConfig } from '../config/schema.js';
import { channelMatches, topicForThreadKey } from '../pipeline/types.js';
import { getThread, upsertThread } from '../pipeline/thread-store.js';
import { ensureOutboundAppSession } from './outbound.js';
import { sessionCanResume } from './resume.js';

export interface AppEvent { seq: number; event: 'message' | 'session'; data: Record<string, unknown> }

/**
 * SQL condition (transcripts aliased `t`): not a bus-originated system-only
 * turn (E65 critical advisory turns, E66 journal instructions). Those rows
 * stay in the DB, flagged `metadata.system_only`, for debugging, but are
 * never shown to people.
 */
export const VISIBLE_TRANSCRIPT = `COALESCE(json_extract(t.metadata, '$.system_only'), 0) = 0`;

export function routedAgent(config: AppConfig, contactId: string): string | null {
  for (const rule of config.pipeline.routes) {
    if (rule.match.sender && rule.match.sender !== `contact:${contactId}`) continue;
    if (rule.match.channel && !channelMatches(rule.match.channel, 'app')) continue;
    if (rule.match.topic && rule.match.topic !== 'general') continue;
    return rule.target.recipientId;
  }
  return null;
}

interface SessionRow {
  id: string; conversation_id: string; channel: string; contact_id: string;
  started_at: string; last_activity: string; ended_at: string | null;
  message_count: number; agent_id: string | null; topic: string;
}

export function visibleSession(db: Database.Database, contactId: string, agentId: string, id: string): SessionRow | null {
  const row = db.prepare(`SELECT s.*, cr.topic FROM sessions s
    JOIN conversation_registry cr ON cr.id = s.conversation_id
    WHERE s.id = ? AND s.contact_id = ? AND s.agent_id = ?
      AND cr.topic NOT LIKE 'sched:%' AND (
        s.channel = 'app' OR EXISTS (SELECT 1 FROM transcripts t
          WHERE t.session_id = s.id AND t.direction = 'inbound'
            AND t.contact_id = ?
            AND COALESCE(json_extract(t.metadata, '$.scheduled'), 0) = 0
            AND ${VISIBLE_TRANSCRIPT})
      )`).get(id, contactId, agentId, contactId) as SessionRow | undefined;
  return row ?? null;
}

export function eventBounds(db: Database.Database, contactId: string): { first: number; latest: number } {
  const latest = (db.prepare('SELECT seq FROM app_event_counters WHERE contact_id = ?').get(contactId) as { seq: number } | undefined)?.seq ?? 0;
  const first = (db.prepare('SELECT MIN(seq) AS seq FROM app_events WHERE contact_id = ?').get(contactId) as { seq: number | null }).seq ?? latest + 1;
  return { first, latest };
}

export function sessionInfo(db: Database.Database, row: SessionRow, contactId: string, config?: AppConfig): Record<string, unknown> {
  const title = row.channel === 'app' && row.topic === 'general' ? 'Main'
    : getThread<{ title?: string; name?: string }>(db, row.channel, row.topic)?.metadata.title
      ?? getThread<{ title?: string; name?: string }>(db, row.channel, row.topic)?.metadata.name
      ?? (db.prepare(`SELECT substr(t.body,1,60) AS body FROM transcripts t WHERE t.session_id = ? AND t.direction = 'inbound'
        AND ${VISIBLE_TRANSCRIPT} ORDER BY t.created_at LIMIT 1`).get(row.id) as {body:string}|undefined)?.body
      ?? (row.channel === 'app' ? 'New Conversation' : row.channel);
  const marker = (db.prepare('SELECT seq FROM app_read_markers WHERE contact_id = ? AND session_id = ?').get(contactId, row.id) as {seq:number}|undefined)?.seq ?? 0;
  const unread = (db.prepare(`SELECT COUNT(*) AS n FROM app_events e JOIN transcripts t ON t.id = e.transcript_id
    WHERE e.contact_id = ? AND e.session_id = ? AND e.kind = 'message' AND t.direction = 'outbound' AND e.seq > ?`).get(contactId, row.id, marker) as {n:number}).n;
  return { session_id: row.id, channel: row.channel, topic: row.topic, title, started_at: row.started_at,
    last_activity: row.last_activity, ended_at: row.ended_at, message_count: row.message_count,
    unread_count: unread, resumable: row.ended_at === null || (!!config && sessionCanResume(db, config, row.id)),
    is_main: row.channel === 'app' && row.topic === 'general', activity: 'idle' };
}

export function listSessions(db: Database.Database, contactId: string, agentId: string, state: string, limit: number, before?: string, config?: AppConfig): Record<string, unknown>[] {
  const cursor = before ? db.prepare(`SELECT last_activity, id FROM sessions WHERE id = ? AND contact_id = ? AND agent_id = ?`)
    .get(before, contactId, agentId) as {last_activity:string;id:string}|undefined : undefined;
  const rows = db.prepare(`SELECT s.id FROM sessions s WHERE s.contact_id = ? AND s.agent_id = ?
    AND (? = 'all' OR (? = 'active' AND s.ended_at IS NULL) OR (? = 'earlier' AND s.ended_at IS NOT NULL))
    AND (? IS NULL OR s.last_activity < ? OR (s.last_activity = ? AND s.id < ?))
    ORDER BY s.last_activity DESC, s.id DESC`)
    .all(contactId, agentId, state, state, state, before ?? null,
      cursor?.last_activity ?? before ?? null, cursor?.last_activity ?? before ?? null, cursor?.id ?? '' ) as {id:string}[];
  return rows.map(({id}) => visibleSession(db, contactId, agentId, id)).filter((r): r is SessionRow => !!r)
    .slice(0, limit).map(r => sessionInfo(db, r, contactId, config));
}

export function readEvents(db: Database.Database, contactId: string, agentId: string, after: number, through: number, config?: AppConfig): AppEvent[] {
  const rows = db.prepare(`SELECT seq, kind, session_id, transcript_id FROM app_events
    WHERE contact_id = ? AND seq > ? AND seq <= ? ORDER BY seq`).all(contactId, after, through) as
    {seq:number;kind:'message'|'session';session_id:string;transcript_id:string|null}[];
  const events: AppEvent[] = [];
  for (const row of rows) {
    const session = visibleSession(db, contactId, agentId, row.session_id);
    if (!session) continue;
    if (row.kind === 'session') {
      events.push({ seq: row.seq, event: 'session', data: sessionInfo(db, session, contactId, config) });
    } else {
      const message = db.prepare(`SELECT * FROM transcripts t WHERE t.id = ? AND t.session_id = ? AND ${VISIBLE_TRANSCRIPT}`)
        .get(row.transcript_id, row.session_id) as Record<string, unknown> | undefined;
      if (message) events.push({ seq: row.seq, event: 'message', data: messageInfo(db, message, row.seq) });
    }
  }
  return events;
}

export function messageInfo(db: Database.Database, row: Record<string, unknown>, seq: number): Record<string, unknown> {
  const meta = JSON.parse(String(row['metadata'] ?? '{}')) as Record<string, unknown>;
  const attachments = Array.isArray(meta['attachments']) ? meta['attachments'] as Record<string, unknown>[] : [];
  return { message_id: row['message_id'], session_id: row['session_id'], seq, direction: row['direction'],
    cursor: row['id'],
    arrival_channel: row['channel'], body: row['body'], created_at: row['created_at'],
    scheduled: meta['scheduled'] === true,
    attachments: attachments.map(a => ({ id: a['id'] ?? null, type: a['type'],
      original_filename: a['original_filename'], mime_type: a['mime_type'],
      expired: a['id'] ? !(db.prepare('SELECT 1 FROM attachments WHERE id = ?').get(a['id'])) : false })) };
}

export function history(db: Database.Database, contactId: string, agentId: string, sessionId: string, limit: number, before?: string): Record<string, unknown>[] | null {
  if (!visibleSession(db, contactId, agentId, sessionId)) return null;
  const cursor = before ? db.prepare(`SELECT created_at, id FROM transcripts WHERE id = ? AND session_id = ?`)
    .get(before, sessionId) as {created_at:string;id:string}|undefined : undefined;
  const rows = db.prepare(`SELECT t.*, e.seq FROM transcripts t LEFT JOIN app_events e
    ON e.contact_id = ? AND e.kind = 'message' AND e.transcript_id = t.id
    WHERE t.session_id = ? AND ${VISIBLE_TRANSCRIPT} AND (? IS NULL OR t.created_at < ? OR (t.created_at = ? AND t.id < ?))
    ORDER BY t.created_at DESC, t.id DESC LIMIT ?`)
    .all(contactId, sessionId, before ?? null,
      cursor?.created_at ?? before ?? null, cursor?.created_at ?? before ?? null, cursor?.id ?? '', limit) as Record<string, unknown>[];
  return rows.reverse().map(r => messageInfo(db, r, Number(r['seq'] ?? 0)));
}

export function createAppSession(db: Database.Database, contactId: string, agentId: string, title?: string): { sessionId: string; topic: string } {
  return db.transaction(() => {
    const key = randomUUID();
    const topic = topicForThreadKey(key);
    // Untitled topics take their title from the first message (see sessionInfo).
    const named = title?.trim();
    upsertThread(db, { channel: 'app', topic, threadKey: key, metadata: named ? { title: named } : {} });
    const session = ensureOutboundAppSession(db, contactId, agentId, topic);
    return { sessionId: session.sessionId, topic };
  })();
}

export function recordSessionEvent(db: Database.Database, contactId: string, sessionId: string): void {
  db.transaction(() => {
    db.prepare(`INSERT INTO app_event_counters(contact_id,seq) VALUES (?,1)
      ON CONFLICT(contact_id) DO UPDATE SET seq = seq + 1`).run(contactId);
    db.prepare(`INSERT INTO app_events(contact_id,seq,kind,session_id,created_at)
      VALUES (?,(SELECT seq FROM app_event_counters WHERE contact_id = ?),'session',?,?)`)
      .run(contactId, contactId, sessionId, new Date().toISOString());
  })();
}

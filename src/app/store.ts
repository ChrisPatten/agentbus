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
 * never shown to people. Also the condition the pending-context query uses
 * for outbound rows (E79), which must still see context-only ones.
 */
export const NOT_SYSTEM_ONLY = `COALESCE(json_extract(t.metadata, '$.system_only'), 0) = 0`;

/**
 * SQL condition (transcripts aliased `t`): not a context-only handoff (E79).
 * `share_context` writes outbound rows flagged `metadata.context_only` that
 * Main reads as context but the app never shows.
 */
export const NOT_CONTEXT_ONLY = `COALESCE(json_extract(t.metadata, '$.context_only'), 0) = 0`;

/**
 * SQL condition (transcripts aliased `t`) for every app-facing read: history,
 * replay events, session list previews, unread counts, the transcript API,
 * transcript search and quote resolution. Hides both bus-internal
 * `system_only` turns and E79 `context_only` handoffs. Pending context and
 * journaling windows read around it on purpose (`NOT_SYSTEM_ONLY`).
 */
export const VISIBLE_TRANSCRIPT = `(${NOT_SYSTEM_ONLY} AND ${NOT_CONTEXT_ONLY})`;

/**
 * The route target that serves a contact's `general` conversation on `channel`
 * (the first matching `pipeline.routes` rule, as stage 70 matches), or null.
 * E80: any channel, not just the app.
 */
export function routedTarget(config: AppConfig, contactId: string, channel: string): { adapterId: string; recipientId: string } | null {
  for (const rule of config.pipeline.routes) {
    if (rule.match.sender && rule.match.sender !== `contact:${contactId}`) continue;
    if (rule.match.channel && !channelMatches(rule.match.channel, channel)) continue;
    if (rule.match.topic && rule.match.topic !== 'general') continue;
    return { adapterId: rule.target.adapterId, recipientId: rule.target.recipientId };
  }
  return null;
}

/** The route target that serves a contact's app conversations, or null. */
export function routedAppTarget(config: AppConfig, contactId: string): { adapterId: string; recipientId: string } | null {
  return routedTarget(config, contactId, 'app');
}

export function routedAgent(config: AppConfig, contactId: string): string | null {
  return routedAppTarget(config, contactId)?.recipientId ?? null;
}

interface SessionRow {
  id: string; conversation_id: string; channel: string; contact_id: string;
  started_at: string; last_activity: string; ended_at: string | null;
  message_count: number; agent_id: string | null; topic: string;
  end_reason?: string | null;
}

/** E69: Main is the `app` + `general` conversation; its rows rotate underneath one Main item. */
export const isMainRow = (row: Pick<SessionRow, 'channel' | 'topic'>): boolean => row.channel === 'app' && row.topic === 'general';

/** E69: Main's rows for this contact and agent, current first (the active row, else the newest). */
function mainRows(db: Database.Database, row: SessionRow): SessionRow[] {
  return db.prepare(`SELECT s.*, cr.topic FROM sessions s JOIN conversation_registry cr ON cr.id = s.conversation_id
    WHERE s.conversation_id = ? AND s.contact_id = ? AND s.agent_id IS ?
    ORDER BY (s.ended_at IS NULL) DESC, s.started_at DESC, s.rowid DESC`)
    .all(row.conversation_id, row.contact_id, row.agent_id) as SessionRow[];
}

/** Session ids a row stands for in the app: every Main row of its conversation (E69), else just itself. */
export function sessionScope(db: Database.Database, row: SessionRow): string[] {
  return isMainRow(row) ? mainRows(db, row).map(r => r.id) : [row.id];
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

export interface QuotedMessage {
  message_id: string; sender_name: 'you' | 'agent'; text: string;
  /** E69: the target's transcript time and source (its `origin.label`, else "you" / "agent"). */
  created_at?: string; source?: string;
}

/**
 * Resolve a whole-message reply reference (E72) from a client-supplied
 * message id. The message must be a visible transcript row in a session this
 * contact can see for this agent; the client never supplies quote text.
 * `message_id` is not unique in transcripts, so the newest match wins.
 */
export function quotableMessage(db: Database.Database, contactId: string, agentId: string, messageId: string,
  conversationId?: string): QuotedMessage | null {
  // E69: `conversationId` (agent outbound quotes only) limits the target to one conversation, any of its rows.
  const row = db.prepare(`SELECT t.session_id, t.direction, t.body, t.created_at,
      json_extract(t.metadata, '$.origin.label') AS label FROM transcripts t
    JOIN sessions s ON s.id = t.session_id
    WHERE t.message_id = ? AND s.contact_id = ? AND s.agent_id = ? AND (? IS NULL OR s.conversation_id = ?)
      AND ${VISIBLE_TRANSCRIPT}
    ORDER BY t.rowid DESC LIMIT 1`).get(messageId, contactId, agentId, conversationId ?? null, conversationId ?? null) as
    { session_id: string; direction: string; body: string | null; created_at: string; label: unknown } | undefined;
  if (!row || !visibleSession(db, contactId, agentId, row.session_id)) return null;
  const sender = row.direction === 'inbound' ? 'you' : 'agent';
  return { message_id: messageId, sender_name: sender, text: (row.body ?? '').slice(0, 200),
    created_at: row.created_at, source: typeof row.label === 'string' && row.label ? row.label : sender };
}

export function eventBounds(db: Database.Database, contactId: string): { first: number; latest: number } {
  const latest = (db.prepare('SELECT seq FROM app_event_counters WHERE contact_id = ?').get(contactId) as { seq: number } | undefined)?.seq ?? 0;
  const first = (db.prepare('SELECT MIN(seq) AS seq FROM app_events WHERE contact_id = ?').get(contactId) as { seq: number | null }).seq ?? latest + 1;
  return { first, latest };
}

export function sessionInfo(db: Database.Database, row: SessionRow, contactId: string, config?: AppConfig): Record<string, unknown> {
  if (isMainRow(row)) return mainInfo(db, row, contactId);
  const title = getThread<{ title?: string; name?: string }>(db, row.channel, row.topic)?.metadata.title
      ?? getThread<{ title?: string; name?: string }>(db, row.channel, row.topic)?.metadata.name
      ?? (db.prepare(`SELECT substr(t.body,1,60) AS body FROM transcripts t WHERE t.session_id = ? AND t.direction = 'inbound'
        AND ${VISIBLE_TRANSCRIPT} ORDER BY t.created_at LIMIT 1`).get(row.id) as {body:string}|undefined)?.body
      ?? (row.channel === 'app' ? 'New Conversation' : row.channel);
  const marker = (db.prepare('SELECT seq FROM app_read_markers WHERE contact_id = ? AND session_id = ?').get(contactId, row.id) as {seq:number}|undefined)?.seq ?? 0;
  const unread = (db.prepare(`SELECT COUNT(*) AS n FROM app_events e JOIN transcripts t ON t.id = e.transcript_id
    WHERE e.contact_id = ? AND e.session_id = ? AND e.kind = 'message' AND t.direction = 'outbound' AND e.seq > ?
      AND ${VISIBLE_TRANSCRIPT}`).get(contactId, row.id, marker) as {n:number}).n;
  return { session_id: row.id, conversation_id: row.conversation_id, channel: row.channel, topic: row.topic, title, started_at: row.started_at,
    last_activity: row.last_activity, ended_at: row.ended_at, message_count: row.message_count,
    unread_count: unread, resumable: row.ended_at === null || (!!config && sessionCanResume(db, config, row.id)),
    is_main: false, activity: 'idle' };
}

/**
 * E69: the one Main item, aggregated over every Main row of the conversation.
 * `session_id` is the active row, else the newest; counts and the read
 * marker span all rows, so rotation never resets them.
 */
function mainInfo(db: Database.Database, row: SessionRow, contactId: string): Record<string, unknown> {
  const rows = mainRows(db, row);
  const current = rows[0] ?? row;
  const scope = JSON.stringify(rows.map(r => r.id));
  const marker = (db.prepare(`SELECT MAX(seq) AS seq FROM app_read_markers WHERE contact_id = ?
    AND session_id IN (SELECT value FROM json_each(?))`).get(contactId, scope) as {seq:number|null}).seq ?? 0;
  const unread = (db.prepare(`SELECT COUNT(*) AS n FROM app_events e JOIN transcripts t ON t.id = e.transcript_id
    WHERE e.contact_id = ? AND e.session_id IN (SELECT value FROM json_each(?)) AND e.kind = 'message'
      AND t.direction = 'outbound' AND e.seq > ? AND ${VISIBLE_TRANSCRIPT}`).get(contactId, scope, marker) as {n:number}).n;
  return { session_id: current.id, conversation_id: current.conversation_id, channel: 'app', topic: 'general', title: 'Main',
    started_at: rows.reduce((min, r) => r.started_at < min ? r.started_at : min, current.started_at),
    last_activity: current.last_activity, ended_at: null,
    message_count: rows.reduce((n, r) => n + r.message_count, 0),
    unread_count: unread, resumable: true, is_main: true, activity: 'idle' };
}

/** SQL condition (sessions aliased `s`): a Main row. */
const MAIN_SQL = `(s.channel = 'app' AND EXISTS (SELECT 1 FROM conversation_registry mcr
  WHERE mcr.id = s.conversation_id AND mcr.channel = 'app' AND mcr.topic = 'general'))`;

export function listSessions(db: Database.Database, contactId: string, agentId: string, state: string, limit: number, before?: string, config?: AppConfig): Record<string, unknown>[] {
  const cursor = before ? db.prepare(`SELECT last_activity, id FROM sessions WHERE id = ? AND contact_id = ? AND agent_id = ?`)
    .get(before, contactId, agentId) as {last_activity:string;id:string}|undefined : undefined;
  // E69: Main is listed once (at its current row) under active/all, never under earlier.
  const rows = db.prepare(`SELECT s.id FROM sessions s WHERE s.contact_id = ? AND s.agent_id = ?
    AND (? = 'all' OR (? = 'active' AND (s.ended_at IS NULL OR ${MAIN_SQL}))
      OR (? = 'earlier' AND s.ended_at IS NOT NULL AND NOT ${MAIN_SQL}))
    AND (? IS NULL OR s.last_activity < ? OR (s.last_activity = ? AND s.id < ?))
    ORDER BY s.last_activity DESC, s.id DESC`)
    .all(contactId, agentId, state, state, state, before ?? null,
      cursor?.last_activity ?? before ?? null, cursor?.last_activity ?? before ?? null, cursor?.id ?? '' ) as {id:string}[];
  return rows.map(({id}) => visibleSession(db, contactId, agentId, id)).filter((r): r is SessionRow => !!r)
    .filter(r => !isMainRow(r) || mainRows(db, r)[0]?.id === r.id)
    .slice(0, limit).map(r => sessionInfo(db, r, contactId, config));
}

export function readEvents(db: Database.Database, contactId: string, agentId: string, after: number, through: number, config?: AppConfig): AppEvent[] {
  const rows = db.prepare(`SELECT seq, kind, session_id, transcript_id, rotation FROM app_events
    WHERE contact_id = ? AND seq > ? AND seq <= ? ORDER BY seq`).all(contactId, after, through) as
    {seq:number;kind:'message'|'session';session_id:string;transcript_id:string|null;rotation:number}[];
  const events: AppEvent[] = [];
  for (const row of rows) {
    const session = visibleSession(db, contactId, agentId, row.session_id);
    if (!session) continue;
    if (row.kind === 'session') {
      const data = sessionInfo(db, session, contactId, config);
      // E69: `app_events.rotation` marks the event recorded when rotateMainSession ended this row.
      if (row.rotation === 1 && isMainRow(session) && session.ended_at)
        data['rotated'] = { previous_session_id: session.id, ended_at: session.ended_at, reason: endReason(session.end_reason) };
      events.push({ seq: row.seq, event: 'session', data });
    } else {
      const message = db.prepare(`SELECT * FROM transcripts t WHERE t.id = ? AND t.session_id = ? AND ${VISIBLE_TRANSCRIPT}`)
        .get(row.transcript_id, row.session_id) as Record<string, unknown> | undefined;
      if (message) events.push({ seq: row.seq, event: 'message', data: messageInfo(db, message, row.seq) });
    }
  }
  return events;
}

const endReason = (reason: string | null | undefined): 'idle' | 'clear' | null =>
  reason === 'idle' || reason === 'clear' ? reason : null;

export function messageInfo(db: Database.Database, row: Record<string, unknown>, seq: number): Record<string, unknown> {
  const meta = JSON.parse(String(row['metadata'] ?? '{}')) as Record<string, unknown>;
  const attachments = Array.isArray(meta['attachments']) ? meta['attachments'] as Record<string, unknown>[] : [];
  // Only app whole-message references (E72) carry a string message_id;
  // Telegram quotes use platform_message_id and must not produce reply_to.
  const quoted = meta['quoted_message'] as Record<string, unknown> | undefined;
  const replyTo = quoted && typeof quoted['message_id'] === 'string'
    ? { message_id: quoted['message_id'], sender_name: quoted['sender_name'], text: quoted['text'],
        ...(typeof quoted['created_at'] === 'string' ? { created_at: quoted['created_at'] } : {}),
        ...(typeof quoted['source'] === 'string' ? { source: quoted['source'] } : {}) } : undefined;
  return { message_id: row['message_id'], session_id: row['session_id'], conversation_id: row['conversation_id'],
    seq, direction: row['direction'],
    cursor: row['id'],
    ...(replyTo ? { reply_to: replyTo } : {}),
    arrival_channel: row['channel'], body: row['body'], created_at: row['created_at'],
    scheduled: meta['scheduled'] === true,
    attachments: attachments.map(a => ({ id: a['id'] ?? null, type: a['type'],
      original_filename: a['original_filename'], mime_type: a['mime_type'],
      expired: a['id'] ? !(db.prepare('SELECT 1 FROM attachments WHERE id = ?').get(a['id'])) : false })) };
}

export interface HistoryBoundary { session_id: string; ended_at: string; reason: 'idle' | 'clear' | null }
export interface HistoryPage { messages: Record<string, unknown>[]; boundaries?: HistoryBoundary[] }

/**
 * One page of a session's messages, oldest first. E69: for any Main row id
 * the page spans every Main row of the conversation and carries the
 * `boundaries` (ended Main rows) inside the page's time range. The range
 * runs from the page's oldest message (open-ended on a short, final page) up
 * to the `before` cursor (open-ended on the newest page), so pages tile.
 */
export function history(db: Database.Database, contactId: string, agentId: string, sessionId: string, limit: number, before?: string): HistoryPage | null {
  const session = visibleSession(db, contactId, agentId, sessionId);
  if (!session) return null;
  const main = isMainRow(session);
  const scope = JSON.stringify(sessionScope(db, session));
  const cursor = before ? db.prepare(`SELECT created_at, id FROM transcripts WHERE id = ? AND session_id IN (SELECT value FROM json_each(?))`)
    .get(before, scope) as {created_at:string;id:string}|undefined : undefined;
  const rows = db.prepare(`SELECT t.*, e.seq FROM transcripts t LEFT JOIN app_events e
    ON e.contact_id = ? AND e.kind = 'message' AND e.transcript_id = t.id
    WHERE t.session_id IN (SELECT value FROM json_each(?)) AND ${VISIBLE_TRANSCRIPT} AND (? IS NULL OR t.created_at < ? OR (t.created_at = ? AND t.id < ?))
    ORDER BY t.created_at DESC, t.id DESC LIMIT ?`)
    .all(contactId, scope, before ?? null,
      cursor?.created_at ?? before ?? null, cursor?.created_at ?? before ?? null, cursor?.id ?? '', limit) as Record<string, unknown>[];
  const messages = rows.reverse().map(r => messageInfo(db, r, Number(r['seq'] ?? 0)));
  if (!main) return { messages };
  const from = messages.length === limit ? String(messages[0]!['created_at']) : null;
  const to = before ? cursor?.created_at ?? before : null;
  const ended = db.prepare(`SELECT id, ended_at, end_reason FROM sessions WHERE id IN (SELECT value FROM json_each(?))
    AND ended_at IS NOT NULL AND (? IS NULL OR julianday(ended_at) >= julianday(?)) AND (? IS NULL OR julianday(ended_at) < julianday(?))
    ORDER BY julianday(ended_at), id`).all(scope, from, from, to, to) as {id:string;ended_at:string;end_reason:string|null}[];
  return { messages, boundaries: ended.map(r => ({ session_id: r.id, ended_at: r.ended_at, reason: endReason(r.end_reason) })) };
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

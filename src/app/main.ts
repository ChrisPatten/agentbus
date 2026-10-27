import type Database from 'better-sqlite3';
import { AppAdapterSchema, type AppConfig } from '../config/schema.js';
import type { JournalEngine, TriggerHandle } from '../journaling/engine.js';
import { appConversationId } from './outbound.js';
import { VISIBLE_TRANSCRIPT } from './store.js';

/**
 * E69 — Main is the `app` + `general` conversation for a contact. It is one
 * continuous conversation in the app; its session rows (one per Claude
 * session) rotate underneath it.
 */
export const MAIN_TOPIC = 'general';

export function mainConversationId(contactId: string): string {
  return appConversationId(contactId, MAIN_TOPIC);
}

/** Whether a conversation is some contact's Main. */
export function isMainConversation(db: Database.Database, conversationId: string): boolean {
  return !!db.prepare(`SELECT 1 FROM conversation_registry WHERE id = ? AND channel = 'app' AND topic = ?`)
    .get(conversationId, MAIN_TOPIC);
}

/** Whether a session row belongs to some contact's Main. */
export function isMainSession(db: Database.Database, sessionId: string): boolean {
  return !!db.prepare(`SELECT 1 FROM sessions s JOIN conversation_registry cr ON cr.id = s.conversation_id
    WHERE s.id = ? AND cr.channel = 'app' AND cr.topic = ?`).get(sessionId, MAIN_TOPIC);
}

/** E69: why a Main row ended (`sessions.end_reason`). */
export type MainEndReason = 'idle' | 'clear';

/**
 * E69: end a Main row so the next turn starts a new row and a new Claude
 * session. Scrollback is unchanged: Main's history spans every row. The
 * `app_session_changed` trigger records the Main `session` event, tagged
 * here so replay adds `rotated`. With a journal engine, fires `clear` for
 * /clear and `close` for idle rotation; without one, SessionTracker's
 * mid-flight pass reports the close on its next tick, as for any session
 * ended outside it. Returns null when the row is not an active Main row.
 */
export function rotateMainSession(db: Database.Database, sessionId: string, reason: MainEndReason,
  journal?: Pick<JournalEngine, 'trigger'>): { journal?: TriggerHandle } | null {
  if (!isMainSession(db, sessionId)) return null;
  const ended = db.transaction(() => {
    const changed = db.prepare(`UPDATE sessions SET ended_at = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL`)
      .run(new Date().toISOString(), reason, sessionId).changes > 0;
    // Tag the session event the trigger just wrote, so replay adds `rotated` to it.
    if (changed) db.prepare(`UPDATE app_events SET rotation = 1 WHERE kind = 'session' AND session_id = ?
      AND (contact_id, seq) IN (SELECT c.contact_id, c.seq FROM app_event_counters c JOIN sessions s ON s.contact_id = c.contact_id WHERE s.id = ?)`)
      .run(sessionId, sessionId);
    return changed;
  })();
  if (!ended) return null;
  const handle = journal?.trigger({ reason: reason === 'clear' ? 'clear' : 'close', sessionId });
  return handle ? { journal: handle } : {};
}

/**
 * E69: Main's activity clock, derived from transcripts: the later of the
 * newest visible inbound and the newest outbound sent from a turn in this
 * conversation (`origin.kind = 'turn'`). Proactive sends from elsewhere
 * never advance it. Null when the conversation has neither.
 */
export function mainActivityClock(db: Database.Database, conversationId: string): string | null {
  const row = db.prepare(`SELECT MAX(at) AS at FROM (
      SELECT MAX(t.created_at) AS at FROM transcripts t
        WHERE t.conversation_id = ? AND t.direction = 'inbound' AND ${VISIBLE_TRANSCRIPT}
      UNION ALL
      SELECT MAX(t.created_at) FROM transcripts t
        WHERE t.conversation_id = ? AND t.direction = 'outbound'
          AND json_extract(t.metadata, '$.origin.kind') = 'turn'
          AND json_extract(t.metadata, '$.origin.conversation_id') = ?)`)
    .get(conversationId, conversationId, conversationId) as {at:string|null};
  return row.at;
}

/**
 * E69: idle rotation sweep. Ends every active Main row that has a
 * `claude_session_id` and whose activity clock (else its start) is older
 * than `adapters.app.main_idle_rotation_ms` (0 disables). Rows with no Claude
 * session have nothing to journal and never rotate. Returns the rotated ids.
 */
export function rotateIdleMainSessions(db: Database.Database, config: AppConfig,
  journal?: Pick<JournalEngine, 'trigger'>, now = Date.now()): string[] {
  const periodMs = config.adapters?.app?.main_idle_rotation_ms ?? AppAdapterSchema.parse({}).main_idle_rotation_ms;
  if (periodMs <= 0) return [];
  const rows = db.prepare(`SELECT s.id, s.conversation_id, s.started_at FROM sessions s
    JOIN conversation_registry cr ON cr.id = s.conversation_id
    WHERE s.ended_at IS NULL AND s.claude_session_id IS NOT NULL AND s.channel = 'app'
      AND cr.channel = 'app' AND cr.topic = ?`).all(MAIN_TOPIC) as {id:string;conversation_id:string;started_at:string}[];
  const rotated: string[] = [];
  for (const row of rows) {
    const clock = mainActivityClock(db, row.conversation_id) ?? row.started_at;
    if (now - new Date(clock).getTime() < periodMs) continue;
    if (rotateMainSession(db, row.id, 'idle', journal)) rotated.push(row.id);
  }
  return rotated;
}

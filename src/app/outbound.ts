import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { computeConversationId } from '../pipeline/conversation-id.js';

export function appConversationId(contactId: string, topic: string): string {
  // Mirrors Stage 70's sorted participant/channel/topic hash.
  return computeConversationId(contactId, 'app', topic);
}

export type AppDestinationValidation = { ok: true } | { ok: false; error: string };

/** Validate an agent-initiated app target before delivery can create a session. */
export function validateAppDestination(
  db: Database.Database, contactId: string, agentId: string, topic: string,
): AppDestinationValidation {
  if (topic === 'general') return { ok: true };
  if (!/^thread:[0-9a-f]{16}$/.test(topic)) {
    return { ok: false, error: `Unknown app topic "${topic}". Use general for Main or list_sessions to find an app topic.` };
  }
  const row = db.prepare(`SELECT 1 FROM sessions s
    JOIN conversation_registry cr ON cr.id = s.conversation_id
    JOIN threads t ON t.channel = 'app' AND t.topic = cr.topic
    WHERE s.channel = 'app' AND s.contact_id = ? AND s.agent_id = ?
      AND s.ended_at IS NULL AND cr.channel = 'app' AND cr.topic = ?
    LIMIT 1`).get(contactId, agentId, topic);
  return row
    ? { ok: true }
    : { ok: false, error: `Unknown or inactive app topic "${topic}" for this contact and agent. Use list_sessions to find an active app topic.` };
}

/** Ensure proactive sends have a real session before DeliveryWorker logs them. */
export function ensureOutboundAppSession(db: Database.Database, contactId: string, agentId: string, topic: string): { conversationId: string; sessionId: string } {
  const conversationId = appConversationId(contactId, topic);
  const now = new Date().toISOString();
  return db.transaction(() => {
    db.prepare(`INSERT INTO conversation_registry(id,contact_id,channel,topic,first_seen,last_seen)
      VALUES (?,?,'app',?,?,?) ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen`)
      .run(conversationId, contactId, topic, now, now);
    let row = db.prepare(`SELECT id FROM sessions WHERE conversation_id = ? AND ended_at IS NULL
      ORDER BY started_at DESC LIMIT 1`).get(conversationId) as {id:string}|undefined;
    if (!row) {
      row = { id: randomUUID() };
      db.prepare(`INSERT INTO sessions(id,conversation_id,channel,contact_id,started_at,last_activity,message_count,agent_id)
        VALUES (?,?,'app',?,?,?,0,?)`).run(row.id, conversationId, contactId, now, now, agentId);
    }
    return { conversationId, sessionId: row.id };
  })();
}

/**
 * E83 — the session row a hidden `share_context` note for a non-app primary
 * conversation (a Telegram DM) attaches to when the conversation has none: the
 * conversation registry row and an open placeholder session with no
 * `claude_session_id`, no messages and the owning agent's logical id.
 *
 * The placeholder keeps the note's foreign key valid and leaves the DM exactly
 * as a quiet conversation: the first real message finds it as the active row,
 * and `PoolManager` sees no `claude_session_id` there, so it launches a fresh
 * `--session-id` pane session (and stores that id on this row). It would
 * otherwise be closed as an idle legacy session, so `SessionTracker` exempts a
 * message-less row in a primary channel.
 */
export function ensurePrimarySession(
  db: Database.Database, contactId: string, channel: string, topic: string, agentId: string,
): { conversationId: string; sessionId: string } {
  const conversationId = computeConversationId(contactId, channel, topic);
  const now = new Date().toISOString();
  return db.transaction(() => {
    db.prepare(`INSERT INTO conversation_registry(id,contact_id,channel,topic,first_seen,last_seen)
      VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen`)
      .run(conversationId, contactId, channel, topic, now, now);
    const sessionId = randomUUID();
    db.prepare(`INSERT INTO sessions(id,conversation_id,channel,contact_id,started_at,last_activity,message_count,agent_id)
      VALUES (?,?,?,?,?,?,0,?)`).run(sessionId, conversationId, channel, contactId, now, now, agentId);
    return { conversationId, sessionId };
  })();
}

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { computeConversationId } from '../pipeline/conversation-id.js';

export function appConversationId(contactId: string, topic: string): string {
  // Mirrors Stage 70's sorted participant/channel/topic hash.
  return computeConversationId(contactId, 'app', topic);
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

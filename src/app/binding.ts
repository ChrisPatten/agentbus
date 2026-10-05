import type Database from 'better-sqlite3';

export interface BoundAppReply {
  sessionId: string;
  conversationId: string;
  agentId: string;
}

/** Only an actual app-origin inbound transcript can direct a reply to a foreign session. */
export function boundAppReply(db: Database.Database, replyTo: string | null, contactId: string, agentId?: string,
  allowClosed = false): BoundAppReply | null {
  if (!replyTo) return null;
  const row = db.prepare(`SELECT s.id AS sessionId, s.conversation_id AS conversationId, s.agent_id AS agentId
    FROM transcripts t JOIN sessions s ON s.id = t.session_id
    WHERE t.message_id = ? AND t.direction = 'inbound' AND t.channel = 'app'
      AND t.contact_id = ? AND s.contact_id = ? AND (? = 1 OR s.ended_at IS NULL)
      AND (? IS NULL OR s.agent_id = ?)
    ORDER BY t.rowid DESC LIMIT 1`)
    .get(replyTo, contactId, contactId, allowClosed ? 1 : 0, agentId ?? null, agentId ?? null) as BoundAppReply | undefined;
  return row ?? null;
}

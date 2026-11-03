/**
 * E96 S96.6 — per-conversation flags for the sessions resource: `answer_needed`
 * (set by reply/send_message, cleared by a tap, a reply from the contact or the
 * explicit clear tool) and the `status(subject)` line.
 */
import type Database from 'better-sqlite3';

export interface AnswerNeeded { conversation_id: string; message_id: string; agent_id: string | null; set_at: string }

export function setAnswerNeeded(db: Database.Database, input: { conversationId: string; messageId: string; agentId?: string | null }, now = Date.now()): void {
  db.prepare(`INSERT OR REPLACE INTO surface_answer_needed(conversation_id, message_id, agent_id, set_at) VALUES (?,?,?,?)`)
    .run(input.conversationId, input.messageId, input.agentId ?? null, new Date(now).toISOString());
}

/** Returns true when a flag was cleared. */
export function clearAnswerNeeded(db: Database.Database, conversationId: string): boolean {
  return db.prepare(`DELETE FROM surface_answer_needed WHERE conversation_id = ?`).run(conversationId).changes > 0;
}

export function getAnswerNeeded(db: Database.Database, conversationId: string): AnswerNeeded | null {
  return (db.prepare(`SELECT conversation_id, message_id, agent_id, set_at FROM surface_answer_needed WHERE conversation_id = ?`)
    .get(conversationId) as AnswerNeeded | undefined) ?? null;
}

export function listAnswerNeeded(db: Database.Database): AnswerNeeded[] {
  return db.prepare(`SELECT conversation_id, message_id, agent_id, set_at FROM surface_answer_needed`).all() as AnswerNeeded[];
}

export function setSubject(db: Database.Database, conversationId: string, subject: string, now = Date.now()): void {
  db.prepare(`INSERT OR REPLACE INTO surface_session_subjects(conversation_id, subject, updated_at) VALUES (?,?,?)`)
    .run(conversationId, subject, new Date(now).toISOString());
}

export function listSubjects(db: Database.Database): Map<string, string> {
  const rows = db.prepare(`SELECT conversation_id, subject FROM surface_session_subjects`).all() as { conversation_id: string; subject: string }[];
  return new Map(rows.map((r) => [r.conversation_id, r.subject]));
}

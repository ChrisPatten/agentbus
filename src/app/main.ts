import type Database from 'better-sqlite3';
import { appConversationId } from './outbound.js';

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

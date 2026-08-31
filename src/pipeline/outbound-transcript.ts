import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { MessagePayload } from '../types/envelope.js';

/**
 * S31.1 — Shared outbound-transcript-insert helper.
 *
 * Single insert path for every `direction: 'outbound'` transcripts row, used
 * by both the slash-command bypass (`src/http/api.ts`) and `DeliveryWorker`
 * (`src/core/delivery.ts`) so the SQL/columns can't drift between the two.
 *
 * `transcripts.conversation_id`/`session_id` are NOT NULL (FK to sessions), so
 * when either is unresolvable the row is skipped rather than inserted with a
 * placeholder — this is best-effort auditability, not a delivery gate.
 */
export function logOutboundTranscript(
  db: Database.Database,
  params: {
    messageId: string;
    conversationId: string | null;
    sessionId: string | null;
    channel: string;
    contactId: string;
    body: string;
    metadata: Record<string, unknown>;
  },
): void {
  const { messageId, conversationId, sessionId, channel, contactId, body, metadata } = params;

  if (!conversationId || !sessionId) {
    console.warn(
      `[outbound-transcript] Skipping transcript for message ${messageId}: conversation/session not resolvable`,
    );
    return;
  }

  db.prepare(
    `INSERT INTO transcripts (id, message_id, conversation_id, session_id, created_at, channel, contact_id, direction, body, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, json(?))`,
  ).run(
    randomUUID(),
    messageId,
    conversationId,
    sessionId,
    new Date().toISOString(),
    channel,
    contactId,
    'outbound',
    body,
    JSON.stringify(metadata),
  );
}

/**
 * Resolve `conversation_id`/`session_id` for an outbound send, the same way
 * the inbound pipeline resolves them: look up `conversation_registry` by
 * contact + channel (most recently seen), then the active session for that
 * conversation. Returns nulls when unresolvable (e.g. no prior inbound
 * history for this contact on this channel) — callers must not fail the send
 * over a miss here.
 */
export function resolveConversationForOutbound(
  db: Database.Database,
  contactId: string,
  channel: string,
): { conversationId: string | null; sessionId: string | null } {
  const conversation = db
    .prepare(
      `SELECT id FROM conversation_registry WHERE contact_id = ? AND channel = ? ORDER BY last_seen DESC LIMIT 1`,
    )
    .get(contactId, channel) as { id: string } | undefined;

  if (!conversation) {
    return { conversationId: null, sessionId: null };
  }

  const session = db
    .prepare(
      `SELECT id FROM sessions WHERE conversation_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1`,
    )
    .get(conversation.id) as { id: string } | undefined;

  return { conversationId: conversation.id, sessionId: session?.id ?? null };
}

/**
 * Render a message payload as transcript body text, mirroring the
 * `[reaction:...]` placeholder convention `transcript-log.ts` uses for
 * inbound reactions (S31.3) — kept here so the outbound call sites don't
 * duplicate the ternary.
 */
export function renderOutboundBody(payload: MessagePayload): string {
  return payload.type === 'reaction'
    ? `[reaction:${payload.removed ? 'removed' : 'added'} ${payload.emoji} → ${payload.target_message_id}]`
    : payload.body;
}

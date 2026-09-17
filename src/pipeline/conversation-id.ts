import { createHash } from 'node:crypto';

/**
 * Compute a stable conversation id from a (contact, channel, topic) triple.
 *
 * Pure function: sha256 of the three inputs, sorted before joining, so the
 * result depends only on the three values themselves (not the order the
 * caller happens to pass them in). Callers are responsible for stripping any
 * "contact:" prefix from the contact id BEFORE calling this — see
 * src/pipeline/stages/route-resolve.ts, which strips it from
 * `envelope.sender` before building its `parts` array. This function itself
 * just hashes whatever bare contact id it's given.
 *
 * Extracted from src/pipeline/stages/route-resolve.ts (Stage 70) so other
 * callers — e.g. src/http/api.ts's outbound stale-pane guard (E48 S48.6),
 * which has no `reply_to` to resolve a conversation_id from for a
 * send_message/send_email call — can derive the exact same conversation_id
 * without duplicating the hash logic.
 */
export function computeConversationId(contactId: string, channel: string, topic: string): string {
  const parts = [contactId, channel, topic].sort();
  return createHash('sha256').update(parts.join(':')).digest('hex');
}

/**
 * E96 S96.6 — clearing the `answer_needed` flag (set by reply/send_message via
 * `setAnswerNeeded`, stored in `surface_answer_needed`, read by sessions.ts).
 *
 * It clears on:
 *   - a choice-button tap on that conversation's prompt ({@link clearAnswerNeededOnTap},
 *     called from `resolveChoiceTap` on `answered`);
 *   - a reply from the contact in that conversation ({@link clearAnswerNeededOnInbound},
 *     called by the inbound path);
 *   - the explicit clear tool (`clearAnswerNeeded` in flags.ts).
 *
 * Every clear that removed a row notifies {@link onAnswerNeededCleared} listeners so the
 * owner of the sessions resource can push a delta right away instead of on its next poll.
 */
import type Database from 'better-sqlite3';
import { computeConversationId } from '../pipeline/conversation-id.js';
import type { ChoicePrompt } from '../choices/types.js';
import { clearAnswerNeeded } from './flags.js';

type Listener = (conversationIds: string[]) => void;
const listeners = new Set<Listener>();

/** Subscribe to flag clears (by tap or inbound). Returns an unsubscribe function. Listener errors are logged, never thrown. */
export function onAnswerNeededCleared(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function notify(conversationIds: string[]): void {
  if (conversationIds.length === 0) return;
  for (const l of listeners) {
    try { l(conversationIds); } catch (err) { console.error(`[surface] answer-needed listener failed: ${String(err)}`); }
  }
}

const bare = (id: string): string => id.replace(/^contact:/, '');

/** The pipeline's conversation id for a (contact, channel, topic): route-resolve strips `contact:` and defaults the topic to `general`. */
export function pipelineConversationId(contactId: string, channel: string, topic?: string | null): string {
  return computeConversationId(bare(contactId), channel, topic || 'general');
}

/**
 * The contact wrote in this conversation: clear its flag. Pass the inbound envelope's
 * `metadata` so bus-originated turns that only look like the contact (scheduled fires,
 * `system_only` turns) do not clear it. Returns true when a flag was removed.
 */
export function clearAnswerNeededOnInbound(
  db: Database.Database,
  input: { channel: string; contactId: string; topic?: string | null; conversationId?: string | null; metadata?: Record<string, unknown> | null },
): boolean {
  const meta = input.metadata ?? {};
  if (meta['scheduled'] === true || meta['system_only'] === true) return false;
  if (input.contactId.startsWith('agent:') || input.contactId.startsWith('system:')) return false;
  const conversationId = input.conversationId || pipelineConversationId(input.contactId, input.channel, input.topic);
  let changed = false;
  try { changed = clearAnswerNeeded(db, conversationId); } catch (err) { console.error(`[surface] clearAnswerNeededOnInbound failed: ${String(err)}`); }
  if (changed) notify([conversationId]);
  return changed;
}

/**
 * A choice button on `prompt` was tapped by `tapperContactId`. Clears the flag of the
 * prompt's conversation (computed from the addressee or, for an any-sender prompt, the
 * tapper) and any flag whose question message carries this prompt. Returns true when a
 * flag was removed.
 */
export function clearAnswerNeededOnTap(
  db: Database.Database,
  prompt: Pick<ChoicePrompt, 'channel' | 'topic' | 'contact_id' | 'bus_message_id'>,
  tapperContactId: string,
): boolean {
  const ids = new Set<string>([pipelineConversationId(prompt.contact_id ?? tapperContactId, prompt.channel, prompt.topic)]);
  try {
    if (prompt.bus_message_id) {
      const rows = db.prepare(`SELECT conversation_id FROM surface_answer_needed WHERE message_id = ?`).all(prompt.bus_message_id) as { conversation_id: string }[];
      for (const r of rows) ids.add(r.conversation_id);
    }
    const cleared = [...ids].filter((id) => clearAnswerNeeded(db, id));
    notify(cleared);
    return cleared.length > 0;
  } catch (err) {
    console.error(`[surface] clearAnswerNeededOnTap failed: ${String(err)}`);
    return false;
  }
}

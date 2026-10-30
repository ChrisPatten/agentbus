/**
 * S86.1 — the platform-neutral part of a choice-button tap.
 *
 * Looks the prompt up, checks the tapper is its addressee, and makes the
 * atomic `open -> answered` flip (ChoiceStore.answer, so a double tap answers
 * once). On `answered` it also builds the inbound message body: the choice's
 * slash command when it carries one (E54), otherwise `[tapped] <label>` (E74).
 *
 * The caller injects that body and, if injection fails, calls
 * `store.reopen(prompt.id)` so the human can tap again. Toasts, keyboard edits
 * and platform metadata stay in the adapter (Telegram) or route (Mac app).
 */
import type { ChoiceStore } from './store.js';
import type { ChoicePrompt } from './types.js';

export type ChoiceTapOutcome = 'answered' | 'already_answered' | 'expired' | 'invalid_choice' | 'not_found' | 'forbidden';

export interface ChoiceTapAnswered {
  outcome: 'answered';
  prompt: ChoicePrompt;
  label: string;
  /** The inbound body: the choice's command, else `[tapped] <label>`. */
  body: string;
  /** The choice's slash command (E54), or null for a plain choice. */
  command: string | null;
  /** Inbound metadata every platform carries on the tap's message. */
  metadata: { choice_prompt_id: string; choice_index: number };
}

export interface ChoiceTapRejected {
  outcome: Exclude<ChoiceTapOutcome, 'answered'>;
  /** Null only for `not_found`. */
  prompt: ChoicePrompt | null;
}

export type ChoiceTapResult = ChoiceTapAnswered | ChoiceTapRejected;

/**
 * Resolves a tap on button `index` of prompt `promptId` by bare contact id
 * `contactId`. Only the contact the prompt was addressed to may answer (a
 * prompt with no addressee accepts any authenticated tapper). A copy or link
 * button (E81) never answers a prompt: such an index is `invalid_choice`.
 */
export function resolveChoiceTap(
  store: ChoiceStore,
  promptId: string,
  index: number,
  contactId: string,
  answeredBy: string = `contact:${contactId}`,
  now: Date = new Date(),
): ChoiceTapResult {
  const prompt = store.getById(promptId);
  if (!prompt) return { outcome: 'not_found', prompt: null };
  if (prompt.contact_id && prompt.contact_id !== contactId) return { outcome: 'forbidden', prompt };

  const attrs = Number.isInteger(index) ? prompt.buttons?.[index] : undefined;
  if (prompt.status === 'open' && attrs && (attrs.copy_text !== undefined || attrs.url !== undefined)) {
    return { outcome: 'invalid_choice', prompt };
  }

  const result = store.answer(promptId, index, answeredBy, now);
  switch (result.outcome) {
    case 'not_found':
      return { outcome: 'not_found', prompt: null };
    case 'already_answered':
    case 'expired':
    case 'invalid_choice':
      return { outcome: result.outcome, prompt: result.prompt };
    case 'answered': {
      const command = result.prompt.commands?.[index] ?? null;
      return {
        outcome: 'answered',
        prompt: result.prompt,
        label: result.label,
        body: command ?? `[tapped] ${result.label}`,
        command,
        metadata: { choice_prompt_id: promptId, choice_index: index },
      };
    }
  }
}

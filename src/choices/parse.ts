/**
 * S86.1 — parsing of `metadata.choices` / `metadata.choice_commands`, shared by
 * every adapter that draws choice buttons (Telegram, the Mac app).
 *
 * Moved out of src/adapters/telegram.ts unchanged; the log tag is passed in.
 */
import type { ChoiceButtonAttrs } from './types.js';
import { choicesSchema, choiceCommandsSchema, choiceAttrs, choiceLabel } from './validate.js';

export interface ParsedChoices {
  labels: string[];
  /** Parallel to `labels`; present only when some item is an E81 button object. */
  buttons?: Array<ChoiceButtonAttrs | null>;
}

/**
 * `metadata.choices` if valid (see choicesSchema), else undefined (message sent without buttons).
 * `buttons` is parallel to `labels` and present only when some item is an E81 button object.
 */
export function parseChoices(raw: unknown, tag: string): ParsedChoices | undefined {
  if (raw === undefined) return undefined;
  const parsed = choicesSchema.safeParse(raw);
  if (!parsed.success) {
    console.warn(`${tag} Ignoring invalid metadata.choices: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
    return undefined;
  }
  const labels = parsed.data.map(choiceLabel);
  const attrs = parsed.data.map(choiceAttrs);
  return attrs.some((a) => a) ? { labels, buttons: attrs } : { labels };
}

/**
 * `metadata.choice_commands` (E54): per-choice slash-command payloads, parallel
 * to the labels. Invalid or wrong-length input is dropped (plain E74 buttons).
 */
export function parseChoiceCommands(raw: unknown, labelCount: number, tag: string): Array<string | null> | undefined {
  if (raw === undefined) return undefined;
  const parsed = choiceCommandsSchema.safeParse(raw);
  if (!parsed.success || parsed.data.length !== labelCount) {
    console.warn(
      `${tag} Ignoring invalid metadata.choice_commands: ${parsed.success ? 'length does not match choices' : (parsed.error.issues[0]?.message ?? 'invalid')}`,
    );
    return undefined;
  }
  return parsed.data;
}

/** True if at least one of `count` buttons is a callback button (not copy_text/url) — only then is there anything to answer. */
export function hasCallbackButton(buttons: Array<ChoiceButtonAttrs | null> | undefined, count: number): boolean {
  if (!buttons) return count > 0;
  return buttons.some((b) => !b || (b.copy_text === undefined && b.url === undefined));
}

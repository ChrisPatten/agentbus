/**
 * S74.1 — shared validation and rendering for the `choices` argument of the
 * `reply` / `send_message` MCP tools (E74).
 */
import { z } from 'zod';
import {
  MAX_CHOICES,
  MAX_CHOICE_LABEL_LENGTH,
  MAX_CHOICE_COMMAND_LENGTH,
  MAX_COPY_TEXT_LENGTH,
  type ChoiceButtonAttrs,
} from './types.js';

const labelSchema = z
  .string()
  .refine((s) => s.trim().length > 0, { message: 'choice labels must not be empty' })
  .refine((s) => s.length <= MAX_CHOICE_LABEL_LENGTH, {
    message: `choice labels must be at most ${MAX_CHOICE_LABEL_LENGTH} characters`,
  });

/**
 * E81 (S81.3) — a button object: a plain callback button with a `style`, a
 * `copy_text` button (tap copies, nothing is sent back) or a `url` button.
 */
export const choiceObjectSchema = z
  .object({
    label: labelSchema,
    style: z.enum(['primary', 'success', 'danger']).optional(),
    copy_text: z.string().min(1).max(MAX_COPY_TEXT_LENGTH).optional(),
    url: z
      .string()
      .max(2048)
      .refine((u) => /^(https?|tg):\/\/\S+$/i.test(u), { message: 'choice url must be an http(s) or tg:// link' })
      .optional(),
  })
  .refine((o) => !(o.copy_text !== undefined && o.url !== undefined), {
    message: 'a choice may carry copy_text or url, not both',
  });

export type ChoiceObject = z.infer<typeof choiceObjectSchema>;
/** One `choices` entry: a plain label (E74) or a button object (E81). */
export type ChoiceItem = string | ChoiceObject;

export const choicesSchema = z
  .array(z.union([labelSchema, choiceObjectSchema]))
  .min(1, { message: 'choices needs at least 1 label' })
  .max(MAX_CHOICES, { message: `choices allows at most ${MAX_CHOICES} labels` });

export function choiceLabel(item: ChoiceItem): string {
  return typeof item === 'string' ? item : item.label;
}

/** The non-label attributes of a choice, or null for a plain callback button. */
export function choiceAttrs(item: ChoiceItem): ChoiceButtonAttrs | null {
  if (typeof item === 'string') return null;
  const attrs: ChoiceButtonAttrs = {};
  if (item.style) attrs.style = item.style;
  if (item.copy_text !== undefined) attrs.copy_text = item.copy_text;
  if (item.url !== undefined) attrs.url = item.url;
  return Object.keys(attrs).length > 0 ? attrs : null;
}

/**
 * E54 — `metadata.choice_commands`: per-choice slash-command payloads,
 * parallel to `choices`. Bus-internal (set by command handlers via
 * deliverCommandResponse), not exposed on the MCP tools.
 */
export const choiceCommandsSchema = z
  .array(
    z
      .string()
      .refine((s) => s.startsWith('/') && s.length > 1 && !/[\r\n]/.test(s), {
        message: 'choice commands must be single-line slash commands',
      })
      .refine((s) => s.length <= MAX_CHOICE_COMMAND_LENGTH, {
        message: `choice commands must be at most ${MAX_CHOICE_COMMAND_LENGTH} characters`,
      })
      .nullable(),
  )
  .max(MAX_CHOICES);

export const CHOICES_DESCRIPTION =
  `Optional single-choice answers (1-${MAX_CHOICES} labels, each at most ${MAX_CHOICE_LABEL_LENGTH} characters). ` +
  'On Telegram and in the Mac app they render as tappable buttons and the tap arrives back as a normal inbound ' +
  'message "[tapped] <label>"; typed replies still work. On other channels they are appended to the body as a ' +
  'numbered list. Use only for a real decision the user must make, not for routine messages. ' +
  'An item may instead be an object {label, style?: "primary"|"success"|"danger", copy_text?, url?}: ' +
  'copy_text makes a button that copies that text when tapped (nothing is sent back), url makes a link button; ' +
  'after a tap on an object-style prompt the chosen button stays visible and disabled.';

export function isTelegramChannel(channel: string): boolean {
  return channel === 'telegram' || channel.startsWith('telegram:');
}

/**
 * E86 — channels whose adapter draws `metadata.choices` as buttons: Telegram
 * (inline keyboard, E74) and the Mac app (`app`, buttons in the transcript).
 */
export function supportsChoiceButtons(channel: string): boolean {
  return isTelegramChannel(channel) || channel === 'app';
}

/**
 * Applies `choices` to an outbound message for `channel`: Telegram and the Mac
 * app get `metadata.choices` (the adapter renders the buttons); every other
 * channel gets a numbered list appended to the body.
 */
export function applyChoices(
  channel: string,
  body: string,
  metadata: Record<string, unknown>,
  choices: ChoiceItem[] | undefined,
): { body: string; metadata: Record<string, unknown> } {
  if (!choices || choices.length === 0) return { body, metadata };
  if (supportsChoiceButtons(channel)) {
    return { body, metadata: { ...metadata, choices } };
  }
  const list = choices
    .map((item, i) => {
      const attrs = typeof item === 'string' ? null : item;
      const extra = attrs?.copy_text !== undefined ? ` (${attrs.copy_text})` : attrs?.url !== undefined ? ` (${attrs.url})` : '';
      return `${i + 1}. ${choiceLabel(item)}${extra}`;
    })
    .join('\n');
  return { body: `${body}\n\n${list}`, metadata };
}

/**
 * S74.1 — shared validation and rendering for the `choices` argument of the
 * `reply` / `send_message` MCP tools (E74).
 */
import { z } from 'zod';
import { MAX_CHOICES, MAX_CHOICE_LABEL_LENGTH, MAX_CHOICE_COMMAND_LENGTH } from './types.js';

export const choicesSchema = z
  .array(
    z
      .string()
      .refine((s) => s.trim().length > 0, { message: 'choice labels must not be empty' })
      .refine((s) => s.length <= MAX_CHOICE_LABEL_LENGTH, {
        message: `choice labels must be at most ${MAX_CHOICE_LABEL_LENGTH} characters`,
      }),
  )
  .min(1, { message: 'choices needs at least 1 label' })
  .max(MAX_CHOICES, { message: `choices allows at most ${MAX_CHOICES} labels` });

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
  'On Telegram they render as tappable buttons and the tap arrives back as a normal inbound message ' +
  '"[tapped] <label>"; typed replies still work. On other channels they are appended to the body as a ' +
  'numbered list. Use only for a real decision the user must make, not for routine messages.';

export function isTelegramChannel(channel: string): boolean {
  return channel === 'telegram' || channel.startsWith('telegram:');
}

/**
 * Applies `choices` to an outbound message for `channel`: Telegram gets
 * `metadata.choices` (the adapter renders the keyboard); every other channel
 * gets a numbered list appended to the body.
 */
export function applyChoices(
  channel: string,
  body: string,
  metadata: Record<string, unknown>,
  choices: string[] | undefined,
): { body: string; metadata: Record<string, unknown> } {
  if (!choices || choices.length === 0) return { body, metadata };
  if (isTelegramChannel(channel)) {
    return { body, metadata: { ...metadata, choices } };
  }
  const list = choices.map((label, i) => `${i + 1}. ${label}`).join('\n');
  return { body: `${body}\n\n${list}`, metadata };
}

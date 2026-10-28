/** E74 — types for single-choice button prompts. */

export type ChoicePromptStatus = 'open' | 'answered' | 'expired';

/** Non-label attributes of a button (E81 buttons v2). */
export interface ChoiceButtonAttrs {
  style?: 'primary' | 'success' | 'danger';
  copy_text?: string;
  url?: string;
}

/** A row of `choice_prompts`, with `labels` parsed. */
export interface ChoicePrompt {
  id: string;
  channel: string;
  topic: string;
  contact_id: string | null;
  labels: string[];
  /** Per-choice slash-command payloads parallel to `labels` (E54); null/absent entries are plain choices. */
  commands: Array<string | null> | null;
  /** Per-button style/copy_text/url (E81 buttons v2), parallel to `labels`; null = every button is a plain callback button. */
  buttons: Array<ChoiceButtonAttrs | null> | null;
  platform_message_id: string | null;
  bus_message_id: string | null;
  status: ChoicePromptStatus;
  chosen_index: number | null;
  answered_by: string | null;
  answered_at: string | null;
  created_at: string;
  expires_at: string;
}

export interface ChoicePromptInput {
  /** Pre-generated id (it must exist before the Telegram send, to go in callback_data). */
  id: string;
  channel: string;
  topic: string;
  contactId: string | null;
  labels: string[];
  /** Optional per-choice command payloads, same length as `labels` (E54). */
  commands?: Array<string | null> | null;
  /** Optional per-button attributes, same length as `labels` (E81). */
  buttons?: Array<ChoiceButtonAttrs | null> | null;
  platformMessageId: string | null;
  busMessageId: string | null;
}

export type AnswerChoiceOutcome =
  | { outcome: 'answered'; prompt: ChoicePrompt; label: string }
  | { outcome: 'already_answered'; prompt: ChoicePrompt }
  | { outcome: 'expired'; prompt: ChoicePrompt }
  | { outcome: 'invalid_choice'; prompt: ChoicePrompt }
  | { outcome: 'not_found' };

/** Default lifetime of a prompt before the sweep expires it. */
export const DEFAULT_CHOICE_TTL_MS = 24 * 60 * 60 * 1000;

export const MAX_CHOICES = 8;
export const MAX_CHOICE_LABEL_LENGTH = 64;

/** Longest slash-command payload a choice may carry. */
export const MAX_CHOICE_COMMAND_LENGTH = 200;

/** Telegram's limit for a CopyTextButton's text. */
export const MAX_COPY_TEXT_LENGTH = 256;

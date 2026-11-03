/**
 * S81.2 — optional send parameters shared by `reply` / `send_message` (E81).
 *
 * `silent`, `no_preview` and `pin` ride `metadata` to the Telegram adapter,
 * which applies them; every other channel ignores them. Each is individually
 * optional and combinable with `choices`.
 */
import { z } from 'zod';
import { clampGlance, GLANCE_MAX } from '../intercom/glance.js';

export const SILENT_DESCRIPTION =
  'Telegram only: deliver without a notification sound (disable_notification). Use for routine or low-urgency messages. Ignored on other channels.';
export const NO_PREVIEW_DESCRIPTION =
  'Telegram only: do not expand link previews in this message. Ignored on other channels.';
export const PIN_DESCRIPTION =
  'Telegram only: pin this message in its chat or forum topic after sending (silently). Needs the bot to have the "Pin Messages" admin right; a failure is logged, not returned. Ignored on other channels.';

export const GLANCE_DESCRIPTION =
  `Optional one-line summary of this message for small glance displays (Intercom), a plain line of at most ${GLANCE_MAX} characters, no markdown. ` +
  'Longer text is truncated. When omitted the bus derives one from the first sentence. Other channels ignore it.';

export const ANSWER_NEEDED_DESCRIPTION =
  "Set when you need the user's answer before you can continue; shows as needs-you on Intercom until they answer " +
  '(or tap a button, or you call clear_answer_needed). Leave it unset for anything that does not block you.';

/** Zod fields to spread into a tool's inputSchema. */
export const sendOptionFields = {
  silent: z.boolean().optional().describe(SILENT_DESCRIPTION),
  no_preview: z.boolean().optional().describe(NO_PREVIEW_DESCRIPTION),
  pin: z.boolean().optional().describe(PIN_DESCRIPTION),
  glance: z.string().max(2000).optional().describe(GLANCE_DESCRIPTION),
  answer_needed: z.boolean().optional().describe(ANSWER_NEEDED_DESCRIPTION),
};

export interface SendOptions {
  silent?: boolean;
  no_preview?: boolean;
  pin?: boolean;
  /** E90 (I3): glance line for Intercom surfaces; truncated to 100 characters. */
  glance?: string | undefined;
  /** E96 (S96.6): the sender needs the user's answer; stored as `metadata.answer_needed`. */
  answer_needed?: boolean | undefined;
}

/** Copies the options the caller set (true only) into `metadata`; unset or false options add nothing. */
export function applySendOptions(metadata: Record<string, unknown>, opts: SendOptions): Record<string, unknown> {
  const out = { ...metadata };
  if (opts.silent) out['silent'] = true;
  if (opts.no_preview) out['no_preview'] = true;
  if (opts.pin) out['pin'] = true;
  const glance = clampGlance(opts.glance);
  if (glance) out['glance'] = glance;
  if (opts.answer_needed) out['answer_needed'] = true;
  return out;
}

/** Reads the options back out of an envelope's metadata (adapter side). Only a literal `true` counts. */
export function readSendOptions(metadata: Record<string, unknown> | undefined): SendOptions {
  return {
    silent: metadata?.['silent'] === true,
    no_preview: metadata?.['no_preview'] === true,
    pin: metadata?.['pin'] === true,
  };
}

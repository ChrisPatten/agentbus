/**
 * S81.2 — optional send parameters shared by `reply` / `send_message` (E81).
 *
 * `silent`, `no_preview` and `pin` ride `metadata` to the Telegram adapter,
 * which applies them; every other channel ignores them. Each is individually
 * optional and combinable with `choices`.
 */
import { z } from 'zod';

export const SILENT_DESCRIPTION =
  'Telegram only: deliver without a notification sound (disable_notification). Use for routine or low-urgency messages. Ignored on other channels.';
export const NO_PREVIEW_DESCRIPTION =
  'Telegram only: do not expand link previews in this message. Ignored on other channels.';
export const PIN_DESCRIPTION =
  'Telegram only: pin this message in its chat or forum topic after sending (silently). Needs the bot to have the "Pin Messages" admin right; a failure is logged, not returned. Ignored on other channels.';

/** Zod fields to spread into a tool's inputSchema. */
export const sendOptionFields = {
  silent: z.boolean().optional().describe(SILENT_DESCRIPTION),
  no_preview: z.boolean().optional().describe(NO_PREVIEW_DESCRIPTION),
  pin: z.boolean().optional().describe(PIN_DESCRIPTION),
};

export interface SendOptions {
  silent?: boolean;
  no_preview?: boolean;
  pin?: boolean;
}

/** Copies the options the caller set (true only) into `metadata`; unset or false options add nothing. */
export function applySendOptions(metadata: Record<string, unknown>, opts: SendOptions): Record<string, unknown> {
  const out = { ...metadata };
  if (opts.silent) out['silent'] = true;
  if (opts.no_preview) out['no_preview'] = true;
  if (opts.pin) out['pin'] = true;
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

/**
 * E81 — Telegram-native outbound tools.
 *
 *   send_location, send_venue, send_contact  (S81.6)
 *   send_document                            (S81.7)
 *   ask_input                                (S81.8)
 *   send_rich                                (S81.9)
 *   edit_message                             (S81.4)
 *   pin_message, unpin_message               (S81.5)
 *
 * The send tools enqueue an ordinary text envelope through POST /api/v1/messages,
 * exactly like `send_message`, so the contact allow-list and delivery path are
 * unchanged. The body is always a plain-text fallback (what every non-Telegram
 * channel delivers); on a Telegram channel the native form rides
 * `metadata.telegram_send`, which the adapter validates again. edit/pin tools
 * are thin wrappers over bus-core endpoints that look the message up in the
 * outbound_messages registry.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toolError, toolSuccess } from './helpers.js';
import { getTelegramInstances, type AppConfig } from '../../config/schema.js';
import { toPrefixedAgentId } from '../../pool/types.js';
import { applyChoices, choicesSchema, CHOICES_DESCRIPTION, isTelegramChannel } from '../../choices/validate.js';
import { originFromEnv, withOrigin } from '../../core/origin.js';
import { applySendOptions, SILENT_DESCRIPTION, PIN_DESCRIPTION } from '../../outbound/send-options.js';
import {
  MAX_CAPTION_LENGTH,
  contactFallback,
  locationFallback,
  venueFallback,
  type TelegramSend,
} from '../../outbound/telegram-send.js';
import { renderRichPlain } from '../../outbound/rich.js';
import { checkDocumentPath, resolveSendDirs, MAX_DOCUMENT_BYTES, MAX_PHOTO_BYTES } from '../../outbound/documents.js';

/** Addressing shared by every send tool; identical to `send_message`. */
const addressing = {
  to: z.string().min(1).describe('Recipient identifier (e.g. "contact:chris")'),
  channel: z.string().min(1).describe('Target channel (e.g. "telegram", "telegram:peggy:group:-100123", "email")'),
  topic: z
    .string()
    .optional()
    .default('general')
    .describe('Message topic (default "general"); for a Telegram forum topic pass its "thread:<hash>" id, as for send_message.'),
  reply_to: z.string().optional().describe('Bus message ID this message is replying to'),
  silent: z.boolean().optional().describe(SILENT_DESCRIPTION),
  pin: z.boolean().optional().describe(PIN_DESCRIPTION),
};

interface Addressing {
  to: string;
  channel: string;
  topic?: string | undefined;
  reply_to?: string | undefined;
  silent?: boolean | undefined;
  pin?: boolean | undefined;
}

const latitudeField = z.number().min(-90).max(90).describe('Latitude, -90 to 90');
const longitudeField = z.number().min(-180).max(180).describe('Longitude, -180 to 180');

/** The Telegram instance config whose adapter id matches `channel` (first instance as a fallback). */
function instanceFor(config: AppConfig | undefined, channel: string) {
  if (!config) return undefined;
  const instances = getTelegramInstances(config);
  return (
    instances.find((i) => {
      const id = i.name ? `telegram:${i.name}` : 'telegram';
      return channel === id || channel.startsWith(`${id}:`);
    }) ?? instances[0]
  );
}

export function registerTelegramSendTools(
  server: McpServer,
  busBaseUrl: string,
  agentId: string,
  config?: AppConfig,
): void {
  async function channelExists(channel: string): Promise<string | null> {
    try {
      const res = await fetch(`${busBaseUrl}/api/v1/adapters/resolve?channel=${encodeURIComponent(channel)}`);
      if (!res.ok) return `Failed to resolve channel: HTTP ${res.status}`;
      const data = (await res.json()) as { ok: boolean; exists?: boolean };
      if (!data.exists) return `Unknown channel: "${channel}". Call list_channels to see available channels.`;
      return null;
    } catch (err) {
      return `Failed to validate channel: ${String(err)}`;
    }
  }

  /**
   * Enqueues `body` (the plain-text fallback) with `native` attached for Telegram
   * channels. `extra` carries `choices` etc. already applied to body/metadata.
   */
  async function enqueue(
    a: Addressing,
    body: string,
    native: TelegramSend | undefined,
    base: Record<string, unknown> = {},
  ) {
    const bad = await channelExists(a.channel);
    if (bad) return toolError(bad);
    const metadata = applySendOptions(base, { silent: a.silent, pin: a.pin });
    if (native && isTelegramChannel(a.channel)) metadata['telegram_send'] = native;
    const envelope = {
      channel: a.channel,
      topic: a.topic ?? 'general',
      sender: toPrefixedAgentId(agentId),
      recipient: a.to,
      reply_to: a.reply_to ?? null,
      priority: 'normal' as const,
      payload: { type: 'text' as const, body },
      metadata: withOrigin(metadata, originFromEnv(agentId)),
    };
    try {
      const res = await fetch(`${busBaseUrl}/api/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(envelope),
      });
      const data = (await res.json()) as { ok: boolean; id?: string; error?: string };
      if (!data.ok) return toolError(`Bus rejected message: ${data.error ?? 'unknown error'}`);
      return toolSuccess({ success: true, message_id: data.id });
    } catch (err) {
      return toolError(`Failed to send message: ${String(err)}`);
    }
  }

  // ── S81.6 location / venue / contact ──────────────────────────────────────

  server.registerTool(
    'send_location',
    {
      description:
        'Send a map location (static coordinates; live location is not supported). On Telegram it is a tappable map card; ' +
        'on other channels a text line with an Apple Maps link. Same addressing as send_message.',
      inputSchema: { ...addressing, latitude: latitudeField, longitude: longitudeField },
    },
    async ({ latitude, longitude, ...a }) =>
      enqueue(a, locationFallback(latitude, longitude), { kind: 'location', latitude, longitude }),
  );

  server.registerTool(
    'send_venue',
    {
      description:
        'Send a venue: coordinates with a title and street address. On Telegram a tappable map card; on other channels ' +
        'text with the name, address and an Apple Maps link.',
      inputSchema: {
        ...addressing,
        latitude: latitudeField,
        longitude: longitudeField,
        title: z.string().min(1).max(255).describe('Venue name'),
        address: z.string().min(1).max(255).describe('Street address'),
      },
    },
    async ({ latitude, longitude, title, address, ...a }) =>
      enqueue(a, venueFallback({ latitude, longitude, title, address }), { kind: 'venue', latitude, longitude, title, address }),
  );

  server.registerTool(
    'send_contact',
    {
      description:
        'Send a contact card (name and phone number, optional vCard). On Telegram a shareable contact card; on other ' +
        'channels a text line with the name and number. A phone number is required.',
      inputSchema: {
        ...addressing,
        phone_number: z.string().min(3).max(64).describe('Phone number, ideally with country code'),
        first_name: z.string().min(1).max(64).describe('First name'),
        last_name: z.string().max(64).optional().describe('Last name'),
        vcard: z.string().max(2048).optional().describe('Optional vCard 3.0 text with more detail'),
      },
    },
    async ({ phone_number, first_name, last_name, vcard, ...a }) =>
      enqueue(a, contactFallback({ phone_number, first_name, last_name }), {
        kind: 'contact',
        phone_number,
        first_name,
        ...(last_name ? { last_name } : {}),
        ...(vcard ? { vcard } : {}),
      }),
  );

  // ── S81.7 send_document ───────────────────────────────────────────────────

  server.registerTool(
    'send_document',
    {
      description:
        'Send a local file to a Telegram chat as a document (or, with as="photo", as an inline photo). The path must be ' +
        'absolute and resolve (after following symlinks) inside the configured send directories — by default the agent\'s ' +
        'data/ directory and its scratchpad; anything else is rejected. Limits: 50 MB for a document, 10 MB for a photo, ' +
        `${MAX_CAPTION_LENGTH}-character caption. Telegram channels only: other channels get an "unsupported" error.`,
      inputSchema: {
        ...addressing,
        path: z.string().min(1).describe('Absolute path of the file to send'),
        caption: z.string().max(MAX_CAPTION_LENGTH).optional().describe(`Optional caption, at most ${MAX_CAPTION_LENGTH} characters`),
        as: z.enum(['document', 'photo']).optional().default('document').describe('Send as a document (default) or an inline photo'),
      },
    },
    async ({ path, caption, as, ...a }) => {
      if (!isTelegramChannel(a.channel)) {
        return toolError(
          `send_document is not supported on channel "${a.channel}" (Telegram only). ` +
            'Tell the user where the file is, or send a link instead.',
        );
      }
      if (config) {
        const inst = instanceFor(config, a.channel);
        const check = checkDocumentPath(
          path,
          resolveSendDirs(config, inst?.send_paths),
          as === 'photo' ? MAX_PHOTO_BYTES : MAX_DOCUMENT_BYTES,
        );
        if (!check.ok) return toolError(`Cannot send ${path}: ${check.error}`);
      }
      const name = path.split('/').pop() ?? path;
      const body = caption ? `[file: ${name}] ${caption}` : `[file: ${name}]`;
      return enqueue(a, body, { kind: as, path, ...(caption ? { caption } : {}) });
    },
  );

  // ── S81.8 ask_input ───────────────────────────────────────────────────────

  server.registerTool(
    'ask_input',
    {
      description:
        'Ask the user for a structured answer. kind "location" / "contact" / "person" shows a one-time button that shares ' +
        'a location, a contact card or a chosen person; kind "text" shows a reply prompt with an optional placeholder. ' +
        'The answer arrives as an ordinary inbound message (location and contact as text plus structured metadata) ' +
        'replying to this prompt. The share buttons only work in a private chat; in a group topic the prompt degrades to ' +
        'a plain reply prompt and the user can send the location or contact from the attach menu. On other channels this ' +
        'is just the prompt as text.',
      inputSchema: {
        to: addressing.to,
        channel: addressing.channel,
        topic: addressing.topic,
        reply_to: addressing.reply_to,
        silent: addressing.silent,
        kind: z.enum(['location', 'contact', 'person', 'text']).describe('What to ask for'),
        prompt: z.string().min(1).describe('The question shown to the user'),
        placeholder: z.string().max(64).optional().describe('Placeholder in the input field (kind "text" only; at most 64 characters)'),
      },
    },
    async ({ kind, prompt, placeholder, ...a }) => {
      const body = isTelegramChannel(a.channel) ? prompt : `${prompt}\n\n(Please reply with ${kind === 'text' ? 'your answer' : `a ${kind === 'person' ? 'name' : kind}`}.)`;
      return enqueue(a, body, { kind: 'ask_input', input: kind, ...(placeholder ? { placeholder } : {}) });
    },
  );

  // ── S81.9 send_rich ───────────────────────────────────────────────────────

  server.registerTool(
    'send_rich',
    {
      description:
        'Send a rich message. On Telegram it renders natively: headings, real tables, collapsible <details><summary> ' +
        'sections, quotes, lists, links and inline buttons (<tg-button-row><tg-button type="url" url="...">Label</tg-button></tg-button-row>). ' +
        'Give exactly one of `markdown` (Rich Markdown, preferred) or `html`. Up to 32768 characters; longer text is split ' +
        'at block boundaries. On other channels, and if Telegram rejects the rich form, the body is rendered to plain text ' +
        'with tables as "label: value" lists. Pass `choices` for tappable answer buttons.',
      inputSchema: {
        to: addressing.to,
        channel: addressing.channel,
        topic: addressing.topic,
        reply_to: addressing.reply_to,
        silent: addressing.silent,
        pin: addressing.pin,
        markdown: z.string().min(1).optional().describe('Rich Markdown content (pipe tables, <details>, headings, lists)'),
        html: z.string().min(1).optional().describe('Rich HTML content, as an alternative to markdown'),
        choices: choicesSchema.optional().describe(CHOICES_DESCRIPTION),
      },
    },
    async ({ markdown, html, choices, ...a }) => {
      if ((markdown === undefined) === (html === undefined)) {
        return toolError('Provide exactly one of `markdown` or `html`.');
      }
      const format = markdown !== undefined ? 'markdown' : 'html';
      const content = (markdown ?? html)!;
      const plain = renderRichPlain(content, format);
      const withChoices = applyChoices(a.channel, plain, {}, choices);
      return enqueue(a, withChoices.body, { kind: 'rich', format, content }, withChoices.metadata);
    },
  );

  // ── S81.4 / S81.5 edit, pin, unpin ────────────────────────────────────────

  async function callMessageAction(path: string, payload: Record<string, unknown>, ok: Record<string, unknown>) {
    try {
      const res = await fetch(`${busBaseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; note?: string };
      if (!data.ok) return toolError(data.error ?? `HTTP ${res.status}`);
      return toolSuccess({ success: true, ...ok, ...(data.note ? { note: data.note } : {}) });
    } catch (err) {
      return toolError(String(err));
    }
  }

  server.registerTool(
    'edit_message',
    {
      description:
        'Edit the text of a message you previously sent on Telegram, in place, by the message id that reply / send_message ' +
        'returned. Works for text and rich messages sent within the last 30 days that were delivered as one piece. ' +
        '`choices` replaces the buttons; omit it to remove them. Editing to identical text is a harmless no-op. ' +
        'A rich message is edited with Rich Markdown.',
      inputSchema: {
        message_id: z.string().min(1).describe('The id returned by reply / send_message / send_rich'),
        body: z.string().min(1).describe('New text'),
        choices: choicesSchema.optional().describe(CHOICES_DESCRIPTION),
      },
    },
    async ({ message_id, body, choices }) =>
      callMessageAction(`/api/v1/messages/${encodeURIComponent(message_id)}/edit`, { body, choices }, { message_id }),
  );

  server.registerTool(
    'pin_message',
    {
      description:
        'Pin a message you previously sent on Telegram, by the id reply / send_message returned. Silent by default (no ' +
        'notification). Needs the bot to have the "Pin Messages" admin right in the chat; if it does not the error says so.',
      inputSchema: {
        message_id: z.string().min(1).describe('The id returned by reply / send_message'),
        silent: z.boolean().optional().default(true).describe('Pin without notifying members (default true)'),
      },
    },
    async ({ message_id, silent }) =>
      callMessageAction(`/api/v1/messages/${encodeURIComponent(message_id)}/pin`, { silent }, { message_id, pinned: true }),
  );

  server.registerTool(
    'unpin_message',
    {
      description:
        'Unpin a message you previously sent on Telegram. With unpin_all=true, unpin every pinned message in that ' +
        'message\'s forum topic (or the whole chat if it is not in a topic).',
      inputSchema: {
        message_id: z.string().min(1).describe('The id returned by reply / send_message'),
        unpin_all: z.boolean().optional().default(false).describe('Unpin everything in the same topic/chat instead of just this message'),
      },
    },
    async ({ message_id, unpin_all }) =>
      callMessageAction(`/api/v1/messages/${encodeURIComponent(message_id)}/unpin`, { all: unpin_all }, { message_id, pinned: false, all: unpin_all }),
  );
}

/**
 * Telegram adapter — long-poll daemon for AgentBus.
 *
 * Run as a separate process:
 *   AGENTBUS_CONFIG=/path/to/config.yaml npx tsx src/adapters/telegram.ts
 *
 * This process communicates with bus-core exclusively over HTTP.
 * It does NOT import from bus-core internals (only config loader and types).
 *
 * Two concurrent loops:
 *   - Inbound: long-polls Telegram Bot API for new messages, submits to bus pipeline
 *   - Outbound: polls bus for pending messages addressed to Telegram contacts, delivers them
 */
import { resolve } from 'node:path';
import { loadConfig } from '../config/loader.js';
import type { MessageEnvelope } from '../types/envelope.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const TELEGRAM_API_BASE = 'https://api.telegram.org';
const MAX_MESSAGE_LENGTH = 4096;
const OUTBOUND_POLL_MS = 2000;
const BACKOFF_INITIAL_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
const ACK_MAX_RETRIES = 3;
const LOOP_RESTART_DELAY_MS = 5000;

// ── Minimal Telegram Bot API types ────────────────────────────────────────────

interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
}

interface TelegramChat {
  id: number;
  type: string;
}

interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  caption?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

// ── Config ────────────────────────────────────────────────────────────────────

const configPath = process.env['AGENTBUS_CONFIG'] ?? resolve(process.cwd(), 'config.yaml');
const config = loadConfig(configPath);

const telegramConfig = config.adapters.telegram;
if (!telegramConfig) {
  console.error('[telegram] No adapters.telegram section in config — exiting');
  process.exit(1);
}

const TOKEN = telegramConfig.token;
const POLL_TIMEOUT = telegramConfig.poll_timeout;
const busBaseUrl = `http://127.0.0.1:${config.bus.http_port}`;
const authToken = config.bus.auth_token;

// ── Derived state from config.contacts ───────────────────────────────────────

/** Set of Telegram user IDs (as strings) that are allowed to send messages. */
const allowedSenderIds = new Set<string>();
/** Map from contact id (e.g. "chris") to their Telegram user ID (for outbound chat_id resolution). */
const contactChatIdMap = new Map<string, number>();
/** List of contact recipients (e.g. ["contact:alice"]) that this adapter delivers to. */
const telegramRecipients: string[] = [];

for (const contact of Object.values(config.contacts)) {
  if (contact.platforms.telegram) {
    const userId = contact.platforms.telegram.userId;
    if (!Number.isInteger(userId) || userId <= 0) {
      console.error(
        `[telegram] Invalid Telegram userId ${userId} for contact "${contact.id}" — must be a positive integer`,
      );
      process.exit(1);
    }
    allowedSenderIds.add(String(userId));
    contactChatIdMap.set(contact.id, userId);
    telegramRecipients.push(`contact:${contact.id}`);
  }
}

// ── Shutdown signal ───────────────────────────────────────────────────────────

let stopping = false;
const stopController = new AbortController();

process.on('SIGTERM', () => {
  console.log('[telegram] SIGTERM received — shutting down');
  stopping = true;
  stopController.abort();
});

process.on('SIGINT', () => {
  console.log('[telegram] SIGINT received — shutting down');
  stopping = true;
  stopController.abort();
});

// ── HTTP helpers ──────────────────────────────────────────────────────────────

/** Fetch wrapper for Telegram Bot API calls. */
async function callTelegram<T>(
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  const res = await fetch(`${TELEGRAM_API_BASE}/bot${TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = (await res.json()) as TelegramApiResponse<T>;
  if (!res.ok || !data.ok) {
    throw Object.assign(new Error(`Telegram API error: ${data.description ?? res.status}`), {
      status: res.status,
    });
  }
  return data.result as T;
}

/** Fetch wrapper for bus-core HTTP API. Injects X-Bus-Token if configured. */
async function busFetch(path: string, opts: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = {
    ...(opts.headers as Record<string, string>),
  };
  if (authToken) {
    headers['x-bus-token'] = authToken;
  }
  return fetch(`${busBaseUrl}${path}`, { ...opts, headers });
}

// ── Message splitting ─────────────────────────────────────────────────────────

/**
 * Split a message body into chunks that fit within Telegram's 4096-char limit.
 * Splits on the last newline before the limit when possible; otherwise hard-splits.
 */
export function splitMessage(text: string, maxLen: number = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= maxLen) return [text];

  const parts: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    const chunk = remaining.slice(0, maxLen);
    const lastNewline = chunk.lastIndexOf('\n');
    const splitAt = lastNewline > 0 ? lastNewline + 1 : maxLen;
    const part = remaining.slice(0, splitAt).trimEnd();
    // Only push non-empty parts; hard-split if trimming emptied the chunk
    if (part.length > 0) {
      parts.push(part);
      remaining = remaining.slice(splitAt).trimStart();
    } else {
      parts.push(remaining.slice(0, maxLen));
      remaining = remaining.slice(maxLen);
    }
  }

  if (remaining.length > 0) parts.push(remaining);
  return parts;
}

// ── Sleep with shutdown interruption ─────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    stopController.signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

// ── Ack with retry ────────────────────────────────────────────────────────────

async function ackMessage(
  id: string,
  status: 'delivered' | 'failed',
  error?: string,
): Promise<void> {
  for (let attempt = 0; attempt < ACK_MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(500 * attempt);
    try {
      const res = await busFetch(`/api/v1/messages/${id}/ack`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, ...(error !== undefined && { error }) }),
      });
      if (res.ok) return;
      console.error(
        `[telegram] Ack attempt ${attempt + 1}/${ACK_MAX_RETRIES} failed for ${id}: HTTP ${res.status}`,
      );
    } catch (err) {
      console.error(
        `[telegram] Ack attempt ${attempt + 1}/${ACK_MAX_RETRIES} threw for ${id}: ${String(err)}`,
      );
    }
  }
  console.error(
    `[telegram] All ${ACK_MAX_RETRIES} ack attempts failed for ${id} (status=${status}) — message may be reprocessed`,
  );
}

// ── Inbound long-poll loop ────────────────────────────────────────────────────

let offset = 0;
let inboundBackoffMs = BACKOFF_INITIAL_MS;

async function processUpdate(update: TelegramUpdate): Promise<boolean> {
  const msg = update.message;
  if (!msg || !msg.from) return true; // skip non-message updates

  const senderId = String(msg.from.id);

  if (!allowedSenderIds.has(senderId)) {
    console.log(`[telegram] Dropped message from unknown sender ${senderId}`);
    return true; // still advance offset — message is intentionally dropped
  }

  const body = msg.text ?? msg.caption;
  if (!body) {
    console.log(`[telegram] Skipped non-text update ${update.update_id} from ${senderId}`);
    return true;
  }

  try {
    const res = await busFetch('/api/v1/inbound', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: 'telegram',
        sender: senderId,
        payload: { type: 'text', body },
        metadata: {
          telegram_chat_id: msg.chat.id,
          telegram_message_id: msg.message_id,
        },
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(
        `[telegram] Bus rejected inbound message ${update.update_id}: HTTP ${res.status} — ${text}`,
      );
      return false; // don't advance offset — let Telegram redeliver
    }

    // Drain response body to release the connection
    await res.body?.cancel();
    return true;
  } catch (err) {
    console.error(`[telegram] Failed to POST inbound message ${update.update_id}: ${String(err)}`);
    return false;
  }
}

async function inboundLoop(): Promise<void> {
  console.log(`[telegram] Inbound loop started (poll_timeout=${POLL_TIMEOUT}s)`);

  while (!stopping) {
    try {
      const updates = await callTelegram<TelegramUpdate[]>('getUpdates', {
        offset,
        timeout: POLL_TIMEOUT,
        allowed_updates: ['message'],
      });

      for (const update of updates) {
        const success = await processUpdate(update);
        if (success) {
          offset = update.update_id + 1;
        } else {
          // Stop processing this batch — wait for next poll to retry from current offset
          break;
        }
      }

      inboundBackoffMs = BACKOFF_INITIAL_MS; // reset on success
    } catch (err) {
      console.error(`[telegram] Inbound poll error: ${String(err)}`);
      await sleep(inboundBackoffMs);
      inboundBackoffMs = Math.min(inboundBackoffMs * 2, BACKOFF_MAX_MS);
    }
  }
}

// ── Outbound delivery loop ────────────────────────────────────────────────────

async function deliverMessage(envelope: MessageEnvelope): Promise<void> {
  const contactId = envelope.recipient.startsWith('contact:')
    ? envelope.recipient.slice('contact:'.length)
    : envelope.recipient;

  const chatId = contactChatIdMap.get(contactId);
  if (!chatId) {
    throw new Error(
      `No Telegram chat_id for contact "${contactId}" (recipient="${envelope.recipient}"). ` +
        `Known contacts: [${[...contactChatIdMap.keys()].join(', ')}]`,
    );
  }

  if (envelope.payload.type !== 'text') {
    throw new Error(`Unsupported payload type: ${envelope.payload.type}`);
  }

  const parts = splitMessage(envelope.payload.body);

  // Typing indicator — fire-and-forget, but log failures for observability
  callTelegram('sendChatAction', { chat_id: chatId, action: 'typing' }).catch((err) =>
    console.warn(`[telegram] Typing indicator failed for chat ${chatId}: ${String(err)}`),
  );

  let sentParts = 0;
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) await sleep(200);

    try {
      await callTelegram('sendMessage', {
        chat_id: chatId,
        text: parts[i],
        parse_mode: 'Markdown',
      });
      sentParts++;
    } catch (err: unknown) {
      // Retry without parse_mode if Telegram rejects due to malformed markdown (HTTP 400)
      const status = (err as { status?: number }).status;
      if (status === 400) {
        console.error(
          `[telegram] Markdown parse error for part ${i + 1}/${parts.length}, retrying plain text`,
        );
        await callTelegram('sendMessage', { chat_id: chatId, text: parts[i] });
        sentParts++;
      } else {
        // Enrich error with partial delivery context if some parts already sent
        const prefix =
          sentParts > 0 ? `Partial delivery (${sentParts}/${parts.length} parts sent): ` : '';
        throw Object.assign(new Error(`${prefix}${String(err)}`), {
          sentParts,
          totalParts: parts.length,
        });
      }
    }
  }
}

async function outboundLoop(): Promise<void> {
  if (telegramRecipients.length === 0) {
    console.log('[telegram] No Telegram-enabled contacts found — outbound loop idle');
    return;
  }

  console.log(`[telegram] Outbound loop started — polling for: ${telegramRecipients.join(', ')}`);

  while (!stopping) {
    for (const recipientId of telegramRecipients) {
      try {
        const res = await busFetch(
          `/api/v1/messages/pending?recipient=${encodeURIComponent(recipientId)}&limit=10`,
        );

        if (!res.ok) {
          console.error(`[telegram] Failed to poll outbound messages: HTTP ${res.status}`);
          continue;
        }

        const data = (await res.json()) as {
          ok: boolean;
          messages: MessageEnvelope[];
          count: number;
        };

        for (const envelope of data.messages) {
          try {
            await deliverMessage(envelope);
            await ackMessage(envelope.id, 'delivered');
          } catch (err) {
            console.error(`[telegram] Delivery failed for ${envelope.id}: ${String(err)}`);
            await ackMessage(envelope.id, 'failed', String(err));
          }
        }
      } catch (err) {
        console.error(`[telegram] Outbound poll error for ${recipientId}: ${String(err)}`);
      }
    }

    if (!stopping) await sleep(OUTBOUND_POLL_MS);
  }
}

// ── Loop supervision ──────────────────────────────────────────────────────────

/**
 * Runs `fn` in a supervised loop: if the function throws (rather than catching internally),
 * logs the crash and restarts after a delay, until `stopping` is true.
 */
async function supervise(name: string, fn: () => Promise<void>): Promise<void> {
  while (!stopping) {
    try {
      await fn();
    } catch (err) {
      console.error(`[telegram] ${name} crashed unexpectedly: ${String(err)}`);
      if (!stopping) {
        console.error(`[telegram] Restarting ${name} in ${LOOP_RESTART_DELAY_MS}ms`);
        await sleep(LOOP_RESTART_DELAY_MS);
      }
    }
  }
  console.log(`[telegram] ${name} stopped`);
}

// ── Startup: register slash commands ─────────────────────────────────────────

async function clearWebhook(): Promise<void> {
  try {
    await callTelegram('deleteWebhook', { drop_pending_updates: false });
    console.log('[telegram] Webhook cleared (polling mode active)');
  } catch (err) {
    console.error(`[telegram] Failed to clear webhook: ${String(err)}`);
  }
}

async function registerCommands(): Promise<void> {
  const commands = [
    { command: 'status', description: 'Check AgentBus status' },
    { command: 'help', description: 'Show available commands' },
  ];

  try {
    await callTelegram('setMyCommands', { commands });
    console.log(`[telegram] Registered ${commands.length} slash commands`);
  } catch (err) {
    console.error(`[telegram] Failed to register slash commands: ${String(err)}`);
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────

console.log(
  `[telegram] Adapter starting — bus at ${busBaseUrl}, ` +
    `allowed senders: [${[...allowedSenderIds].join(', ')}]`,
);

await clearWebhook();
await registerCommands();

void supervise('inboundLoop', inboundLoop);
void supervise('outboundLoop', outboundLoop);

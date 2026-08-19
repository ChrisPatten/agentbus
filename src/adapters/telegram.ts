/**
 * Telegram adapter — platform adapter for AgentBus.
 *
 * Runs in-process with bus-core. Implements AdapterInstance so bus-core can
 * register it in the AdapterRegistry and dispatch outbound messages directly.
 *
 * Inbound: long-polls Telegram Bot API, submits messages to the pipeline via
 * the shared processInbound() function (no HTTP hop).
 *
 * Outbound: bus-core's delivery worker calls send(envelope) directly.
 */
import { createWriteStream, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import type { MessageEnvelope } from '../types/envelope.js';
import type {
  AdapterInstance,
  AdapterCapabilities,
  DeliveryResult,
  HealthStatus,
  CommandManifest,
} from '../core/registry.js';
import type { AppConfig } from '../config/schema.js';
import { processInbound, type InboundMessage, type Attachment } from '../http/api.js';
import type { MessageQueue } from '../core/queue.js';
import type { PipelineEngine } from '../pipeline/engine.js';
import type { AdapterRegistry } from '../core/registry.js';
import type { CommandRegistry } from '../commands/registry.js';
import type Database from 'better-sqlite3';
import { extensionFor, resolveMediaConfig } from '../media/attachments.js';
import { topicForThreadKey, isThreadTopic } from '../pipeline/types.js';
import { getThread, upsertThread } from '../pipeline/thread-store.js';

// Re-exported from the shared media module for backwards-compatible imports.
export { extensionFor, resolveMediaConfig };

// ── Constants ─────────────────────────────────────────────────────────────────

const TELEGRAM_API_BASE = 'https://api.telegram.org';
const MAX_MESSAGE_LENGTH = 4096;
const BACKOFF_INITIAL_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
const LOOP_RESTART_DELAY_MS = 5000;

/**
 * Matches the trailing `:group:<chatId>` suffix of a dynamically-derived
 * Telegram group channel (E28), e.g. `telegram:group:-1001234567890`. Chat
 * ids for groups/supergroups are always negative integers.
 */
const GROUP_CHANNEL_SUFFIX_RE = /:group:(-?\d+)$/;

// ── Live tool-call status stream (E29) ───────────────────────────────────────

/** How long to batch tool-call lines before issuing a single editMessageText. */
const DRAFT_BATCH_WINDOW_MS = 1000;
/** Comfortably under Telegram's 4096-char hard limit, leaving overhead margin. */
const DRAFT_MAX_CHARS = 3500;
const DRAFT_TRUNCATION_NOTICE = '… (earlier steps omitted)';

/**
 * Emoji that Telegram's Bot API accepts for sendReaction.
 * Stored without variation selectors (U+FE0F) — that's the form the API expects.
 * Source: https://core.telegram.org/bots/api#reactiontypeemoji
 */
const TELEGRAM_REACTION_EMOJIS = new Set([
  '👍', '👎', '❤', '🔥', '🥰', '👏', '😁', '🤔', '🤯', '😱',
  '🤬', '😢', '🎉', '🤩', '🤮', '💩', '🙏', '👌', '🕊', '🤡',
  '🥱', '🥴', '😍', '🐳', '❤\u200D🔥', '🌚', '🌭', '💯', '🤣', '⚡',
  '🍌', '🏆', '💔', '🤨', '😐', '🍓', '🍾', '💋', '🖕', '😈',
  '😴', '😭', '🤓', '👻', '👨\u200D💻', '👀', '🎃', '🙈', '😇', '😨',
  '🤝', '✍', '🤗', '🫡', '🎅', '🎄', '☃', '💅', '🤪', '🗿',
  '🆒', '💘', '🙉', '🦄', '😘', '💊', '🙊', '😎', '👾',
  '🤷\u200D♂', '🤷', '🤷\u200D♀', '😡',
]);

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

interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

interface TelegramDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

interface TelegramFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  /** Present when this message belongs to a forum topic thread (E28). */
  message_thread_id?: number;
  /** True for a message in a forum topic other than General (E28). */
  is_topic_message?: boolean;
  /** The message this one quote-replies to, if any (E28 — context only, not thread routing). */
  reply_to_message?: { message_id: number; from?: TelegramUser; text?: string; caption?: string };
}

interface TelegramReactionType {
  type: 'emoji' | 'custom_emoji';
  emoji?: string;
  custom_emoji_id?: string;
}

interface TelegramMessageReactionUpdated {
  chat: TelegramChat;
  message_id: number;
  user?: TelegramUser;
  date: number;
  old_reaction: TelegramReactionType[];
  new_reaction: TelegramReactionType[];
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  message_reaction?: TelegramMessageReactionUpdated;
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

/**
 * Per-thread reply metadata stored in the generic `threads` table (E27),
 * mirroring EmailAdapter's EmailThreadMetadata. `chatId` is redundant with
 * the group channel string's own encoding but kept explicit — it's what
 * send() actually needs, without re-parsing the channel every time.
 */
interface TelegramThreadMetadata {
  chatId: number;
  messageThreadId: number;
  /**
   * One-shot context injected by create_telegram_topic, consumed (and
   * cleared) the first time any inbound message lands on this topic — this
   * topic is guaranteed brand new, so that first message is definitionally
   * the first turn of a fresh session, regardless of which contact sends it.
   */
  pendingContext?: string;
}

/** Per-chat state for the live tool-call status stream (E29). */
interface DraftState {
  /** null while the initial sendMessage (draft creation) is in flight. */
  messageId: number | null;
  lines: string[];
  timer: ReturnType<typeof setTimeout> | null;
  /** Resolves when the initial sendMessage settles — send() awaits this to
   * close the race where final delivery arrives before the draft exists. */
  creating: Promise<void> | null;
}

// ── Dependencies for inbound pipeline processing ─────────────────────────────

export interface TelegramAdapterDeps {
  config: AppConfig;
  queue: MessageQueue;
  pipeline: PipelineEngine;
  db: Database.Database;
  registry?: AdapterRegistry;
  commandRegistry?: CommandRegistry;
  pauseSet?: Set<string>;
  /**
   * Instance name used as the adapter id suffix (e.g. "peggy" → id "telegram:peggy").
   * Omit for the legacy single-bot form (id stays "telegram").
   */
  instanceName?: string;
  /**
   * Pre-resolved per-instance config from getTelegramInstances().
   * When provided, the constructor uses this instead of reading from config.adapters.telegram.
   */
  instanceConfig?: { token: string; poll_timeout: number; plugin?: string };
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

/**
 * Build the visible text for a tool-call trail (E29), dropping the oldest
 * whole lines (never mid-line) until it fits `maxChars`, prefixing a
 * truncation notice when anything was dropped.
 */
export function buildDraftTrail(lines: string[], maxChars: number = DRAFT_MAX_CHARS): { text: string; truncated: boolean } {
  if (lines.length === 0) return { text: '', truncated: false };

  const kept = [...lines];
  let truncated = false;
  const render = (): string => (truncated ? `${DRAFT_TRUNCATION_NOTICE}\n${kept.join('\n')}` : kept.join('\n'));

  while (kept.length > 1 && render().length > maxChars) {
    kept.shift();
    truncated = true;
  }

  let text = render();
  // Defensive last resort: formatToolCallSummary bounds individual fields, so
  // a single line should never alone exceed maxChars — but never exceed the
  // budget regardless.
  if (text.length > maxChars) text = `${text.slice(0, maxChars - 1)}…`;
  return { text, truncated };
}

// ── Image attachment helpers (E17) ───────────────────────────────────────────

/** Pick the highest-resolution entry from a Telegram photo array. */
export function pickLargestPhoto(photos: [TelegramPhotoSize, ...TelegramPhotoSize[]]): TelegramPhotoSize {
  // Telegram conventionally returns photos in ascending size order; we still
  // choose the max by file_size/width to be safe against API changes.
  let best = photos[0];
  for (const p of photos) {
    const bestSize = best.file_size ?? best.width * best.height;
    const thisSize = p.file_size ?? p.width * p.height;
    if (thisSize > bestSize) best = p;
  }
  return best;
}

// ── TelegramAdapter class ────────────────────────────────────────────────────

export class TelegramAdapter implements AdapterInstance {
  readonly id: string;
  readonly name: string;
  readonly capabilities: AdapterCapabilities;

  private readonly token: string;
  private readonly pollTimeout: number;
  private readonly deps: TelegramAdapterDeps;
  /** Log tag derived from id, e.g. "[telegram]" or "[telegram:peggy]". */
  private readonly tag: string;

  /** Set of Telegram user IDs (as strings) that are allowed to send messages. */
  private readonly allowedSenderIds = new Set<string>();
  /** Map from contact id (e.g. "chris") to their Telegram chat ID. */
  private readonly contactChatIdMap = new Map<string, number>();

  private stopping = false;
  private stopController = new AbortController();
  private offset = 0;
  private inboundBackoffMs = BACKOFF_INITIAL_MS;
  private lastActivity: string | null = null;
  private consecutiveFailures = 0;
  /** Per-(chat, topic) typing indicator loops. Key is draftKey(chatId, messageThreadId) — a
   * forum topic's loop must not collide with another topic in the same group (E28). */
  private readonly typingLoops = new Map<string, AbortController>();
  /** Per-(chat, topic) live tool-call status draft messages (E29/E28). Key is draftKey(chatId, messageThreadId). */
  private readonly draftMessages = new Map<string, DraftState>();
  /** This bot's own Telegram user id, cached from getMe() at start() (E28 — admin-rights check for createTopic). Null if getMe failed. */
  private botUserId: number | null = null;

  constructor(deps: TelegramAdapterDeps) {
    this.id = deps.instanceName ? `telegram:${deps.instanceName}` : 'telegram';
    this.name = this.id;
    this.tag = `[${this.id}]`;
    this.capabilities = {
      send: true,
      react: true,
      markRead: false,
      typing: true,
      toolStatus: true,
      registerCommands: true,
      channels: [this.id],
    };

    // Resolve per-instance config. instanceConfig is always provided by
    // getTelegramInstances(); the fallback supports legacy direct construction.
    let resolvedToken: string;
    let resolvedPollTimeout: number;

    if (deps.instanceConfig) {
      resolvedToken = deps.instanceConfig.token;
      resolvedPollTimeout = deps.instanceConfig.poll_timeout;
    } else {
      const t = deps.config.adapters.telegram;
      if (!t || typeof (t as { token?: unknown }).token !== 'string') {
        throw new Error(`No Telegram config found for adapter "${this.id}"`);
      }
      const singleBot = t as { token: string; poll_timeout: number };
      resolvedToken = singleBot.token;
      resolvedPollTimeout = singleBot.poll_timeout;
    }

    this.token = resolvedToken;
    this.pollTimeout = resolvedPollTimeout;
    this.deps = deps;

    // Build contact lookup maps from config
    for (const contact of Object.values(deps.config.contacts)) {
      if (contact.platforms.telegram) {
        const userId = contact.platforms.telegram.userId;
        if (!Number.isInteger(userId) || userId <= 0) {
          throw new Error(
            `Invalid Telegram userId ${userId} for contact "${contact.id}" — must be a positive integer`,
          );
        }
        this.allowedSenderIds.add(String(userId));
        this.contactChatIdMap.set(contact.id, userId);
      }
    }
  }

  // ── Group channel identity (E28) ──────────────────────────────────────────

  /**
   * True for this bot's own DM channel id, or any of its dynamically-derived
   * group channels (`${this.id}:group:<chatId>`) — computed per-message in
   * processUpdate, never statically registered. Lets the registry's channel
   * lookups (outbound delivery, react_to_message, slash-command replies,
   * pause checks, the typing/tool-status HTTP endpoints) resolve this
   * instance for a group channel exactly as they already do for the DM one.
   */
  ownsChannel(channel: string): boolean {
    return channel === this.id || channel.startsWith(`${this.id}:group:`);
  }

  /**
   * Parse the group chat_id back out of a dynamically-derived group channel
   * (e.g. "telegram:group:-100123" -> -100123). Null for this bot's DM
   * channel or any unrelated channel string.
   */
  private parseGroupChatId(channel: string): number | null {
    if (!channel.startsWith(`${this.id}:group:`)) return null;
    const match = channel.match(GROUP_CHANNEL_SUFFIX_RE);
    return match ? Number(match[1]) : null;
  }

  /**
   * Resolve the chat to target for a contact-scoped, fire-and-forget action
   * (typing indicator, live tool-call status, /stop finalization) — `channel`
   * disambiguates a group from the contact's own DM (E28); omitted, or a DM
   * channel, falls back to the contact's DM chat exactly as before E28.
   */
  private resolveChatId(contactId: string, channel?: string): number | undefined {
    if (channel) {
      const groupChatId = this.parseGroupChatId(channel);
      if (groupChatId !== null) return groupChatId;
    }
    const id = contactId.startsWith('contact:') ? contactId.slice('contact:'.length) : contactId;
    return this.contactChatIdMap.get(id);
  }

  /**
   * Resolve both the chat *and* the forum topic (if any) to target for a
   * contact-scoped, fire-and-forget action — so the typing indicator and live
   * tool-call status stream land in the specific topic being discussed, not
   * just the right group (E28). `topic` is looked up against the generic
   * thread store (E27) exactly as resolveSendTarget does for a real send.
   */
  private resolveChatAndTopic(
    contactId: string,
    channel?: string,
    topic?: string,
  ): { chatId: number; messageThreadId?: number } | undefined {
    const chatId = this.resolveChatId(contactId, channel);
    if (!chatId) return undefined;
    if (channel && topic && isThreadTopic(topic)) {
      const thread = getThread<TelegramThreadMetadata>(this.deps.db, channel, topic);
      if (thread) return { chatId, messageThreadId: thread.metadata.messageThreadId };
    }
    return { chatId };
  }

  /**
   * Composite key for per-(chat, topic) ephemeral state (typing loops, live
   * tool-call status drafts) — a forum topic's state must not collide with
   * another topic in the same group (E28).
   */
  private draftKey(chatId: number, messageThreadId?: number): string {
    return `${chatId}:${messageThreadId ?? 'general'}`;
  }

  // ── AdapterInstance lifecycle ─────────────────────────────────────────────

  async start(): Promise<void> {
    console.log(
      `${this.tag} Adapter starting — allowed senders: [${[...this.allowedSenderIds].join(', ')}]`,
    );

    await this.clearWebhook();
    // Command registration is deferred to bus-core startup after all commands
    // are registered — bus-core calls adapter.registerCommands(manifests).

    // Cache this bot's own user id for createTopic's admin-rights check (E28).
    // Non-fatal: a failure here just means createTopic fails closed later with
    // a clear error, not that startup itself fails.
    try {
      const me = await this.callTelegram<{ id: number }>('getMe');
      this.botUserId = me.id;
    } catch (err) {
      console.warn(`${this.tag} getMe failed, create_telegram_topic will be unavailable: ${String(err)}`);
    }

    // Launch inbound loop in background (supervised)
    void this.supervise('inboundLoop', () => this.inboundLoop());

    console.log(`${this.tag} Adapter started`);
  }

  async stop(): Promise<void> {
    console.log(`${this.tag} Stopping`);
    this.stopping = true;
    for (const controller of this.typingLoops.values()) controller.abort();
    this.typingLoops.clear();
    for (const state of this.draftMessages.values()) {
      if (state.timer) clearTimeout(state.timer);
    }
    this.draftMessages.clear();
    this.stopController.abort();
  }

  async health(): Promise<HealthStatus> {
    if (this.consecutiveFailures >= 10) {
      return {
        status: 'unhealthy',
        lastActivity: this.lastActivity ?? undefined,
        details: { consecutiveFailures: this.consecutiveFailures },
      };
    }
    if (this.consecutiveFailures >= 3) {
      return {
        status: 'degraded',
        lastActivity: this.lastActivity ?? undefined,
        details: { consecutiveFailures: this.consecutiveFailures },
      };
    }
    return {
      status: 'healthy',
      lastActivity: this.lastActivity ?? undefined,
    };
  }

  // ── AdapterInstance send ──────────────────────────────────────────────────

  /**
   * Sends (`sendMessage`) or edits (`editMessageText`, when `editMessageId`
   * is given) with the same Markdown-then-plain-text-on-400 retry either way.
   * Returns the resulting message_id (the edit target itself, for edits).
   * `extraParams` (e.g. `message_thread_id`, `reply_parameters`) is only
   * meaningful on a fresh send — an edit already targets an existing message
   * whose thread/reply is fixed, so it's ignored when `editMessageId` is set.
   */
  private async deliverText(
    chatId: number,
    text: string,
    editMessageId?: number,
    extraParams?: Record<string, unknown>,
  ): Promise<number> {
    const method = editMessageId ? 'editMessageText' : 'sendMessage';
    const params: Record<string, unknown> = editMessageId
      ? { chat_id: chatId, message_id: editMessageId, text }
      : { chat_id: chatId, text, ...extraParams };

    try {
      const result = await this.callTelegram<TelegramMessage>(method, { ...params, parse_mode: 'Markdown' });
      return editMessageId ?? result.message_id;
    } catch (err: unknown) {
      // Retry without parse_mode if Telegram rejects due to malformed markdown (HTTP 400)
      if ((err as { status?: number }).status === 400) {
        console.error(`${this.tag} Markdown parse error for ${method}, retrying plain text`);
        const result = await this.callTelegram<TelegramMessage>(method, params);
        return editMessageId ?? result.message_id;
      }
      throw err;
    }
  }

  /**
   * Resolve where an outbound envelope should land: a `thread:`-prefixed
   * topic resolves chat_id/message_thread_id from E27's generic thread store
   * (a Telegram forum topic, E28); a group channel with no thread topic (i.e.
   * "General") resolves chat_id from the channel string itself; anything else
   * (a DM) resolves from `contactChatIdMap`, exactly as before E28.
   */
  private resolveSendTarget(
    envelope: MessageEnvelope,
  ): { chatId: number; messageThreadId?: number } | { error: string } {
    if (isThreadTopic(envelope.topic)) {
      const thread = getThread<TelegramThreadMetadata>(this.deps.db, envelope.channel, envelope.topic);
      if (!thread) {
        return {
          error: `No thread metadata for topic "${envelope.topic}" on channel "${envelope.channel}"`,
        };
      }
      return { chatId: thread.metadata.chatId, messageThreadId: thread.metadata.messageThreadId };
    }

    const groupChatId = this.parseGroupChatId(envelope.channel);
    if (groupChatId !== null) {
      return { chatId: groupChatId };
    }

    const contactId = envelope.recipient.startsWith('contact:')
      ? envelope.recipient.slice('contact:'.length)
      : envelope.recipient;
    const chatId = this.contactChatIdMap.get(contactId);
    if (!chatId) {
      return {
        error:
          `No Telegram chat_id for contact "${contactId}" (recipient="${envelope.recipient}"). ` +
          `Known contacts: [${[...this.contactChatIdMap.keys()].join(', ')}]`,
      };
    }
    return { chatId };
  }

  async send(envelope: MessageEnvelope): Promise<DeliveryResult> {
    const target = this.resolveSendTarget(envelope);
    if ('error' in target) {
      return { success: false, error: target.error, retryable: false };
    }
    const { chatId, messageThreadId } = target;
    const extraParams = messageThreadId ? { message_thread_id: messageThreadId } : undefined;

    // Native reply quote (E28): reply_to_platform_message_id is "chatId:messageId",
    // the same encoding processUpdate uses for platform_message_id everywhere else.
    // Only applied when the resolved chat matches — a stale reply target from a
    // different chat/topic must never leak across, and allow_sending_without_reply
    // means a since-deleted target message never blocks delivery.
    let replyParams: { reply_parameters: { message_id: number; allow_sending_without_reply: true } } | undefined;
    const rawReplyTarget = envelope.metadata['reply_to_platform_message_id'];
    if (typeof rawReplyTarget === 'string') {
      const colonIdx = rawReplyTarget.indexOf(':');
      if (colonIdx !== -1) {
        const replyChatId = parseInt(rawReplyTarget.slice(0, colonIdx), 10);
        const replyMessageId = parseInt(rawReplyTarget.slice(colonIdx + 1), 10);
        if (!isNaN(replyChatId) && !isNaN(replyMessageId) && replyChatId === chatId) {
          replyParams = { reply_parameters: { message_id: replyMessageId, allow_sending_without_reply: true } };
        }
      }
    }

    if (envelope.payload.type !== 'text') {
      return {
        success: false,
        error: `Unsupported payload type: ${envelope.payload.type}`,
        retryable: false,
      };
    }

    const parts = splitMessage(envelope.payload.body);
    const key = this.draftKey(chatId, messageThreadId);

    // Stop the persistent typing loop for this chat/topic now that we're delivering
    this.stopTypingIndicator(chatId, messageThreadId);

    // Overwrite-on-delivery (E29): a pending tool-call trail for this chat/topic
    // is torn down unconditionally below — success or fallback — so it never
    // leaks across turns. When the draft's own creation is still in flight,
    // wait for it so a very-fast turn can't leave two messages behind.
    const draft = this.draftMessages.get(key);
    if (draft?.timer) clearTimeout(draft.timer);
    this.draftMessages.delete(key);

    let sentParts = 0;
    let platformMessageId: string | undefined;
    let firstPartHandled = false;

    if (draft) {
      if (draft.creating) await draft.creating.catch(() => {});
      if (draft.messageId !== null) {
        try {
          const messageId = await this.deliverText(chatId, parts[0]!, draft.messageId);
          sentParts = 1;
          platformMessageId = String(messageId);
          firstPartHandled = true;
        } catch (err) {
          console.warn(
            `${this.tag} Draft overwrite failed for chat ${chatId}, falling back to sendMessage: ${String(err)}`,
          );
        }
      }
    }

    const startIndex = firstPartHandled ? 1 : 0;
    for (let i = startIndex; i < parts.length; i++) {
      if (i > 0) await this.sleep(200);

      // The reply quote only makes sense on the first freshly-sent part — a
      // multi-part answer's later parts are continuations, not replies.
      const partParams = i === startIndex ? { ...extraParams, ...replyParams } : extraParams;

      try {
        const messageId = await this.deliverText(chatId, parts[i]!, undefined, partParams);
        sentParts++;
        if (i === parts.length - 1) {
          platformMessageId = String(messageId);
        }
      } catch (err) {
        const prefix = sentParts > 0 ? `Partial delivery (${sentParts}/${parts.length} parts sent): ` : '';
        return {
          success: false,
          error: `${prefix}${String(err)}`,
          retryable: true,
        };
      }
    }

    this.lastActivity = new Date().toISOString();
    return { success: true, platformMessageId };
  }

  // ── AdapterInstance createTopic (E28) ─────────────────────────────────────

  /**
   * Create a new forum topic in a Telegram group. Group-only — DM Threaded
   * Mode is retired, so this always rejects a DM channel. Requires this bot
   * to have "Manage Topics" admin rights in the target group; verified via
   * getChatMember before calling createForumTopic, so a missing right
   * surfaces a clear, actionable error instead of an opaque Telegram API
   * rejection. On success, upserts the thread row immediately (E27's generic
   * thread store) so send() can resolve it before any inbound message ever
   * arrives on the new topic.
   *
   * The topic always starts a brand-new session — a forum topic's
   * message_thread_id is freshly issued by Telegram, so the `thread:<hash>`
   * topic (and therefore conversation_id) it hashes into has never existed
   * before; there is no prior history to inherit. `context`, when given, is
   * stashed on the thread row and injected into the agent's *first* turn on
   * this topic only (one-shot, consumed and cleared the moment any message
   * lands on it — see `processUpdate`), rather than a real conversation turn.
   */
  async createTopic(
    channel: string,
    name: string,
    context?: string,
  ): Promise<{ ok: true; topic: string; message_thread_id: number; name: string } | { ok: false; error: string }> {
    const chatId = this.parseGroupChatId(channel);
    if (chatId === null) {
      return {
        ok: false,
        error: `create_telegram_topic is group-only; "${channel}" is not a Telegram group channel (DM Threaded Mode is retired)`,
      };
    }

    if (this.botUserId === null) {
      return {
        ok: false,
        error: `Could not determine this bot's own Telegram user id (getMe failed at startup) — cannot verify admin rights`,
      };
    }

    try {
      const member = await this.callTelegram<{ status: string; can_manage_topics?: boolean }>('getChatMember', {
        chat_id: chatId,
        user_id: this.botUserId,
      });
      if (!member.can_manage_topics) {
        return {
          ok: false,
          error:
            'This bot lacks "Manage Topics" admin rights in this group. In Telegram: open the group, ' +
            'go to the member list, select this bot, "Edit Admin Rights", and enable "Manage Topics".',
        };
      }
    } catch (err) {
      return { ok: false, error: `Failed to verify admin rights: ${String(err)}` };
    }

    let created: { message_thread_id: number; name: string };
    try {
      created = await this.callTelegram<{ message_thread_id: number; name: string }>('createForumTopic', {
        chat_id: chatId,
        name,
      });
    } catch (err) {
      return { ok: false, error: `Failed to create forum topic: ${String(err)}` };
    }

    const threadKey = `${chatId}:${created.message_thread_id}`;
    const topic = topicForThreadKey(threadKey);
    upsertThread<TelegramThreadMetadata>(this.deps.db, {
      channel,
      topic,
      threadKey,
      metadata: {
        chatId,
        messageThreadId: created.message_thread_id,
        ...(context ? { pendingContext: context } : {}),
      },
    });

    return { ok: true, topic, message_thread_id: created.message_thread_id, name: created.name };
  }

  // ── AdapterInstance react ─────────────────────────────────────────────────

  async react(platformMessageId: string, reaction: string): Promise<void> {
    // platform_message_id is encoded as "{chatId}:{messageId}" by processUpdate()
    const colonIdx = platformMessageId.indexOf(':');
    if (colonIdx === -1) {
      throw new Error(`Invalid Telegram platform_message_id "${platformMessageId}" — expected "chatId:messageId"`);
    }
    const chatId = parseInt(platformMessageId.slice(0, colonIdx), 10);
    const messageId = parseInt(platformMessageId.slice(colonIdx + 1), 10);
    if (isNaN(chatId) || isNaN(messageId)) {
      throw new Error(`Invalid Telegram platform_message_id "${platformMessageId}" — could not parse chat or message ID`);
    }

    // Telegram requires emoji without variation selectors (U+FE0F)
    const normalized = reaction.replace(/\uFE0F/g, '');

    if (!TELEGRAM_REACTION_EMOJIS.has(normalized)) {
      // Unsupported reaction — send as a text message instead
      console.log(`${this.tag} "${reaction}" is not a supported Telegram reaction; sending as text`);
      await this.callTelegram('sendMessage', {
        chat_id: chatId,
        text: reaction,
      });
      return;
    }

    await this.callTelegram('setMessageReaction', {
      chat_id: chatId,
      message_id: messageId,
      reaction: [{ type: 'emoji', emoji: normalized }],
    });
  }

  // ── AdapterInstance startTyping ───────────────────────────────────────────

  /**
   * Called by bus-core when the CC adapter confirms a message has been
   * delivered to the agent. Starts the persistent typing loop for the
   * contact's chat so the indicator appears while the agent works.
   */
  startTyping(contactId: string, channel?: string, topic?: string): void {
    const resolved = this.resolveChatAndTopic(contactId, channel, topic);
    if (resolved) {
      this.startTypingIndicator(resolved.chatId, resolved.messageThreadId);
    } else {
      console.warn(`${this.tag} startTyping: no chat_id for contact "${contactId}"`);
    }
  }

  // ── Typing indicator ──────────────────────────────────────────────────────

  /**
   * Start a persistent typing indicator loop for `chatId` (and forum topic
   * `messageThreadId`, if any — E28). Resends `sendChatAction('typing')`
   * every 4 seconds so the indicator stays visible while the agent processes
   * the message. Auto-stops after 2 minutes as a safety valve. Idempotent —
   * calling while a loop is already running for this (chat, topic) is a no-op.
   */
  private startTypingIndicator(chatId: number, messageThreadId?: number): void {
    const key = this.draftKey(chatId, messageThreadId);
    if (this.typingLoops.has(key)) return;

    const controller = new AbortController();
    this.typingLoops.set(key, controller);

    void (async () => {
      const deadline = Date.now() + 120_000;
      while (!controller.signal.aborted && !this.stopping && Date.now() < deadline) {
        this.callTelegram('sendChatAction', {
          chat_id: chatId,
          action: 'typing',
          ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
        }).catch((err) => console.warn(`${this.tag} Typing indicator failed for chat ${chatId}: ${String(err)}`));
        await this.sleep(4000);
      }
      this.typingLoops.delete(key);
    })();
  }

  /** Stop the typing indicator loop for (`chatId`, `messageThreadId`), if one is running. */
  private stopTypingIndicator(chatId: number, messageThreadId?: number): void {
    const key = this.draftKey(chatId, messageThreadId);
    const controller = this.typingLoops.get(key);
    if (controller) {
      controller.abort();
      this.typingLoops.delete(key);
    }
  }

  // ── AdapterInstance reportToolCall (E29) ──────────────────────────────────

  /**
   * Called by bus-core once per non-delivery tool call during an in-flight
   * turn. Appends `text` as a line to a single evolving Telegram message for
   * the contact's chat, batching edits to ~1/sec (see appendToolCallLine).
   */
  reportToolCall(contactId: string, text: string, channel?: string, topic?: string): void {
    const resolved = this.resolveChatAndTopic(contactId, channel, topic);
    if (resolved) {
      this.appendToolCallLine(resolved.chatId, text, resolved.messageThreadId);
    } else {
      console.warn(`${this.tag} reportToolCall: no chat_id for contact "${contactId}"`);
    }
  }

  /**
   * Append a tool-call line for (`chatId`, `messageThreadId`). The map
   * check-and-reserve is synchronous (no `await` in between) so two calls
   * arriving before the first `sendMessage` resolves can never both see "no
   * draft" and both create one.
   */
  private appendToolCallLine(chatId: number, line: string, messageThreadId?: number): void {
    const key = this.draftKey(chatId, messageThreadId);
    const state = this.draftMessages.get(key);
    if (state) {
      state.lines.push(line);
      if (state.messageId !== null) this.scheduleDraftFlush(chatId, key, state);
      // else: creation still in flight — createDraftMessage's post-await
      // check picks up this line once the initial send resolves.
      return;
    }

    const fresh: DraftState = { messageId: null, lines: [line], timer: null, creating: null };
    this.draftMessages.set(key, fresh);
    fresh.creating = this.createDraftMessage(chatId, key, fresh, messageThreadId);
  }

  /**
   * Sends the first line as a new message (into forum topic `messageThreadId`,
   * if any — E28) and records its message_id.
   */
  private async createDraftMessage(
    chatId: number,
    key: string,
    state: DraftState,
    messageThreadId?: number,
  ): Promise<void> {
    try {
      const messageId = await this.deliverText(
        chatId,
        state.lines[0]!,
        undefined,
        messageThreadId ? { message_thread_id: messageThreadId } : undefined,
      );
      state.messageId = messageId;
      if (state.lines.length > 1) {
        // More lines arrived while the create was in flight — the sent
        // message only shows lines[0]; flush now to catch it up.
        this.scheduleDraftFlush(chatId, key, state);
      }
    } catch (err) {
      console.warn(`${this.tag} Failed to create draft message for chat ${chatId}: ${String(err)}`);
      // Nothing to track — the next tool call starts a fresh draft.
      if (this.draftMessages.get(key) === state) this.draftMessages.delete(key);
    } finally {
      state.creating = null;
    }
  }

  /** Arms a batching timer for `key` if one isn't already pending. Anchored
   * on the first pending line (not a rolling debounce) so constant tool-call
   * traffic can never defer a flush forever. */
  private scheduleDraftFlush(chatId: number, key: string, state: DraftState): void {
    if (state.timer) return;
    state.timer = setTimeout(() => {
      state.timer = null;
      void this.flushDraft(chatId, key);
    }, DRAFT_BATCH_WINDOW_MS);
  }

  /** Edits the draft message with the current (possibly truncated) trail. */
  private async flushDraft(chatId: number, key: string): Promise<void> {
    const state = this.draftMessages.get(key);
    if (!state || state.messageId === null) return; // cleared/overwritten mid-flight
    const { text } = buildDraftTrail(state.lines);
    try {
      await this.deliverText(chatId, text, state.messageId);
    } catch (err) {
      // Leave state as-is — the next scheduled flush retries with the fuller
      // trail; if delivery happens first, overwrite-on-delivery still lands.
      console.warn(`${this.tag} Draft edit failed for chat ${chatId}: ${String(err)}`);
    }
  }

  // ── AdapterInstance finalizeDraft (/stop) ─────────────────────────────────

  /**
   * Called when `/stop` cancels a contact's in-flight turn. Appends `note` as
   * a final line to the contact's open draft (if any) and stops treating it
   * as a draft — no future tool call or delivery will edit it again, so it
   * persists in the conversation exactly as left. Returns false (no-op) if no
   * draft is currently open — the caller knows `note` never reached the user
   * and should fall back to its own confirmation message.
   */
  finalizeDraft(contactId: string, note: string, channel?: string, topic?: string): boolean {
    const resolved = this.resolveChatAndTopic(contactId, channel, topic);
    if (!resolved) return false;
    const { chatId, messageThreadId } = resolved;

    // /stop is a hard stop — the typing indicator must not keep blinking for
    // up to its 2-minute safety timeout after the turn has already been
    // killed, whether or not a draft was open to finalize.
    this.stopTypingIndicator(chatId, messageThreadId);

    const key = this.draftKey(chatId, messageThreadId);
    const state = this.draftMessages.get(key);
    if (!state) return false;

    // Reserve immediately — a tool call arriving after this point must start
    // a brand-new draft rather than touch the one being finalized.
    if (state.timer) clearTimeout(state.timer);
    this.draftMessages.delete(key);
    state.lines.push(note);

    void (async () => {
      if (state.creating) await state.creating.catch(() => {});
      if (state.messageId === null) return; // draft never actually got created
      const { text } = buildDraftTrail(state.lines);
      try {
        await this.deliverText(chatId, text, state.messageId);
      } catch (err) {
        console.warn(`${this.tag} Failed to finalize draft for chat ${chatId}: ${String(err)}`);
      }
    })();

    return true;
  }

  // ── Telegram API helper ──────────────────────────────────────────────────

  private async callTelegram<T>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    const res = await fetch(`${TELEGRAM_API_BASE}/bot${this.token}/${method}`, {
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

  // ── Image download (E17) ──────────────────────────────────────────────────

  /**
   * Identify whether an inbound Telegram message carries an image we should
   * download. Returns the raw {file_id, mime, filename} triple, or null.
   *
   * We handle two shapes:
   *   - `photo[]`  — Telegram's compressed photo (pick the largest size)
   *   - `document` — any file; `kind` is 'image' for image/* MIME types, 'file' otherwise
   */
  private extractAttachmentSource(
    msg: TelegramMessage,
  ): { file_id: string; mime_type?: string; original_filename?: string; kind: 'image' | 'file' } | null {
    if (msg.photo && msg.photo.length > 0) {
      const largest = pickLargestPhoto(msg.photo as [TelegramPhotoSize, ...TelegramPhotoSize[]]);
      return { file_id: largest.file_id, mime_type: 'image/jpeg', kind: 'image' };
    }
    if (msg.document) {
      return {
        file_id: msg.document.file_id,
        mime_type: msg.document.mime_type,
        original_filename: msg.document.file_name,
        kind: msg.document.mime_type?.startsWith('image/') ? 'image' : 'file',
      };
    }
    return null;
  }

  /**
   * Resolve media config, download the file, and insert the DB row.
   * Returns the populated attachments list on success, an empty array if no
   * media config is set for the target agent, or an empty array on download
   * failure (error logged). Never throws — the inbound message is always
   * delivered, with or without the attachment.
   */
  private async maybeDownloadAttachment(source: {
    file_id: string;
    mime_type?: string;
    original_filename?: string;
    kind: 'image' | 'file';
  }): Promise<Attachment[]> {
    const media = resolveMediaConfig(this.deps.config, this.id);
    if (!media) {
      console.warn(
        `${this.tag} Received an attachment but no agent with media config is routed from channel "${this.id}" — skipping download`,
      );
      return [];
    }

    let localPath: string | undefined;
    try {
      localPath = await this.downloadFile(
        source.file_id,
        media.download_path,
        source.mime_type,
        source.original_filename,
      );

      const now = Date.now();
      this.deps.db
        .prepare(
          `INSERT INTO attachments (id, agent_id, local_path, original_filename, mime_type, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          media.agentId,
          localPath,
          source.original_filename ?? null,
          source.mime_type ?? null,
          now,
          now + media.ttl_seconds * 1000,
        );

      const att: Attachment = { type: source.kind, local_path: localPath };
      if (source.mime_type) att.mime_type = source.mime_type;
      if (source.original_filename) att.original_filename = source.original_filename;
      return [att];
    } catch (err) {
      console.error(`${this.tag} Attachment download failed: ${String(err)}`);
      if (localPath) {
        try { unlinkSync(localPath); } catch {}
      }
      return [];
    }
  }

  /**
   * Download a Telegram file by `file_id` to `<downloadDir>/<uuid><ext>`.
   * Returns the absolute local path on success. Caller is responsible for
   * catching failures and deciding whether to proceed without the attachment.
   */
  private async downloadFile(
    file_id: string,
    downloadDir: string,
    mime?: string,
    filename?: string,
  ): Promise<string> {
    const file = await this.callTelegram<TelegramFile>('getFile', { file_id });
    if (!file.file_path) {
      throw new Error(`Telegram getFile returned no file_path for ${file_id}`);
    }

    const url = `${TELEGRAM_API_BASE}/file/bot${this.token}/${file.file_path}`;
    const res = await fetch(url);
    if (!res.ok || !res.body) {
      throw new Error(`Telegram file download failed: HTTP ${res.status}`);
    }

    const ext = extensionFor(mime, filename ?? file.file_path);
    const destPath = join(downloadDir, `${randomUUID()}${ext}`);
    try {
      // Two-step cast via unknown: Node's Readable.fromWeb expects its own
      // internal ReadableStream type, not the DOM ReadableStream that fetch returns.
      await streamPipeline(Readable.fromWeb(res.body as unknown as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(destPath));
    } catch (err) {
      try { unlinkSync(destPath); } catch {}
      throw err;
    }
    return destPath;
  }

  // ── Sleep with shutdown interruption ──────────────────────────────────────

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.stopController.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }

  // ── Inbound long-poll loop ────────────────────────────────────────────────

  private async processReactionUpdate(reaction: TelegramMessageReactionUpdated): Promise<boolean> {
    const userId = reaction.user?.id;
    if (!userId) return true; // anonymous admin reactions — skip

    const senderId = String(userId);
    if (!this.allowedSenderIds.has(senderId)) {
      console.log(`${this.tag} Dropped reaction from unknown sender ${senderId}`);
      return true;
    }

    // Compute net emoji: prefer newly added, fall back to removed.
    const oldEmojis = reaction.old_reaction
      .filter((r) => r.type === 'emoji' && r.emoji)
      .map((r) => r.emoji!);
    const newEmojis = reaction.new_reaction
      .filter((r) => r.type === 'emoji' && r.emoji)
      .map((r) => r.emoji!);

    const added = newEmojis.filter((e) => !oldEmojis.includes(e));
    const removed = oldEmojis.filter((e) => !newEmojis.includes(e));

    // Skip custom-emoji-only changes and no-op updates.
    const emoji = added[0] ?? removed[0];
    if (!emoji) return true;

    const isRemoved = added.length === 0;

    // Same DM-vs-group channel derivation as processUpdate (E28) — a reaction
    // in a group is part of that group's conversation, not the reactor's DM.
    const channel = reaction.chat.type === 'private' ? this.id : `${this.id}:group:${reaction.chat.id}`;

    try {
      const message: InboundMessage = {
        channel,
        sender: senderId,
        payload: {
          type: 'reaction',
          emoji,
          removed: isRemoved,
          target_message_id: `${reaction.chat.id}:${reaction.message_id}`,
        },
        metadata: {
          telegram_chat_id: reaction.chat.id,
          telegram_message_id: reaction.message_id,
          platform_message_id: `${reaction.chat.id}:${reaction.message_id}`,
        },
      };

      await processInbound(message, this.deps);
      this.lastActivity = new Date().toISOString();
      return true;
    } catch (err) {
      console.error(`${this.tag} Failed to process reaction from ${senderId}: ${String(err)}`);
      return false;
    }
  }

  private async processUpdate(update: TelegramUpdate): Promise<boolean> {
    if (process.env.TELEGRAM_DEBUG_PAYLOADS) {
      console.log(`${this.tag} [DEBUG] raw update ${update.update_id}:\n${JSON.stringify(update, null, 2)}`);
      return true; // skip pipeline in debug mode so test messages don't reach agents
    }

    if (update.message_reaction) {
      return this.processReactionUpdate(update.message_reaction);
    }

    const msg = update.message;
    if (!msg || !msg.from) return true; // skip non-message updates

    const senderId = String(msg.from.id);

    if (!this.allowedSenderIds.has(senderId)) {
      console.log(`${this.tag} Dropped message from unknown sender ${senderId}`);
      return true;
    }

    // A DM keeps today's channel (this.id) unchanged. A group/supergroup gets
    // its own channel, distinct from any contact's DM, derived per-message —
    // no static per-group config (E28). See ownsChannel() for how the
    // registry's channel lookups recognize this dynamically-derived id.
    const channel = msg.chat.type === 'private' ? this.id : `${this.id}:group:${msg.chat.id}`;

    // Detect an inbound image or file attachment.
    const attachmentSource = this.extractAttachmentSource(msg);

    const body = msg.text ?? msg.caption ?? '';
    if (!body && !attachmentSource) {
      console.log(`${this.tag} Skipped non-text update ${update.update_id} from ${senderId}`);
      return true;
    }

    const attachments = attachmentSource
      ? await this.maybeDownloadAttachment(attachmentSource)
      : undefined;

    // If an attachment was detected but download failed or media isn't configured,
    // use a fallback body so the message still reaches the agent.
    const fallback = attachmentSource?.kind === 'file' ? '[File]' : '[Image]';
    const effectiveBody = body || (attachmentSource && (!attachments || attachments.length === 0) ? fallback : '');

    // Forum topic → its own long-lived session, on E27's generic thread store
    // (E28). No message_thread_id (posted in "General") gets no thread row —
    // its own session falls out of the group channel alone, same as a DM's
    // main conversation needs no thread row either. Deliberately placed after
    // the skip-check above: a skipped update (no text/attachment, e.g. a
    // sticker) must never consume create_telegram_topic's one-shot
    // pendingContext before a real message actually reaches the agent.
    let topic: string | undefined;
    let injectedTopicContext: string | undefined;
    if (msg.is_topic_message && msg.message_thread_id) {
      const threadKey = `${msg.chat.id}:${msg.message_thread_id}`;
      topic = topicForThreadKey(threadKey);
      const existingThread = getThread<TelegramThreadMetadata>(this.deps.db, channel, topic);
      if (existingThread?.metadata.pendingContext) {
        injectedTopicContext = existingThread.metadata.pendingContext;
      }
      // Full replace (not patch): omitting pendingContext here is what clears
      // it — this topic's very first delivered message is definitionally the
      // first turn of a fresh session, so the injection is naturally one-shot.
      upsertThread<TelegramThreadMetadata>(this.deps.db, {
        channel,
        topic,
        threadKey,
        metadata: { chatId: msg.chat.id, messageThreadId: msg.message_thread_id },
      });
    }

    // Quoted reply context (E28) — a user quote-replying to a message is a
    // conversational gesture, not a request to fork a session: surfaced to
    // the agent as context only, via metadata.quoted_message. Never touches
    // topic/thread routing (computed independently above).
    const quoted = msg.reply_to_message;
    const quotedMessage = quoted
      ? {
          platform_message_id: `${msg.chat.id}:${quoted.message_id}`,
          sender_name: quoted.from?.first_name,
          text: (quoted.text ?? quoted.caption ?? '').slice(0, 200),
        }
      : undefined;

    try {
      const message: InboundMessage = {
        channel,
        ...(topic ? { topic } : {}),
        sender: senderId,
        payload: { type: 'text', body: effectiveBody },
        metadata: {
          telegram_chat_id: msg.chat.id,
          telegram_message_id: msg.message_id,
          // Encodes both IDs so react() can call setMessageReaction without a separate lookup
          platform_message_id: `${msg.chat.id}:${msg.message_id}`,
          ...(quotedMessage ? { quoted_message: quotedMessage } : {}),
          ...(injectedTopicContext ? { injected_topic_context: injectedTopicContext } : {}),
        },
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
      };

      await processInbound(message, this.deps);
      this.lastActivity = new Date().toISOString();
      return true;
    } catch (err) {
      console.error(`${this.tag} Failed to process inbound message ${update.update_id}: ${String(err)}`);
      return false;
    }
  }

  private async inboundLoop(): Promise<void> {
    console.log(`${this.tag} Inbound loop started (poll_timeout=${this.pollTimeout}s)`);

    while (!this.stopping) {
      try {
        const updates = await this.callTelegram<TelegramUpdate[]>('getUpdates', {
          offset: this.offset,
          timeout: this.pollTimeout,
          allowed_updates: ['message', 'message_reaction'],
        });

        for (const update of updates) {
          const success = await this.processUpdate(update);
          if (success) {
            this.offset = update.update_id + 1;
          } else {
            break;
          }
        }

        this.inboundBackoffMs = BACKOFF_INITIAL_MS;
        this.consecutiveFailures = 0;
      } catch (err) {
        this.consecutiveFailures++;
        console.error(`${this.tag} Inbound poll error: ${String(err)}`);
        await this.sleep(this.inboundBackoffMs);
        this.inboundBackoffMs = Math.min(this.inboundBackoffMs * 2, BACKOFF_MAX_MS);
      }
    }
  }

  // ── Loop supervision ──────────────────────────────────────────────────────

  private async supervise(name: string, fn: () => Promise<void>): Promise<void> {
    while (!this.stopping) {
      try {
        await fn();
      } catch (err) {
        console.error(`${this.tag} ${name} crashed unexpectedly: ${String(err)}`);
        if (!this.stopping) {
          console.error(`${this.tag} Restarting ${name} in ${LOOP_RESTART_DELAY_MS}ms`);
          await this.sleep(LOOP_RESTART_DELAY_MS);
        }
      }
    }
    console.log(`${this.tag} ${name} stopped`);
  }

  // ── Startup helpers ───────────────────────────────────────────────────────

  private async clearWebhook(): Promise<void> {
    try {
      await this.callTelegram('deleteWebhook', { drop_pending_updates: false });
      console.log(`${this.tag} Webhook cleared (polling mode active)`);
    } catch (err) {
      console.error(`${this.tag} Failed to clear webhook: ${String(err)}`);
    }
  }

  async registerCommands(manifests: CommandManifest[]): Promise<void> {
    // Telegram requires: name = [a-z0-9_]{1,32}, description = 3-256 chars.
    // A single invalid entry causes the whole setMyCommands call to fail, so
    // validate each manifest and skip (with a warning) rather than reject all.
    const VALID_NAME_RE = /^[a-z0-9_]{1,32}$/;
    const commands: Array<{ command: string; description: string }> = [];

    for (const m of manifests) {
      if (!VALID_NAME_RE.test(m.name)) {
        console.warn(
          `${this.tag} Skipping command "${m.name}" — name must be 1-32 chars, only [a-z0-9_]`,
        );
        continue;
      }
      if (m.description.length < 3 || m.description.length > 256) {
        console.warn(
          `${this.tag} Skipping command "${m.name}" — description must be 3-256 chars (got ${m.description.length})`,
        );
        continue;
      }
      commands.push({ command: m.name, description: m.description });
    }

    if (commands.length === 0) {
      console.warn(`${this.tag} No valid commands to register`);
      return;
    }

    try {
      // Telegram resolves a chat's command menu by scope precedence:
      //   chat (specific) > all_private_chats > all_group_chats > default.
      // Writing only the default scope is not enough: a stale `all_private_chats`
      // set (e.g. left behind by BotFather, which is what most bots show) shadows
      // it permanently in 1:1 chats, so new commands never appear in autocomplete.
      // Set both scopes so the private-chat menu always reflects the live list.
      await this.callTelegram('setMyCommands', { commands });
      await this.callTelegram('setMyCommands', {
        commands,
        scope: { type: 'all_private_chats' },
      });
      await this.callTelegram('setChatMenuButton', { menu_button: { type: 'commands' } });
      // Confirm against the all_private_chats scope — the one the client actually
      // reads in a 1:1 chat — so the log reflects what the user will see.
      const stored = await this.callTelegram<Array<{ command: string }>>('getMyCommands', {
        scope: { type: 'all_private_chats' },
      });
      console.log(
        `${this.tag} Registered ${commands.length} slash commands (default + all_private_chats) — Telegram confirms for private chats: ${stored.map((c) => c.command).join(', ')}`,
      );
    } catch (err) {
      console.error(`${this.tag} Failed to register slash commands: ${String(err)}`);
    }
  }
}

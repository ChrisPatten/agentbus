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
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
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
  OutboundActionResult,
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
import type { ApprovalDecision, ApprovalRequest } from '../approvals/types.js';
import type { ResolveApprovalOutcome } from '../approvals/resolve.js';
import { ChoiceStore } from '../choices/store.js';
import { DEFAULT_CHOICE_TTL_MS, MAX_CHOICES, type ChoiceButtonAttrs, type ChoicePrompt } from '../choices/types.js';
import { hasCallbackButton, parseChoiceCommands, parseChoices, type ParsedChoices } from '../choices/parse.js';
import { resolveChoiceTap } from '../choices/tap.js';
import { InputPromptStore, type InputKind, type InputPrompt } from '../choices/input-store.js';
import { OutboundStore, type OutboundKind } from '../outbound/store.js';
import { readSendOptions, type SendOptions } from '../outbound/send-options.js';
import { parseTelegramSend, type TelegramSend } from '../outbound/telegram-send.js';
import { checkDocumentPath, resolveSendDirs, MAX_DOCUMENT_BYTES, MAX_PHOTO_BYTES } from '../outbound/documents.js';
import { splitRichContent, RICH_MAX_CHARS } from '../outbound/rich.js';
import { renderApprovalOutcome, renderApprovalPending } from '../approvals/render.js';

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
  reply_to_message?: {
    message_id: number;
    from?: TelegramUser;
    text?: string;
    caption?: string;
    /** Present when the replied-to message is a forum topic's creation service message (the topic root). */
    forum_topic_created?: { name: string };
  };
  /** Service message: a message was pinned (in a forum topic, in that topic). Carries the pinned message. */
  pinned_message?: { message_id: number; text?: string; caption?: string; date?: number };
  /** Service message: a forum topic was created. */
  forum_topic_created?: { name: string };
  /** A location the user shared (E81 ask_input). */
  location?: { latitude: number; longitude: number; horizontal_accuracy?: number };
  /** A contact the user shared (E81 ask_input). */
  contact?: { phone_number: string; first_name: string; last_name?: string; user_id?: number; vcard?: string };
  /** Users the user picked with a request_users button (E81 ask_input). */
  users_shared?: {
    request_id: number;
    users: Array<{ user_id: number; first_name?: string; last_name?: string; username?: string }>;
  };
  /** Service message: a forum topic was renamed (name absent if only the icon changed). */
  forum_topic_edited?: { name?: string };
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
  callback_query?: TelegramCallbackQuery;
}

/** An inline-keyboard button tap (E51 approval buttons). */
interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
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
  /**
   * Forum topic display name, captured from Telegram service messages
   * (forum_topic_created / forum_topic_edited, or the topic-root reply_to of
   * any message in the topic) or from createForumTopic. Survives restarts.
   */
  topicName?: string;
  /**
   * Text of the topic's most recently pinned message, captured from the
   * `pinned_message` service update. The Bot API has no per-topic getChat
   * pinned_message, so this is the only way to learn a topic's pin.
   */
  pinnedText?: string;
}

/** Max chars of a topic's pinned text injected into a new session's context. */
export const TOPIC_PIN_MAX_CHARS = 2000;

/** Per-chat state for the live tool-call status stream (E29). */
interface DraftState {
  /** null while the initial sendMessage (draft creation) is in flight. */
  messageId: number | null;
  lines: string[];
  timer: ReturnType<typeof setTimeout> | null;
  /** Resolves when the initial sendMessage settles — send() awaits this to
   * close the race where final delivery arrives before the draft exists. */
  creating: Promise<void> | null;
  /** True while `lines` holds only a cold-start stand-in (e.g. cc-pool's
   * "One moment") rather than real activity. The next appended line
   * replaces `lines` instead of growing it — see appendToolCallLine. */
  placeholder: boolean;
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
  instanceConfig?: { token: string; poll_timeout: number; plugin?: string; choice_ttl_hours?: number; send_paths?: string[] };
  /**
   * Store for single-choice button prompts (E74). Defaults to one built over
   * `db` on first use, so tests and deployments that never send `choices`
   * never touch the table.
   */
  choiceStore?: ChoiceStore;
  /** Store for `ask_input` prompts (E81). Defaults to one built over `db` on first use. */
  inputPromptStore?: InputPromptStore;
  /** Registry of delivered messages for edit/pin by bus message id (E81). Defaults to one built over `db`. */
  outboundStore?: OutboundStore;
  /**
   * Answers an approval request when the human taps Approve/Deny (E51). Absent
   * in tests/deployments without approvals — taps are then acknowledged as
   * unavailable rather than dropped.
   */
  resolveApproval?: (
    id: string,
    decision: ApprovalDecision,
    resolvedBy: string,
    onlyContactId?: string,
  ) => Promise<ResolveApprovalOutcome>;
}

// ── Choice keyboard (E74) ─────────────────────────────────────────────────────

/** Labels this short or shorter are paired two per row. */
const CHOICE_SHORT_LABEL = 12;

/**
 * Inline keyboard for a choice prompt: one button per row, or two per row when
 * every label is short. `callback_data` carries only the prompt id and index
 * (`choice:<uuid>:<n>`, 45 bytes at most) — Telegram caps it at 64 bytes, so
 * labels are stored server-side.
 */
export interface InlineButton {
  text: string;
  callback_data?: string;
  url?: string;
  copy_text?: { text: string };
  style?: string;
  disabled?: Record<string, never>;
}

export function buildChoiceKeyboard(
  promptId: string,
  labels: string[],
  buttons?: Array<ChoiceButtonAttrs | null> | null,
): { inline_keyboard: InlineButton[][] } {
  const built = labels.slice(0, MAX_CHOICES).map((text, i): InlineButton => {
    const attrs = buttons?.[i];
    // E81: a copy_text or url button has no tap to report back, so it carries no callback_data.
    const button: InlineButton =
      attrs?.copy_text !== undefined
        ? { text, copy_text: { text: attrs.copy_text } }
        : attrs?.url !== undefined
          ? { text, url: attrs.url }
          : { text, callback_data: `choice:${promptId}:${i}` };
    if (attrs?.style) button.style = attrs.style;
    return button;
  });
  const perRow = labels.every((l) => l.length <= CHOICE_SHORT_LABEL) ? 2 : 1;
  const rows: InlineButton[][] = [];
  for (let i = 0; i < built.length; i += perRow) rows.push(built.slice(i, i + perRow));
  return { inline_keyboard: rows };
}

/** Telegram's description from a failed call, without the "Telegram API error:" boilerplate or any token. */
function describeTelegramError(err: unknown): string {
  return String(err instanceof Error ? err.message : err).replace(/^Telegram API error:\s*/, '');
}

/** A readable pin/unpin failure; the missing-rights case names the exact fix. */
function describePinError(err: unknown): string {
  const text = describeTelegramError(err);
  if (/not enough rights|CHAT_ADMIN_REQUIRED|administrator rights/i.test(text)) {
    return (
      'This bot lacks the "Pin Messages" admin right in this chat. In Telegram: open the group, ' +
      'go to the member list, select this bot, "Edit Admin Rights", and enable "Pin Messages".'
    );
  }
  return text;
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
      interactiveApproval: true,
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

    // E81: keep the outbound-message registry bounded.
    try {
      const pruned = this.outbound.prune();
      if (pruned > 0) console.log(`${this.tag} Pruned ${pruned} old outbound message record(s)`);
    } catch (err) {
      console.warn(`${this.tag} Outbound registry prune failed: ${String(err)}`);
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
    replyMarkup?: unknown,
  ): Promise<number> {
    const method = editMessageId ? 'editMessageText' : 'sendMessage';
    const params: Record<string, unknown> = editMessageId
      ? {
          chat_id: chatId,
          message_id: editMessageId,
          text,
          // The one send option that also applies to an edit (E81 `no_preview`).
          ...(extraParams?.['link_preview_options'] ? { link_preview_options: extraParams['link_preview_options'] } : {}),
        }
      : { chat_id: chatId, text, ...extraParams };
    if (replyMarkup) params['reply_markup'] = replyMarkup;

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
    // E81 (S81.2): silent / no_preview ride metadata and are applied to the Telegram call.
    const opts = readSendOptions(envelope.metadata);
    const extraBase: Record<string, unknown> = {
      ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
      ...(opts.silent ? { disable_notification: true } : {}),
      ...(opts.no_preview ? { link_preview_options: { is_disabled: true } } : {}),
    };
    const extraParams = Object.keys(extraBase).length > 0 ? extraBase : undefined;

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

    // E81: a tool-built Telegram-native message (location, venue, contact,
    // document, rich message, input prompt). Absent or invalid falls through to
    // the plain-text body, which is also what every other channel delivers.
    const special = parseTelegramSend(envelope.metadata['telegram_send']);
    if (special === null) {
      console.warn(`${this.tag} Ignoring invalid metadata.telegram_send on ${envelope.id}; sending the plain-text body`);
    } else if (special) {
      return this.sendSpecial(envelope, special, { chatId, messageThreadId }, opts, replyParams);
    }

    const parts = splitMessage(envelope.payload.body);
    const key = this.draftKey(chatId, messageThreadId);

    // E74: single-choice buttons ride the last part of the message. The
    // prompt id is minted now (it goes in callback_data) and persisted only
    // once Telegram has returned the message id.
    const parsedChoices = this.parseChoices(envelope.metadata['choices']);
    const choices = parsedChoices?.labels;
    const choiceCommands = choices ? this.parseChoiceCommands(envelope.metadata['choice_commands'], choices.length) : undefined;
    const choicePromptId = choices ? randomUUID() : undefined;
    const choiceMarkup =
      choices && choicePromptId ? buildChoiceKeyboard(choicePromptId, choices, parsedChoices?.buttons) : undefined;

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
          const messageId = await this.deliverText(
            chatId,
            parts[0]!,
            draft.messageId,
            opts.no_preview ? { link_preview_options: { is_disabled: true } } : undefined,
            parts.length === 1 ? choiceMarkup : undefined,
          );
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
        const messageId = await this.deliverText(
          chatId,
          parts[i]!,
          undefined,
          partParams,
          i === parts.length - 1 ? choiceMarkup : undefined,
        );
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

    if (choices && choicePromptId && platformMessageId && hasCallbackButton(parsedChoices?.buttons, choices.length)) {
      this.persistChoicePrompt(
        envelope,
        choicePromptId,
        choices,
        `${chatId}:${platformMessageId}`,
        choiceCommands,
        parsedChoices?.buttons,
      );
    }

    if (platformMessageId) {
      this.recordOutbound(envelope, { chatId, threadId: messageThreadId, messageId: Number(platformMessageId), kind: 'text', parts: parts.length });
      if (opts.pin) await this.pinQuietly(chatId, Number(platformMessageId));
    }

    this.lastActivity = new Date().toISOString();
    return { success: true, platformMessageId };
  }

  /**
   * Send a PNG via `sendPhoto` (multipart upload) to the same chat/topic
   * `send()` would resolve for `envelope`. Captions are capped at Telegram's
   * 1024-character limit. Used by command replies such as `/pane`.
   */
  async sendImage(
    envelope: MessageEnvelope,
    image: { png: Buffer; caption: string; filename: string },
  ): Promise<DeliveryResult> {
    const target = this.resolveSendTarget(envelope);
    if ('error' in target) {
      return { success: false, error: target.error, retryable: false };
    }
    const form = new FormData();
    form.append('chat_id', String(target.chatId));
    if (target.messageThreadId) form.append('message_thread_id', String(target.messageThreadId));
    form.append('caption', image.caption.slice(0, 1024));
    form.append('photo', new Blob([new Uint8Array(image.png)], { type: 'image/png' }), image.filename);

    try {
      const res = await fetch(`${TELEGRAM_API_BASE}/bot${this.token}/sendPhoto`, { method: 'POST', body: form });
      const data = (await res.json()) as TelegramApiResponse<TelegramMessage>;
      if (!res.ok || !data.ok) {
        return { success: false, error: `Telegram API error: ${data.description ?? res.status}`, retryable: false };
      }
      this.lastActivity = new Date().toISOString();
      return { success: true, platformMessageId: String(data.result?.message_id) };
    } catch (err) {
      return { success: false, error: String(err), retryable: true };
    }
  }

  // ── E81 outbound registry ─────────────────────────────────────────────────

  private outboundStoreInstance?: OutboundStore;

  private get outbound(): OutboundStore {
    this.outboundStoreInstance ??= this.deps.outboundStore ?? new OutboundStore(this.deps.db);
    return this.outboundStoreInstance;
  }

  private inputStoreInstance?: InputPromptStore;

  private get inputStore(): InputPromptStore {
    this.inputStoreInstance ??= this.deps.inputPromptStore ?? new InputPromptStore(this.deps.db);
    return this.inputStoreInstance;
  }

  /** Records a delivered message so edit_message / pin_message can find it by bus message id. Never throws. */
  private recordOutbound(
    envelope: MessageEnvelope,
    sent: { chatId: number; threadId?: number | undefined; messageId: number; kind: OutboundKind; parts?: number },
  ): void {
    if (!envelope.id || !Number.isInteger(sent.messageId)) return;
    try {
      this.outbound.record({
        busMessageId: envelope.id,
        channel: envelope.channel,
        chatId: sent.chatId,
        threadId: sent.threadId ?? null,
        platformMessageId: sent.messageId,
        kind: sent.kind,
        parts: sent.parts ?? 1,
      });
    } catch (err) {
      console.error(`${this.tag} Failed to record outbound message ${envelope.id}: ${String(err)}`);
    }
  }

  /** Pins right after a send (the `pin` option). A failure is logged: the message itself was delivered. */
  private async pinQuietly(chatId: number, messageId: number): Promise<void> {
    try {
      await this.callTelegram('pinChatMessage', { chat_id: chatId, message_id: messageId, disable_notification: true });
    } catch (err) {
      console.error(`${this.tag} Pin after send failed for ${chatId}:${messageId}: ${describeTelegramError(err)}`);
    }
  }

  // ── E81 Telegram-native sends ─────────────────────────────────────────────

  /**
   * Deletes a pending tool-status draft so a native message (which cannot
   * overwrite it the way text can) does not leave a stale status line behind.
   */
  private async discardDraft(chatId: number, messageThreadId?: number): Promise<void> {
    const key = this.draftKey(chatId, messageThreadId);
    const draft = this.draftMessages.get(key);
    if (!draft) return;
    if (draft.timer) clearTimeout(draft.timer);
    this.draftMessages.delete(key);
    if (draft.creating) await draft.creating.catch(() => {});
    if (draft.messageId !== null) {
      await this.callTelegram('deleteMessage', { chat_id: chatId, message_id: draft.messageId }).catch(() => {});
    }
  }

  /** Delivers one `metadata.telegram_send` message (location, venue, contact, document, photo, rich, input prompt). */
  private async sendSpecial(
    envelope: MessageEnvelope,
    spec: TelegramSend,
    target: { chatId: number; messageThreadId?: number | undefined },
    opts: SendOptions,
    replyParams: { reply_parameters: { message_id: number; allow_sending_without_reply: true } } | undefined,
  ): Promise<DeliveryResult> {
    const { chatId, messageThreadId } = target;
    this.stopTypingIndicator(chatId, messageThreadId);
    await this.discardDraft(chatId, messageThreadId);

    const base: Record<string, unknown> = {
      chat_id: chatId,
      ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
      ...(opts.silent ? { disable_notification: true } : {}),
      ...replyParams,
    };
    const fallbackToText = async (reason: string): Promise<DeliveryResult> => {
      console.warn(`${this.tag} ${spec.kind} send for ${envelope.id} fell back to the plain-text body: ${reason}`);
      const metadata = { ...envelope.metadata };
      delete metadata['telegram_send'];
      return this.send({ ...envelope, metadata });
    };

    try {
      let sent: { messageId: number; kind: OutboundKind; parts?: number } | DeliveryResult;
      switch (spec.kind) {
        case 'location': {
          const m = await this.callTelegram<TelegramMessage>('sendLocation', { ...base, latitude: spec.latitude, longitude: spec.longitude });
          sent = { messageId: m.message_id, kind: 'location' };
          break;
        }
        case 'venue': {
          const m = await this.callTelegram<TelegramMessage>('sendVenue', {
            ...base,
            latitude: spec.latitude,
            longitude: spec.longitude,
            title: spec.title,
            address: spec.address,
          });
          sent = { messageId: m.message_id, kind: 'venue' };
          break;
        }
        case 'contact': {
          const m = await this.callTelegram<TelegramMessage>('sendContact', {
            ...base,
            phone_number: spec.phone_number,
            first_name: spec.first_name,
            ...(spec.last_name ? { last_name: spec.last_name } : {}),
            ...(spec.vcard ? { vcard: spec.vcard } : {}),
          });
          sent = { messageId: m.message_id, kind: 'contact' };
          break;
        }
        case 'document':
        case 'photo':
          sent = await this.sendFile(envelope, spec, base);
          break;
        case 'rich':
          sent = await this.sendRichSpecial(envelope, spec, base, chatId);
          break;
        case 'ask_input':
          sent = await this.sendAskInput(envelope, spec, base, target);
          break;
      }
      if ('success' in sent) {
        // A rich message Telegram rejected degrades to the plain-text body (S81.9 fallback).
        if (!sent.success && spec.kind === 'rich' && sent.retryable === false && sent.error?.startsWith('rich-fallback')) {
          return fallbackToText(sent.error);
        }
        return sent;
      }
      this.recordOutbound(envelope, { chatId, threadId: messageThreadId, ...sent });
      if (opts.pin) await this.pinQuietly(chatId, sent.messageId);
      this.lastActivity = new Date().toISOString();
      return { success: true, platformMessageId: String(sent.messageId) };
    } catch (err) {
      const status = (err as { status?: number }).status;
      return { success: false, error: describeTelegramError(err), retryable: status === undefined || status >= 500 || status === 429 };
    }
  }

  /** `sendDocument` / `sendPhoto` of an allow-listed local file; every rejection happens before any upload. */
  private async sendFile(
    envelope: MessageEnvelope,
    spec: Extract<TelegramSend, { kind: 'document' | 'photo' }>,
    base: Record<string, unknown>,
  ): Promise<{ messageId: number; kind: OutboundKind } | DeliveryResult> {
    const limit = spec.kind === 'photo' ? MAX_PHOTO_BYTES : MAX_DOCUMENT_BYTES;
    const check = checkDocumentPath(
      spec.path,
      resolveSendDirs(this.deps.config, this.deps.instanceConfig?.send_paths),
      limit,
    );
    if (!check.ok) {
      console.error(`${this.tag} Refused to send ${spec.kind} for ${envelope.id}: ${check.error}`);
      return { success: false, error: `send_${spec.kind} refused: ${check.error}`, retryable: false };
    }
    const bytes = await readFile(check.realPath);
    if (bytes.length > limit) {
      return { success: false, error: `send_${spec.kind} refused: file grew past the ${limit} byte upload limit`, retryable: false };
    }
    const form = new FormData();
    for (const [k, v] of Object.entries(base)) form.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    if (spec.caption) form.append('caption', spec.caption);
    form.append(spec.kind, new Blob([new Uint8Array(bytes)]), basename(spec.path));
    const m = await this.callTelegramForm<TelegramMessage>(spec.kind === 'photo' ? 'sendPhoto' : 'sendDocument', form);
    return { messageId: m.message_id, kind: spec.kind };
  }

  /**
   * `sendRichMessage` in chunks (S81.9). The choice keyboard rides the last
   * chunk. If Telegram rejects the rich call itself (feature unavailable or
   * unparsable markup) before anything was sent, signals the caller to send the
   * plain-text body instead.
   */
  private async sendRichSpecial(
    envelope: MessageEnvelope,
    spec: Extract<TelegramSend, { kind: 'rich' }>,
    base: Record<string, unknown>,
    chatId: number,
  ): Promise<{ messageId: number; kind: OutboundKind; parts: number } | DeliveryResult> {
    const chunks = splitRichContent(spec.content, spec.format);
    const parsedChoices = this.parseChoices(envelope.metadata['choices']);
    const promptId = parsedChoices ? randomUUID() : undefined;
    const markup = parsedChoices && promptId ? buildChoiceKeyboard(promptId, parsedChoices.labels, parsedChoices.buttons) : undefined;

    let lastId = 0;
    for (let i = 0; i < chunks.length; i++) {
      if (i > 0) await this.sleep(200);
      const params: Record<string, unknown> = {
        ...base,
        rich_message: { [spec.format]: chunks[i] },
        ...(i === chunks.length - 1 && markup ? { reply_markup: markup } : {}),
      };
      if (i > 0) delete params['reply_parameters'];
      try {
        const m = await this.callTelegram<TelegramMessage>('sendRichMessage', params);
        lastId = m.message_id;
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (i === 0 && (status === 400 || status === 404)) {
          return { success: false, error: `rich-fallback: ${describeTelegramError(err)}`, retryable: false };
        }
        const prefix = i > 0 ? `Partial delivery (${i}/${chunks.length} parts sent): ` : '';
        return { success: false, error: `${prefix}${describeTelegramError(err)}`, retryable: true };
      }
    }
    if (parsedChoices && promptId && hasCallbackButton(parsedChoices.buttons, parsedChoices.labels.length)) {
      this.persistChoicePrompt(envelope, promptId, parsedChoices.labels, `${chatId}:${lastId}`, undefined, parsedChoices.buttons);
    }
    return { messageId: lastId, kind: 'rich', parts: chunks.length };
  }

  // ── E81 ask_input ─────────────────────────────────────────────────────────

  private inputTtlMs(): number {
    const hours = this.deps.instanceConfig?.choice_ttl_hours;
    return hours ? hours * 60 * 60 * 1000 : DEFAULT_CHOICE_TTL_MS;
  }

  /**
   * Sends an input prompt: a one-time reply keyboard with request_location /
   * request_contact / request_users in a private chat, otherwise a force_reply
   * prompt. Telegram only allows the keyboard buttons in private chats (S81.1),
   * so a group topic degrades to force_reply and the user shares from the
   * attach menu.
   */
  private async sendAskInput(
    envelope: MessageEnvelope,
    spec: Extract<TelegramSend, { kind: 'ask_input' }>,
    base: Record<string, unknown>,
    target: { chatId: number; messageThreadId?: number | undefined },
  ): Promise<{ messageId: number; kind: OutboundKind }> {
    const { chatId, messageThreadId } = target;
    const useKeyboard = chatId > 0 && spec.input !== 'text';
    const requestId = spec.input === 'person' ? Math.floor(Math.random() * 2_000_000_000) + 1 : undefined;
    let markup: Record<string, unknown>;
    if (useKeyboard) {
      const button =
        spec.input === 'location'
          ? { text: 'Share my location', request_location: true }
          : spec.input === 'contact'
            ? { text: 'Share my contact', request_contact: true }
            : {
                text: 'Choose a person',
                request_users: { request_id: requestId, max_quantity: 1, request_name: true, request_username: true },
              };
      markup = { keyboard: [[button]], one_time_keyboard: true, resize_keyboard: true };
    } else {
      markup = { force_reply: true, ...(spec.placeholder ? { input_field_placeholder: spec.placeholder } : {}) };
    }
    const hint =
      !useKeyboard && spec.input !== 'text'
        ? `\n\n(Reply with the ${spec.input === 'person' ? 'person\'s name' : spec.input}; in this chat use the attach menu to share a ${spec.input === 'person' ? 'contact' : spec.input}.)`
        : '';
    const extra: Record<string, unknown> = { ...base };
    delete extra['chat_id'];
    const messageId = await this.deliverText(chatId, `${envelope.payload.type === 'text' ? envelope.payload.body : ''}${hint}`, undefined, extra, markup);

    const recipient = envelope.recipient.startsWith('contact:') ? envelope.recipient.slice('contact:'.length) : null;
    try {
      this.inputStore.create(
        {
          id: randomUUID(),
          channel: envelope.channel,
          topic: envelope.topic || 'general',
          contactId: recipient,
          kind: spec.input as InputKind,
          chatId,
          threadId: messageThreadId ?? null,
          platformMessageId: messageId,
          busMessageId: envelope.id || null,
          requestId: requestId ?? null,
          keyboard: useKeyboard,
        },
        this.inputTtlMs(),
      );
    } catch (err) {
      console.error(`${this.tag} Failed to persist input prompt for ${envelope.id}: ${String(err)}`);
    }
    return { messageId, kind: 'input' };
  }

  /** Removes a lingering reply keyboard by sending then deleting a short message that carries remove_keyboard. */
  private async removeReplyKeyboard(chatId: number, messageThreadId: number | null): Promise<void> {
    const sent = await this.callTelegram<TelegramMessage>('sendMessage', {
      chat_id: chatId,
      ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
      text: 'Done',
      disable_notification: true,
      reply_markup: { remove_keyboard: true },
    });
    await this.callTelegram('deleteMessage', { chat_id: chatId, message_id: sent.message_id }).catch(() => {});
  }

  /** The sweep's path for an answered or expired prompt whose reply keyboard may still show. */
  async finalizeInputPrompt(prompt: InputPrompt): Promise<void> {
    if (!prompt.keyboard) return;
    await this.removeReplyKeyboard(prompt.chat_id, prompt.thread_id);
  }

  /** The contact id for a Telegram sender id, or undefined. */
  private contactForSender(senderId: string): string | undefined {
    return [...this.contactChatIdMap.entries()].find(([, userId]) => String(userId) === senderId)?.[0];
  }

  /** Text, structured metadata and prompt kind for an inbound location / contact / users_shared message. */
  private describeSharedPayload(
    msg: TelegramMessage,
  ): { body: string; metadata: Record<string, unknown>; kind: InputKind } | undefined {
    if (msg.location) {
      const { latitude, longitude, horizontal_accuracy } = msg.location;
      return {
        body: `[location] ${latitude}, ${longitude}`,
        metadata: { location: { latitude, longitude, ...(horizontal_accuracy !== undefined ? { horizontal_accuracy } : {}) } },
        kind: 'location',
      };
    }
    if (msg.contact) {
      const c = msg.contact;
      const name = [c.first_name, c.last_name].filter(Boolean).join(' ');
      return {
        body: `[contact] ${name}, ${c.phone_number}`,
        metadata: {
          contact: {
            phone_number: c.phone_number,
            first_name: c.first_name,
            ...(c.last_name ? { last_name: c.last_name } : {}),
            ...(c.user_id !== undefined ? { user_id: c.user_id } : {}),
            ...(c.vcard ? { vcard: c.vcard } : {}),
          },
        },
        kind: 'contact',
      };
    }
    if (msg.users_shared) {
      const people = msg.users_shared.users.map((u) => {
        const name = [u.first_name, u.last_name].filter(Boolean).join(' ');
        return [name || `user ${u.user_id}`, u.username ? `@${u.username}` : ''].filter(Boolean).join(' ');
      });
      return {
        body: `[shared person] ${people.join('; ')}`,
        metadata: { users_shared: { request_id: msg.users_shared.request_id, users: msg.users_shared.users } },
        kind: 'person',
      };
    }
    return undefined;
  }

  /** The open input prompt an inbound message answers, if any. */
  private matchInputPrompt(msg: TelegramMessage, shared: { kind: InputKind } | undefined, contactId: string | undefined): InputPrompt | null {
    if (!contactId) return null;
    try {
      const replyTo = msg.reply_to_message?.message_id;
      if (replyTo !== undefined) {
        const byMessage = this.inputStore.findOpenByMessage(msg.chat.id, replyTo, contactId);
        if (byMessage) return byMessage;
      }
      if (!shared) return null;
      const threadId = msg.is_topic_message && msg.message_thread_id ? msg.message_thread_id : null;
      const prompt = this.inputStore.findOpen(shared.kind, msg.chat.id, threadId, contactId);
      if (prompt && shared.kind === 'person' && prompt.request_id !== null && msg.users_shared?.request_id !== prompt.request_id) return null;
      return prompt;
    } catch (err) {
      console.error(`${this.tag} Input prompt lookup failed: ${String(err)}`);
      return null;
    }
  }

  // ── E81 edit / pin by bus message id ──────────────────────────────────────

  private lookupOutbound(busMessageId: string): { row: NonNullable<ReturnType<OutboundStore['get']>> } | { error: string } {
    const row = this.outbound.get(busMessageId);
    if (!row) {
      return {
        error: `No record of a Telegram message sent for bus message "${busMessageId}". Only messages this bot delivered recently (30 days) can be edited or pinned.`,
      };
    }
    if (!this.ownsChannel(row.channel)) return { error: `Message "${busMessageId}" was not sent by adapter "${this.id}"` };
    return { row };
  }

  async editMessage(busMessageId: string, body: string, choices?: unknown[]): Promise<OutboundActionResult> {
    const found = this.lookupOutbound(busMessageId);
    if ('error' in found) return { ok: false, error: found.error };
    const { row } = found;
    if (row.kind !== 'text' && row.kind !== 'rich') {
      return { ok: false, error: `A ${row.kind} message cannot be edited; only text and rich messages can` };
    }
    if (row.parts > 1) {
      return { ok: false, error: `That message was delivered in ${row.parts} parts and cannot be edited; send a new message instead` };
    }
    const limit = row.kind === 'rich' ? RICH_MAX_CHARS : MAX_MESSAGE_LENGTH;
    if (body.length > limit) {
      return { ok: false, error: `The new text is ${body.length} characters; an edit is limited to ${limit}` };
    }
    let parsed: ReturnType<TelegramAdapter['parseChoices']>;
    if (choices !== undefined) {
      parsed = this.parseChoices(choices);
      if (!parsed) return { ok: false, error: 'Invalid choices: 1-8 labels of at most 64 characters (or button objects)' };
    }
    const promptId = parsed ? randomUUID() : undefined;
    // editMessageText without a keyboard clears it, so "no choices" means "clear the keyboard".
    const markup = parsed && promptId ? buildChoiceKeyboard(promptId, parsed.labels, parsed.buttons) : { inline_keyboard: [] };
    const ref = `${row.chat_id}:${row.platform_message_id}`;

    try {
      if (row.kind === 'rich') {
        await this.callTelegram('editMessageText', {
          chat_id: row.chat_id,
          message_id: row.platform_message_id,
          rich_message: { markdown: body },
          reply_markup: markup,
        });
      } else {
        await this.deliverText(row.chat_id, body, row.platform_message_id, undefined, markup);
      }
    } catch (err) {
      if (/not modified/i.test(String(err))) {
        // Same text and keyboard: nothing to do, and not an error for the agent.
        return { ok: true, note: 'The message already had that text; nothing changed' };
      }
      return { ok: false, error: describeTelegramError(err) };
    }

    // The old keyboard (and any prompt behind it) is gone either way.
    this.choiceStore.supersedeByMessageRef(ref);
    if (parsed && promptId && hasCallbackButton(parsed.buttons, parsed.labels.length)) {
      const topic = row.thread_id ? topicForThreadKey(`${row.chat_id}:${row.thread_id}`) : 'general';
      const contactId = row.chat_id > 0 ? (this.contactForChat(row.chat_id) ?? null) : null;
      this.persistChoicePromptRow({
        id: promptId,
        channel: row.channel,
        topic,
        contactId,
        labels: parsed.labels,
        buttons: parsed.buttons ?? null,
        platformMessageId: ref,
        busMessageId: busMessageId,
      });
    }
    this.lastActivity = new Date().toISOString();
    return { ok: true };
  }

  private contactForChat(chatId: number): string | undefined {
    return [...this.contactChatIdMap.entries()].find(([, id]) => id === chatId)?.[0];
  }

  async pinMessage(busMessageId: string, silent: boolean): Promise<OutboundActionResult> {
    const found = this.lookupOutbound(busMessageId);
    if ('error' in found) return { ok: false, error: found.error };
    try {
      await this.callTelegram('pinChatMessage', {
        chat_id: found.row.chat_id,
        message_id: found.row.platform_message_id,
        disable_notification: silent,
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: describePinError(err) };
    }
  }

  async unpinMessage(busMessageId: string, all: boolean): Promise<OutboundActionResult> {
    const found = this.lookupOutbound(busMessageId);
    if ('error' in found) return { ok: false, error: found.error };
    const { row } = found;
    try {
      if (all) {
        if (row.thread_id) {
          await this.callTelegram('unpinAllForumTopicMessages', { chat_id: row.chat_id, message_thread_id: row.thread_id });
        } else {
          await this.callTelegram('unpinAllChatMessages', { chat_id: row.chat_id });
        }
      } else {
        await this.callTelegram('unpinChatMessage', { chat_id: row.chat_id, message_id: row.platform_message_id });
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: describePinError(err) };
    }
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
        topicName: created.name ?? name,
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
   * turn — and once, with `placeholder: true`, by cc-pool right before a
   * cold-starting pane launch begins (no pane is alive yet to have made a
   * real tool call). Appends `text` as a line to a single evolving Telegram
   * message for the contact's chat, batching edits to ~1/sec (see
   * appendToolCallLine). A placeholder line is replaced, not appended to, by
   * whatever line comes after it.
   */
  reportToolCall(contactId: string, text: string, channel?: string, topic?: string, placeholder?: boolean): void {
    const resolved = this.resolveChatAndTopic(contactId, channel, topic);
    if (resolved) {
      this.appendToolCallLine(resolved.chatId, text, resolved.messageThreadId, placeholder);
    } else {
      console.warn(`${this.tag} reportToolCall: no chat_id for contact "${contactId}"`);
    }
  }

  /**
   * Append a tool-call line for (`chatId`, `messageThreadId`). The map
   * check-and-reserve is synchronous (no `await` in between) so two calls
   * arriving before the first `sendMessage` resolves can never both see "no
   * draft" and both create one.
   *
   * If a draft already exists and is currently just a cold-start placeholder
   * (`state.placeholder`), this line REPLACES it (`state.lines = [line]`)
   * instead of appending — the placeholder was a stand-in for activity, not
   * activity itself, so it shouldn't linger as a permanent first line once
   * something real has happened. Only one placeholder call is ever made per
   * draft (cc-pool fires it once, before launch), so this replace can only
   * ever fire against a state that is still exactly `["One moment"]`.
   */
  private appendToolCallLine(chatId: number, line: string, messageThreadId?: number, placeholder?: boolean): void {
    const key = this.draftKey(chatId, messageThreadId);
    const state = this.draftMessages.get(key);
    if (state) {
      if (state.placeholder) {
        // E79: a transient line identical to the one shown needs no edit
        // (Telegram rejects an unchanged edit).
        if (state.lines.length === 1 && state.lines[0] === line) {
          state.placeholder = placeholder ?? false;
          return;
        }
        state.lines = [line];
        // E79: a transient line (phrase-mode status) is itself replaced by the next one.
        state.placeholder = placeholder ?? false;
      } else {
        state.lines.push(line);
        state.placeholder = placeholder ?? false;
      }
      if (state.messageId !== null) this.scheduleDraftFlush(chatId, key, state);
      // else: creation still in flight — createDraftMessage's post-await
      // check picks up this line once the initial send resolves.
      return;
    }

    const fresh: DraftState = {
      messageId: null,
      lines: [line],
      timer: null,
      creating: null,
      placeholder: placeholder ?? false,
    };
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

  // ── Choice buttons (E74) ──────────────────────────────────────────────────

  private choiceStoreInstance?: ChoiceStore;

  private get choiceStore(): ChoiceStore {
    this.choiceStoreInstance ??= this.deps.choiceStore ?? new ChoiceStore(this.deps.db);
    return this.choiceStoreInstance;
  }

  /** `metadata.choices` if valid, else undefined (message sent without buttons). See src/choices/parse.ts. */
  private parseChoices(raw: unknown): ParsedChoices | undefined {
    return parseChoices(raw, this.tag);
  }

  /** `metadata.choice_commands` (E54), parallel to the labels; invalid input is dropped. See src/choices/parse.ts. */
  private parseChoiceCommands(raw: unknown, labelCount: number): Array<string | null> | undefined {
    return parseChoiceCommands(raw, labelCount, this.tag);
  }

  private persistChoicePrompt(
    envelope: MessageEnvelope,
    id: string,
    labels: string[],
    platformMessageId: string,
    commands?: Array<string | null>,
    buttons?: Array<ChoiceButtonAttrs | null>,
  ): void {
    const recipient = envelope.recipient.startsWith('contact:') ? envelope.recipient.slice('contact:'.length) : null;
    this.persistChoicePromptRow({
      id,
      channel: envelope.channel,
      topic: envelope.topic || 'general',
      contactId: recipient,
      labels,
      commands: commands ?? null,
      buttons: buttons ?? null,
      platformMessageId,
      busMessageId: envelope.id || null,
    });
  }

  private persistChoicePromptRow(input: Parameters<ChoiceStore['create']>[0]): void {
    const ttlMs = this.deps.instanceConfig?.choice_ttl_hours
      ? this.deps.instanceConfig.choice_ttl_hours * 60 * 60 * 1000
      : DEFAULT_CHOICE_TTL_MS;
    try {
      this.choiceStore.create(input, ttlMs);
    } catch (err) {
      // The message is already out; a failed insert means its buttons will
      // answer "Prompt not found". Log loudly rather than fail the delivery.
      console.error(`${this.tag} Failed to persist choice prompt ${input.id}: ${String(err)}`);
    }
  }

  /** Removes the keyboard from an expired prompt's message (the sweep's path). */
  async finalizeChoicePrompt(prompt: ChoicePrompt): Promise<void> {
    const ref = prompt.platform_message_id?.split(':');
    if (!ref || ref.length !== 2) return;
    await this.clearKeyboard(Number(ref[0]), Number(ref[1]));
  }

  /** Empties a message's inline keyboard, leaving its text. A 400 (already cleared / message gone) is swallowed so the sweep never retries forever. */
  private async clearKeyboard(chatId: number, messageId: number): Promise<void> {
    try {
      await this.callTelegram('editMessageReplyMarkup', {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [] },
      });
    } catch (err: unknown) {
      if ((err as { status?: number }).status !== 400) throw err;
    }
  }

  /**
   * Handles a `choice:<id>:<index>` tap (the sender is already authenticated).
   * Only the contact the prompt was addressed to may answer. The prompt is
   * marked answered first (an atomic flip, so a double tap injects once),
   * then the pick is injected as an ordinary inbound message in the
   * prompt's conversation; if injection fails the prompt is reopened so the
   * human can tap again.
   */
  private async processChoiceTap(
    query: TelegramCallbackQuery,
    promptId: string,
    index: number,
    contactId: string,
    answer: (text: string) => Promise<unknown>,
  ): Promise<void> {
    const chat = query.message?.chat.id;
    const messageId = query.message?.message_id;
    const result = resolveChoiceTap(this.choiceStore, promptId, index, contactId);
    switch (result.outcome) {
      case 'not_found':
        await answer('Prompt not found');
        return;
      case 'forbidden':
        console.error(`${this.tag} Choice ${promptId} tapped by ${contactId} but addressed to ${result.prompt?.contact_id}`);
        await answer('Not authorized');
        return;
      case 'already_answered':
        await answer('Already answered');
        return;
      case 'invalid_choice':
        await answer('Unrecognized choice');
        return;
      case 'expired':
        if (chat !== undefined && messageId !== undefined) {
          await this.clearKeyboard(chat, messageId).catch(() => {});
          this.choiceStore.clearMessageRef(promptId);
        }
        await answer('Expired');
        return;
      case 'answered':
        break;
    }
    const { prompt } = result;

    // E54: a choice that carries a command payload runs that slash command as
    // the user's own message (through the normal inbound/command path, after
    // all of the checks above); every other choice stays "[tapped] <label>".
    try {
      const message: InboundMessage = {
        channel: prompt.channel,
        ...(prompt.topic && prompt.topic !== 'general' ? { topic: prompt.topic } : {}),
        sender: String(query.from.id),
        reply_to: prompt.bus_message_id,
        payload: { type: 'text', body: result.body },
        metadata: {
          ...result.metadata,
          ...(chat !== undefined && messageId !== undefined
            ? {
                telegram_chat_id: chat,
                telegram_message_id: messageId,
                platform_message_id: `${chat}:${messageId}`,
              }
            : {}),
        },
      };
      await processInbound(message, this.deps);
      this.lastActivity = new Date().toISOString();
    } catch (err) {
      console.error(`${this.tag} Failed to deliver choice ${promptId}: ${String(err)}`);
      this.choiceStore.reopen(promptId);
      await answer('Failed — try again');
      return;
    }

    if (chat !== undefined && messageId !== undefined) {
      // E81 buttons v2: keep the chosen button, disabled, instead of dropping the keyboard;
      // E74 prompts (plain labels) and any failure of the new edit keep the "You chose" text.
      const kept = prompt.buttons ? await this.keepChosenButton(chat, messageId, result.label, prompt.buttons[index]) : false;
      if (!kept) await this.editChoiceMessage(chat, messageId, query.message?.text, result.label);
      this.choiceStore.clearMessageRef(promptId);
    }
    await answer(`Chose: ${result.label}`.slice(0, 200));
  }

  /** Replaces the keyboard with just the chosen button, disabled (Bot API 10.3 `DisabledButton`). False if Telegram refused. */
  private async keepChosenButton(chatId: number, messageId: number, label: string, attrs: ChoiceButtonAttrs | null | undefined): Promise<boolean> {
    try {
      await this.callTelegram('editMessageReplyMarkup', {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: {
          inline_keyboard: [[{ text: `✓ ${label}`.slice(0, 64), disabled: {}, ...(attrs?.style ? { style: attrs.style } : {}) }]],
        },
      });
      return true;
    } catch (err) {
      console.warn(`${this.tag} Could not keep the chosen button disabled on ${chatId}:${messageId}, falling back: ${String(err)}`);
      return false;
    }
  }

  /** Appends "You chose: <label>" to the prompt message and removes its buttons; falls back to just removing them. */
  private async editChoiceMessage(chatId: number, messageId: number, text: string | undefined, label: string): Promise<void> {
    const suffix = `\n\nYou chose: ${label}`;
    try {
      if (text) {
        await this.callTelegram('editMessageText', {
          chat_id: chatId,
          message_id: messageId,
          text: text.slice(0, 4096 - suffix.length) + suffix,
          reply_markup: { inline_keyboard: [] },
        });
      } else {
        await this.clearKeyboard(chatId, messageId);
      }
    } catch (err) {
      console.error(`${this.tag} Failed to edit choice message ${chatId}:${messageId}: ${String(err)}`);
    }
  }

  // ── Interactive approvals (E51) ───────────────────────────────────────────

  /**
   * Sends the Approve/Deny inline keyboard for `request` to the addressed
   * contact's DM — deliberately not the conversation's own chat, so a tool
   * summary from a group-topic session (a shell command, a file path) isn't
   * shown to the rest of that group. The stored message id is
   * "{chatId}:{messageId}", the same encoding as `platform_message_id`.
   */
  async notifyApproval(request: ApprovalRequest): Promise<{ channel: string; messageId: string }> {
    const chatId = this.resolveChatId(request.contact_id);
    if (chatId === undefined) {
      throw new Error(`no Telegram chat known for contact "${request.contact_id}"`);
    }
    const sent = await this.callTelegram<TelegramMessage>('sendMessage', {
      chat_id: chatId,
      text: renderApprovalPending(request),
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Approve', callback_data: `approve:${request.id}` },
            { text: 'Deny', callback_data: `deny:${request.id}` },
          ],
        ],
      },
    });
    return { channel: this.id, messageId: `${chatId}:${sent.message_id}` };
  }

  /** Replaces a resolved request's buttons with its outcome — the sweep's path for requests nobody tapped. */
  async finalizeApproval(request: ApprovalRequest): Promise<void> {
    const ref = request.notify_message_id?.split(':');
    if (!ref || ref.length !== 2) return;
    await this.editApprovalMessage(Number(ref[0]), Number(ref[1]), request);
  }

  /**
   * Edits an approval message to its terminal text with no keyboard. A 400
   * ("message is not modified" when the tap path already edited it, or the
   * message was deleted) means there is nothing left to clean up, so it is
   * swallowed — otherwise the sweep would retry the same message forever.
   */
  private async editApprovalMessage(chatId: number, messageId: number, request: ApprovalRequest): Promise<void> {
    try {
      await this.callTelegram('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: renderApprovalOutcome(request),
        reply_markup: { inline_keyboard: [] },
      });
    } catch (err: unknown) {
      if ((err as { status?: number }).status !== 400) throw err;
    }
  }

  /**
   * Handles an Approve/Deny tap. Only the contact the request was addressed
   * to may answer — an allow-listed sender is not enough, since a forwarded
   * message or a shared chat would otherwise let anyone on the allow list
   * resolve someone else's pending tool call. Always returns true so a bad
   * tap never wedges the update offset.
   */
  private async processCallbackQuery(query: TelegramCallbackQuery): Promise<boolean> {
    const answer = (text: string) =>
      this.callTelegram('answerCallbackQuery', { callback_query_id: query.id, text }).catch((err) =>
        console.error(`${this.tag} answerCallbackQuery failed: ${String(err)}`),
      );

    const choiceMatch = query.data?.match(/^choice:([0-9a-f-]{36}):(\d{1,2})$/);
    const match = choiceMatch ? null : query.data?.match(/^(approve|deny):([0-9a-f-]{36})$/);
    if (!choiceMatch && !match) {
      await answer('Unrecognized action');
      return true;
    }

    const senderId = String(query.from.id);
    const contactId = [...this.contactChatIdMap.entries()].find(([, userId]) => String(userId) === senderId)?.[0];
    if (!this.allowedSenderIds.has(senderId) || !contactId) {
      console.log(`${this.tag} Dropped ${choiceMatch ? 'choice' : 'approval'} tap from unknown sender ${senderId}`);
      await answer('Not authorized');
      return true;
    }
    if (choiceMatch) {
      try {
        await this.processChoiceTap(query, choiceMatch[1]!, Number(choiceMatch[2]), contactId, answer);
      } catch (err) {
        console.error(`${this.tag} Failed to handle choice tap: ${String(err)}`);
        await answer('Failed — try again');
      }
      return true;
    }
    const [, decision, requestId] = match as unknown as [string, ApprovalDecision, string];
    if (!this.deps.resolveApproval) {
      await answer('Approvals are not enabled');
      return true;
    }

    try {
      const result = await this.deps.resolveApproval(requestId, decision, `contact:${contactId}`, contactId);
      if (result.outcome === 'not_found' || result.outcome === 'forbidden') {
        if (result.outcome === 'forbidden') {
          console.error(`${this.tag} Approval ${requestId} tapped by ${contactId} but addressed to another contact`);
        }
        await answer(result.outcome === 'forbidden' ? 'Not authorized' : 'Request not found');
        return true;
      }
      const chat = query.message?.chat.id;
      if (chat !== undefined && query.message) {
        await this.editApprovalMessage(chat, query.message.message_id, result.request);
      }
      const labels: Record<Exclude<ResolveApprovalOutcome['outcome'], 'not_found' | 'forbidden'>, string> = {
        approved: 'Approved',
        denied: 'Denied',
        already_resolved: `Already ${result.outcome === 'already_resolved' ? result.request.status : 'handled'}`,
        expired: 'Request expired',
        stale: 'Prompt is no longer waiting — nothing sent',
      };
      await answer(labels[result.outcome]);
    } catch (err) {
      console.error(`${this.tag} Failed to resolve approval ${requestId}: ${String(err)}`);
      await answer('Failed — try again or answer at the terminal');
    }
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

  /** Multipart variant of callTelegram, for file uploads. */
  private async callTelegramForm<T>(method: string, form: FormData): Promise<T> {
    const res = await fetch(`${TELEGRAM_API_BASE}/bot${this.token}/${method}`, { method: 'POST', body: form });
    const data = (await res.json()) as TelegramApiResponse<T>;
    if (!res.ok || !data.ok) {
      throw Object.assign(new Error(`Telegram API error: ${data.description ?? res.status}`), { status: res.status });
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

  /**
   * Record a forum topic's name / pinned message from a service message.
   * Returns true when `msg` was such a service message (fully handled).
   * Pure local DB work; never throws into the inbound loop.
   */
  private captureTopicServiceMessage(msg: TelegramMessage, channel: string): boolean {
    const isPin = !!msg.pinned_message;
    const created = msg.forum_topic_created?.name;
    const edited = msg.forum_topic_edited;
    if (!isPin && !created && !edited) return false;
    // Topic id: service messages inside a topic carry message_thread_id; a
    // creation message is the topic root, whose id is the topic id.
    const threadId = msg.message_thread_id ?? (created ? msg.message_id : undefined);
    if (threadId === undefined || msg.chat.type === 'private') return true;
    try {
      const threadKey = `${msg.chat.id}:${threadId}`;
      const topic = topicForThreadKey(threadKey);
      const existing = getThread<TelegramThreadMetadata>(this.deps.db, channel, topic);
      const metadata: TelegramThreadMetadata = {
        ...(existing?.metadata ?? {}),
        chatId: msg.chat.id,
        messageThreadId: threadId,
      };
      const newName = created ?? edited?.name;
      if (newName) metadata.topicName = newName;
      if (msg.pinned_message) {
        const text = (msg.pinned_message.text ?? msg.pinned_message.caption ?? '').trim();
        // An inaccessible/non-text pin still replaces any older pin, so a
        // stale pin is never presented as current.
        if (text) metadata.pinnedText = text;
        else delete metadata.pinnedText;
      }
      upsertThread<TelegramThreadMetadata>(this.deps.db, { channel, topic, threadKey, metadata });
    } catch (err) {
      console.error(`${this.tag} Failed to record forum topic service message: ${String(err)}`);
    }
    return true;
  }

  /**
   * AdapterInstance.getTopicContext — the "[Topic context]" block for a forum
   * topic's new session: its name and pinned-message text, from what
   * captureTopicServiceMessage / processUpdate persisted. Null when the topic
   * is unknown or has neither. Synchronous local read: cannot block delivery.
   */
  getTopicContext(channel: string, topic: string): string | null {
    if (!this.ownsChannel(channel)) return null;
    try {
      const thread = getThread<TelegramThreadMetadata>(this.deps.db, channel, topic);
      const { topicName, pinnedText } = thread?.metadata ?? {};
      if (!topicName && !pinnedText) return null;
      const lines = ['[Topic context]'];
      if (topicName) lines[0] += ` Topic: ${topicName}`;
      if (pinnedText) {
        const pin = pinnedText.length > TOPIC_PIN_MAX_CHARS
          ? `${pinnedText.slice(0, TOPIC_PIN_MAX_CHARS)}… [truncated]`
          : pinnedText;
        lines.push(`Pinned: ${pin}`);
      }
      return lines.join('\n');
    } catch (err) {
      console.error(`${this.tag} getTopicContext failed: ${String(err)}`);
      return null;
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

    if (update.callback_query) {
      return this.processCallbackQuery(update.callback_query);
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

    // Forum-topic service messages (pin / create / rename) carry no body but
    // are the only way the Bot API tells us a topic's name and pinned
    // message. Capture them (after the allowlist check, so only trusted
    // members' pins can reach an agent's context) and stop — nothing to
    // deliver.
    if (this.captureTopicServiceMessage(msg, channel)) return true;

    // Detect an inbound image or file attachment.
    const attachmentSource = this.extractAttachmentSource(msg);

    // E81 ask_input answers: a shared location, contact or picked user arrives as
    // a structured message with no text.
    const shared = this.describeSharedPayload(msg);
    const body = msg.text ?? msg.caption ?? shared?.body ?? '';
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
      // Preserves the captured topic name / pin (they are not one-shot).
      const rootName = msg.reply_to_message?.forum_topic_created?.name;
      upsertThread<TelegramThreadMetadata>(this.deps.db, {
        channel,
        topic,
        threadKey,
        metadata: {
          chatId: msg.chat.id,
          messageThreadId: msg.message_thread_id,
          ...((rootName ?? existingThread?.metadata.topicName) ? { topicName: rootName ?? existingThread!.metadata.topicName } : {}),
          ...(existingThread?.metadata.pinnedText ? { pinnedText: existingThread.metadata.pinnedText } : {}),
        },
      });
    }

    // Quoted reply context (E28) — a user quote-replying to a message is a
    // conversational gesture, not a request to fork a session: surfaced to
    // the agent as context only, via metadata.quoted_message. Never touches
    // topic/thread routing (computed independently above).
    // In a forum topic, a message with no explicit reply targets the topic
    // root, which Telegram reports as reply_to_message (the creation service
    // message) — that is not a user quote.
    const quoted = msg.reply_to_message?.forum_topic_created ? undefined : msg.reply_to_message;
    const quotedMessage = quoted
      ? {
          platform_message_id: `${msg.chat.id}:${quoted.message_id}`,
          sender_name: quoted.from?.first_name,
          text: (quoted.text ?? quoted.caption ?? '').slice(0, 200),
        }
      : undefined;

    const answeredPrompt = this.matchInputPrompt(msg, shared, this.contactForSender(senderId));

    try {
      const message: InboundMessage = {
        channel,
        ...(topic ? { topic } : {}),
        sender: senderId,
        ...(answeredPrompt?.bus_message_id ? { reply_to: answeredPrompt.bus_message_id } : {}),
        payload: { type: 'text', body: effectiveBody },
        metadata: {
          ...(shared?.metadata ?? {}),
          ...(answeredPrompt ? { input_prompt_id: answeredPrompt.id, input_kind: answeredPrompt.kind } : {}),
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
      if (answeredPrompt) {
        this.inputStore.markAnswered(answeredPrompt.id);
        if (answeredPrompt.keyboard) {
          this.finalizeInputPrompt(answeredPrompt)
            .then(() => this.inputStore.clearKeyboard(answeredPrompt.id))
            .catch((err) => console.error(`${this.tag} Could not remove the reply keyboard: ${String(err)}`));
        }
      }
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
          allowed_updates: ['message', 'message_reaction', 'callback_query'],
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

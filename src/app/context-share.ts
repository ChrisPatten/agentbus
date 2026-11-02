import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getTelegramInstances, type AppConfig } from '../config/schema.js';
import type { Origin } from '../core/origin.js';
import { CONTEXT_ONLY_KEY } from '../core/system-block.js';
import { computeConversationId } from '../pipeline/conversation-id.js';
import { logOutboundTranscript } from '../pipeline/outbound-transcript.js';
import { MAIN_TOPIC, pendingContextAgent, primaryChannels } from './main.js';
import { ensureOutboundAppSession, ensurePrimarySession, validateAppDestination } from './outbound.js';
import { pendingContextLimits, pendingItemLine } from './pending-context.js';
import { routedTarget } from './store.js';

/**
 * E82, E83 — `share_context`: a hidden handoff into a primary conversation.
 *
 * Writes one outbound transcript row flagged `metadata.context_only` straight
 * into the contact's primary conversation: Main (`channel: 'app'`, E82) or a
 * channel an agent lists in `pending_context.channels`, such as its Telegram
 * DM (E83). There is no `message_queue` row, no delivery and no adapter send,
 * and the row touches neither `last_activity` nor `message_count`, so the
 * user sees nothing and the agent isn't woken. The row joins the
 * conversation's newest session row, open or ended (after an idle rotation or
 * eviction the next turn starts a new one), and changes nothing on it. Only a
 * conversation with no session row at all gets one created: Main's visible
 * event (E82), or a placeholder for a Telegram DM (`ensurePrimarySession`).
 * The agent's next turn reads the note through pending context (E69) in its
 * own section, and journaling windows keep it. The reserved key is stripped
 * at every ingress (`stripSystemMetadata`), so this is the only writer.
 */

/** The caller's origin as stamped by its MCP server (`originFromEnv`) or the bus (`paneTurnOrigin`); a label is replaced by `source`. */
export type ShareOrigin =
  | { kind: 'turn'; agent_id: string; conversation_id: string; label?: string }
  | { kind: 'external'; label?: string };

export interface ShareContextRequest {
  /** Bare contact id (the `contact:` prefix already removed). */
  contactId: string;
  body: string;
  /** Required label naming where the note came from; shown to the agent. */
  source: string;
  /** `app` (Main, the default) or a primary channel such as `telegram:peggy`. */
  channel?: string;
  /**
   * A Telegram forum topic of `channel`'s bot: its `thread:<hash>` id, or its name as captured in the
   * `threads` store. The note goes to that topic's conversation instead of the DM. Telegram channels only.
   */
  topic?: string;
  origin?: ShareOrigin;
}

export type ShareContextResult =
  | { ok: true; messageId: string; conversationId: string; sessionId: string; topic?: string }
  | { ok: false; status: 400 | 409 | 413; error: string };

/** Runtimes that read pending context: cc-headless in `runBatch`, cc-pool through the pipeline stage. */
const READS_PENDING_CONTEXT = new Set(['cc-headless', 'cc-pool']);

/** One line, no markers: the label sits in the middle of a rendered item line. */
export function normalizeSource(source: string): string {
  return source.replace(/\s+/g, ' ').trim();
}

const THREAD_ID_RE = /^thread:[0-9a-f]{16}$/;

export type ResolvedTopic = { ok: true; channel: string; topic: string; name?: string } | { ok: false; error: string };

/**
 * Resolve a forum topic of the Telegram bot `botChannel` to the (group channel, `thread:<hash>`) pair its
 * inbound messages carry. The adapter records every topic it sees or creates in the `threads` store under the
 * derived group channel (`<bot>:group:<chatId>`), with the captured name in `metadata.topicName`; the
 * conversation key is `computeConversationId(contact, groupChannel, topic)`, exactly as route-resolve builds it.
 */
export function resolveTelegramTopic(db: Database.Database, botChannel: string, topicArg: string): ResolvedTopic {
  const wanted = topicArg.trim();
  if (!wanted) return { ok: false, error: 'topic must not be empty' };
  const rows = db.prepare('SELECT channel, topic, metadata FROM threads').all() as Array<{ channel: string; topic: string; metadata: string }>;
  const inBot = rows.filter((r) => r.channel.startsWith(`${botChannel}:group:`));
  const nameOf = (r: { metadata: string }): string | undefined => {
    try { return (JSON.parse(r.metadata) as { topicName?: string }).topicName; } catch { return undefined; }
  };
  if (wanted.startsWith('thread:')) {
    if (!THREAD_ID_RE.test(wanted)) return { ok: false, error: `Malformed topic id "${wanted}": expected thread:<16 hex characters>, as returned by create_telegram_topic.` };
    const hit = inBot.find((r) => r.topic === wanted);
    if (!hit) return { ok: false, error: `Unknown topic "${wanted}" for ${botChannel}: no forum topic with that id has been seen or created by this bot.` };
    const name = nameOf(hit);
    return { ok: true, channel: hit.channel, topic: hit.topic, ...(name ? { name } : {}) };
  }
  const hits = inBot.filter((r) => nameOf(r)?.trim().toLowerCase() === wanted.toLowerCase());
  if (hits.length === 0) return { ok: false, error: `Unknown topic "${wanted}" for ${botChannel}: no forum topic with that name is known. Pass its thread:<hash> id instead.` };
  if (hits.length > 1) return { ok: false, error: `Topic name "${wanted}" is ambiguous (${hits.map((h) => h.topic).join(', ')}): pass the thread:<hash> id.` };
  return { ok: true, channel: hits[0]!.channel, topic: hits[0]!.topic, name: nameOf(hits[0]!)! };
}

export function shareContext(db: Database.Database, config: AppConfig, req: ShareContextRequest, now = new Date()): ShareContextResult {
  const channel = req.channel?.trim() || 'app';
  const isApp = channel === 'app';
  const topicArg = req.topic?.trim();
  if (topicArg && isApp) {
    return { ok: false, status: 400, error: 'topic is only valid with a Telegram channel (e.g. channel "telegram:peggy"); the app channel is Main.' };
  }
  const where = isApp ? 'Main' : channel;
  const source = normalizeSource(req.source);
  if (!source) return { ok: false, status: 400, error: 'source is required: name where this note comes from (e.g. "Claude Code: baxter")' };
  if (!req.body.trim()) return { ok: false, status: 400, error: 'body is required' };
  if (!Object.values(config.contacts).some((c) => c.id === req.contactId)) {
    return { ok: false, status: 400, error: `Unknown contact "${req.contactId}"` };
  }
  // Only Main and channels an agent opts in are targets, so a typo or a group chat can't swallow a note.
  if (!isApp && !primaryChannels(config).includes(channel)) {
    return { ok: false, status: 400, error: `Channel "${channel}" is not a primary channel: share_context reaches Main (channel app) ` +
      'and channels listed in agents.<id>.pending_context.channels, such as the agent\'s Telegram DM.' };
  }
  if (channel === 'telegram' || channel.startsWith('telegram:')) {
    const bot = getTelegramInstances(config).find((i) => (i.name ? `telegram:${i.name}` : 'telegram') === channel);
    if (!bot) return { ok: false, status: 400, error: `No Telegram bot is configured for channel "${channel}"` };
    // The adapter's own rule: a contact is the bot's (it can DM them) iff it has a Telegram identity.
    if (!Object.values(config.contacts).find((c) => c.id === req.contactId)?.platforms.telegram) {
      return { ok: false, status: 400, error: `Contact "${req.contactId}" has no Telegram identity (contacts.${req.contactId}.platforms.telegram), so ${channel} has no conversation with them` };
    }
  }
  if (topicArg && !(channel === 'telegram' || channel.startsWith('telegram:'))) {
    return { ok: false, status: 400, error: `topic is only valid with a Telegram channel, not "${channel}".` };
  }
  // With a topic the note lands in that forum topic's conversation: the group channel and thread id its inbound messages use.
  let convChannel = channel;
  let convTopic = MAIN_TOPIC;
  let topicName: string | undefined;
  if (topicArg) {
    const resolved = resolveTelegramTopic(db, channel, topicArg);
    if (!resolved.ok) return { ok: false, status: 400, error: resolved.error };
    convChannel = resolved.channel;
    convTopic = resolved.topic;
    topicName = resolved.name;
  }
  const route = routedTarget(config, req.contactId, convChannel);
  if (!route) return { ok: false, status: 400, error: `${isApp ? 'App channel' : `Channel "${convChannel}"`} is not routed for this contact` };
  const agentId = route.recipientId;
  // For any other runtime the note would sit unread.
  if (!READS_PENDING_CONTEXT.has(route.adapterId)) {
    return { ok: false, status: 400, error: `${where} is served by ${route.adapterId}, which does not read shared context: ` +
      `share_context only works when the route targets cc-headless or cc-pool. Use send_message instead.` };
  }
  if (isApp) {
    const target = validateAppDestination(db, req.contactId, agentId, MAIN_TOPIC);
    if (!target.ok) return { ok: false, status: 400, error: target.error };
  }

  const conversationId = computeConversationId(req.contactId, convChannel, convTopic);
  if (req.origin?.kind === 'turn' && req.origin.conversation_id === conversationId) {
    return { ok: false, status: 409, error: isApp
      ? 'share_context cannot be called from a turn in Main: Main already has this context. Use send_message if the operator should see something.'
      : topicArg
        ? `share_context cannot be called from a turn in the topic it targets (${topicName ?? convTopic}): that conversation already has this context. Use send_message if the user should see something.`
        : `share_context cannot be called from a turn in ${channel}: that conversation already has this context. Use send_message if the user should see something.` };
  }

  // Reject rather than truncate: the injected item is the whole rendered line, label and timestamp included.
  const { max_chars } = pendingContextLimits(config, pendingContextAgent(config, convChannel));
  const line = pendingItemLine({ id: '', message_id: '', created_at: now.toISOString(), body: req.body, label: source, kind: 'context' }, { now });
  if (line.length > max_chars) {
    return { ok: false, status: 413, error: `Context is too long: with its label and timestamp it takes ${line.length} characters ` +
      `and the limit is ${max_chars}. Summarize it and call share_context again.` };
  }

  const origin: Origin = req.origin?.kind === 'turn'
    ? { kind: 'turn', agent_id: req.origin.agent_id, conversation_id: req.origin.conversation_id, label: source }
    : { kind: 'external', label: source };
  const messageId = randomUUID();
  return db.transaction((): ShareContextResult => {
    // Attach to the conversation's newest row, open or ended, and touch nothing on it: a
    // new row would set `last_activity` and fire `app_session_created`, moving
    // Main in the sidebar. Only a conversation that has never had a row gets one.
    const existing = db.prepare(`SELECT id FROM sessions WHERE conversation_id = ?
      ORDER BY (ended_at IS NULL) DESC, started_at DESC, rowid DESC LIMIT 1`).get(conversationId) as { id: string } | undefined;
    const sessionId = existing?.id ?? (isApp
      ? ensureOutboundAppSession(db, req.contactId, agentId, MAIN_TOPIC)
      : ensurePrimarySession(db, req.contactId, convChannel, convTopic, agentId)).sessionId;
    logOutboundTranscript(db, {
      messageId, conversationId, sessionId, channel: convChannel, contactId: req.contactId, body: req.body,
      metadata: { origin, [CONTEXT_ONLY_KEY]: true }, silent: true,
    });
    return { ok: true, messageId, conversationId, sessionId, ...(topicArg ? { topic: convTopic } : {}) };
  })();
}

export type FollowedContextResult = { ok: true; messageId: string; conversationId: string } | { ok: false; error: string };

/**
 * E89 — a hidden context-only note in a conversation an Intercom surface
 * follows (a Telegram DM or a forum topic), so the agent's next turn there
 * reads it as pending context. Same row as `shareContext` writes, but the
 * target is the followed (channel, topic) rather than a primary channel, and
 * the topic is not `general`. Never creates an app item and wakes no one.
 */
export function shareContextToConversation(
  db: Database.Database, config: AppConfig,
  req: { contactId: string; channel: string; topic: string; body: string; source: string },
): FollowedContextResult {
  const route = routedTarget(config, req.contactId, req.channel);
  if (!route) return { ok: false, error: `Channel "${req.channel}" is not routed for ${req.contactId}` };
  if (!READS_PENDING_CONTEXT.has(route.adapterId)) return { ok: false, error: `${req.channel} is served by ${route.adapterId}, which does not read pending context` };
  const conversationId = computeConversationId(req.contactId, req.channel, req.topic);
  const source = normalizeSource(req.source);
  const messageId = randomUUID();
  db.transaction(() => {
    const existing = db.prepare(`SELECT id FROM sessions WHERE conversation_id = ?
      ORDER BY (ended_at IS NULL) DESC, started_at DESC, rowid DESC LIMIT 1`).get(conversationId) as { id: string } | undefined;
    const sessionId = existing?.id ?? ensurePrimarySession(db, req.contactId, req.channel, req.topic, route.recipientId).sessionId;
    logOutboundTranscript(db, {
      messageId, conversationId, sessionId, channel: req.channel, contactId: req.contactId, body: req.body,
      metadata: { origin: { kind: 'external', label: source } satisfies Origin, [CONTEXT_ONLY_KEY]: true }, silent: true,
    });
  })();
  return { ok: true, messageId, conversationId };
}

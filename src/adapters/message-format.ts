/**
 * Agent-turn message formatting, shared by the claude-code adapter (cc.ts)
 * and cc-headless. Pure: no config load, no I/O.
 */
import type { MessageEnvelope } from '../types/envelope.js';
import { isSystemOnly, neutralizeSystemMarkers, readSystemBlocks } from '../core/system-block.js';

function fmtTs(iso: string, full: boolean): string {
  const d = new Date(iso);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const get = (t: Intl.DateTimeFormatPartTypes) => p.find(x => x.type === t)?.value ?? '00';
  const hh = get('hour') === '24' ? '00' : get('hour');
  const time = `${hh}:${get('minute')}`;
  return full ? `${get('year')}-${get('month')}-${get('day')}T${time}` : time;
}

/**
 * E69 — absolute local datetime with its zone, e.g. "2026-10-05 11:06 EDT".
 * `timeZone` defaults to the process zone (as `fmtTs` uses). An unparseable
 * input is returned as-is.
 */
export function fmtLocalDateTime(iso: string, timeZone?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const tz = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short',
  }).formatToParts(d);
  const get = (t: Intl.DateTimeFormatPartTypes) => p.find(x => x.type === t)?.value ?? '00';
  const hh = get('hour') === '24' ? '00' : get('hour');
  return `${get('year')}-${get('month')}-${get('day')} ${hh}:${get('minute')} ${get('timeZoneName')}`;
}

/** E69 — coarse age of `iso` relative to `now`: "just now", "12m ago", "4h ago", "3d ago". */
export function fmtRelativeAge(iso: string, now: Date): string {
  const ms = now.getTime() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 60_000) return 'just now';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * Quoted reply context (E28) — a user quote-replying to a message. Telegram
 * quotes carry only `sender_name` and `text`. E69: app quotes may also carry
 * the target's `created_at` and `source` (its origin label, or "you" /
 * "agent"), rendered when present.
 */
function formatQuoteLine(quoted: Record<string, unknown>): string {
  const str = (k: string): string | undefined => typeof quoted[k] === 'string' && (quoted[k] as string).length > 0 ? quoted[k] as string : undefined;
  const text = str('text') ?? '';
  const createdAt = str('created_at');
  const source = str('source');
  if (!createdAt && !source) return `[Replying to ${str('sender_name') ?? 'someone'}: "${text}"]`;
  const who = source === 'agent' ? 'your message'
    : source === 'you' ? "the user's own message"
    : source ? `a message from ${source}`
    : `${str('sender_name') ?? 'someone'}'s message`;
  const when = createdAt ? ` sent ${fmtLocalDateTime(createdAt)}` : '';
  return `[Replying to ${who}${when}: "${text}"]`;
}

/**
 * Format a batch of message envelopes into a single string for delivery.
 * Each message becomes one paragraph; multiple messages in a batch are
 * separated by a blank line.
 */
export function formatMessagesForSampling(envelopes: MessageEnvelope[]): string {
  const parts: string[] = [];

  // Bus-originated system blocks (E65) go first, deduplicated across the
  // batch. Everything after them is neutralized (see src/core/system-block.ts),
  // so no message text can open or close a block of its own.
  const systemBlocks = [...new Set(envelopes.flatMap((env) => readSystemBlocks(env.metadata)))];

  const firstMeta = envelopes[0]?.metadata;

  // One-shot context injected by create_telegram_topic (E28) for a brand-new
  // topic's first turn.
  const topicContext = firstMeta?.injected_topic_context;
  if (typeof topicContext === 'string' && topicContext.length > 0) {
    parts.push(`[Context for this new topic, provided when it was created]\n${topicContext}`);
    delete firstMeta!['injected_topic_context'];
  }

  // Topic name + pinned message, stamped by the topic-context-inject stage on
  // the first message of a new session. User-authored text, so neutralized.
  const sessionTopicContext = firstMeta?.['topic_context'];
  if (typeof sessionTopicContext === 'string' && sessionTopicContext.length > 0) {
    parts.push(sessionTopicContext);
  }

  for (let i = 0; i < envelopes.length; i++) {
    const env = envelopes[i]!;
    let body: string;
    if (env.payload.type === 'text') {
      body = env.payload.body;
    } else if (env.payload.type === 'reaction') {
      const verb = env.payload.removed ? 'removed reaction' : 'reacted';
      body = `[${verb} ${env.payload.emoji} to message ${env.payload.target_message_id}]`;
    } else {
      body = `[${(env.payload as { type: string }).type}]`;
    }
    // Quoted reply context (E28), rendered as a context line before the body
    // (same precedent as the reaction line above), never affecting which
    // session/topic the message routed to.
    const quoted = env.metadata?.['quoted_message'];
    if (quoted && typeof quoted === 'object') {
      body = `${formatQuoteLine(quoted as Record<string, unknown>)}\n${body}`;
    }
    const ts = env.timestamp ? ` at ${fmtTs(env.timestamp, i === 0)}` : '';
    // Append [Image: ...] and [File: ...] lines after the body so the agent can
    // read any attached files. Empty-body attachment-only messages become just
    // the attachment line(s).
    const attachments = extractAttachments(env.metadata);
    const attachmentLines = attachments
      .map((a) => {
        if (a.type === 'image') return `[Image: ${a.local_path}]`;
        const label = a.original_filename ? ` — ${a.original_filename}` : '';
        return `[File: ${a.local_path}${label}]`;
      })
      .join('\n');
    // Inline (HTML-embedded) email images are not downloaded into the body;
    // surface a hint with the id so the agent can pull one in via fetch_attachment.
    const inlineLines = extractInlineAttachments(env.metadata)
      .map((a) => {
        const name = a.original_filename ? ` ${a.original_filename}` : '';
        return `[Inline image available${name} — fetch with fetch_attachment(id="${a.id}")]`;
      })
      .join('\n');
    const extraLines = [attachmentLines, inlineLines].filter(Boolean).join('\n');
    const bodyWithImages = body && extraLines ? `${body}\n${extraLines}` : body || extraLines;
    const sessionChannel = env.metadata?.['session_channel'];
    const routeLabel = typeof sessionChannel === 'string' && sessionChannel !== env.channel
      ? `via ${env.channel} (in your ${sessionChannel} session)`
      : `via ${env.channel} (topic: ${env.topic})`;
    // A system-only envelope (E65) carries no human message: only its blocks.
    if (isSystemOnly(env.metadata)) continue;
    parts.push(`New message from ${env.sender} ${routeLabel}${ts} [id:${env.id}]:\n${bodyWithImages}`);
  }

  return [...systemBlocks, ...parts.map(neutralizeSystemMarkers)].join('\n\n');
}

/**
 * Pull attachments out of envelope.metadata. Tolerant of shape drift: anything
 * that is not an object with a known `type` and a string `local_path` is ignored.
 */
function extractAttachments(
  metadata: Record<string, unknown> | undefined,
): Array<{ type: 'image' | 'file'; local_path: string; original_filename?: string }> {
  const raw = metadata?.['attachments'];
  if (!Array.isArray(raw)) return [];
  const out: Array<{ type: 'image' | 'file'; local_path: string; original_filename?: string }> = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const { type, local_path, original_filename } = item as Record<string, unknown>;
    if ((type === 'image' || type === 'file') && typeof local_path === 'string') {
      out.push({
        type,
        local_path,
        ...(typeof original_filename === 'string' ? { original_filename } : {}),
      });
    }
  }
  return out;
}

/**
 * Pull inline-attachment references out of envelope.metadata.inline_attachments.
 * These carry only an id (not a path) — the agent fetches them on demand via the
 * fetch_attachment tool. Tolerant of shape drift, like extractAttachments.
 */
function extractInlineAttachments(
  metadata: Record<string, unknown> | undefined,
): Array<{ id: string; original_filename?: string }> {
  const raw = metadata?.['inline_attachments'];
  if (!Array.isArray(raw)) return [];
  const out: Array<{ id: string; original_filename?: string }> = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const { id, original_filename } = item as Record<string, unknown>;
    if (typeof id === 'string') {
      out.push({
        id,
        ...(typeof original_filename === 'string' ? { original_filename } : {}),
      });
    }
  }
  return out;
}

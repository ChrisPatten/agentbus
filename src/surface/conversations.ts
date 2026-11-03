/**
 * E96 S96.7 — the Conversation view: `GET /api/v1/surface/conversations/{id}` data and
 * live appends.
 *
 * Source is the `transcripts` table (every inbound message the pipeline logged, every
 * delivered outbound message), across all sessions of the conversation. Text only:
 *
 *   shown     inbound rows (role `user`) and outbound rows (role `agent`).
 *   hidden    `system_only` turns (E65/E66), `context_only` handoffs (E82), bus notices
 *             (`bus_notice`), Intercom echoes (`intercom_echo`), scheduled fires
 *             (`scheduled`: the routine's prompt, not something Chris wrote), reaction rows
 *             (`[reaction:...]`) and empty bodies. The transcript holds no tool output.
 *
 * Text longer than {@link MAX_MESSAGE_TEXT} characters is cut and ends with `…`.
 *
 * Paging: newest page first, messages chronological within the page. The cursor is a
 * message id (`transcripts.message_id`); order is `(created_at, rowid)` so equal timestamps
 * page stably. `next_before` is the oldest message on the page when older ones exist.
 */
import type Database from 'better-sqlite3';
import { conversationTitle } from '../intercom/desk.js';
import type { MessageEnvelope } from '../types/envelope.js';
import { getAnswerNeeded } from './flags.js';
import { pipelineConversationId } from './answer-needed.js';
import { BOUNDS, type ConversationMessage, type ConversationPage } from './types.js';

export const DEFAULT_PAGE_LIMIT = 30;
export const MAX_PAGE_LIMIT = 100;
/** Longest message text sent to a device; longer text is cut to this length including the trailing `…`. */
export const MAX_MESSAGE_TEXT = BOUNDS.draft;

/** SQL (transcripts aliased `t`): rows the Conversation view shows. */
const VISIBLE = `COALESCE(json_extract(t.metadata, '$.system_only'), 0) = 0
  AND COALESCE(json_extract(t.metadata, '$.context_only'), 0) = 0
  AND COALESCE(json_extract(t.metadata, '$.bus_notice'), 0) = 0
  AND COALESCE(json_extract(t.metadata, '$.intercom_echo'), 0) = 0
  AND COALESCE(json_extract(t.metadata, '$.scheduled'), 0) = 0
  AND t.body NOT LIKE '[reaction:%'
  AND trim(t.body) <> ''`;

const HIDDEN_META = ['system_only', 'context_only', 'bus_notice', 'intercom_echo', 'scheduled'] as const;

export function clipText(text: string): string {
  const chars = Array.from(text);
  return chars.length > MAX_MESSAGE_TEXT ? `${chars.slice(0, MAX_MESSAGE_TEXT - 1).join('')}…` : text;
}

interface Row { rowid: number; message_id: string; direction: string; body: string; created_at: string }

/** Open, unexpired choice buttons per bus message id (callback buttons only: copy/link buttons cannot be tapped from a surface). */
function openButtons(db: Database.Database, messageIds: string[], nowIso: string): Map<string, { index: number; label: string }[]> {
  const out = new Map<string, { index: number; label: string }[]>();
  if (messageIds.length === 0) return out;
  let rows: { bus_message_id: string; labels: string; buttons: string | null }[] = [];
  try {
    rows = db.prepare(`SELECT bus_message_id, labels, buttons FROM choice_prompts
      WHERE status = 'open' AND expires_at > ? AND bus_message_id IN (SELECT value FROM json_each(?))
      ORDER BY created_at`).all(nowIso, JSON.stringify(messageIds)) as typeof rows;
  } catch { return out; }
  for (const r of rows) {
    let labels: unknown[] = [];
    let attrs: ({ copy_text?: string; url?: string } | null)[] = [];
    try { labels = JSON.parse(r.labels) as unknown[]; } catch { continue; }
    try { attrs = r.buttons ? JSON.parse(r.buttons) as typeof attrs : []; } catch { attrs = []; }
    const list = labels
      .map((label, index) => ({ index, label: String(label) }))
      .filter(({ index }) => { const a = attrs[index]; return !a || (a.copy_text === undefined && a.url === undefined); });
    if (list.length) out.set(r.bus_message_id, list);   // newest open prompt on a message wins
  }
  return out;
}

/**
 * One page of a conversation, or null when the conversation is unknown (no registry row
 * and no transcript). An unknown `before` cursor yields an empty page (`next_before: null`).
 */
export function getConversationPage(
  db: Database.Database,
  opts: { conversationId: string; before?: string | null; limit?: number; now?: Date },
): ConversationPage | null {
  const { conversationId } = opts;
  const limit = Math.min(MAX_PAGE_LIMIT, Math.max(1, Math.floor(opts.limit ?? DEFAULT_PAGE_LIMIT)));
  const nowIso = (opts.now ?? new Date()).toISOString();
  const known = db.prepare(`SELECT 1 FROM conversation_registry WHERE id = ?`).get(conversationId)
    ?? db.prepare(`SELECT 1 FROM transcripts WHERE conversation_id = ? LIMIT 1`).get(conversationId);
  if (!known) return null;
  const title = conversationTitle(db, conversationId, 'Conversation').title;

  let cursor: { created_at: string; rowid: number } | undefined;
  if (opts.before) {
    cursor = db.prepare(`SELECT created_at, rowid FROM transcripts WHERE conversation_id = ? AND message_id = ?
      ORDER BY created_at, rowid LIMIT 1`).get(conversationId, opts.before) as typeof cursor;
    if (!cursor) return { conversation_id: conversationId, title, messages: [], next_before: null };
  }

  const rows = db.prepare(`SELECT t.rowid AS rowid, t.message_id, t.direction, t.body, t.created_at FROM transcripts t
    WHERE t.conversation_id = ? AND ${VISIBLE}
      AND (? IS NULL OR t.created_at < ? OR (t.created_at = ? AND t.rowid < ?))
    ORDER BY t.created_at DESC, t.rowid DESC LIMIT ?`)
    .all(conversationId, cursor ? 1 : null, cursor?.created_at ?? null, cursor?.created_at ?? null, cursor?.rowid ?? 0, limit + 1) as Row[];

  const more = rows.length > limit;
  const page = rows.slice(0, limit).reverse();
  const buttons = openButtons(db, page.filter((r) => r.direction === 'outbound').map((r) => r.message_id), nowIso);
  const flag = getAnswerNeeded(db, conversationId);
  const messages = page.map((r): ConversationMessage => {
    const m: ConversationMessage = {
      id: r.message_id,
      role: r.direction === 'outbound' ? 'agent' : 'user',
      text: clipText(r.body),
      created_at: r.created_at,
    };
    const b = r.direction === 'outbound' ? buttons.get(r.message_id) : undefined;
    if (b) m.buttons = b;
    if (flag && flag.message_id === r.message_id) m.answer_needed = true;
    return m;
  });
  return { conversation_id: conversationId, title, messages, next_before: more && page.length ? page[0]!.message_id : null };
}

/**
 * The conversation an envelope belongs to, computed the pipeline's way: inbound from the
 * sender, outbound from the recipient (the contact), topic defaulting to `general`.
 * Null for agent-to-agent or bus-internal traffic.
 */
export function conversationIdForEnvelope(envelope: Pick<MessageEnvelope, 'sender' | 'recipient' | 'channel' | 'topic'>): string | null {
  const inbound = envelope.sender.startsWith('contact:');
  const contact = inbound ? envelope.sender : envelope.recipient;
  if (!contact.startsWith('contact:')) return null;
  return pipelineConversationId(contact, envelope.channel, envelope.topic);
}

/**
 * A live append for devices viewing the envelope's conversation (`view` =
 * `conversation:<conversationIdForEnvelope(envelope)>`), or null when the Conversation view
 * would not show it (same rules as the page). Call from the delivery hook (outbound) and
 * after the inbound pipeline logged the message. `buttons` / `answer_needed` reflect the DB
 * when `db` is given (call after the prompt / flag was written).
 */
export function messageForLiveAppend(envelope: MessageEnvelope, db?: Database.Database, now: Date = new Date()): ConversationMessage | null {
  if (envelope.payload.type !== 'text') return null;
  const meta = envelope.metadata ?? {};
  if (HIDDEN_META.some((k) => meta[k] === true)) return null;
  const body = envelope.payload.body;
  if (!body.trim() || body.startsWith('[reaction:')) return null;
  const inbound = envelope.sender.startsWith('contact:');
  if (!inbound && !envelope.sender.startsWith('agent:')) return null;   // bus notices, system senders
  const m: ConversationMessage = {
    id: envelope.id,
    role: inbound ? 'user' : 'agent',
    text: clipText(body),
    created_at: envelope.timestamp || now.toISOString(),
  };
  if (db && !inbound) {
    const b = openButtons(db, [envelope.id], now.toISOString()).get(envelope.id);
    if (b) m.buttons = b;
    const cid = conversationIdForEnvelope(envelope);
    if (cid && getAnswerNeeded(db, cid)?.message_id === envelope.id) m.answer_needed = true;
  }
  return m;
}

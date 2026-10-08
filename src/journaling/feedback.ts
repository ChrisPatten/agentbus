/**
 * Feedback events (E68 S68.2): signals that the agent went wrong, recorded
 * for its journalers. See docs/AGENT_LEARNING.md#feedback-events.
 *
 *   denied-approval  an approval request was denied (E51 resolution path,
 *                    including denied self-edit proposals)
 *   user-feedback    `/feedback <text>`: acknowledged at once, never delivered
 *                    to the agent as a message, journaled with the next run
 *   tool-error       a tool call failed in a cc-headless turn, or a message
 *                    the agent sent could not be delivered
 *   lapsed-proposal  a self-edit proposal went stale (the file changed) or
 *                    expired unanswered; the agent may re-propose (migration 034)
 *
 * Session journal runs get the unconsumed events of their conversation and
 * consume them on success. `denied-approval` and `user-feedback` make the
 * session eligible without `min_human_messages` (tool errors are too
 * frequent for that). Consolidation gets counts across conversations.
 * Table from migration 032.
 */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

export const FEEDBACK_KINDS = ['denied-approval', 'user-feedback', 'tool-error', 'lapsed-proposal'] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

/** Kinds that make a session eligible to journal immediately (bypassing min_human_messages). */
export const BYPASS_KINDS: ReadonlySet<FeedbackKind> = new Set<FeedbackKind>(['denied-approval', 'user-feedback']);

/** Max stored length of an event's text. */
export const MAX_FEEDBACK_TEXT = 2000;
/** `feedback_events` retention. */
export const FEEDBACK_RETENTION_DAYS = 90;

export interface FeedbackInput {
  /** Prefixed logical agent id (callers map pane ids to their pool). */
  agentId: string;
  kind: FeedbackKind;
  text: string;
  conversationId?: string | null;
  sessionId?: string | null;
  refMessageId?: string | null;
  contactId?: string | null;
  detail?: Record<string, unknown>;
}

export interface FeedbackEventRow {
  id: string;
  agent_id: string;
  kind: FeedbackKind;
  conversation_id: string | null;
  session_id: string | null;
  ref_message_id: string | null;
  contact_id: string | null;
  text: string;
  detail: string | null;
  created_at: string;
  consumed_by_run: string | null;
  consumed_at: string | null;
}

/** One event as journalers receive it (`JournalJob.feedback`, script `feedback[]`). */
export interface FeedbackItem {
  id: string;
  kind: FeedbackKind;
  created_at: string;
  text: string;
  /** Bus message id of the agent message it refers to, when known. */
  ref_message_id: string | null;
  contact_id: string | null;
  detail: Record<string, unknown> | null;
}

/** Cross-conversation summary for consolidation. */
export interface FeedbackSummary {
  since: string | null;
  counts: Record<FeedbackKind, number>;
  /** Events grouped by kind and text, most frequent first (at most `limit`). */
  recurring: Array<{ kind: FeedbackKind; text: string; count: number; conversations: number; first_at: string; last_at: string }>;
}

const AGENT_PREFIX = 'agent:';
const toPrefixed = (id: string) => (id.startsWith(AGENT_PREFIX) ? id : `${AGENT_PREFIX}${id}`);

function parseDetail(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function toFeedbackItem(row: FeedbackEventRow): FeedbackItem {
  return {
    id: row.id, kind: row.kind, created_at: row.created_at, text: row.text,
    ref_message_id: row.ref_message_id, contact_id: row.contact_id, detail: parseDetail(row.detail),
  };
}

/** Grouping key for recurring feedback: case- and whitespace-insensitive. */
const groupKey = (kind: string, text: string) => `${kind}\u0000${text.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 200)}`;

export class FeedbackStore {
  private listeners: Array<(row: FeedbackEventRow) => void> = [];

  constructor(private readonly db: Database.Database, private readonly now: () => Date = () => new Date()) {}

  /** Called after every recorded event (the engine re-arms the conversation's evaluation). */
  onRecorded(listener: (row: FeedbackEventRow) => void): void {
    this.listeners.push(listener);
  }

  record(input: FeedbackInput): FeedbackEventRow {
    const text = input.text.trim();
    const row: FeedbackEventRow = {
      id: randomUUID(),
      agent_id: toPrefixed(input.agentId),
      kind: input.kind,
      conversation_id: input.conversationId ?? null,
      session_id: input.sessionId ?? null,
      ref_message_id: input.refMessageId ?? null,
      contact_id: input.contactId ? input.contactId.replace(/^contact:/, '') : null,
      text: text.length > MAX_FEEDBACK_TEXT ? `${text.slice(0, MAX_FEEDBACK_TEXT - 1)}…` : text,
      detail: input.detail ? JSON.stringify(input.detail) : null,
      created_at: this.now().toISOString(),
      consumed_by_run: null,
      consumed_at: null,
    };
    this.db
      .prepare(
        `INSERT INTO feedback_events (id, agent_id, kind, conversation_id, session_id, ref_message_id, contact_id, text, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.agent_id, row.kind, row.conversation_id, row.session_id, row.ref_message_id, row.contact_id, row.text, row.detail, row.created_at);
    for (const l of this.listeners) {
      try { l(row); } catch (err) { console.error('[feedback] listener failed:', err); }
    }
    return row;
  }

  /** Unconsumed events of a conversation, oldest first. */
  pendingForConversation(conversationId: string): FeedbackEventRow[] {
    return this.db
      .prepare(`SELECT * FROM feedback_events WHERE conversation_id = ? AND consumed_at IS NULL ORDER BY created_at ASC, rowid ASC`)
      .all(conversationId) as FeedbackEventRow[];
  }

  /** Newest unconsumed bypass event (denied-approval, user-feedback) of a conversation, or null. */
  latestBypass(conversationId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT MAX(created_at) AS at FROM feedback_events
         WHERE conversation_id = ? AND consumed_at IS NULL AND kind IN ('denied-approval', 'user-feedback')`,
      )
      .get(conversationId) as { at: string | null };
    return row.at ?? null;
  }

  consume(ids: readonly string[], runId: string): void {
    if (ids.length === 0) return;
    const now = this.now().toISOString();
    const stmt = this.db.prepare(`UPDATE feedback_events SET consumed_by_run = ?, consumed_at = ? WHERE id = ? AND consumed_at IS NULL`);
    this.db.transaction(() => { for (const id of ids) stmt.run(runId, now, id); })();
  }

  list(filter: { agentId?: string; kind?: FeedbackKind; limit?: number } = {}): FeedbackEventRow[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.agentId) { where.push('agent_id = ?'); params.push(toPrefixed(filter.agentId)); }
    if (filter.kind) { where.push('kind = ?'); params.push(filter.kind); }
    params.push(filter.limit ?? 50);
    return this.db
      .prepare(`SELECT * FROM feedback_events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(...params) as FeedbackEventRow[];
  }

  /** Counts and recurring texts for an agent since `since` (everything when null). */
  summary(agentId: string, since: string | null, limit = 20): FeedbackSummary {
    const rows = this.db
      .prepare(
        `SELECT * FROM feedback_events WHERE agent_id = ? AND (? IS NULL OR created_at > ?) ORDER BY created_at ASC`,
      )
      .all(toPrefixed(agentId), since, since) as FeedbackEventRow[];
    const counts: Record<FeedbackKind, number> = { 'denied-approval': 0, 'user-feedback': 0, 'tool-error': 0, 'lapsed-proposal': 0 };
    const groups = new Map<string, { kind: FeedbackKind; text: string; count: number; conversations: Set<string>; first_at: string; last_at: string }>();
    for (const r of rows) {
      counts[r.kind] += 1;
      const key = groupKey(r.kind, r.text);
      const g = groups.get(key) ?? { kind: r.kind, text: r.text, count: 0, conversations: new Set<string>(), first_at: r.created_at, last_at: r.created_at };
      g.count += 1;
      if (r.conversation_id) g.conversations.add(r.conversation_id);
      g.last_at = r.created_at;
      g.text = r.text;
      groups.set(key, g);
    }
    const recurring = [...groups.values()]
      .sort((a, b) => b.count - a.count || (a.last_at < b.last_at ? 1 : -1))
      .slice(0, limit)
      .map((g) => ({ kind: g.kind, text: g.text, count: g.count, conversations: g.conversations.size, first_at: g.first_at, last_at: g.last_at }));
    return { since, counts, recurring };
  }

  /** Delete events older than the retention window. Returns rows deleted. */
  sweep(retentionDays: number = FEEDBACK_RETENTION_DAYS): number {
    const cutoff = new Date(this.now().getTime() - retentionDays * 86_400_000).toISOString();
    return this.db.prepare('DELETE FROM feedback_events WHERE created_at < ?').run(cutoff).changes;
  }
}

/** The agent message a feedback event in `conversationId` most likely refers to: the latest non-command outbound row. */
export function latestAgentMessageId(db: Database.Database, conversationId: string): string | null {
  const row = db
    .prepare(
      `SELECT message_id FROM transcripts WHERE conversation_id = ? AND direction = 'outbound'
         AND json_extract(metadata, '$.command_response') IS NOT 1
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(conversationId) as { message_id: string } | undefined;
  return row?.message_id ?? null;
}

/**
 * Journal windows and eligibility (E66 S66.2).
 *
 * Eligible content is human-authored inbound since the session's cursor.
 * Excluded from the count: scheduler-fired inbound (`metadata.scheduled`),
 * bus-originated system-only turns (`metadata.system_only`), slash commands
 * and their `command_response` replies, reactions, and messages from agents
 * or the bus itself (`agent:` / `system:` senders). Any human counts, not
 * only owners.
 *
 * The window starts at the last agent message before the first eligible
 * human message, so a reply to a scheduled-job message is journaled with
 * that message as context. Slash commands and their replies are left out of
 * the window entirely.
 *
 * Thresholds: a non-final trigger needs `min_human_messages`; below that the
 * content is "pending". Final triggers (close, clear, evict, release,
 * pre-compact, session-end, shutdown) and `manual` bypass the threshold.
 * Pending content older than 24 h is journaled anyway.
 */
import type Database from 'better-sqlite3';
import type { JournalMessage, JournalTrigger } from './types.js';
import { isFinalTrigger } from './types.js';

/** Pending content older than this is journaled on the next trigger regardless of the threshold. */
export const PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface TranscriptRowLite {
  id: string;
  message_id: string;
  created_at: string;
  direction: string;
  contact_id: string;
  channel: string;
  body: string;
  metadata: string;
}

export interface JournalWindow {
  sessionId: string;
  cursorAt: string | null;
  /** Messages to journal, oldest first (context first, flagged). Empty when there is no eligible human message. */
  messages: JournalMessage[];
  /** created_at of each eligible human message past the cursor, oldest first. */
  humanTimes: string[];
  /** Newest transcript row past the cursor, of any kind: where the cursor moves on success. */
  advanceTo: string | null;
  from: string | null;
  to: string | null;
}

export type Eligibility =
  | { kind: 'nothing' }
  | { kind: 'pending'; humanCount: number; firstHumanAt: string }
  | { kind: 'eligible'; reason: 'threshold' | 'final' | 'aged' | 'manual'; humanCount: number };

function parseMeta(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const isCommandRow = (row: TranscriptRowLite, meta: Record<string, unknown>) =>
  meta['command_response'] === true || (row.direction === 'inbound' && row.body.startsWith('/'));

const isNonHumanSender = (contactId: string) => contactId.startsWith('agent:') || contactId.startsWith('system:');

/** True when an inbound transcript row counts as a human message for eligibility. */
export function isEligibleHuman(row: Pick<TranscriptRowLite, 'direction' | 'contact_id' | 'body'>, meta: Record<string, unknown>): boolean {
  return (
    row.direction === 'inbound' &&
    !isNonHumanSender(row.contact_id) &&
    meta['scheduled'] !== true &&
    meta['system_only'] !== true &&
    !row.body.startsWith('/') &&
    !row.body.startsWith('[reaction:')
  );
}

function attachmentsOf(meta: Record<string, unknown>): JournalMessage['attachments'] {
  const raw = meta['attachments'];
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object' && typeof (a as { local_path?: unknown }).local_path === 'string')
    .map((a) => ({
      type: typeof a['type'] === 'string' ? (a['type'] as string) : 'file',
      path: a['local_path'] as string,
      ...(typeof a['mime_type'] === 'string' ? { mime_type: a['mime_type'] as string } : {}),
      ...(typeof a['original_filename'] === 'string' ? { filename: a['original_filename'] as string } : {}),
    }));
}

/**
 * Build the journal window for a session from its transcript rows.
 * `isOwner(contactId, channel)` flags owner-authored messages for journalers.
 */
export function loadWindow(
  db: Database.Database,
  opts: {
    sessionId: string;
    cursorAt: string | null;
    agentId: string;
    isOwner?: (contactId: string, channel: string) => boolean;
  },
): JournalWindow {
  const rows = db
    .prepare(
      `SELECT id, message_id, created_at, direction, contact_id, channel, body, metadata
       FROM transcripts WHERE session_id = ? ORDER BY created_at ASC, rowid ASC`,
    )
    .all(opts.sessionId) as TranscriptRowLite[];

  const cursor = opts.cursorAt;
  const parsed = rows.map((row) => ({ row, meta: parseMeta(row.metadata) }));
  const past = parsed.filter(({ row }) => cursor === null || row.created_at > cursor);
  const advanceTo = past.length > 0 ? past[past.length - 1]!.row.created_at : null;

  const humanIdx = parsed.findIndex(({ row, meta }) => (cursor === null || row.created_at > cursor) && isEligibleHuman(row, meta));
  const humanTimes = past.filter(({ row, meta }) => isEligibleHuman(row, meta)).map(({ row }) => row.created_at);

  if (humanIdx < 0) {
    return { sessionId: opts.sessionId, cursorAt: cursor, messages: [], humanTimes, advanceTo, from: null, to: null };
  }

  // Context: the last agent message before the first eligible human message,
  // even if it is before the cursor (a scheduled briefing the reply answers).
  let startIdx = humanIdx;
  for (let i = humanIdx - 1; i >= 0; i--) {
    const { row, meta } = parsed[i]!;
    if (row.direction === 'outbound' && !isCommandRow(row, meta)) {
      startIdx = i;
      break;
    }
  }

  const messages: JournalMessage[] = [];
  for (let i = startIdx; i < parsed.length; i++) {
    const { row, meta } = parsed[i]!;
    if (isCommandRow(row, meta)) continue;
    const inbound = row.direction === 'inbound';
    const human = inbound && isEligibleHuman(row, meta);
    messages.push({
      id: row.id,
      message_id: row.message_id,
      created_at: row.created_at,
      direction: inbound ? 'inbound' : 'outbound',
      author: {
        id: inbound ? row.contact_id : opts.agentId,
        is_human: human,
        is_owner: inbound && !isNonHumanSender(row.contact_id) && (opts.isOwner?.(row.contact_id, row.channel) ?? false),
        is_agent: !inbound || row.contact_id.startsWith('agent:'),
      },
      body: row.body,
      attachments: attachmentsOf(meta),
      scheduled: meta['scheduled'] === true,
      context: i < humanIdx,
    });
  }

  return {
    sessionId: opts.sessionId,
    cursorAt: cursor,
    messages,
    humanTimes,
    advanceTo,
    from: messages[0]?.created_at ?? null,
    to: messages[messages.length - 1]?.created_at ?? null,
  };
}

/** Decide whether a window should be journaled for this trigger. */
export function assessEligibility(
  window: Pick<JournalWindow, 'humanTimes'>,
  opts: { minHumanMessages: number; trigger: JournalTrigger; hasPendingFinal?: boolean; now: Date },
): Eligibility {
  const humanCount = window.humanTimes.length;
  if (humanCount === 0) return { kind: 'nothing' };
  if (opts.trigger === 'manual') return { kind: 'eligible', reason: 'manual', humanCount };
  if (isFinalTrigger(opts.trigger) || opts.hasPendingFinal) return { kind: 'eligible', reason: 'final', humanCount };
  if (humanCount >= opts.minHumanMessages) return { kind: 'eligible', reason: 'threshold', humanCount };
  const firstHumanAt = window.humanTimes[0]!;
  if (opts.now.getTime() - new Date(firstHumanAt).getTime() >= PENDING_MAX_AGE_MS) {
    return { kind: 'eligible', reason: 'aged', humanCount };
  }
  return { kind: 'pending', humanCount, firstHumanAt };
}

/**
 * When the unjournaled content first became eligible, for backlog age (the
 * 24 h critical escalation). Below-threshold content does not count until it
 * ages past 24 h or a final trigger fires. Null when nothing is eligible.
 */
export function eligibleSince(
  window: Pick<JournalWindow, 'humanTimes'>,
  opts: { minHumanMessages: number; pendingSince?: string | null; now: Date },
): string | null {
  const times = window.humanTimes;
  if (times.length === 0) return null;
  const candidates: number[] = [];
  if (times.length >= opts.minHumanMessages) candidates.push(new Date(times[opts.minHumanMessages - 1]!).getTime());
  const aged = new Date(times[0]!).getTime() + PENDING_MAX_AGE_MS;
  if (aged <= opts.now.getTime()) candidates.push(aged);
  if (opts.pendingSince) candidates.push(new Date(opts.pendingSince).getTime());
  if (candidates.length === 0) return null;
  return new Date(Math.min(...candidates)).toISOString();
}

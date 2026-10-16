/**
 * `recent.md` freshness and delivery for live sessions (E67 S67.4, E73). See
 * docs/AGENT_MEMORY.md#freshness-hook.
 *
 * The hook (`SessionStart`, `UserPromptSubmit`) asks `GET /api/v1/memory/recent`
 * and the bus decides, per agent, from disk which mode applies:
 *
 *  - import mode: the agent's CLAUDE.md closure imports recent.md (or the agent
 *    has no working dir to check), so Claude Code loads the file itself at
 *    launch, `/compact` and `/clear`. A `session-start` check only records a
 *    baseline and returns nothing; later checks return what is new. Without a
 *    SessionStart registration, a session's first prompt check is the baseline.
 *  - hook mode: no import, so the hook is the only way the session gets the
 *    file. A session with no record (new session, `clear`/`fork` get a new id)
 *    or a `compact` start gets the whole file; every other check returns
 *    nothing or only what is new.
 *
 * What is new is, per day, the lines appended to that day's journal (the whole
 * day when it is new or was rewritten), not the whole file. A day that a budget
 * cut keeps only the end of is compared by overlap, so a moving cut isn't a rewrite.
 */
import type Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { hashContent } from './recent.js';
import type { RecentMemory } from './recent-service.js';
import { claudeMdImportsRecent } from './setup-check.js';

export type FreshnessEvent = 'prompt' | 'session-start';

/** Why a Claude Code session started (the `source` field of the SessionStart hook input). */
export const START_SOURCES = ['startup', 'resume', 'clear', 'compact', 'fork'] as const;
export type StartSource = (typeof START_SOURCES)[number];

/** How recent.md reaches the agent's sessions: Claude Code's CLAUDE.md import, or the hook. */
export type RecentMode = 'import' | 'hook';

export interface FreshnessRequest {
  harnessSessionId: string;
  event?: FreshnessEvent;
  /** Why the session started, for `event: 'session-start'`. */
  source?: StartSource;
  /** Fallback when the session id resolves to no agent (e.g. a `claude-code` session): bare or prefixed agent id. */
  agentId?: string;
}

export type FreshnessReason = 'baseline' | 'unchanged' | 'no-recent' | 'no-new-entries';

export type FreshnessResult =
  | {
      ok: true;
      agent_id: string;
      /** True when `context` carries content the session hasn't seen. */
      changed: boolean;
      /** Why nothing was returned, when `changed` is false. */
      reason?: FreshnessReason;
      hash: string | null;
      /** Delivery mode the bus chose for this agent (debugging aid). */
      mode: RecentMode;
      /** Text for the hook to print as additional context. */
      context?: string;
    }
  | { ok: false; status: number; error: string };

export interface RecentFreshnessDeps {
  db: Database.Database;
  recent: Pick<RecentMemory, 'regenerate' | 'layoutFor'>;
  /** Logical agent for a harness session id (bus session, then pool pane), or null. */
  resolveAgent: (harnessSessionId: string) => string | null;
  /** Whether a fallback agent id names a configured agent. */
  knownAgent?: (agentId: string) => boolean;
  now?: () => Date;
}

const RETENTION_MS = 30 * 86_400_000;
const SWEEP_EVERY_MS = 60 * 60 * 1000;

export function freshnessContext(relPath: string, content: string): string {
  return (
    `AgentBus: ${relPath} (your recent daily journals) changed since this session loaded it. ` +
    'This is the current version; it replaces the earlier one.\n\n' +
    content
  );
}

const DAY_HEADING = /^## (\d{4}-\d{2}-\d{2})(?: \(today\))?$/;
const OLDER_MARKER = /^_\[\d+ older day\(s\) left out/;
const CUT_NOTE = /^_\[Earlier entries of this day were cut[^\n]*\]_\n\n/;

/** Journal text per day in a rendered `recent.md`, newest first, without headings, the budget-cut note or the left-out marker. */
export function parseRecentDays(content: string): Array<{ date: string; body: string }> {
  const days: Array<{ date: string; lines: string[] }> = [];
  let cur: { date: string; lines: string[] } | null = null;
  for (const line of content.split('\n')) {
    const m = DAY_HEADING.exec(line);
    if (m) {
      cur = { date: m[1]!, lines: [] };
      days.push(cur);
    } else if (OLDER_MARKER.test(line)) {
      cur = null;
    } else if (cur) {
      cur.lines.push(line);
    }
  }
  return days.map((d) => ({ date: d.date, body: d.lines.join('\n').trim().replace(CUT_NOTE, '').trim() }));
}

/** An overlap shorter than this (after trimming) is too likely to be a repeated stock line ("- Nothing actionable."). */
const MIN_OVERLAP_CHARS = 40;

/**
 * Where `next` (a day's body) picks up after what the session already has
 * (`old`), when a budget cut moved the start of the day: the length of the
 * longest suffix of `old`, starting at a line boundary of `old`, that equals a
 * prefix of `next` ending at a line boundary of `next`. Null when no such
 * overlap of at least `MIN_OVERLAP_CHARS` exists. O(lines x length).
 */
function overlapLength(old: string, next: string): number | null {
  let start = 0;
  // Candidate starts in increasing order, so the first match is the longest overlap.
  for (;;) {
    const tail = old.slice(start);
    if (tail.trim().length < MIN_OVERLAP_CHARS) return null; // shorter from here on
    if (tail.length <= next.length && (tail.length === next.length || next[tail.length] === '\n') && next.startsWith(tail)) return tail.length;
    const nl = old.indexOf('\n', start);
    if (nl < 0) return null;
    start = nl + 1;
  }
}

/**
 * What a session that has `prev` is missing from `next`: per day, the lines
 * appended since (the dailies are append-only), or the whole day when it is
 * new or was rewritten. Empty when nothing new.
 *
 * Over the budget, the oldest included day is a tail of its journal whose cut
 * point moves later as newer days grow, so its text is no longer an extension
 * of what the session saw. That day is not rewritten: when the new text is a
 * line-aligned tail of the old (the cut moved, nothing was added) nothing is
 * sent, and when the old tail overlaps the start of the new text on whole lines
 * (cut moved and lines were appended) only the lines after the overlap are sent.
 */
export function recentDelta(prev: string, next: string): string {
  const before = new Map(parseRecentDays(prev).map((d) => [d.date, d.body]));
  const parts: string[] = [];
  for (const { date, body } of parseRecentDays(next)) {
    const old = before.get(date);
    if (old === body) continue;
    if (old === undefined || old === '') {
      parts.push(`## ${date}\n\n${body}`);
      continue;
    }
    if (body.startsWith(`${old}\n`)) {
      parts.push(`## ${date} (new entries only)\n\n${body.slice(old.length).trim()}`);
      continue;
    }
    if (body !== '') {
      // The cut moved later and nothing was added: the new text is the end of the old, from a line start.
      if (old.endsWith(`\n${body}`)) continue;
      const overlap = overlapLength(old, body);
      if (overlap !== null) {
        const added = body.slice(overlap).trim();
        if (added !== '') parts.push(`## ${date} (new entries only)\n\n${added}`);
        continue;
      }
    }
    parts.push(`## ${date} (rewritten; replaces the earlier version of this day)\n\n${body}`);
  }
  return parts.join('\n\n');
}

/** The whole file, for a session that has never seen it (hook mode). */
export function fullContext(relPath: string, content: string): string {
  return (
    `AgentBus: ${relPath}, your recent daily journals (loaded by the freshness hook; later updates arrive as new entries only):\n\n` +
    content
  );
}

export function deltaContext(relPath: string, delta: string): string {
  return (
    `AgentBus: new entries in ${relPath} (your recent daily journals) since this session last saw it. ` +
    'Everything you already have from it is unchanged; these lines are additions.\n\n' +
    delta
  );
}

export class RecentFreshness {
  private lastSweep = 0;

  constructor(private readonly deps: RecentFreshnessDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  check(req: FreshnessRequest): FreshnessResult {
    const fromSession = this.deps.resolveAgent(req.harnessSessionId);
    const fallback = req.agentId && (this.deps.knownAgent?.(req.agentId) ?? false) ? req.agentId : null;
    const agentId = fromSession ?? fallback;
    if (!agentId) return { ok: false, status: 404, error: 'no agent for this harness_session_id' };

    // Regenerate first, so dailies written in-turn since the last journal run are picked up.
    const written = this.deps.recent.regenerate(agentId, 'hook');
    const layout = this.deps.recent.layoutFor(agentId);
    // Import mode unless we can see the working dir and its CLAUDE.md closure doesn't import recent.md
    // (without a working dir the import can't be checked; assuming it exists avoids a double load).
    const mode: RecentMode = layout.workingDir && layout.recentPath && !claudeMdImportsRecent(layout.workingDir, layout.recentPath) ? 'hook' : 'import';
    let content: string | null = null;
    if (layout.recentPath) {
      try {
        content = readFileSync(layout.recentPath, 'utf-8');
      } catch {
        content = null;
      }
    }
    if (content === null) {
      return { ok: true, agent_id: layout.agentId, changed: false, reason: 'no-recent', hash: null, mode };
    }
    const hash = written.hash ?? hashContent(content);
    const now = this.now().toISOString();
    const row = this.deps.db
      .prepare('SELECT content_hash, content FROM memory_recent_seen WHERE harness_session_id = ?')
      .get(req.harnessSessionId) as { content_hash: string; content: string | null } | undefined;
    this.deps.db
      .prepare(
        `INSERT INTO memory_recent_seen (harness_session_id, agent_id, content_hash, content, seen_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (harness_session_id) DO UPDATE SET agent_id = excluded.agent_id, content_hash = excluded.content_hash, content = excluded.content, seen_at = excluded.seen_at`,
      )
      .run(req.harnessSessionId, layout.agentId, hash, content, now);
    this.sweep();

    const rel = `${layout.dir.replace(/\/+$/, '')}/recent.md`;
    const base = { ok: true as const, agent_id: layout.agentId, hash, mode };
    if (mode === 'hook' && (!row || (req.event === 'session-start' && req.source === 'compact'))) {
      // The session has never seen the file, or compaction just dropped it: send it whole.
      return { ...base, changed: true, context: fullContext(rel, content) };
    }
    // Import mode: the session loaded the file through CLAUDE.md, so a start only records a baseline.
    // (Hook mode never reaches here without a row.)
    if (!row || (mode === 'import' && req.event === 'session-start')) return { ...base, changed: false, reason: 'baseline' };
    if (row.content_hash === hash) return { ...base, changed: false, reason: 'unchanged' };
    if (row.content !== null) {
      const delta = recentDelta(row.content, content);
      if (delta === '') return { ...base, changed: false, reason: 'no-new-entries' };
      return { ...base, changed: true, context: deltaContext(rel, delta) };
    }
    // Row from before migration 035: no stored text to diff against, send the whole file once.
    return { ...base, changed: true, context: freshnessContext(rel, content) };
  }

  /** Drop rows untouched for 30 days (at most hourly). */
  sweep(): number {
    const now = this.now().getTime();
    if (now - this.lastSweep < SWEEP_EVERY_MS) return 0;
    this.lastSweep = now;
    const cutoff = new Date(now - RETENTION_MS).toISOString();
    return this.deps.db.prepare('DELETE FROM memory_recent_seen WHERE seen_at < ?').run(cutoff).changes;
  }
}

/** Parse the query string of `GET /api/v1/memory/recent`. */
export function parseFreshnessQuery(q: Record<string, unknown>): FreshnessRequest | { error: string } {
  const id = q['harness_session_id'];
  if (typeof id !== 'string' || id.length === 0) return { error: 'harness_session_id is required' };
  const event = q['event'];
  if (event !== undefined && event !== 'prompt' && event !== 'session-start') return { error: 'event must be prompt or session-start' };
  const source = q['source'];
  if (source !== undefined && !(typeof source === 'string' && (START_SOURCES as readonly string[]).includes(source))) {
    return { error: `source must be one of ${START_SOURCES.join(', ')}` };
  }
  const agent = q['agent'];
  return {
    harnessSessionId: id,
    ...(event ? { event } : {}),
    ...(source ? { source: source as StartSource } : {}),
    ...(typeof agent === 'string' && agent.length > 0 ? { agentId: agent } : {}),
  };
}

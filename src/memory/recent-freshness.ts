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
 * What is new is, per day, the lines added to that day's journal (the whole
 * day when it is new or was edited), not the whole file. Days are compared line
 * by line, so an entry inserted mid-day is sent alone, and a day that a budget
 * cut keeps only the end of isn't a rewrite when the cut moves.
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

/** A shared stretch shorter than this (after trimming) is too likely to be a repeated stock line ("- Nothing actionable."). */
const MIN_OVERLAP_CHARS = 40;

/** Above this many cells (old lines x new lines) the LCS table is not built; the append/tail/overlap rules decide instead. */
const MAX_LCS_CELLS = 4_000_000;

/** What changed in one day: nothing, text the session lacks, or an edit of text it already has. */
type DayChange = { added: string } | 'none' | 'rewritten';

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
 * Fallback for days too large for the line diff: the new text extends the old
 * (append), is a line-aligned tail of it (the budget cut moved), or starts with
 * a line-aligned tail of it (cut moved and lines were appended). Anything else,
 * including an entry inserted mid-day, is a rewrite.
 */
function appendOnlyChange(old: string, body: string): DayChange {
  if (body.startsWith(`${old}\n`)) return { added: body.slice(old.length).trim() };
  if (body === '') return 'rewritten';
  if (old.endsWith(`\n${body}`)) return 'none';
  const overlap = overlapLength(old, body);
  if (overlap === null) return 'rewritten';
  const added = body.slice(overlap).trim();
  return added === '' ? 'none' : { added };
}

/**
 * Line-level diff of one day (old and new both non-empty and different): the
 * longest common subsequence of the non-blank lines pairs up what the session
 * already has with the new text. Blank lines never take part in the alignment,
 * so whitespace-only changes are invisible.
 *
 *  - An old line that is not in the LCS and comes after the first matched old
 *    line is an edit or removal: the day is rewritten. Old lines before the first
 *    match are what a budget cut dropped from the start of the day: ignored.
 *  - Otherwise the new lines outside the LCS are the additions, one block per
 *    contiguous run (blank lines inside a run stay, at its edges they are dropped).
 *  - If almost nothing matched (under `MIN_OVERLAP_CHARS`) while the old text was
 *    longer, the match is a coincidence of stock lines: rewritten.
 */
function lineDiffChange(old: string, body: string): DayChange {
  const oldLines = old.split('\n').filter((l) => l.trim() !== '');
  const newLines = body.split('\n');
  const a = oldLines.map((l) => l.trimEnd());
  const bLines = newLines.filter((l) => l.trim() !== '');
  const b = bLines.map((l) => l.trimEnd());
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return 'rewritten';

  // lcs[i][j]: length of the LCS of a[i..] and b[j..].
  const w = m + 1;
  const lcs = new Int32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] = a[i] === b[j] ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
    }
  }
  const oldMatched = new Array<boolean>(n).fill(false);
  const newMatched = new Array<boolean>(m).fill(false);
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (a[i] === b[j]) {
      oldMatched[i] = true;
      newMatched[j] = true;
      i++;
      j++;
    } else if (lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!) i++;
    else j++;
  }

  const firstMatch = oldMatched.indexOf(true);
  if (firstMatch < 0) return 'rewritten';
  for (let i = firstMatch + 1; i < n; i++) if (!oldMatched[i]) return 'rewritten';
  let matchedChars = 0;
  for (let i = 0; i < n; i++) if (oldMatched[i]) matchedChars += a[i]!.trim().length;
  if (matchedChars < MIN_OVERLAP_CHARS && old.trim().length > MIN_OVERLAP_CHARS) return 'rewritten';

  const blocks: string[] = [];
  let run: string[] = [];
  const flush = (): void => {
    while (run.length > 0 && run[run.length - 1]!.trim() === '') run.pop();
    if (run.length > 0) blocks.push(run.join('\n'));
    run = [];
  };
  let k = 0;
  for (const line of newLines) {
    if (line.trim() === '') {
      if (run.length > 0) run.push(line);
    } else if (newMatched[k++]) flush();
    else run.push(line);
  }
  flush();
  return blocks.length === 0 ? 'none' : { added: blocks.join('\n\n') };
}

export interface RecentDeltaOptions {
  /** Largest old lines x new lines product the line diff is run for (default 4,000,000); bigger days use the append/tail/overlap rules. */
  maxLcsCells?: number;
}

/**
 * What a session that has `prev` is missing from `next`: per day, the lines
 * added since, or the whole day when it is new or was edited. Empty when
 * nothing new.
 *
 * Days are compared line by line (see `lineDiffChange`): lines added anywhere
 * in the day, at the end or between entries, are sent as new entries; a changed
 * or removed line the session already has makes the day a rewrite. Over the
 * budget, the oldest included day is a tail of its journal whose cut point
 * moves later as newer days grow; lines gone from the start of the day are not
 * an edit, so a moving cut sends nothing by itself. Days too large for the line
 * diff fall back to `appendOnlyChange`.
 */
export function recentDelta(prev: string, next: string, opts: RecentDeltaOptions = {}): string {
  const maxCells = opts.maxLcsCells ?? MAX_LCS_CELLS;
  const before = new Map(parseRecentDays(prev).map((d) => [d.date, d.body]));
  const parts: string[] = [];
  for (const { date, body } of parseRecentDays(next)) {
    const old = before.get(date);
    if (old === body) continue;
    if (old === undefined || old === '') {
      parts.push(`## ${date}\n\n${body}`);
      continue;
    }
    const tooBig = old.split('\n').length * body.split('\n').length > maxCells;
    const change = body === '' ? 'rewritten' : tooBig ? appendOnlyChange(old, body) : lineDiffChange(old, body);
    if (change === 'none') continue;
    if (change === 'rewritten') parts.push(`## ${date} (rewritten; replaces the earlier version of this day)\n\n${body}`);
    else if (change.added !== '') parts.push(`## ${date} (new entries only)\n\n${change.added}`);
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

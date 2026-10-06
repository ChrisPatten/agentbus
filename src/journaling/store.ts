/**
 * Journaling persistence (E66 S66.2): the per-session cursor and pending
 * state, transcript snapshots, per-agent counters, hook sightings and the
 * `journal_runs` log. Tables come from migration 026. All calls are
 * synchronous (better-sqlite3).
 */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { JournalOutcome, JournalFidelity, JobKind } from './types.js';

/** `journal_runs` retention. */
export const JOURNAL_RUN_RETENTION_DAYS = 90;
/** Max stored length of a run's error text. */
export const MAX_ERROR_LENGTH = 500;

export interface JournalStateRow {
  session_id: string;
  pending_trigger: string | null;
  pending_since: string | null;
  last_turn_ended_at: string | null;
  harness_session_id: string | null;
  harness_transcript_path: string | null;
  attempts: number;
  attempts_window_to: string | null;
  last_attempt_at: string | null;
  last_outcome: string | null;
  updated_at: string;
}

export interface JournalSnapshotRow {
  id: string;
  session_id: string;
  event: string;
  path: string;
  created_at: string;
  consumed_by_run: string | null;
  consumed_at: string | null;
}

export interface JournalAgentStateRow {
  agent_id: string;
  consecutive_exhaustions: number;
  last_exhausted_at: string | null;
  last_success_at: string | null;
  last_failure_at: string | null;
  last_failure: string | null;
  updated_at: string;
}

export interface JournalRunInput {
  runId: string;
  agentId: string;
  sessionId: string | null;
  conversationId: string | null;
  kind: JobKind;
  trigger: string;
  journaler: string;
  chainPosition: number;
  fallbackFrom: string | null;
  outcome: JournalOutcome;
  error?: string | null;
  fidelity?: JournalFidelity | null;
  windowFrom?: string | null;
  windowTo?: string | null;
  messageCount: number;
  startedAt: string;
  durationMs?: number | null;
  filesChanged?: string[] | null;
  notes?: string | null;
  costUsd?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
}

export interface JournalRunRow {
  id: number;
  run_id: string;
  agent_id: string;
  session_id: string | null;
  conversation_id: string | null;
  kind: JobKind;
  trigger: string;
  journaler: string;
  chain_position: number;
  fallback_from: string | null;
  outcome: JournalOutcome;
  error: string | null;
  fidelity: JournalFidelity | null;
  window_from: string | null;
  window_to: string | null;
  message_count: number;
  started_at: string;
  duration_ms: number | null;
  files_changed: string | null;
  notes: string | null;
  cost_usd: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
}

export function truncateError(err: string | null | undefined): string | null {
  if (err == null) return null;
  return err.length > MAX_ERROR_LENGTH ? `${err.slice(0, MAX_ERROR_LENGTH - 1)}…` : err;
}

export class JournalStore {
  constructor(private readonly db: Database.Database, private readonly now: () => Date = () => new Date()) {}

  private iso(): string {
    return this.now().toISOString();
  }

  // ── Cursor ─────────────────────────────────────────────────────────────────

  getCursor(sessionId: string): string | null {
    const row = this.db.prepare('SELECT journal_cursor_at FROM sessions WHERE id = ?').get(sessionId) as
      | { journal_cursor_at: string | null }
      | undefined;
    return row?.journal_cursor_at ?? null;
  }

  /**
   * Move the cursor to `to` (never backwards) and stamp last_journaled_at.
   * Called only after a run ends `done` or `nothing-to-do`.
   */
  advanceCursor(sessionId: string, to: string | null): void {
    const now = this.iso();
    this.db
      .prepare(
        `UPDATE sessions
         SET journal_cursor_at = CASE
               WHEN ? IS NULL THEN journal_cursor_at
               WHEN journal_cursor_at IS NULL OR journal_cursor_at < ? THEN ?
               ELSE journal_cursor_at END,
             last_journaled_at = ?
         WHERE id = ?`,
      )
      .run(to, to, to, now, sessionId);
  }

  // ── Per-session state ──────────────────────────────────────────────────────

  getState(sessionId: string): JournalStateRow | null {
    return (this.db.prepare('SELECT * FROM journal_state WHERE session_id = ?').get(sessionId) as JournalStateRow | undefined) ?? null;
  }

  private ensureState(sessionId: string): void {
    this.db
      .prepare(`INSERT INTO journal_state (session_id, updated_at) VALUES (?, ?) ON CONFLICT(session_id) DO NOTHING`)
      .run(sessionId, this.iso());
  }

  /**
   * Record a final (or manual) trigger that must still be journaled, so it
   * survives a restart. An earlier pending trigger keeps its `pending_since`.
   */
  markPending(sessionId: string, trigger: string, at: string = this.iso()): void {
    this.ensureState(sessionId);
    this.db
      .prepare(
        `UPDATE journal_state
         SET pending_trigger = ?, pending_since = COALESCE(pending_since, ?), updated_at = ?
         WHERE session_id = ?`,
      )
      .run(trigger, at, this.iso(), sessionId);
  }

  clearPending(sessionId: string): void {
    this.db
      .prepare(`UPDATE journal_state SET pending_trigger = NULL, pending_since = NULL, updated_at = ? WHERE session_id = ?`)
      .run(this.iso(), sessionId);
  }

  /** Sessions with a pending trigger, oldest first. */
  listPending(): JournalStateRow[] {
    return this.db
      .prepare(`SELECT * FROM journal_state WHERE pending_trigger IS NOT NULL ORDER BY pending_since ASC`)
      .all() as JournalStateRow[];
  }

  noteTurnEnded(sessionId: string, at: string = this.iso()): void {
    this.ensureState(sessionId);
    this.db
      .prepare(
        `UPDATE journal_state
         SET last_turn_ended_at = CASE WHEN last_turn_ended_at IS NULL OR last_turn_ended_at < ? THEN ? ELSE last_turn_ended_at END,
             updated_at = ?
         WHERE session_id = ?`,
      )
      .run(at, at, this.iso(), sessionId);
  }

  noteHarness(sessionId: string, harnessSessionId: string | null, transcriptPath: string | null): void {
    this.ensureState(sessionId);
    this.db
      .prepare(
        `UPDATE journal_state
         SET harness_session_id = COALESCE(?, harness_session_id),
             harness_transcript_path = COALESCE(?, harness_transcript_path),
             updated_at = ?
         WHERE session_id = ?`,
      )
      .run(harnessSessionId, transcriptPath, this.iso(), sessionId);
  }

  /**
   * Count an exhausted run for the window ending at `windowTo`. The count
   * restarts when the window end moves (new content arrived). Returns the
   * count for this window.
   */
  recordExhausted(sessionId: string, windowTo: string | null): number {
    this.ensureState(sessionId);
    const now = this.iso();
    const state = this.getState(sessionId)!;
    const sameWindow = state.attempts_window_to === windowTo;
    const attempts = sameWindow ? state.attempts + 1 : 1;
    this.db
      .prepare(
        `UPDATE journal_state SET attempts = ?, attempts_window_to = ?, last_attempt_at = ?, last_outcome = 'exhausted', updated_at = ?
         WHERE session_id = ?`,
      )
      .run(attempts, windowTo, now, now, sessionId);
    return attempts;
  }

  /** Exhausted runs already spent on the window ending at `windowTo`. */
  attemptsFor(sessionId: string, windowTo: string | null): number {
    const state = this.getState(sessionId);
    if (!state || state.attempts_window_to !== windowTo) return 0;
    return state.attempts;
  }

  /** A run succeeded: clear the pending trigger and the attempt counter. */
  recordSuccess(sessionId: string, outcome: 'done' | 'nothing-to-do'): void {
    this.ensureState(sessionId);
    const now = this.iso();
    this.db
      .prepare(
        `UPDATE journal_state
         SET pending_trigger = NULL, pending_since = NULL, attempts = 0, attempts_window_to = NULL,
             last_attempt_at = ?, last_outcome = ?, updated_at = ?
         WHERE session_id = ?`,
      )
      .run(now, outcome, now, sessionId);
  }

  // ── Snapshots ──────────────────────────────────────────────────────────────

  addSnapshot(sessionId: string, event: string, path: string): JournalSnapshotRow {
    const row: JournalSnapshotRow = {
      id: randomUUID(), session_id: sessionId, event, path, created_at: this.iso(), consumed_by_run: null, consumed_at: null,
    };
    this.db
      .prepare(`INSERT INTO journal_snapshots (id, session_id, event, path, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(row.id, row.session_id, row.event, row.path, row.created_at);
    return row;
  }

  pendingSnapshots(sessionId: string): JournalSnapshotRow[] {
    return this.db
      .prepare(`SELECT * FROM journal_snapshots WHERE session_id = ? AND consumed_at IS NULL ORDER BY created_at ASC`)
      .all(sessionId) as JournalSnapshotRow[];
  }

  consumeSnapshots(ids: readonly string[], runId: string): void {
    if (ids.length === 0) return;
    const now = this.iso();
    const stmt = this.db.prepare(`UPDATE journal_snapshots SET consumed_by_run = ?, consumed_at = ? WHERE id = ? AND consumed_at IS NULL`);
    this.db.transaction(() => { for (const id of ids) stmt.run(runId, now, id); })();
  }

  // ── Per-agent counters ─────────────────────────────────────────────────────

  getAgentState(agentId: string): JournalAgentStateRow | null {
    return (this.db.prepare('SELECT * FROM journal_agent_state WHERE agent_id = ?').get(agentId) as JournalAgentStateRow | undefined) ?? null;
  }

  /** Count an exhausted run for the agent. Returns the new consecutive count. */
  recordAgentExhausted(agentId: string, failure: string): number {
    const now = this.iso();
    this.db
      .prepare(
        `INSERT INTO journal_agent_state (agent_id, consecutive_exhaustions, last_exhausted_at, last_failure_at, last_failure, updated_at)
         VALUES (?, 1, ?, ?, ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET
           consecutive_exhaustions = consecutive_exhaustions + 1,
           last_exhausted_at = excluded.last_exhausted_at,
           last_failure_at = excluded.last_failure_at,
           last_failure = excluded.last_failure,
           updated_at = excluded.updated_at`,
      )
      .run(agentId, now, now, truncateError(failure), now);
    return this.getAgentState(agentId)!.consecutive_exhaustions;
  }

  /** Note a failed attempt that a later journaler recovered from (health summary only). */
  recordAgentFailure(agentId: string, failure: string): void {
    const now = this.iso();
    this.db
      .prepare(
        `INSERT INTO journal_agent_state (agent_id, last_failure_at, last_failure, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET last_failure_at = excluded.last_failure_at,
           last_failure = excluded.last_failure, updated_at = excluded.updated_at`,
      )
      .run(agentId, now, truncateError(failure), now);
  }

  recordAgentSuccess(agentId: string): void {
    const now = this.iso();
    this.db
      .prepare(
        `INSERT INTO journal_agent_state (agent_id, consecutive_exhaustions, last_success_at, updated_at) VALUES (?, 0, ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET consecutive_exhaustions = 0,
           last_success_at = excluded.last_success_at, updated_at = excluded.updated_at`,
      )
      .run(agentId, now, now);
  }

  // ── Hook sightings ─────────────────────────────────────────────────────────

  recordHookEvent(agentId: string, event: string, at: string = this.iso()): void {
    this.db
      .prepare(
        `INSERT INTO journal_hook_events (agent_id, event, last_seen_at, count) VALUES (?, ?, ?, 1)
         ON CONFLICT(agent_id, event) DO UPDATE SET last_seen_at = excluded.last_seen_at, count = count + 1`,
      )
      .run(agentId, event, at);
  }

  hookEvents(agentId: string): Array<{ event: string; last_seen_at: string; count: number }> {
    return this.db
      .prepare(`SELECT event, last_seen_at, count FROM journal_hook_events WHERE agent_id = ? ORDER BY event`)
      .all(agentId) as Array<{ event: string; last_seen_at: string; count: number }>;
  }

  // ── Runs ───────────────────────────────────────────────────────────────────

  insertRun(run: JournalRunInput): number {
    const result = this.db
      .prepare(
        `INSERT INTO journal_runs (run_id, agent_id, session_id, conversation_id, kind, trigger, journaler, chain_position,
           fallback_from, outcome, error, fidelity, window_from, window_to, message_count, started_at, duration_ms,
           files_changed, notes, cost_usd, input_tokens, output_tokens)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.runId, run.agentId, run.sessionId, run.conversationId, run.kind, run.trigger, run.journaler, run.chainPosition,
        run.fallbackFrom, run.outcome, truncateError(run.error ?? null), run.fidelity ?? null, run.windowFrom ?? null,
        run.windowTo ?? null, run.messageCount, run.startedAt, run.durationMs ?? null,
        run.filesChanged ? JSON.stringify(run.filesChanged) : null, run.notes ?? null, run.costUsd ?? null,
        run.inputTokens ?? null, run.outputTokens ?? null,
      );
    return Number(result.lastInsertRowid);
  }

  /** Most recent attempts first. */
  listRuns(filter: { agentId?: string; sessionId?: string; conversationId?: string; limit?: number } = {}): JournalRunRow[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.agentId) { where.push('agent_id = ?'); params.push(filter.agentId); }
    if (filter.sessionId) { where.push('session_id = ?'); params.push(filter.sessionId); }
    if (filter.conversationId) { where.push('conversation_id = ?'); params.push(filter.conversationId); }
    params.push(filter.limit ?? 50);
    return this.db
      .prepare(
        `SELECT * FROM journal_runs ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY started_at DESC, id DESC LIMIT ?`,
      )
      .all(...params) as JournalRunRow[];
  }

  /** Delete runs older than the retention window. Returns rows deleted. */
  sweepRuns(retentionDays: number = JOURNAL_RUN_RETENTION_DAYS): number {
    const cutoff = new Date(this.now().getTime() - retentionDays * 86_400_000).toISOString();
    return this.db.prepare('DELETE FROM journal_runs WHERE started_at < ?').run(cutoff).changes;
  }
}

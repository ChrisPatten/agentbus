/**
 * E8 — Session Tracker (S8.2)
 *
 * Background task that runs on a configurable interval. Each tick:
 *   1. Closes sessions that have been idle past the inactivity threshold.
 *   2. Processes sessions closed mid-conversation by Stage 80 (ended_at set,
 *      status still 'active') — fires the on_session_close hook and triggers
 *      summarization for those that meet the min-messages threshold.
 *   3. Triggers Summarizer.summarize() for each newly-closed session (async,
 *      fire-and-forget so one slow API call does not block subsequent ticks).
 *   4. Retries sessions that previously failed summarization (up to 3 times).
 *   5. Hard-deletes memories expired more than 30 days ago.
 *
 * Stage 80 (transcript-log) sets ended_at when a new message arrives after the
 * idle threshold, but does not fire the hook or update status. This tracker
 * picks those up on its next tick via processMidFlightClosedSessions().
 */
import { exec, type ExecOptionsWithStringEncoding } from 'node:child_process';
import type Database from 'better-sqlite3';
import type { AppConfig } from '../config/schema.js';
import { journalingThresholdForChannel } from '../config/schema.js';
import type { Summarizer } from './summarizer.js';
import type { SessionRow } from './types.js';

/** Drives a silent journaling turn for a paused conversation (cc-headless). */
export type JournalingRunner = (conversationId: string) => Promise<{ skipped?: boolean }>;

/** Days after expiry before a memory is hard-deleted. */
const HARD_DELETE_AFTER_DAYS = 30;
/** Max summarization attempts before giving up. */
const MAX_SUMMARY_ATTEMPTS = 3;
/** Max consecutive journaling failures per conversation before backing off (re-armed by new activity). */
const MAX_JOURNALING_ATTEMPTS = 3;

export class SessionTracker {
  private db: Database.Database;
  private config: AppConfig;
  private summarizer: Summarizer;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Injected by index.ts when the headless adapter is running. */
  private journalingRunner: JournalingRunner | null = null;
  /** conversation_id → { lastActivity seen, consecutive failures }. Re-armed when last_activity advances. */
  private journalingAttempts = new Map<string, { lastActivity: string; count: number }>();

  constructor(deps: {
    db: Database.Database;
    config: AppConfig;
    summarizer: Summarizer;
  }) {
    this.db = deps.db;
    this.config = deps.config;
    this.summarizer = deps.summarizer;
  }

  /** Provide the journaling runner (cc-headless). Without it, journaling dispatch is a no-op. */
  setJournalingRunner(runner: JournalingRunner): void {
    this.journalingRunner = runner;
  }

  /** Start the background tick loop. Runs one immediate tick before the interval. */
  start(): void {
    this.tick();
    this.timer = setInterval(() => this.tick(), this.config.memory.summarizer_interval_ms);
  }

  /** Stop the background tick loop. In-flight summarize calls complete on their own. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Run one tracker tick. Exposed for testing.
   *
   * All DB operations are synchronous (better-sqlite3). Summarizer calls are
   * async and fire-and-forget — errors are caught and logged by the summarizer.
   */
  tick(): void {
    try {
      this.closeIdleSessions();
    } catch (err) {
      console.error('[session-tracker] Error closing idle sessions:', err);
    }

    try {
      this.processMidFlightClosedSessions();
    } catch (err) {
      console.error('[session-tracker] Error processing mid-flight closed sessions:', err);
    }

    try {
      this.retryFailedSessions();
    } catch (err) {
      console.error('[session-tracker] Error retrying failed sessions:', err);
    }

    try {
      this.sweepExpiredMemories();
    } catch (err) {
      console.error('[session-tracker] Error sweeping expired memories:', err);
    }

    try {
      this.dispatchJournaling();
    } catch (err) {
      console.error('[session-tracker] Error dispatching journaling:', err);
    }
  }

  /**
   * E20 — fire a silent journaling turn for each headless conversation that has
   * paused (idle past the per-channel journaling threshold) and has not been
   * journaled since its last activity. One journaling turn per pause; new
   * activity advances last_activity past last_journaled_at and re-arms it.
   *
   * No-op when journaling is disabled, no runner is wired, or cc-headless is not
   * configured. Never sets ended_at — sessions stay long-lived.
   */
  private dispatchJournaling(): void {
    const headless = this.config.adapters['cc-headless'];
    if (!headless || !headless.journaling.enabled || !this.journalingRunner) return;
    const runner = this.journalingRunner;
    const threshold = headless.journaling.threshold_ms;

    const now = Date.now();
    const nowIso = new Date(now).toISOString();

    // Candidate sessions: headless-managed (claude_session_id set), still open,
    // not journaled since their last activity.
    const candidates = this.db
      .prepare(
        `SELECT * FROM sessions
         WHERE ended_at IS NULL AND claude_session_id IS NOT NULL
           AND (last_journaled_at IS NULL OR last_journaled_at < last_activity)`,
      )
      .all() as SessionRow[];

    for (const session of candidates) {
      const thresholdMs = journalingThresholdForChannel(threshold, session.channel);
      const idleMs = now - new Date(session.last_activity).getTime();
      if (idleMs < thresholdMs) continue;

      // Reset the failure counter when new activity has occurred since last seen.
      let rec = this.journalingAttempts.get(session.conversation_id);
      if (!rec || rec.lastActivity !== session.last_activity) {
        rec = { lastActivity: session.last_activity, count: 0 };
        this.journalingAttempts.set(session.conversation_id, rec);
      }
      if (rec.count >= MAX_JOURNALING_ATTEMPTS) continue;

      // Fire-and-forget. Stamp last_journaled_at on success (or skip); on failure
      // leave it unchanged so a later tick retries, bounded by the attempt cap.
      runner(session.conversation_id)
        .then(() => {
          this.journalingAttempts.delete(session.conversation_id);
          this.db
            .prepare(`UPDATE sessions SET last_journaled_at = ? WHERE id = ?`)
            .run(nowIso, session.id);
        })
        .catch((err: unknown) => {
          const current = this.journalingAttempts.get(session.conversation_id);
          if (current) current.count += 1;
          console.error(
            `[session-tracker] Journaling turn failed for ${session.conversation_id.slice(0, 8)} ` +
              `(attempt ${current?.count ?? 1}):`,
            err,
          );
        });
    }
  }

  /** Resolve the minimum message count required before a session can be closed, for a given channel. */
  private minMessagesForChannel(channel: string): number {
    const cfg = this.config.memory.session_close_min_messages;
    if (cfg == null) return 0;
    if (typeof cfg === 'number') return cfg;
    return cfg[channel] ?? 0;
  }

  /** Close sessions idle past the inactivity threshold and trigger summarization. */
  private closeIdleSessions(): void {
    const thresholdMs = this.config.memory.session_idle_threshold_ms;
    const cutoff = new Date(Date.now() - thresholdMs).toISOString();

    // All idle sessions are closed regardless of message_count to prevent
    // accumulation. Hook and summarization only fire for those meeting the
    // per-channel minimum.
    //
    // E20: headless-managed sessions (claude_session_id set by cc-headless) are
    // long-lived and never force-closed on idle — the journaling dispatcher
    // captures their knowledge on pause instead. Only the legacy MCP path
    // (claude_session_id IS NULL) is torn down here.
    const idleSessions = this.db
      .prepare(
        `SELECT * FROM sessions
         WHERE ended_at IS NULL AND status = 'active' AND last_activity < ?
           AND claude_session_id IS NULL`,
      )
      .all(cutoff) as SessionRow[];

    if (idleSessions.length === 0) return;

    const now = new Date().toISOString();
    const closeSession = this.db.prepare(
      `UPDATE sessions SET ended_at = ?, status = 'summarize_pending' WHERE id = ?`,
    );

    for (const session of idleSessions) {
      closeSession.run(now, session.id);
      const meetsThreshold = session.message_count >= this.minMessagesForChannel(session.channel);
      console.log(
        `[session-tracker] Closed idle session ${session.id.slice(0, 8)} ` +
          `(${session.channel}/${session.contact_id}, ${session.message_count} msgs)` +
          (meetsThreshold ? '' : ' — below min_messages, skipping hook+summarize'),
      );
      if (!meetsThreshold) continue;
      this.runOnSessionCloseHook(session);
      // Fire-and-forget — summarizer handles retries and error marking internally.
      // The outer .catch() is a last-resort guard: if summarize() itself throws
      // unexpectedly (e.g. DB failure inside its own error handler), we still
      // need to move the session out of 'summarize_pending' so it is not orphaned.
      this.summarizer.summarize(session.id).catch((err) => {
        console.error(
          `[session-tracker] Unhandled error summarizing ${session.id.slice(0, 8)}:`,
          err,
        );
        try {
          this.db
            .prepare(
              `UPDATE sessions
               SET status = 'summarize_failed', summary_attempts = summary_attempts + 1
               WHERE id = ?`,
            )
            .run(session.id);
        } catch (dbErr) {
          console.error(
            `[session-tracker] Failed to mark session ${session.id.slice(0, 8)} as failed:`,
            dbErr,
          );
        }
      });
    }
  }

  /**
   * Process sessions that Stage 80 closed mid-conversation (ended_at set by
   * transcript-log when a new message arrives after the idle gap, but status
   * left as 'active' and hook never called). Fires the on_session_close hook
   * and promotes them to 'summarize_pending' so the summarizer picks them up.
   *
   * Only processes sessions whose ended_at falls within the last 2× the idle
   * threshold — older orphans are silently promoted to suppress accumulated
   * backlog without flooding the hook on startup.
   */
  private processMidFlightClosedSessions(): void {
    const thresholdMs = this.config.memory.session_idle_threshold_ms;
    const recentCutoff = new Date(Date.now() - thresholdMs * 2).toISOString();

    // Silently drain any pre-existing orphans older than the recency window
    // so they don't accumulate and flood the hook on every restart.
    this.db
      .prepare(
        `UPDATE sessions SET status = 'summarize_pending'
         WHERE ended_at IS NOT NULL AND status = 'active' AND ended_at < ?`,
      )
      .run(recentCutoff);

    const orphans = (
      this.db
        .prepare(
          `SELECT * FROM sessions
           WHERE ended_at IS NOT NULL AND status = 'active' AND ended_at >= ?`,
        )
        .all(recentCutoff) as SessionRow[]
    ).filter((s) => s.message_count >= this.minMessagesForChannel(s.channel));

    if (orphans.length === 0) return;

    const promote = this.db.prepare(
      `UPDATE sessions SET status = 'summarize_pending' WHERE id = ?`,
    );

    for (const session of orphans) {
      promote.run(session.id);
      console.log(
        `[session-tracker] Processing mid-flight closed session ${session.id.slice(0, 8)} ` +
          `(${session.channel}/${session.contact_id}, ${session.message_count} msgs)`,
      );
      this.runOnSessionCloseHook(session);
      this.summarizer.summarize(session.id).catch((err) => {
        console.error(
          `[session-tracker] Unhandled error summarizing ${session.id.slice(0, 8)}:`,
          err,
        );
        try {
          this.db
            .prepare(
              `UPDATE sessions
               SET status = 'summarize_failed', summary_attempts = summary_attempts + 1
               WHERE id = ?`,
            )
            .run(session.id);
        } catch (dbErr) {
          console.error(
            `[session-tracker] Failed to mark session ${session.id.slice(0, 8)} as failed:`,
            dbErr,
          );
        }
      });
    }
  }

  /** Retry sessions marked summarize_failed that have not exceeded the attempt limit. */
  private retryFailedSessions(): void {
    const failedSessions = this.db
      .prepare(
        `SELECT * FROM sessions
         WHERE status = 'summarize_failed' AND summary_attempts < ?
         LIMIT 3`,
      )
      .all(MAX_SUMMARY_ATTEMPTS) as SessionRow[];

    for (const session of failedSessions) {
      console.log(
        `[session-tracker] Retrying summarization for session ${session.id.slice(0, 8)} ` +
          `(attempt ${session.summary_attempts + 1}/${MAX_SUMMARY_ATTEMPTS})`,
      );
      // Reset to pending so summarize() can proceed
      this.db
        .prepare(`UPDATE sessions SET status = 'summarize_pending' WHERE id = ?`)
        .run(session.id);
      this.summarizer.summarize(session.id).catch((err) => {
        console.error(
          `[session-tracker] Unhandled error retrying ${session.id.slice(0, 8)}:`,
          err,
        );
        try {
          this.db
            .prepare(
              `UPDATE sessions
               SET status = 'summarize_failed', summary_attempts = summary_attempts + 1
               WHERE id = ?`,
            )
            .run(session.id);
        } catch (dbErr) {
          console.error(
            `[session-tracker] Failed to mark session ${session.id.slice(0, 8)} as failed:`,
            dbErr,
          );
        }
      });
    }
  }

  /**
   * Run the on_session_close hook command, if configured.
   * Fires asynchronously — a hook failure never blocks session processing.
   */
  private runOnSessionCloseHook(session: SessionRow): void {
    const hookConfig = this.config.memory.on_session_close;
    if (!hookConfig) return;

    const cmd =
      typeof hookConfig === 'string' ? hookConfig : hookConfig[session.channel];
    if (!cmd) return;

    const options: ExecOptionsWithStringEncoding = {
      encoding: 'utf8',
      env: {
        ...process.env,
        AGENTBUS_SESSION_ID: session.id,
        AGENTBUS_CHANNEL: session.channel,
        AGENTBUS_CONTACT_ID: session.contact_id,
        AGENTBUS_MESSAGE_COUNT: String(session.message_count),
      },
    };

    exec(cmd, options, (err, stdout, stderr) => {
      if (err) {
        console.error(
          `[session-tracker] on_session_close hook failed for ${session.id.slice(0, 8)}:`,
          err.message,
        );
        if (stderr) console.error('[session-tracker] hook stderr:', stderr.trim());
      } else {
        console.log(`[session-tracker] on_session_close hook ran for ${session.id.slice(0, 8)}`);
        if (stdout.trim()) console.log('[session-tracker] hook stdout:', stdout.trim());
      }
    });
  }

  /**
   * Hard-delete memories that expired more than HARD_DELETE_AFTER_DAYS ago.
   *
   * Recently-expired memories (expires_at < now but within the 30-day window)
   * are kept for audit and are soft-excluded from recall results by filtering
   * on expires_at in the query.
   */
  private sweepExpiredMemories(): void {
    const result = this.db
      .prepare(
        `DELETE FROM memories
         WHERE expires_at IS NOT NULL
           AND datetime(expires_at, '+${HARD_DELETE_AFTER_DAYS} days') < datetime('now')`,
      )
      .run();

    if (result.changes > 0) {
      console.log(`[session-tracker] Swept ${result.changes} expired memory record(s)`);
    }
  }
}

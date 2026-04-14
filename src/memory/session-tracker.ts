/**
 * E8 — Session Tracker (S8.2)
 *
 * Background task that runs on a configurable interval. Each tick:
 *   1. Closes sessions that have been idle past the inactivity threshold.
 *   2. Triggers Summarizer.summarize() for each newly-closed session (async,
 *      fire-and-forget so one slow API call does not block subsequent ticks).
 *   3. Retries sessions that previously failed summarization (up to 3 times).
 *   4. Hard-deletes memories expired more than 30 days ago.
 *
 * The tracker does NOT set session.ended_at itself for sessions closed mid-
 * conversation (that is done by Stage 80 when a new message arrives after the
 * threshold). It handles the complementary case: sessions that go idle without
 * any subsequent message — they would never close otherwise.
 */
import type Database from 'better-sqlite3';
import type { AppConfig } from '../config/schema.js';
import type { Summarizer } from './summarizer.js';
import type { SessionRow } from './types.js';

/** Days after expiry before a memory is hard-deleted. */
const HARD_DELETE_AFTER_DAYS = 30;
/** Max summarization attempts before giving up. */
const MAX_SUMMARY_ATTEMPTS = 3;

export class SessionTracker {
  private db: Database.Database;
  private config: AppConfig;
  private summarizer: Summarizer;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: {
    db: Database.Database;
    config: AppConfig;
    summarizer: Summarizer;
  }) {
    this.db = deps.db;
    this.config = deps.config;
    this.summarizer = deps.summarizer;
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
      this.retryFailedSessions();
    } catch (err) {
      console.error('[session-tracker] Error retrying failed sessions:', err);
    }

    try {
      this.sweepExpiredMemories();
    } catch (err) {
      console.error('[session-tracker] Error sweeping expired memories:', err);
    }
  }

  /** Close sessions idle past the inactivity threshold and trigger summarization. */
  private closeIdleSessions(): void {
    const thresholdMs = this.config.memory.session_idle_threshold_ms;
    const cutoff = new Date(Date.now() - thresholdMs).toISOString();

    const idleSessions = this.db
      .prepare(
        `SELECT * FROM sessions
         WHERE ended_at IS NULL AND status = 'active' AND last_activity < ?`,
      )
      .all(cutoff) as SessionRow[];

    if (idleSessions.length === 0) return;

    const now = new Date().toISOString();
    const closeSession = this.db.prepare(
      `UPDATE sessions SET ended_at = ?, status = 'summarize_pending' WHERE id = ?`,
    );

    for (const session of idleSessions) {
      closeSession.run(now, session.id);
      console.log(
        `[session-tracker] Closed idle session ${session.id.slice(0, 8)} ` +
          `(${session.channel}/${session.contact_id}, ${session.message_count} msgs)`,
      );
      // Fire-and-forget — summarizer handles retries and error marking
      this.summarizer.summarize(session.id).catch((err) => {
        console.error(
          `[session-tracker] Unhandled error summarizing ${session.id.slice(0, 8)}:`,
          err,
        );
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
      });
    }
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

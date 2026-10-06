/**
 * E8 — Session Tracker (S8.2)
 *
 * Background task that runs on a configurable interval. Each tick:
 *   1. Closes sessions that have been idle past the inactivity threshold.
 *   2. Processes sessions closed mid-conversation by Stage 80 (ended_at set,
 *      status still 'active') — fires the on_session_close hook for those
 *      that meet the min-messages threshold.
 *   3. Hard-deletes memories expired more than 30 days ago.
 *
 * Every close is reported to the journaling engine (`onSessionClosed`, the
 * `close` trigger) and the session moves to status `closed`. E66 retired the
 * Anthropic-API summarizer that used to run here; journaling replaces it.
 *
 * Stage 80 (transcript-log) sets ended_at when a new message arrives after the
 * idle threshold, but does not fire the hook or update status. This tracker
 * picks those up on its next tick via processMidFlightClosedSessions().
 */
import { exec, type ExecOptionsWithStringEncoding } from 'node:child_process';
import type Database from 'better-sqlite3';
import type { AppConfig } from '../config/schema.js';
import type { SessionRow } from './types.js';

/** Days after expiry before a memory is hard-deleted. */
const HARD_DELETE_AFTER_DAYS = 30;

export class SessionTracker {
  private db: Database.Database;
  private config: AppConfig;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** E66 — the journaling engine's `close` trigger. */
  private readonly onSessionClosed: ((session: SessionRow) => void) | undefined;

  constructor(deps: {
    db: Database.Database;
    config: AppConfig;
    /** Called once for each session the tracker closes or finds closed mid-flight. */
    onSessionClosed?: (session: SessionRow) => void;
  }) {
    this.db = deps.db;
    this.config = deps.config;
    this.onSessionClosed = deps.onSessionClosed;
  }

  private notifyClosed(session: SessionRow): void {
    if (!this.onSessionClosed) return;
    try {
      this.onSessionClosed(session);
    } catch (err) {
      console.error(`[session-tracker] onSessionClosed failed for ${session.id.slice(0, 8)}:`, err);
    }
  }

  /** Start the background tick loop. Runs one immediate tick before the interval. */
  start(): void {
    this.tick();
    this.timer = setInterval(() => this.tick(), this.config.memory.summarizer_interval_ms);
  }

  /** Stop the background tick loop. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Run one tracker tick. Exposed for testing. All DB operations are synchronous. */
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
      this.sweepExpiredMemories();
    } catch (err) {
      console.error('[session-tracker] Error sweeping expired memories:', err);
    }
  }

  /** Resolve the minimum message count required before a session can be closed, for a given channel. */
  private minMessagesForChannel(channel: string): number {
    const cfg = this.config.memory.session_close_min_messages;
    if (cfg == null) return 0;
    if (typeof cfg === 'number') return cfg;
    return cfg[channel] ?? 0;
  }

  /** Close sessions idle past the inactivity threshold. */
  private closeIdleSessions(): void {
    const thresholdMs = this.config.memory.session_idle_threshold_ms;
    const cutoff = new Date(Date.now() - thresholdMs).toISOString();

    // All idle sessions are closed regardless of message_count to prevent
    // accumulation. The hook only fires for those meeting the per-channel
    // minimum; the journaling engine applies its own eligibility rules.
    //
    // E20: headless-managed sessions (claude_session_id set by cc-headless or
    // cc-pool) are long-lived and never force-closed on idle; journaling
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
    const closeSession = this.db.prepare(`UPDATE sessions SET ended_at = ?, status = 'closed' WHERE id = ?`);

    for (const session of idleSessions) {
      closeSession.run(now, session.id);
      this.notifyClosed({ ...session, ended_at: now, status: 'closed' });
      const meetsThreshold = session.message_count >= this.minMessagesForChannel(session.channel);
      console.log(
        `[session-tracker] Closed idle session ${session.id.slice(0, 8)} ` +
          `(${session.channel}/${session.contact_id}, ${session.message_count} msgs)` +
          (meetsThreshold ? '' : ' — below min_messages, skipping hook'),
      );
      if (meetsThreshold) this.runOnSessionCloseHook(session);
    }
  }

  /**
   * Process sessions that Stage 80 closed mid-conversation (ended_at set by
   * transcript-log when a new message arrives after the idle gap, but status
   * left as 'active' and hook never called). Reports each close to
   * journaling once, fires the on_session_close hook for those meeting the
   * min-messages threshold, and moves them to status 'closed'.
   *
   * Only processes sessions whose ended_at falls within the last 2× the idle
   * threshold — older orphans are silently marked closed to suppress
   * accumulated backlog without flooding the hook on startup.
   */
  private processMidFlightClosedSessions(): void {
    const thresholdMs = this.config.memory.session_idle_threshold_ms;
    const recentCutoff = new Date(Date.now() - thresholdMs * 2).toISOString();

    this.db
      .prepare(
        `UPDATE sessions SET status = 'closed'
         WHERE ended_at IS NOT NULL AND status = 'active' AND ended_at < ?`,
      )
      .run(recentCutoff);

    const recent = this.db
      .prepare(
        `SELECT * FROM sessions
         WHERE ended_at IS NOT NULL AND status = 'active' AND ended_at >= ?`,
      )
      .all(recentCutoff) as SessionRow[];

    const markClosed = this.db.prepare(`UPDATE sessions SET status = 'closed' WHERE id = ?`);
    for (const session of recent) {
      markClosed.run(session.id);
      this.notifyClosed({ ...session, status: 'closed' });
      if (session.message_count < this.minMessagesForChannel(session.channel)) continue;
      console.log(
        `[session-tracker] Processing mid-flight closed session ${session.id.slice(0, 8)} ` +
          `(${session.channel}/${session.contact_id}, ${session.message_count} msgs)`,
      );
      this.runOnSessionCloseHook(session);
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
   * Hard-delete legacy memories that expired more than HARD_DELETE_AFTER_DAYS
   * ago (retention for the read-only `memories` table).
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

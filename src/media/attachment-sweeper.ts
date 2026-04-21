/**
 * E17 — Attachment Sweeper (S17.5)
 *
 * Background task that deletes expired attachment files from disk and removes
 * the corresponding rows from the `attachments` table. Runs once at startup
 * and then on a fixed 10-minute interval.
 *
 * Error handling is per-row: a single unlink or delete failure is logged but
 * does not abort the sweep. A missing file (ENOENT) is tolerated — the DB row
 * is still removed so we don't re-attempt the same unlink forever.
 */
import { unlinkSync } from 'node:fs';
import type Database from 'better-sqlite3';

/** Sweep interval: 10 minutes. Not configurable per E17 scope. */
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

interface ExpiredRow {
  id: string;
  local_path: string;
}

export class AttachmentSweeper {
  private db: Database.Database;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: { db: Database.Database }) {
    this.db = deps.db;
  }

  /** Start the sweep. Runs one immediate tick before entering the interval loop. */
  start(): void {
    this.tick();
    this.timer = setInterval(() => this.tick(), SWEEP_INTERVAL_MS);
  }

  /** Stop the sweep. Any in-flight tick completes on its own. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Run one sweep pass. Exposed for testing.
   *
   * All operations are synchronous (better-sqlite3 + fs.unlinkSync) so the
   * sweep completes in a single tick without overlapping itself.
   */
  tick(): void {
    const now = Date.now();
    let rows: ExpiredRow[];
    try {
      rows = this.db
        .prepare(`SELECT id, local_path FROM attachments WHERE expires_at <= ?`)
        .all(now) as ExpiredRow[];
    } catch (err) {
      console.error('[attachment-sweeper] Failed to query expired rows:', err);
      return;
    }

    if (rows.length === 0) return;

    const deleteStmt = this.db.prepare(`DELETE FROM attachments WHERE id = ?`);
    let swept = 0;

    for (const row of rows) {
      try {
        let canDelete = false;
        try {
          unlinkSync(row.local_path);
          canDelete = true;
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === 'ENOENT') {
            // File already gone — still remove the DB row so we don't retry forever.
            canDelete = true;
          } else {
            // Permission error or other fs failure — leave the row so the next
            // sweep can retry once the underlying problem is resolved.
            console.error(
              `[attachment-sweeper] Failed to unlink ${row.local_path}:`,
              err,
            );
          }
        }
        if (canDelete) {
          deleteStmt.run(row.id);
          swept++;
        }
      } catch (err) {
        console.error(`[attachment-sweeper] Failed to sweep row ${row.id}:`, err);
      }
    }

    if (swept > 0) {
      console.log(`[attachment-sweeper] Swept ${swept} expired attachment(s)`);
    }
  }
}

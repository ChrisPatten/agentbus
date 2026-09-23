/**
 * E52 (S52.2) — "unhandled work" for a leased pool pane.
 *
 * `cc.ts` acks a message when it receives it, so `acked_at` means delivered to
 * the pane, not handled. A delivered message is unhandled until a Stop-hook
 * turn end (`last_turn_ended_at`) follows it.
 */
import type Database from 'better-sqlite3';
import type { PoolLeaseRow } from './types.js';

const stmtCache = new WeakMap<Database.Database, Database.Statement>();

/**
 * ISO timestamp of the oldest message `cc.ts` acked for this pane after the
 * later of its last turn end and its lease start, or `null` when nothing is
 * waiting. Never-acked (pending) messages are undelivered and excluded.
 * `acked_at` is ISO-8601 (`Date.toISOString()`), so string comparison is valid.
 */
export function getUnhandledSince(db: Database.Database, row: PoolLeaseRow): string | null {
  let stmt = stmtCache.get(db);
  if (!stmt) {
    stmt = db.prepare(
      `SELECT MIN(acked_at) AS since FROM message_queue
       WHERE recipient = ? AND acked_at IS NOT NULL AND acked_at > ?`,
    );
    stmtCache.set(db, stmt);
  }
  const floor = [row.last_turn_ended_at ?? '', row.leased_at ?? ''].reduce((a, b) => (a > b ? a : b));
  const r = stmt.get(row.agent_id, floor) as { since: string | null } | undefined;
  return r?.since ?? null;
}

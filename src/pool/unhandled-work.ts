/**
 * E52 (S52.2) — "unhandled work" for a leased pool pane.
 *
 * STUB: S52.2 replaces this with the real query. The signature is fixed
 * because S52.1's watchdog wiring imports it.
 */
import type Database from 'better-sqlite3';
import type { PoolLeaseRow } from './types.js';

/**
 * ISO timestamp of the oldest message `cc.ts` acked for this pane that no
 * finished turn has followed, or `null` when nothing is waiting.
 */
export function getUnhandledSince(_db: Database.Database, _row: PoolLeaseRow): string | null {
  return null;
}

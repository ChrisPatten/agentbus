/**
 * "On my way" flags for the desk departure: the user tapped the train alert's action, so the face should show that
 * train's live estimated departure until the API reports it gone. Stored in SQLite (survives a bus restart), one row
 * per (date, train); a flag also expires after a safety timeout in case the API never reports the departure.
 */
import type Database from 'better-sqlite3';

export const ON_MY_WAY_TIMEOUT_MIN = 180;

export class OnMyWayStore {
  constructor(private readonly db: Database.Database) {
    try {
      db.exec('CREATE TABLE IF NOT EXISTS intercom_on_my_way (date TEXT NOT NULL, train TEXT NOT NULL, set_at INTEGER NOT NULL, PRIMARY KEY (date, train))');
    } catch { /* read-only or odd db: flags then simply do not stick */ }
  }

  set(date: string, train: string, nowMs: number): void {
    try { this.db.prepare('INSERT INTO intercom_on_my_way(date, train, set_at) VALUES (?,?,?) ON CONFLICT(date, train) DO UPDATE SET set_at = excluded.set_at').run(date, train, nowMs); }
    catch { /* see constructor */ }
  }

  clear(date: string, train: string): void {
    try { this.db.prepare('DELETE FROM intercom_on_my_way WHERE date = ? AND train = ?').run(date, train); } catch { /* ignore */ }
  }

  /** Trains flagged for `date` and not past the timeout. Older rows (other dates, expired) are deleted. */
  active(date: string, nowMs: number, timeoutMin = ON_MY_WAY_TIMEOUT_MIN): Set<string> {
    try {
      this.db.prepare('DELETE FROM intercom_on_my_way WHERE date <> ? OR set_at < ?').run(date, nowMs - timeoutMin * 60_000);
      return new Set((this.db.prepare('SELECT train FROM intercom_on_my_way WHERE date = ?').all(date) as { train: string }[]).map((r) => r.train));
    } catch { return new Set(); }
  }
}

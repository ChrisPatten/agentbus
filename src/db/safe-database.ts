/**
 * SafeDatabase — read-only wrapper around better-sqlite3.
 *
 * Exposes only `.prepare()` with `.get()` and `.all()` on the returned
 * statement. Prevents `.run()`, `.exec()`, and other write operations.
 *
 * Used in SlashCommandContext so plugin commands cannot mutate the database.
 * Built-in commands that need writes (e.g. /forget) access the real DB
 * through their closure over HandlerDeps.
 */
import type Database from 'better-sqlite3';

/** A statement that can only read, not write */
export interface SafeStatement<T = unknown> {
  get(...params: unknown[]): T | undefined;
  all(...params: unknown[]): T[];
}

/** Read-only database interface exposed to command handlers */
export interface SafeDatabase {
  prepare<T = unknown>(sql: string): SafeStatement<T>;
}

/**
 * Wrap a better-sqlite3 Database in a read-only SafeDatabase.
 */
export function createSafeDatabase(db: Database.Database): SafeDatabase {
  return {
    prepare<T = unknown>(sql: string): SafeStatement<T> {
      const stmt = db.prepare(sql);
      return {
        get(...params: unknown[]): T | undefined {
          return stmt.get(...params) as T | undefined;
        },
        all(...params: unknown[]): T[] {
          return stmt.all(...params) as T[];
        },
      };
    },
  };
}

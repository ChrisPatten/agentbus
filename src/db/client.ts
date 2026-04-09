import Database from 'better-sqlite3';

/**
 * Open (or create) a SQLite database file with WAL mode and foreign key enforcement.
 *
 * WAL mode is non-negotiable: multiple processes (bus-core + adapters via HTTP)
 * read the database simultaneously, requiring WAL for concurrent-safe reads.
 */
export function openDb(path: string): Database.Database {
  const db = new Database(path);

  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  return db;
}

/** Singleton instance — created once and shared within the process */
let _instance: Database.Database | null = null;

/**
 * Return the shared database instance, creating it if this is the first call.
 * Pass `path` only on the first call; subsequent calls ignore it.
 */
export function getDb(path?: string): Database.Database {
  if (_instance === null) {
    if (!path) {
      throw new Error('getDb() called before initialization — provide a db_path on first call');
    }
    _instance = openDb(path);
  }
  return _instance;
}

/** Close and clear the singleton (used in tests). */
export function closeDb(): void {
  if (_instance !== null) {
    _instance.close();
    _instance = null;
  }
}

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import type Database from 'better-sqlite3';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface Migration {
  version: number;
  description: string;
  sql: string;
}

function loadMigrations(): Migration[] {
  const migrationsDir = join(__dirname, 'migrations');
  return [
    {
      version: 1,
      description: 'Initial schema',
      sql: readFileSync(join(migrationsDir, '001_initial_schema.sql'), 'utf-8'),
    },
    {
      version: 2,
      description: 'Paused adapters',
      sql: readFileSync(join(migrationsDir, '002_paused_adapters.sql'), 'utf-8'),
    },
  ];
}

/**
 * Create the migrations tracking table if it doesn't exist.
 */
function ensureMigrationsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     INTEGER PRIMARY KEY,
      applied_at  TEXT NOT NULL,
      description TEXT NOT NULL
    )
  `);
}

/**
 * Run all pending migrations against the database.
 *
 * Fully idempotent — safe to call on an already-migrated database.
 * Each migration is applied in a transaction; if it fails the transaction is
 * rolled back and the error is re-thrown.
 */
export function runMigrations(db: Database.Database): void {
  ensureMigrationsTable(db);

  const applied = new Set<number>(
    (
      db.prepare('SELECT version FROM schema_migrations').all() as Array<{
        version: number;
      }>
    ).map((r) => r.version)
  );

  const migrations = loadMigrations();

  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;

    const apply = db.transaction(() => {
      db.exec(migration.sql);
      db.prepare(
        'INSERT INTO schema_migrations (version, applied_at, description) VALUES (?, ?, ?)'
      ).run(migration.version, new Date().toISOString(), migration.description);
    });

    apply();
  }
}

/**
 * Rebuild FTS5 indices from their source tables.
 *
 * The FTS index uses `content=` mode (external content table) — it stores only
 * the search index, not a copy of the text. Triggers keep it in sync under
 * normal operation, but the index can drift out of sync if:
 *   - The DB file is restored from a backup that pre-dates the FTS index
 *   - A migration runs raw SQL that bypasses the triggers
 *   - SQLite is interrupted mid-write during a bulk insert
 *
 * Trigger via the `--rebuild-fts` CLI flag on startup (handled in index.ts).
 * Safe to run on a live database; FTS REBUILD takes an exclusive lock briefly.
 */
export function rebuildFts(db: Database.Database): void {
  db.exec(`INSERT INTO transcripts_fts (transcripts_fts) VALUES ('rebuild')`);
}

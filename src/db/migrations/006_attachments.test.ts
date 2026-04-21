import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../schema.js';

describe('migration 006 — attachments', () => {
  function fresh() {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    return db;
  }

  it('creates the attachments table on a fresh DB', () => {
    const db = fresh();
    runMigrations(db);

    const row = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='attachments'`)
      .get() as { name: string } | undefined;
    expect(row?.name).toBe('attachments');
  });

  it('creates the expires_at index', () => {
    const db = fresh();
    runMigrations(db);

    const row = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_attachments_expires_at'`,
      )
      .get() as { name: string } | undefined;
    expect(row?.name).toBe('idx_attachments_expires_at');
  });

  it('accepts an insert with the epic-specified column shape', () => {
    const db = fresh();
    runMigrations(db);

    const now = Date.now();
    db.prepare(
      `INSERT INTO attachments (id, agent_id, local_path, original_filename, mime_type, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('att-1', 'agent:claude', '/tmp/foo.jpg', 'photo.jpg', 'image/jpeg', now, now + 3600_000);

    const row = db.prepare(`SELECT * FROM attachments WHERE id = ?`).get('att-1') as {
      agent_id: string;
      local_path: string;
      expires_at: number;
    };
    expect(row.agent_id).toBe('agent:claude');
    expect(row.local_path).toBe('/tmp/foo.jpg');
    expect(row.expires_at).toBe(now + 3600_000);
  });

  it('is idempotent on re-run', () => {
    const db = fresh();
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();

    const count = (
      db.prepare(`SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 6`).get() as {
        n: number;
      }
    ).n;
    expect(count).toBe(1);
  });
});

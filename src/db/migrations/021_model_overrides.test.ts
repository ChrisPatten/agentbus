import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../schema.js';

describe('migration 021 — model_overrides', () => {
  function migrated() {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    return db;
  }

  it('creates model_overrides with the expected columns', () => {
    const db = migrated();
    const cols = db.prepare(`PRAGMA table_info(model_overrides)`).all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name).sort()).toEqual(
      ['agent_id', 'created_at', 'id', 'model', 'updated_at'].sort(),
    );
  });

  it('drops headless_model_overrides', () => {
    const db = migrated();
    const row = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='headless_model_overrides'`)
      .get();
    expect(row).toBeUndefined();
  });

  it('enforces one row per agent_id key (including global NULL)', () => {
    const db = migrated();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO model_overrides (agent_id, model, created_at, updated_at) VALUES (?, ?, ?, ?)`,
    ).run('agent:peggy', 'sonnet', now, now);
    expect(() =>
      db
        .prepare(`INSERT INTO model_overrides (agent_id, model, created_at, updated_at) VALUES (?, ?, ?, ?)`)
        .run('agent:peggy', 'haiku', now, now),
    ).toThrow(/UNIQUE constraint failed/);

    db.prepare(`INSERT INTO model_overrides (agent_id, model, created_at, updated_at) VALUES (NULL, ?, ?, ?)`).run(
      'opus',
      now,
      now,
    );
    expect(() =>
      db
        .prepare(`INSERT INTO model_overrides (agent_id, model, created_at, updated_at) VALUES (NULL, ?, ?, ?)`)
        .run('haiku', now, now),
    ).toThrow(/UNIQUE constraint failed/);
  });

  it('supports an upsert on the COALESCE(agent_id, \'\') index for both scoped and global rows', () => {
    const db = migrated();
    const now = new Date().toISOString();
    const upsert = (agentId: string | null, model: string) =>
      db
        .prepare(
          `INSERT INTO model_overrides (agent_id, model, created_at, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(COALESCE(agent_id, '')) DO UPDATE SET model = excluded.model, updated_at = excluded.updated_at`,
        )
        .run(agentId, model, now, now);

    upsert(null, 'sonnet');
    upsert(null, 'opus');
    upsert('agent:peggy', 'haiku');
    upsert('agent:peggy', 'sonnet');

    const rows = db.prepare(`SELECT agent_id, model FROM model_overrides ORDER BY agent_id`).all() as Array<{
      agent_id: string | null;
      model: string;
    }>;
    expect(rows).toEqual([
      { agent_id: null, model: 'opus' },
      { agent_id: 'agent:peggy', model: 'sonnet' },
    ]);
  });

  it('migrates the newest schedule-less row per agent_id from headless_model_overrides, dropping schedule-scoped rows', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');

    // Run migrations, then revert 021's effects to hand-seed the pre-021 table state.
    runMigrations(db);
    db.exec(`DROP TABLE model_overrides;`);
    db.prepare(`DELETE FROM schema_migrations WHERE version = 21`).run();
    db.exec(`
      CREATE TABLE headless_model_overrides (
        id            INTEGER PRIMARY KEY,
        schedule_id   TEXT,
        agent_id      TEXT,
        model         TEXT NOT NULL,
        priority      INTEGER DEFAULT 0,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );
    `);
    const ins = db.prepare(
      `INSERT INTO headless_model_overrides (schedule_id, agent_id, model, priority, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)`,
    );
    // Global: two rows, newest (opus) should win.
    ins.run(null, null, 'sonnet', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
    ins.run(null, null, 'opus', '2026-09-02T00:00:00.000Z', '2026-09-02T00:00:00.000Z');
    // Agent-scoped: two rows for agent:peggy, newest (haiku) should win.
    ins.run(null, 'agent:peggy', 'sonnet', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
    ins.run(null, 'agent:peggy', 'haiku', '2026-09-03T00:00:00.000Z', '2026-09-03T00:00:00.000Z');
    // Schedule-scoped: dropped, not migrated.
    ins.run('schedule-123', null, 'opus', '2026-09-04T00:00:00.000Z', '2026-09-04T00:00:00.000Z');
    ins.run('schedule-123', 'agent:peggy', 'opus', '2026-09-04T00:00:00.000Z', '2026-09-04T00:00:00.000Z');

    runMigrations(db);

    const rows = db
      .prepare(`SELECT agent_id, model FROM model_overrides ORDER BY agent_id IS NULL DESC, agent_id`)
      .all() as Array<{ agent_id: string | null; model: string }>;
    expect(rows).toEqual([
      { agent_id: null, model: 'opus' },
      { agent_id: 'agent:peggy', model: 'haiku' },
    ]);

    const oldTable = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='headless_model_overrides'`)
      .get();
    expect(oldTable).toBeUndefined();
  });

  it('is idempotent across repeated runMigrations calls', () => {
    const db = migrated();
    expect(() => runMigrations(db)).not.toThrow();
  });
});

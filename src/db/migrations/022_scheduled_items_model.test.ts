import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../schema.js';

describe('migration 022 — scheduled_items model column', () => {
  function migrated() {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    return db;
  }

  it('adds a nullable model column to scheduled_items', () => {
    const db = migrated();
    const cols = db.prepare(`PRAGMA table_info(scheduled_items)`).all() as Array<{
      name: string;
      notnull: number;
    }>;
    const col = cols.find((c) => c.name === 'model');
    expect(col).toBeDefined();
    expect(col!.notnull).toBe(0);
  });

  it('defaults model to NULL for existing and new rows', () => {
    const db = migrated();
    db.prepare(
      `INSERT INTO scheduled_items
         (id, type, timezone, fire_at, channel, sender, payload_body, topic, priority, label, created_at, created_by, fire_count, status)
       VALUES ('sched-1', 'once', 'UTC', '2026-09-26T00:00:00.000Z', 'telegram', 'system:peggy', 'hello', 'general', 'normal', NULL, '2026-09-25T00:00:00.000Z', 'api', 0, 'active')`,
    ).run();
    const row = db.prepare(`SELECT model FROM scheduled_items WHERE id = 'sched-1'`).get() as {
      model: string | null;
    };
    expect(row.model).toBeNull();
  });

  it('preserves existing rows across the migration, with model NULL', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    // Rewind to pre-022 state.
    db.exec(`ALTER TABLE scheduled_items DROP COLUMN model;`);
    db.prepare(`DELETE FROM schema_migrations WHERE version = 22`).run();
    db.prepare(
      `INSERT INTO scheduled_items
         (id, type, timezone, fire_at, channel, sender, payload_body, topic, priority, label, created_at, created_by, fire_count, status)
       VALUES ('sched-2', 'cron', 'UTC', '2026-09-26T00:00:00.000Z', 'telegram', 'system:peggy', 'hello', 'general', 'normal', 'Morning Brief', '2026-09-25T00:00:00.000Z', 'config', 0, 'active')`,
    ).run();

    runMigrations(db);

    const row = db.prepare(`SELECT model, label FROM scheduled_items WHERE id = 'sched-2'`).get() as {
      model: string | null;
      label: string;
    };
    expect(row.model).toBeNull();
    expect(row.label).toBe('Morning Brief');
  });

  it('is idempotent across repeated runMigrations calls', () => {
    const db = migrated();
    expect(() => runMigrations(db)).not.toThrow();
  });
});

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../schema.js';

describe('migration 023 — pool_leases.model', () => {
  function migrated() {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    return db;
  }

  it('adds a nullable model column to pool_leases', () => {
    const db = migrated();
    const cols = db.prepare(`PRAGMA table_info(pool_leases)`).all() as Array<{ name: string; notnull: number }>;
    const col = cols.find((c) => c.name === 'model');
    expect(col).toBeDefined();
    expect(col!.notnull).toBe(0);
  });

  it('leaves existing pool_leases rows with model NULL', () => {
    const db = migrated();
    db.prepare(
      `INSERT INTO pool_leases (pool_id, pane_id, agent_id, state) VALUES ('peggy', 'peggy-pool:1', 'agent:peggy-pool-1', 'free')`,
    ).run();
    const row = db.prepare(`SELECT model FROM pool_leases`).get() as { model: string | null };
    expect(row.model).toBeNull();
  });

  it('is idempotent across repeated runMigrations calls', () => {
    const db = migrated();
    expect(() => runMigrations(db)).not.toThrow();
  });
});

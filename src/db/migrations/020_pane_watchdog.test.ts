import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../schema.js';

describe('migration 020 — pane watchdog', () => {
  function migrated() {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    return db;
  }

  it('adds a nullable last_turn_ended_at column to pool_leases', () => {
    const db = migrated();
    const cols = db.prepare(`PRAGMA table_info(pool_leases)`).all() as Array<{ name: string; notnull: number }>;
    const col = cols.find((c) => c.name === 'last_turn_ended_at');
    expect(col).toBeDefined();
    expect(col!.notnull).toBe(0);
  });

  it('creates pane_incidents with the expected columns', () => {
    const db = migrated();
    const cols = db.prepare(`PRAGMA table_info(pane_incidents)`).all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name).sort()).toEqual(
      [
        'actions',
        'class',
        'conversation_id',
        'detected_at',
        'id',
        'pane_id',
        'pattern',
        'pool_id',
        'resolution',
        'resolved_at',
        'screen_snapshot',
        'unhandled_since',
      ].sort(),
    );
  });

  it('keeps existing pool_leases rows, with last_turn_ended_at NULL', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    db.prepare(
      `INSERT INTO pool_leases (pool_id, pane_id, agent_id, state) VALUES ('peggy', 'peggy-pool:1', 'agent:peggy-pool-1', 'free')`,
    ).run();
    const row = db.prepare(`SELECT last_turn_ended_at FROM pool_leases`).get() as { last_turn_ended_at: string | null };
    expect(row.last_turn_ended_at).toBeNull();
  });

  it('backfills last_turn_ended_at for panes already leased, so old acks are not "unhandled"', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    // Rewind to the pre-020 state, with one leased and one free pane.
    db.exec(`DROP TABLE pane_incidents; ALTER TABLE pool_leases DROP COLUMN last_turn_ended_at;`);
    db.prepare(`DELETE FROM schema_migrations WHERE version = 20`).run();
    const ins = db.prepare(
      `INSERT INTO pool_leases (pool_id, pane_id, agent_id, state, leased_at) VALUES ('peggy', ?, ?, ?, '2026-09-23T18:00:00.000Z')`,
    );
    ins.run('peggy-pool:1', 'agent:peggy-pool-1', 'leased');
    ins.run('peggy-pool:2', 'agent:peggy-pool-2', 'free');

    runMigrations(db);

    const rows = Object.fromEntries(
      (db.prepare(`SELECT pane_id, last_turn_ended_at AS t FROM pool_leases`).all() as Array<{ pane_id: string; t: string | null }>).map(
        (r) => [r.pane_id, r.t],
      ),
    );
    expect(rows['peggy-pool:1']).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(rows['peggy-pool:1']! > '2026-09-23T18:00:00.000Z').toBe(true);
    expect(rows['peggy-pool:2']).toBeNull();
  });

  it('is idempotent across repeated runMigrations calls', () => {
    const db = migrated();
    expect(() => runMigrations(db)).not.toThrow();
  });
});

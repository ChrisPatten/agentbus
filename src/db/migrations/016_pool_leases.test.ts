import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../schema.js';

describe('migration 016 — pool_leases table', () => {
  function fresh() {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    return db;
  }

  it('creates the pool_leases table with the expected columns', () => {
    const db = fresh();
    runMigrations(db);

    const tableRow = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='pool_leases'`)
      .get() as { name: string } | undefined;
    expect(tableRow?.name).toBe('pool_leases');

    const columns = db.prepare(`PRAGMA table_info(pool_leases)`).all() as Array<{
      name: string;
      notnull: number;
      pk: number;
    }>;
    const byName = Object.fromEntries(columns.map((c) => [c.name, c]));

    expect(Object.keys(byName).sort()).toEqual(
      [
        'pool_id',
        'pane_id',
        'agent_id',
        'conversation_id',
        'claude_session_id',
        'state',
        'leased_at',
        'last_activity_at',
        'last_turn_ended_at', // added by migration 020 (E52)
        'model', // added by migration 023 (E53)
      ].sort(),
    );

    // Composite primary key (pool_id, pane_id)
    expect(byName.pool_id?.pk).toBeGreaterThan(0);
    expect(byName.pane_id?.pk).toBeGreaterThan(0);
    expect(byName.conversation_id?.pk).toBe(0);

    // NOT NULL columns
    expect(byName.pool_id?.notnull).toBe(1);
    expect(byName.pane_id?.notnull).toBe(1);
    expect(byName.agent_id?.notnull).toBe(1);
    expect(byName.state?.notnull).toBe(1);
    // Nullable columns
    expect(byName.conversation_id?.notnull).toBe(0);
    expect(byName.claude_session_id?.notnull).toBe(0);
    expect(byName.leased_at?.notnull).toBe(0);
    expect(byName.last_activity_at?.notnull).toBe(0);
  });

  it('creates the expected indexes', () => {
    const db = fresh();
    runMigrations(db);

    const indexNames = (
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='pool_leases'`)
        .all() as Array<{ name: string }>
    ).map((r) => r.name);

    expect(indexNames).toContain('idx_pool_leases_conv');
    expect(indexNames).toContain('idx_pool_leases_agent');
  });

  it('round-trips an insert/select and enforces the (pool_id, pane_id) primary key', () => {
    const db = fresh();
    runMigrations(db);

    db.prepare(
      `INSERT INTO pool_leases
         (pool_id, pane_id, agent_id, conversation_id, claude_session_id, state, leased_at, last_activity_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('peggy-pool', 'peggy-pool:1', 'agent:peggy-pool-1', null, null, 'free', null, null);

    const row = db
      .prepare(`SELECT * FROM pool_leases WHERE pool_id = ? AND pane_id = ?`)
      .get('peggy-pool', 'peggy-pool:1') as
      | {
          pool_id: string;
          pane_id: string;
          agent_id: string;
          conversation_id: string | null;
          claude_session_id: string | null;
          state: string;
          leased_at: string | null;
          last_activity_at: string | null;
        }
      | undefined;

    expect(row).toBeDefined();
    expect(row?.pool_id).toBe('peggy-pool');
    expect(row?.pane_id).toBe('peggy-pool:1');
    expect(row?.agent_id).toBe('agent:peggy-pool-1');
    expect(row?.state).toBe('free');
    expect(row?.conversation_id).toBeNull();
    expect(row?.claude_session_id).toBeNull();

    // Duplicate (pool_id, pane_id) must violate the composite primary key.
    expect(() =>
      db
        .prepare(`INSERT INTO pool_leases (pool_id, pane_id, agent_id, state) VALUES (?, ?, ?, ?)`)
        .run('peggy-pool', 'peggy-pool:1', 'agent:peggy-pool-1', 'free'),
    ).toThrow();

    // A different pane_id in the same pool, or the same pane_id in a
    // different pool, is not a PK collision.
    expect(() =>
      db
        .prepare(`INSERT INTO pool_leases (pool_id, pane_id, agent_id, state) VALUES (?, ?, ?, ?)`)
        .run('peggy-pool', 'peggy-pool:2', 'agent:peggy-pool-2', 'free'),
    ).not.toThrow();
    expect(() =>
      db
        .prepare(`INSERT INTO pool_leases (pool_id, pane_id, agent_id, state) VALUES (?, ?, ?, ?)`)
        .run('other-pool', 'peggy-pool:1', 'agent:other-pool-1', 'free'),
    ).not.toThrow();
  });

  it('is idempotent on re-run', () => {
    const db = fresh();
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();

    const count = (
      db.prepare(`SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 16`).get() as {
        n: number;
      }
    ).n;
    expect(count).toBe(1);
  });
});

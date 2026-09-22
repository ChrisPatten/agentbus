import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../schema.js';

describe('migration 019 — approval_requests table', () => {
  function fresh() {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    return db;
  }

  it('creates the approval_requests table with the expected columns', () => {
    const db = fresh();
    runMigrations(db);

    const tableRow = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='approval_requests'`)
      .get() as { name: string } | undefined;
    expect(tableRow?.name).toBe('approval_requests');

    const columns = db.prepare(`PRAGMA table_info(approval_requests)`).all() as Array<{
      name: string;
      notnull: number;
      pk: number;
    }>;
    const byName = Object.fromEntries(columns.map((c) => [c.name, c]));

    expect(Object.keys(byName).sort()).toEqual(
      [
        'id',
        'adapter_id',
        'agent_id',
        'conversation_id',
        'contact_id',
        'tool_name',
        'summary',
        'raw_context',
        'status',
        'requested_at',
        'resolved_at',
        'resolved_by',
        'notify_channel',
        'notify_message_id',
        'expires_at',
      ].sort(),
    );

    expect(byName.id?.pk).toBe(1);
    expect(byName.adapter_id?.notnull).toBe(1);
    expect(byName.agent_id?.notnull).toBe(1);
    expect(byName.contact_id?.notnull).toBe(1);
    expect(byName.tool_name?.notnull).toBe(1);
    expect(byName.summary?.notnull).toBe(1);
    expect(byName.status?.notnull).toBe(1);
    expect(byName.requested_at?.notnull).toBe(1);
    expect(byName.expires_at?.notnull).toBe(1);
    // Nullable columns
    expect(byName.conversation_id?.notnull).toBe(0);
    expect(byName.raw_context?.notnull).toBe(0);
    expect(byName.resolved_at?.notnull).toBe(0);
    expect(byName.resolved_by?.notnull).toBe(0);
    expect(byName.notify_channel?.notnull).toBe(0);
    expect(byName.notify_message_id?.notnull).toBe(0);
  });

  it('creates the status/expires_at index', () => {
    const db = fresh();
    runMigrations(db);

    const indexNames = (
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='approval_requests'`)
        .all() as Array<{ name: string }>
    ).map((r) => r.name);

    expect(indexNames).toContain('idx_approval_requests_status');
  });

  it('round-trips an insert/select and defaults status to pending', () => {
    const db = fresh();
    runMigrations(db);

    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO approval_requests
         (id, adapter_id, agent_id, conversation_id, contact_id, tool_name, summary, requested_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('req-1', 'cc-pool', 'peggy-pool-1', 'conv-a', 'chris', 'Edit', 'Overwrite memory/daily/2026-09-22.md?', now, now);

    const row = db.prepare(`SELECT * FROM approval_requests WHERE id = ?`).get('req-1') as {
      id: string;
      adapter_id: string;
      agent_id: string;
      status: string;
      resolved_at: string | null;
      notify_channel: string | null;
    };

    expect(row.id).toBe('req-1');
    expect(row.adapter_id).toBe('cc-pool');
    expect(row.agent_id).toBe('peggy-pool-1');
    expect(row.status).toBe('pending');
    expect(row.resolved_at).toBeNull();
    expect(row.notify_channel).toBeNull();

    // Duplicate id violates the primary key.
    expect(() =>
      db
        .prepare(
          `INSERT INTO approval_requests
             (id, adapter_id, agent_id, contact_id, tool_name, summary, requested_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run('req-1', 'cc-pool', 'peggy-pool-1', 'chris', 'Edit', 'dup', now, now),
    ).toThrow();
  });

  it('is idempotent on re-run', () => {
    const db = fresh();
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();

    const count = (
      db.prepare(`SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 19`).get() as {
        n: number;
      }
    ).n;
    expect(count).toBe(1);
  });
});

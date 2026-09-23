import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';
import { getUnhandledSince } from './unhandled-work.js';
import type { PoolLeaseRow } from './types.js';

const AGENT = 'agent:peggy-pool-1';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

let n = 0;
function addMsg(db: Database.Database, recipient: string, ackedAt: string | null): void {
  const id = `m${++n}`;
  db.prepare(
    `INSERT INTO message_queue (id, created_at, updated_at, channel, topic, sender, recipient, status, payload, acked_at)
     VALUES (?, ?, ?, 'telegram', 't', 'contact:x', ?, ?, '{}', ?)`,
  ).run(id, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', recipient, ackedAt ? 'delivered' : 'pending', ackedAt);
}

function row(over: Partial<PoolLeaseRow> = {}): PoolLeaseRow {
  return {
    pool_id: 'peggy',
    pane_id: 'peggy-pool:1',
    agent_id: AGENT,
    conversation_id: 'c',
    claude_session_id: null,
    state: 'leased',
    leased_at: '2026-01-01T10:00:00.000Z',
    last_activity_at: null,
    last_turn_ended_at: '2026-01-01T11:00:00.000Z',
    ...over,
  };
}

describe('getUnhandledSince', () => {
  it('returns acked_at of a message acked after the last turn end', () => {
    const db = makeDb();
    addMsg(db, AGENT, '2026-01-01T11:30:00.000Z');
    expect(getUnhandledSince(db, row())).toBe('2026-01-01T11:30:00.000Z');
  });

  it('returns the oldest of several', () => {
    const db = makeDb();
    addMsg(db, AGENT, '2026-01-01T12:00:00.000Z');
    addMsg(db, AGENT, '2026-01-01T11:10:00.000Z');
    addMsg(db, AGENT, '2026-01-01T11:40:00.000Z');
    expect(getUnhandledSince(db, row())).toBe('2026-01-01T11:10:00.000Z');
  });

  it('ignores messages acked before last_turn_ended_at', () => {
    const db = makeDb();
    addMsg(db, AGENT, '2026-01-01T10:30:00.000Z');
    expect(getUnhandledSince(db, row())).toBeNull();
  });

  it('ignores messages acked before leased_at', () => {
    const db = makeDb();
    addMsg(db, AGENT, '2026-01-01T09:00:00.000Z');
    expect(getUnhandledSince(db, row({ last_turn_ended_at: null }))).toBeNull();
  });

  it('ignores pending (unacked) messages', () => {
    const db = makeDb();
    addMsg(db, AGENT, null);
    expect(getUnhandledSince(db, row())).toBeNull();
  });

  it('ignores other recipients', () => {
    const db = makeDb();
    addMsg(db, 'agent:peggy-pool-2', '2026-01-01T11:30:00.000Z');
    expect(getUnhandledSince(db, row())).toBeNull();
  });

  it('uses leased_at when last_turn_ended_at is null', () => {
    const db = makeDb();
    addMsg(db, AGENT, '2026-01-01T09:00:00.000Z');
    addMsg(db, AGENT, '2026-01-01T10:20:00.000Z');
    expect(getUnhandledSince(db, row({ last_turn_ended_at: null }))).toBe('2026-01-01T10:20:00.000Z');
  });
});

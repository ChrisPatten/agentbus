import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';
import { LeaseStore } from '../pool/lease-store.js';
import { resolveApprovalTarget } from './resolve-target.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function insertSession(
  db: Database.Database,
  opts: { conversationId: string; channel: string; contactId: string; startedAt?: string },
) {
  db.prepare(
    `INSERT INTO sessions (id, conversation_id, channel, contact_id, started_at, last_activity, message_count)
     VALUES (?, ?, ?, ?, ?, ?, 0)`,
  ).run(randomUUID(), opts.conversationId, opts.channel, opts.contactId, opts.startedAt ?? new Date().toISOString(), opts.startedAt ?? new Date().toISOString());
}

describe('resolveApprovalTarget', () => {
  it('resolves contact_id + channel for a leased cc-pool pane', () => {
    const db = makeDb();
    const leaseStore = new LeaseStore(db);
    leaseStore.seedPanes('peggy', [{ paneId: 'peggy-pool:1', agentId: 'agent:peggy-pool-1' }]);
    leaseStore.acquire('peggy', 'conv-a', {
      poolAgentId: 'peggy',
      panes: 1,
      maxPanes: 1,
      growth: 'fixed',
      idleEvictMs: 1_800_000,
    });
    insertSession(db, { conversationId: 'conv-a', channel: 'telegram', contactId: 'chris' });

    const target = resolveApprovalTarget(db, 'cc-pool', 'peggy-pool-1');
    expect(target).toEqual({ contactId: 'chris', channel: 'telegram', conversationId: 'conv-a' });
  });

  it('accepts a bare or prefixed agentId identically', () => {
    const db = makeDb();
    const leaseStore = new LeaseStore(db);
    leaseStore.seedPanes('peggy', [{ paneId: 'peggy-pool:1', agentId: 'agent:peggy-pool-1' }]);
    leaseStore.acquire('peggy', 'conv-a', {
      poolAgentId: 'peggy',
      panes: 1,
      maxPanes: 1,
      growth: 'fixed',
      idleEvictMs: 1_800_000,
    });
    insertSession(db, { conversationId: 'conv-a', channel: 'telegram', contactId: 'chris' });

    expect(resolveApprovalTarget(db, 'cc-pool', 'agent:peggy-pool-1')?.contactId).toBe('chris');
  });

  it('returns null when no lease row matches the agentId', () => {
    const db = makeDb();
    expect(resolveApprovalTarget(db, 'cc-pool', 'ghost-pool-9')).toBeNull();
  });

  it('returns null when a lease exists but no session row for its conversation yet', () => {
    const db = makeDb();
    const leaseStore = new LeaseStore(db);
    leaseStore.seedPanes('peggy', [{ paneId: 'peggy-pool:1', agentId: 'agent:peggy-pool-1' }]);
    leaseStore.acquire('peggy', 'conv-a', {
      poolAgentId: 'peggy',
      panes: 1,
      maxPanes: 1,
      growth: 'fixed',
      idleEvictMs: 1_800_000,
    });

    expect(resolveApprovalTarget(db, 'cc-pool', 'peggy-pool-1')).toBeNull();
  });

  it('falls back to conversationIdHint when the pane has no lease row at all', () => {
    const db = makeDb();
    insertSession(db, { conversationId: 'conv-hint', channel: 'telegram', contactId: 'chris' });

    const target = resolveApprovalTarget(db, 'cc-pool', 'ghost-pool-9', 'conv-hint');
    expect(target).toEqual({ contactId: 'chris', channel: 'telegram', conversationId: 'conv-hint' });
  });

  it('returns null for an unregistered adapterId', () => {
    const db = makeDb();
    expect(resolveApprovalTarget(db, 'cc-headless', 'peggy')).toBeNull();
  });
});

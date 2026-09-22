import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';
import { AdapterRegistry } from '../core/registry.js';
import type { AdapterInstance } from '../core/registry.js';
import { ApprovalStore } from './store.js';
import { sweepApprovals } from './sweep.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function makeAdapter(overrides: Partial<AdapterInstance> = {}): AdapterInstance {
  return {
    id: 'telegram',
    name: 'telegram',
    capabilities: { send: true, channels: ['telegram'] },
    start: async () => {},
    stop: async () => {},
    health: async () => ({ status: 'healthy' as const }),
    send: async () => ({ success: true }),
    ...overrides,
  };
}

const baseInput = {
  adapterId: 'cc-pool',
  agentId: 'peggy-pool-1',
  conversationId: 'conv-a',
  contactId: 'chris',
  toolName: 'Edit',
  summary: 'Overwrite confirmation',
};

describe('sweepApprovals', () => {
  it('expires pending rows past expires_at and leaves fresh ones alone', async () => {
    const db = makeDb();
    const store = new ApprovalStore(db);
    const now = new Date('2026-09-22T12:00:00.000Z');
    const overdue = store.insert(baseInput, 60_000, now); // expires 12:01
    const fresh = store.insert(baseInput, 900_000, now); // expires 12:15
    const registry = new AdapterRegistry();

    const result = await sweepApprovals({ registry, store }, '2026-09-22T12:10:00.000Z');

    expect(result.expired).toBe(1);
    expect(store.getById(overdue.id)!.status).toBe('expired');
    expect(store.getById(fresh.id)!.status).toBe('pending');
  });

  it('finalizes the notification message for a terminal row with a live notify_message_id', async () => {
    const db = makeDb();
    const store = new ApprovalStore(db);
    const row = store.insert(baseInput, 900_000);
    store.updateNotify(row.id, 'telegram', '42');
    store.resolve(row.id, 'approved', 'chris');

    const finalizeApproval = vi.fn(async () => {});
    const registry = new AdapterRegistry();
    registry.register(makeAdapter({ finalizeApproval }));

    const result = await sweepApprovals({ registry, store });

    expect(result.messagesFinalized).toBe(1);
    expect(finalizeApproval).toHaveBeenCalledWith(expect.objectContaining({ id: row.id, status: 'approved' }));
    expect(store.getById(row.id)!.notify_message_id).toBeNull();
  });

  it('leaves notify_message_id set (for a future retry) when no adapter can finalize', async () => {
    const db = makeDb();
    const store = new ApprovalStore(db);
    const row = store.insert(baseInput, 900_000);
    store.updateNotify(row.id, 'telegram', '42');
    store.resolve(row.id, 'denied', 'chris');
    const registry = new AdapterRegistry(); // no adapters registered

    const result = await sweepApprovals({ registry, store });

    expect(result.messagesFinalized).toBe(0);
    expect(store.getById(row.id)!.notify_message_id).toBe('42');
  });

  it('leaves notify_message_id set when finalizeApproval throws', async () => {
    const db = makeDb();
    const store = new ApprovalStore(db);
    const row = store.insert(baseInput, 900_000);
    store.updateNotify(row.id, 'telegram', '42');
    store.resolve(row.id, 'expired', 'timeout');
    const registry = new AdapterRegistry();
    registry.register(
      makeAdapter({
        finalizeApproval: vi.fn(async () => {
          throw new Error('edit failed');
        }),
      }),
    );

    const result = await sweepApprovals({ registry, store });
    expect(result.messagesFinalized).toBe(0);
    expect(store.getById(row.id)!.notify_message_id).toBe('42');
  });

  it('does not touch a pending row even if it somehow has a notify_message_id', async () => {
    const db = makeDb();
    const store = new ApprovalStore(db);
    const row = store.insert(baseInput, 900_000);
    store.updateNotify(row.id, 'telegram', '42');
    const finalizeApproval = vi.fn(async () => {});
    const registry = new AdapterRegistry();
    registry.register(makeAdapter({ finalizeApproval }));

    await sweepApprovals({ registry, store });
    expect(finalizeApproval).not.toHaveBeenCalled();
  });

  it('processes multiple rows needing cleanup in one sweep', async () => {
    const db = makeDb();
    const store = new ApprovalStore(db);
    const a = store.insert(baseInput, 900_000);
    store.updateNotify(a.id, 'telegram', '1');
    store.resolve(a.id, 'approved', 'chris');
    const b = store.insert(baseInput, 900_000);
    store.updateNotify(b.id, 'telegram', '2');
    store.resolve(b.id, 'denied', 'chris');

    const finalizeApproval = vi.fn(async () => {});
    const registry = new AdapterRegistry();
    registry.register(makeAdapter({ finalizeApproval }));

    const result = await sweepApprovals({ registry, store });
    expect(result.messagesFinalized).toBe(2);
    expect(finalizeApproval).toHaveBeenCalledTimes(2);
  });
});

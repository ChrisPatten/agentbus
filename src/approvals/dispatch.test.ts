import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';
import { AdapterRegistry } from '../core/registry.js';
import type { AdapterInstance } from '../core/registry.js';
import { ApprovalStore } from './store.js';
import { dispatchApproval } from './dispatch.js';

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

describe('dispatchApproval', () => {
  it('calls notifyApproval and stores the returned channel/messageId', async () => {
    const db = makeDb();
    const store = new ApprovalStore(db);
    const request = store.insert(baseInput, 900_000);

    const notifyApproval = vi.fn(async () => ({ channel: 'telegram', messageId: '555' }));
    const registry = new AdapterRegistry();
    registry.register(
      makeAdapter({ capabilities: { send: true, channels: ['telegram'], interactiveApproval: true }, notifyApproval }),
    );

    await dispatchApproval({ registry, store }, request, 'telegram');

    expect(notifyApproval).toHaveBeenCalledWith(expect.objectContaining({ id: request.id }));
    const updated = store.getById(request.id)!;
    expect(updated.notify_channel).toBe('telegram');
    expect(updated.notify_message_id).toBe('555');
    expect(updated.status).toBe('pending');
  });

  it('marks the row stale when no adapter serves the channel', async () => {
    const db = makeDb();
    const store = new ApprovalStore(db);
    const request = store.insert(baseInput, 900_000);
    const registry = new AdapterRegistry();

    await dispatchApproval({ registry, store }, request, 'telegram');

    const updated = store.getById(request.id)!;
    expect(updated.status).toBe('stale');
    expect(updated.resolved_by).toBe('system');
    expect(JSON.parse(updated.raw_context!)['stale_reason']).toContain('no adapter registered');
  });

  it('marks the row stale when the adapter does not declare interactiveApproval', async () => {
    const db = makeDb();
    const store = new ApprovalStore(db);
    const request = store.insert(baseInput, 900_000);
    const registry = new AdapterRegistry();
    registry.register(makeAdapter());

    await dispatchApproval({ registry, store }, request, 'telegram');

    const updated = store.getById(request.id)!;
    expect(updated.status).toBe('stale');
    expect(JSON.parse(updated.raw_context!)['stale_reason']).toContain('does not support interactiveApproval');
  });

  it('marks the row stale when notifyApproval throws', async () => {
    const db = makeDb();
    const store = new ApprovalStore(db);
    const request = store.insert(baseInput, 900_000);
    const registry = new AdapterRegistry();
    registry.register(
      makeAdapter({
        capabilities: { send: true, channels: ['telegram'], interactiveApproval: true },
        notifyApproval: vi.fn(async () => {
          throw new Error('Telegram API error: boom');
        }),
      }),
    );

    await dispatchApproval({ registry, store }, request, 'telegram');

    const updated = store.getById(request.id)!;
    expect(updated.status).toBe('stale');
    expect(JSON.parse(updated.raw_context!)['stale_reason']).toContain('notifyApproval failed');
  });

  it('resolves the adapter via ownsChannel (E28 dynamic group channel), not just capabilities.channels', async () => {
    const db = makeDb();
    const store = new ApprovalStore(db);
    const request = store.insert(baseInput, 900_000);
    const notifyApproval = vi.fn(async () => ({ channel: 'telegram:group:-100', messageId: '1' }));
    const registry = new AdapterRegistry();
    registry.register(
      makeAdapter({
        capabilities: { send: true, channels: ['telegram'], interactiveApproval: true },
        ownsChannel: (c) => c === 'telegram:group:-100',
        notifyApproval,
      }),
    );

    await dispatchApproval({ registry, store }, request, 'telegram:group:-100');
    expect(notifyApproval).toHaveBeenCalled();
  });
});

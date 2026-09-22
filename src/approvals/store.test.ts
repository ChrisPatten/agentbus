import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';
import { ApprovalStore } from './store.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

const baseInput = {
  adapterId: 'cc-pool',
  agentId: 'peggy-pool-1',
  conversationId: 'conv-a',
  contactId: 'chris',
  toolName: 'Edit',
  summary: 'Edit: memory/daily/2026-09-22.md — overwrite confirmation',
};

describe('ApprovalStore', () => {
  it('insert() creates a pending row with requested_at/expires_at derived from timeoutMs', () => {
    const store = new ApprovalStore(makeDb());
    const now = new Date('2026-09-22T12:00:00.000Z');
    const row = store.insert(baseInput, 900_000, now);

    expect(row.status).toBe('pending');
    expect(row.adapter_id).toBe('cc-pool');
    expect(row.agent_id).toBe('peggy-pool-1');
    expect(row.conversation_id).toBe('conv-a');
    expect(row.contact_id).toBe('chris');
    expect(row.requested_at).toBe('2026-09-22T12:00:00.000Z');
    expect(row.expires_at).toBe('2026-09-22T12:15:00.000Z');
    expect(row.resolved_at).toBeNull();
    expect(row.notify_channel).toBeNull();
  });

  it('insert() stores context as JSON in raw_context', () => {
    const store = new ApprovalStore(makeDb());
    const row = store.insert({ ...baseInput, context: { tool_input: { file_path: '/x' } } }, 900_000);
    expect(JSON.parse(row.raw_context!)).toEqual({ tool_input: { file_path: '/x' } });
  });

  it('getById() returns null for an unknown id', () => {
    const store = new ApprovalStore(makeDb());
    expect(store.getById('nope')).toBeNull();
  });

  it('list() filters by status and orders newest-first', () => {
    const store = new ApprovalStore(makeDb());
    const t1 = new Date('2026-09-22T12:00:00.000Z');
    const t2 = new Date('2026-09-22T12:05:00.000Z');
    const a = store.insert(baseInput, 900_000, t1);
    const b = store.insert(baseInput, 900_000, t2);
    store.resolve(a.id, 'approved', 'chris');

    const pending = store.list('pending');
    expect(pending.map((r) => r.id)).toEqual([b.id]);

    const all = store.list();
    expect(all.map((r) => r.id)).toEqual([b.id, a.id]);
  });

  it('updateNotify() sets notify_channel/notify_message_id on a pending row', () => {
    const store = new ApprovalStore(makeDb());
    const row = store.insert(baseInput, 900_000);
    store.updateNotify(row.id, 'telegram', '4321');

    const updated = store.getById(row.id)!;
    expect(updated.notify_channel).toBe('telegram');
    expect(updated.notify_message_id).toBe('4321');
    expect(updated.status).toBe('pending');
  });

  it('resolve() transitions pending -> approved/denied and is idempotent', () => {
    const store = new ApprovalStore(makeDb());
    const row = store.insert(baseInput, 900_000);

    const first = store.resolve(row.id, 'approved', 'chris');
    expect(first).toBe(true);
    const resolved = store.getById(row.id)!;
    expect(resolved.status).toBe('approved');
    expect(resolved.resolved_by).toBe('chris');
    expect(resolved.resolved_at).not.toBeNull();

    // Second resolve (e.g. a race with a terminal-answer at the tmux pane) is a no-op.
    const second = store.resolve(row.id, 'denied', 'someone-else');
    expect(second).toBe(false);
    expect(store.getById(row.id)!.status).toBe('approved');
    expect(store.getById(row.id)!.resolved_by).toBe('chris');
  });

  it('markStale() transitions pending -> stale and merges a reason into raw_context', () => {
    const store = new ApprovalStore(makeDb());
    const row = store.insert({ ...baseInput, context: { tool_input: {} } }, 900_000);
    store.markStale(row.id, 'no adapter supports interactiveApproval for channel "telegram"');

    const stale = store.getById(row.id)!;
    expect(stale.status).toBe('stale');
    expect(stale.resolved_by).toBe('system');
    expect(stale.resolved_at).not.toBeNull();
    const context = JSON.parse(stale.raw_context!) as Record<string, unknown>;
    expect(context['stale_reason']).toContain('no adapter supports');
    expect(context['tool_input']).toEqual({});
  });

  it('markStale() is a no-op on an already-resolved row', () => {
    const store = new ApprovalStore(makeDb());
    const row = store.insert(baseInput, 900_000);
    store.resolve(row.id, 'approved', 'chris');
    store.markStale(row.id, 'too late');
    expect(store.getById(row.id)!.status).toBe('approved');
  });

  it('expireDue() transitions only pending rows past expires_at, leaving others untouched', () => {
    const store = new ApprovalStore(makeDb());
    const now = new Date('2026-09-22T12:00:00.000Z');
    const stillFresh = store.insert(baseInput, 900_000, now); // expires 12:15
    const overdue = store.insert(baseInput, 60_000, now); // expires 12:01
    const alreadyResolved = store.insert(baseInput, 60_000, now);
    store.resolve(alreadyResolved.id, 'approved', 'chris');

    const due = store.expireDue('2026-09-22T12:10:00.000Z');
    expect(due.map((r) => r.id)).toEqual([overdue.id]);
    expect(due[0]!.status).toBe('expired');
    expect(due[0]!.resolved_by).toBe('timeout');

    expect(store.getById(stillFresh.id)!.status).toBe('pending');
    expect(store.getById(overdue.id)!.status).toBe('expired');
    expect(store.getById(alreadyResolved.id)!.status).toBe('approved');
  });

  it('expireDue() returns [] when nothing is due', () => {
    const store = new ApprovalStore(makeDb());
    store.insert(baseInput, 900_000, new Date('2026-09-22T12:00:00.000Z'));
    expect(store.expireDue('2026-09-22T12:00:01.000Z')).toEqual([]);
  });

  it('listNeedingMessageCleanup() returns only terminal rows with a live notify_message_id', () => {
    const store = new ApprovalStore(makeDb());
    const pendingRow = store.insert(baseInput, 900_000);
    store.updateNotify(pendingRow.id, 'telegram', '1');

    const resolvedWithMessage = store.insert(baseInput, 900_000);
    store.updateNotify(resolvedWithMessage.id, 'telegram', '2');
    store.resolve(resolvedWithMessage.id, 'approved', 'chris');

    const resolvedAlreadyCleaned = store.insert(baseInput, 900_000);
    store.updateNotify(resolvedAlreadyCleaned.id, 'telegram', '3');
    store.resolve(resolvedAlreadyCleaned.id, 'denied', 'chris');
    store.clearNotifyMessageId(resolvedAlreadyCleaned.id);

    const needing = store.listNeedingMessageCleanup();
    expect(needing.map((r) => r.id)).toEqual([resolvedWithMessage.id]);
  });

  it('clearNotifyMessageId() nulls out notify_message_id', () => {
    const store = new ApprovalStore(makeDb());
    const row = store.insert(baseInput, 900_000);
    store.updateNotify(row.id, 'telegram', '9');
    store.clearNotifyMessageId(row.id);
    expect(store.getById(row.id)!.notify_message_id).toBeNull();
  });
});

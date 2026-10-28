import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';
import { ChoiceStore } from './store.js';

const T0 = new Date('2026-10-27T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

function makeStore() {
  const db = new Database(':memory:');
  runMigrations(db);
  return new ChoiceStore(db);
}

const input = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  channel: 'telegram',
  topic: 'general',
  contactId: 'chris',
  labels: ['A', 'B', 'C'],
  platformMessageId: '12345:100',
  busMessageId: 'bus-1',
  ...extra,
});

describe('ChoiceStore', () => {
  it('creates an open prompt with parsed labels and an expiry', () => {
    const store = makeStore();
    const p = store.create(input('p1'), 24 * HOUR, T0);
    expect(p).toMatchObject({ id: 'p1', status: 'open', labels: ['A', 'B', 'C'], contact_id: 'chris', chosen_index: null });
    expect(p.expires_at).toBe('2026-10-28T12:00:00.000Z');
    expect(store.getById('missing')).toBeNull();
  });

  it('answers an open prompt and returns the chosen label', () => {
    const store = makeStore();
    store.create(input('p1'), 24 * HOUR, T0);
    const r = store.answer('p1', 1, 'contact:chris', new Date(T0.getTime() + HOUR));
    expect(r).toMatchObject({ outcome: 'answered', label: 'B' });
    expect(store.getById('p1')).toMatchObject({ status: 'answered', chosen_index: 1, answered_by: 'contact:chris' });
  });

  it('answering an already-answered prompt returns already_answered', () => {
    const store = makeStore();
    store.create(input('p1'), 24 * HOUR, T0);
    store.answer('p1', 0, 'contact:chris', T0);
    expect(store.answer('p1', 2, 'contact:chris', T0).outcome).toBe('already_answered');
    expect(store.getById('p1')!.chosen_index).toBe(0);
  });

  it('answering after expiry returns expired and marks the row expired', () => {
    const store = makeStore();
    store.create(input('p1'), HOUR, T0);
    const r = store.answer('p1', 0, 'contact:chris', new Date(T0.getTime() + 2 * HOUR));
    expect(r.outcome).toBe('expired');
    expect(store.getById('p1')!.status).toBe('expired');
  });

  it('rejects an out-of-range index and an unknown id', () => {
    const store = makeStore();
    store.create(input('p1'), HOUR, T0);
    expect(store.answer('p1', 3, 'x', T0).outcome).toBe('invalid_choice');
    expect(store.answer('p1', -1, 'x', T0).outcome).toBe('invalid_choice');
    expect(store.getById('p1')!.status).toBe('open');
    expect(store.answer('nope', 0, 'x', T0).outcome).toBe('not_found');
  });

  it('reopen puts an answered prompt back to open', () => {
    const store = makeStore();
    store.create(input('p1'), HOUR, T0);
    store.answer('p1', 0, 'x', T0);
    store.reopen('p1');
    expect(store.getById('p1')).toMatchObject({ status: 'open', chosen_index: null, answered_by: null });
    expect(store.answer('p1', 1, 'x', T0).outcome).toBe('answered');
  });

  it('expireDue expires only overdue open prompts; listNeedingKeyboardCleanup and clearMessageRef track cleanup', () => {
    const store = makeStore();
    store.create(input('old'), HOUR, T0);
    store.create(input('fresh'), 24 * HOUR, T0);
    store.create(input('done'), HOUR, T0);
    store.answer('done', 0, 'x', T0);

    const due = store.expireDue(new Date(T0.getTime() + 2 * HOUR).toISOString());
    expect(due.map((p) => p.id)).toEqual(['old']);
    expect(store.getById('fresh')!.status).toBe('open');
    expect(store.getById('done')!.status).toBe('answered');

    expect(store.listNeedingKeyboardCleanup().map((p) => p.id)).toEqual(['old']);
    store.clearMessageRef('old');
    expect(store.listNeedingKeyboardCleanup()).toEqual([]);
    expect(store.expireDue(new Date(T0.getTime() + 3 * HOUR).toISOString())).toEqual([]);
  });

  it('list filters by status', () => {
    const store = makeStore();
    store.create(input('a'), HOUR, T0);
    store.create(input('b'), HOUR, T0);
    store.answer('b', 0, 'x', T0);
    expect(store.list('answered').map((p) => p.id)).toEqual(['b']);
    expect(store.list()).toHaveLength(2);
  });
});

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';
import { ChoiceStore } from './store.js';
import { resolveChoiceTap } from './tap.js';
import { hasCallbackButton, parseChoiceCommands, parseChoices } from './parse.js';

const T0 = new Date('2026-10-27T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const later = new Date(T0.getTime() + HOUR);

function makeStore() {
  const db = new Database(':memory:');
  runMigrations(db);
  return new ChoiceStore(db);
}

const input = (id: string, extra: Record<string, unknown> = {}) => ({
  id, channel: 'app', topic: 'general', contactId: 'chris', labels: ['A', 'B', 'C'],
  platformMessageId: 'bus-1', busMessageId: 'bus-1', ...extra,
});

describe('resolveChoiceTap (S86.1)', () => {
  it('answered: flips the prompt and builds "[tapped] <label>" with the shared metadata', () => {
    const store = makeStore();
    store.create(input('p1'), 24 * HOUR, T0);
    const r = resolveChoiceTap(store, 'p1', 1, 'chris', undefined, later);
    expect(r).toMatchObject({ outcome: 'answered', label: 'B', body: '[tapped] B', command: null,
      metadata: { choice_prompt_id: 'p1', choice_index: 1 } });
    expect(store.getById('p1')).toMatchObject({ status: 'answered', chosen_index: 1, answered_by: 'contact:chris' });
  });

  it('answered: a choice with a command uses the command as the body (E54)', () => {
    const store = makeStore();
    store.create(input('p1', { commands: ['/model a', null, '/model c'] }), 24 * HOUR, T0);
    expect(resolveChoiceTap(store, 'p1', 2, 'chris', undefined, later)).toMatchObject({ outcome: 'answered', body: '/model c', command: '/model c' });
  });

  it('answered: a prompt with no addressee accepts any tapper', () => {
    const store = makeStore();
    store.create(input('p1', { contactId: null }), 24 * HOUR, T0);
    expect(resolveChoiceTap(store, 'p1', 0, 'someone', undefined, later).outcome).toBe('answered');
  });

  it('already_answered: a second tap injects nothing', () => {
    const store = makeStore();
    store.create(input('p1'), 24 * HOUR, T0);
    resolveChoiceTap(store, 'p1', 0, 'chris', undefined, later);
    const r = resolveChoiceTap(store, 'p1', 1, 'chris', undefined, later);
    expect(r.outcome).toBe('already_answered');
    expect(store.getById('p1')!.chosen_index).toBe(0);
  });

  it('expired: a tap past expires_at flips the prompt to expired', () => {
    const store = makeStore();
    store.create(input('p1'), HOUR, T0);
    const r = resolveChoiceTap(store, 'p1', 0, 'chris', undefined, new Date(T0.getTime() + 2 * HOUR));
    expect(r).toMatchObject({ outcome: 'expired', prompt: { id: 'p1', status: 'expired' } });
    expect(store.getById('p1')!.status).toBe('expired');
  });

  it('invalid_choice: an out-of-range index, and a copy or link button', () => {
    const store = makeStore();
    store.create(input('p1', { labels: ['A', 'Copy', 'Open'], buttons: [null, { copy_text: 'x' }, { url: 'https://example.com' }] }), 24 * HOUR, T0);
    expect(resolveChoiceTap(store, 'p1', 3, 'chris', undefined, later).outcome).toBe('invalid_choice');
    expect(resolveChoiceTap(store, 'p1', 1, 'chris', undefined, later).outcome).toBe('invalid_choice');
    expect(resolveChoiceTap(store, 'p1', 2, 'chris', undefined, later).outcome).toBe('invalid_choice');
    expect(store.getById('p1')!.status).toBe('open');
    expect(resolveChoiceTap(store, 'p1', 0, 'chris', undefined, later).outcome).toBe('answered');
  });

  it('not_found: an unknown prompt id', () => {
    expect(resolveChoiceTap(makeStore(), 'missing', 0, 'chris')).toEqual({ outcome: 'not_found', prompt: null });
  });

  it('forbidden: another contact cannot answer, and the prompt stays open', () => {
    const store = makeStore();
    store.create(input('p1'), 24 * HOUR, T0);
    expect(resolveChoiceTap(store, 'p1', 0, 'mallory', undefined, later)).toMatchObject({ outcome: 'forbidden', prompt: { id: 'p1' } });
    expect(store.getById('p1')!.status).toBe('open');
  });
});

describe('choice parsing (S86.1)', () => {
  it('parses labels and E81 attributes, and drops invalid input', () => {
    expect(parseChoices(['A', 'B'], '[t]')).toEqual({ labels: ['A', 'B'] });
    expect(parseChoices(['A', { label: 'B', style: 'danger' }], '[t]')).toEqual({ labels: ['A', 'B'], buttons: [null, { style: 'danger' }] });
    expect(parseChoices([], '[t]')).toBeUndefined();
    expect(parseChoices(undefined, '[t]')).toBeUndefined();
    expect(parseChoiceCommands(['/a', null], 2, '[t]')).toEqual(['/a', null]);
    expect(parseChoiceCommands(['/a'], 2, '[t]')).toBeUndefined();
  });

  it('hasCallbackButton is false only when every button copies or links', () => {
    expect(hasCallbackButton(undefined, 2)).toBe(true);
    expect(hasCallbackButton([{ copy_text: 'x' }, { url: 'https://x.y' }], 2)).toBe(false);
    expect(hasCallbackButton([{ copy_text: 'x' }, { style: 'primary' }], 2)).toBe(true);
  });
});

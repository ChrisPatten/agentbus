/** E81 — buttons v2 validation (S81.3), input prompt store and sweep (S81.8). */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';
import { applyChoices, choiceAttrs, choiceLabel, choicesSchema } from './validate.js';
import { ChoiceStore } from './store.js';
import { InputPromptStore } from './input-store.js';
import { sweepInputPrompts } from './sweep.js';
import { AdapterRegistry } from '../core/registry.js';
import type { AdapterInstance } from '../core/registry.js';

describe('choicesSchema — button objects (S81.3)', () => {
  it('still accepts plain strings and now accepts objects, mixed', () => {
    expect(choicesSchema.safeParse(['A', { label: 'B' }, { label: 'C', style: 'danger' }, { label: 'D', copy_text: 'x' }, { label: 'E', url: 'https://e.com' }]).success).toBe(true);
    expect(choicesSchema.safeParse([{ label: 'Docs', url: 'tg://resolve?domain=x' }]).success).toBe(true);
  });

  it('rejects bad objects', () => {
    expect(choicesSchema.safeParse([{ label: '' }]).success).toBe(false);
    expect(choicesSchema.safeParse([{ label: 'x'.repeat(65) }]).success).toBe(false);
    expect(choicesSchema.safeParse([{ label: 'A', style: 'rainbow' }]).success).toBe(false);
    expect(choicesSchema.safeParse([{ label: 'A', copy_text: '' }]).success).toBe(false);
    expect(choicesSchema.safeParse([{ label: 'A', copy_text: 'x'.repeat(257) }]).success).toBe(false);
    expect(choicesSchema.safeParse([{ label: 'A', copy_text: 'x', url: 'https://e.com' }]).success).toBe(false);
    expect(choicesSchema.safeParse([{ label: 'A', url: 'javascript:alert(1)' }]).success).toBe(false);
    expect(choicesSchema.safeParse([{ label: 'A', url: 'ftp://e.com' }]).success).toBe(false);
    expect(choicesSchema.safeParse([{ label: 'A', extra: 1 }]).success).toBe(true); // unknown keys are stripped, not fatal
  });

  it('still enforces 1 to 8 entries across both shapes', () => {
    expect(choicesSchema.safeParse(Array.from({ length: 9 }, () => ({ label: 'x' }))).success).toBe(false);
    expect(choicesSchema.safeParse([]).success).toBe(false);
  });

  it('extracts label and attributes', () => {
    expect(choiceLabel('A')).toBe('A');
    expect(choiceLabel({ label: 'B', style: 'success' })).toBe('B');
    expect(choiceAttrs('A')).toBeNull();
    expect(choiceAttrs({ label: 'B' })).toBeNull();
    expect(choiceAttrs({ label: 'B', style: 'success', url: 'https://e.com' })).toEqual({ style: 'success', url: 'https://e.com' });
  });

  it('keeps plain-string choices byte-identical in metadata and renders objects as a numbered list off Telegram', () => {
    expect(applyChoices('telegram', 'Pick', {}, ['A', 'B']).metadata).toEqual({ choices: ['A', 'B'] });
    const off = applyChoices('email', 'Pick', {}, ['A', { label: 'Copy', copy_text: '1234' }, { label: 'Docs', url: 'https://e.com' }]);
    expect(off.body).toBe('Pick\n\n1. A\n2. Copy (1234)\n3. Docs (https://e.com)');
    expect(off.metadata).toEqual({});
  });
});

describe('ChoiceStore buttons column (S81.3)', () => {
  it('round-trips buttons and stores NULL when none carry attributes', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const store = new ChoiceStore(db);
    const base = { channel: 'telegram', topic: 'general', contactId: 'chris', labels: ['A', 'B'], platformMessageId: '1:2', busMessageId: 'b' };
    expect(store.create({ ...base, id: 'p1', buttons: [null, { copy_text: 'x' }] }, 1000).buttons).toEqual([null, { copy_text: 'x' }]);
    expect(store.create({ ...base, id: 'p2', buttons: [null, null] }, 1000).buttons).toBeNull();
    expect(store.create({ ...base, id: 'p3' }, 1000).buttons).toBeNull();
  });

  it('supersedeByMessageRef expires only open prompts on that message', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const store = new ChoiceStore(db);
    const base = { channel: 'telegram', topic: 'general', contactId: 'chris', labels: ['A'], busMessageId: 'b' };
    store.create({ ...base, id: 'a', platformMessageId: '1:2' }, 1000);
    store.create({ ...base, id: 'b', platformMessageId: '1:3' }, 1000);
    expect(store.supersedeByMessageRef('1:2')).toBe(1);
    expect(store.getById('a')).toMatchObject({ status: 'expired', platform_message_id: null });
    expect(store.getById('b')!.status).toBe('open');
    expect(store.supersedeByMessageRef('1:2')).toBe(0);
  });
});

describe('InputPromptStore and sweep (S81.8)', () => {
  let db: Database.Database;
  let store: InputPromptStore;
  const mk = (id: string, over: Record<string, unknown> = {}) =>
    store.create(
      { id, channel: 'telegram', topic: 'general', contactId: 'chris', kind: 'location', chatId: 5, threadId: null, platformMessageId: 10, busMessageId: 'bus', keyboard: true, ...over },
      60_000,
      new Date('2026-10-28T12:00:00Z'),
    );
  const now = '2026-10-28T12:00:30.000Z';

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    store = new InputPromptStore(db);
  });

  it('finds the newest open prompt for the same chat, topic, kind and contact', () => {
    mk('old');
    store.create({ id: 'new', channel: 'telegram', topic: 'general', contactId: 'chris', kind: 'location', chatId: 5, threadId: null, platformMessageId: 11, busMessageId: 'bus2', keyboard: true }, 60_000, new Date('2026-10-28T12:00:10Z'));
    expect(store.findOpen('location', 5, null, 'chris', now)!.id).toBe('new');
    expect(store.findOpen('contact', 5, null, 'chris', now)).toBeNull();
    expect(store.findOpen('location', 6, null, 'chris', now)).toBeNull();
    expect(store.findOpen('location', 5, 9, 'chris', now)).toBeNull();
    expect(store.findOpen('location', 5, null, 'kate', now)).toBeNull();
  });

  it('a prompt with no addressee can be answered by any contact; an expired one cannot be matched', () => {
    mk('any', { contactId: null });
    expect(store.findOpen('location', 5, null, 'kate', now)!.id).toBe('any');
    expect(store.findOpen('location', 5, null, 'kate', '2026-10-28T13:00:00.000Z')).toBeNull();
  });

  it('matches a thread-scoped prompt only in that thread', () => {
    mk('t', { threadId: 9 });
    expect(store.findOpen('location', 5, 9, 'chris', now)!.id).toBe('t');
    expect(store.findOpen('location', 5, null, 'chris', now)).toBeNull();
  });

  it('finds by replied-to message and answers once', () => {
    mk('r', { kind: 'text', keyboard: false });
    expect(store.findOpenByMessage(5, 10, 'chris', now)!.id).toBe('r');
    expect(store.markAnswered('r')).toBe(true);
    expect(store.markAnswered('r')).toBe(false);
    expect(store.findOpenByMessage(5, 10, 'chris', now)).toBeNull();
  });

  it('sweep expires due prompts and asks the adapter to remove lingering keyboards exactly once', async () => {
    mk('k');
    mk('nk', { keyboard: false, platformMessageId: 12 });
    const finalized: string[] = [];
    const registry = new AdapterRegistry();
    registry.register({
      id: 'telegram',
      name: 'telegram',
      capabilities: { send: true, channels: ['telegram'] },
      start: async () => {},
      stop: async () => {},
      health: async () => ({ status: 'healthy' as const }),
      send: async () => ({ success: true }),
      finalizeInputPrompt: async (p) => void finalized.push(p.id),
    } as AdapterInstance);

    expect(await sweepInputPrompts({ registry, store }, '2026-10-28T12:00:30.000Z')).toEqual({ expired: 0, keyboardsCleared: 0 });
    expect(await sweepInputPrompts({ registry, store }, '2026-10-28T13:00:00.000Z')).toEqual({ expired: 2, keyboardsCleared: 1 });
    expect(finalized).toEqual(['k']);
    expect(await sweepInputPrompts({ registry, store }, '2026-10-28T14:00:00.000Z')).toEqual({ expired: 0, keyboardsCleared: 0 });
    expect(store.getById('k')).toMatchObject({ status: 'expired', keyboard: 0 });
  });
});

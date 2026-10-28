import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';
import { AdapterRegistry } from '../core/registry.js';
import type { AdapterInstance } from '../core/registry.js';
import { ChoiceStore } from './store.js';
import { sweepChoices } from './sweep.js';

const T0 = new Date('2026-10-27T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

function setup(adapterOverrides: Partial<AdapterInstance> = {}) {
  const db = new Database(':memory:');
  runMigrations(db);
  const store = new ChoiceStore(db);
  const registry = new AdapterRegistry();
  registry.register({
    id: 'telegram',
    name: 'telegram',
    capabilities: { send: true, channels: ['telegram'] },
    start: async () => {},
    stop: async () => {},
    health: async () => ({ status: 'healthy' as const }),
    send: async () => ({ success: true }),
    ...adapterOverrides,
  });
  const make = (id: string, ttl: number) =>
    store.create(
      { id, channel: 'telegram', topic: 'general', contactId: 'chris', labels: ['A'], platformMessageId: '1:2', busMessageId: null },
      ttl,
      T0,
    );
  return { store, registry, make };
}

describe('sweepChoices', () => {
  it('expires overdue prompts, clears their keyboards, and does not touch fresh ones', async () => {
    const finalizeChoicePrompt = vi.fn(async () => {});
    const { store, registry, make } = setup({ finalizeChoicePrompt });
    make('old', HOUR);
    make('fresh', 24 * HOUR);

    const result = await sweepChoices({ registry, store }, new Date(T0.getTime() + 2 * HOUR).toISOString());

    expect(result).toEqual({ expired: 1, keyboardsCleared: 1 });
    expect(finalizeChoicePrompt).toHaveBeenCalledTimes(1);
    expect(store.getById('old')).toMatchObject({ status: 'expired', platform_message_id: null });
    expect(store.getById('fresh')!.status).toBe('open');
  });

  it('is idempotent: a second pass does nothing', async () => {
    const finalizeChoicePrompt = vi.fn(async () => {});
    const { store, registry, make } = setup({ finalizeChoicePrompt });
    make('old', HOUR);
    const now = new Date(T0.getTime() + 2 * HOUR).toISOString();
    await sweepChoices({ registry, store }, now);
    const second = await sweepChoices({ registry, store }, now);
    expect(second).toEqual({ expired: 0, keyboardsCleared: 0 });
    expect(finalizeChoicePrompt).toHaveBeenCalledTimes(1);
  });

  it('keeps the message ref for retry when the adapter throws', async () => {
    const { store, registry, make } = setup({
      finalizeChoicePrompt: async () => {
        throw new Error('boom');
      },
    });
    make('old', HOUR);
    const result = await sweepChoices({ registry, store }, new Date(T0.getTime() + 2 * HOUR).toISOString());
    expect(result.keyboardsCleared).toBe(0);
    expect(store.getById('old')!.platform_message_id).toBe('1:2');
  });

  it('keeps the message ref when no adapter implements finalizeChoicePrompt', async () => {
    const { store, registry, make } = setup();
    make('old', HOUR);
    const result = await sweepChoices({ registry, store }, new Date(T0.getTime() + 2 * HOUR).toISOString());
    expect(result).toEqual({ expired: 1, keyboardsCleared: 0 });
    expect(store.listNeedingKeyboardCleanup()).toHaveLength(1);
  });
});

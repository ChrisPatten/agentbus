/**
 * E74 — Telegram choice buttons: keyboard on send (S74.3), tap handling
 * (S74.3), the 64-byte callback_data limit, and keyboard cleanup (S74.4).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { TelegramAdapter, buildChoiceKeyboard } from './telegram.js';
import { runMigrations } from '../db/schema.js';
import { ChoiceStore } from '../choices/store.js';
import type { AppConfig } from '../config/schema.js';
import type { MessageQueue } from '../core/queue.js';
import type { PipelineEngine } from '../pipeline/engine.js';
import type { MessageEnvelope } from '../types/envelope.js';

const PROMPT_ID = '11111111-2222-3333-4444-555555555555';

function makeConfig(): AppConfig {
  return {
    bus: { http_port: 3000, db_path: ':memory:', log_level: 'info' },
    adapters: { telegram: { token: 'test:token', poll_timeout: 30 } },
    contacts: {
      chris: { id: 'chris', displayName: 'Chris', platforms: { telegram: { userId: 12345 } } },
      kate: { id: 'kate', displayName: 'Kate', platforms: { telegram: { userId: 67890 } } },
    },
    topics: ['general'],
    agents: {},
    memory: {},
    scheduler: { tick_interval_ms: 30000, enabled: true },
    schedules: [],
    pipeline: {
      dedup_window_ms: 30000,
      drop_unrouted: false,
      topic_rules: [],
      priority_weights: { base_score: 0, topic_bonus: 40, vip_sender_bonus: 20, urgency_keyword_bonus: 15 },
      urgency_keywords: [],
      vip_contacts: [],
      routes: [{ match: { channel: 'telegram' }, target: { adapterId: 'cc', recipientId: 'agent:claude' } }],
    },
  } as unknown as AppConfig;
}

function makeEnvelope(body: string, overrides: Partial<MessageEnvelope> = {}): MessageEnvelope {
  return {
    id: 'bus-msg-1',
    timestamp: new Date(0).toISOString(),
    channel: 'telegram',
    topic: 'general',
    sender: 'agent:claude',
    recipient: 'contact:chris',
    reply_to: null,
    priority: 'normal',
    payload: { type: 'text', body },
    metadata: {},
    ...overrides,
  };
}

function bodyOf(call: unknown): Record<string, unknown> {
  return JSON.parse((call as [string, { body: string }])[1].body) as Record<string, unknown>;
}

describe('buildChoiceKeyboard', () => {
  it('uses one button per row when any label is longer than 12 characters', () => {
    const kb = buildChoiceKeyboard(PROMPT_ID, ['Yes', 'No', 'A rather long label']);
    expect(kb.inline_keyboard.map((r) => r.length)).toEqual([1, 1, 1]);
  });

  it('pairs buttons two per row when every label is 12 characters or fewer', () => {
    const kb = buildChoiceKeyboard(PROMPT_ID, ['A', 'B', 'C']);
    expect(kb.inline_keyboard.map((r) => r.length)).toEqual([2, 1]);
  });

  it('keeps callback_data within Telegram\'s 64-byte limit for every index, with labels never in it', () => {
    const labels = Array.from({ length: 8 }, (_, i) => `${'x'.repeat(64)}${i}`.slice(0, 64));
    const kb = buildChoiceKeyboard(PROMPT_ID, labels);
    const buttons = kb.inline_keyboard.flat();
    expect(buttons).toHaveLength(8);
    buttons.forEach((b, i) => {
      expect(Buffer.byteLength(b.callback_data, 'utf8')).toBeLessThanOrEqual(64);
      expect(b.callback_data).toBe(`choice:${PROMPT_ID}:${i}`);
    });
  });
});

describe('TelegramAdapter choice buttons (E74)', () => {
  let db: Database.Database;
  let store: ChoiceStore;
  let adapter: TelegramAdapter;
  let fetchFn: ReturnType<typeof vi.fn>;
  let inbound: Array<MessageEnvelope>;
  let injectFails: boolean;

  const calls = (method: string) => fetchFn.mock.calls.filter((c) => String(c[0]).endsWith(`/${method}`));

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    store = new ChoiceStore(db);
    inbound = [];
    injectFails = false;
    const pipeline = {
      process: async (ctx: { envelope: MessageEnvelope }) => {
        if (injectFails) throw new Error('pipeline down');
        inbound.push(ctx.envelope);
        return null;
      },
    } as unknown as PipelineEngine;
    adapter = new TelegramAdapter({
      config: makeConfig(),
      queue: {} as unknown as MessageQueue,
      pipeline,
      db,
      instanceConfig: { token: 'test:token', poll_timeout: 30 },
    });
    let nextId = 100;
    fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { message_id: nextId++, chat: { id: 12345, type: 'private' }, date: 0 } }),
    }));
    vi.stubGlobal('fetch', fetchFn);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    db.close();
  });

  function seedPrompt(overrides: Record<string, unknown> = {}, ttlMs = 24 * 60 * 60 * 1000, now = new Date()) {
    return store.create(
      {
        id: PROMPT_ID,
        channel: 'telegram',
        topic: 'general',
        contactId: 'chris',
        labels: ['A', 'B', 'C'],
        platformMessageId: '12345:100',
        busMessageId: 'bus-msg-1',
        ...overrides,
      },
      ttlMs,
      now,
    );
  }

  function tap(fromId: number, data: string, text: string | undefined = 'Which one?') {
    return (adapter as unknown as { processUpdate: (u: unknown) => Promise<boolean> }).processUpdate({
      update_id: 1,
      callback_query: {
        id: 'cbq-1',
        from: { id: fromId, first_name: 'X' },
        data,
        message: { message_id: 100, chat: { id: 12345, type: 'private' }, date: 0, ...(text ? { text } : {}) },
      },
    });
  }

  const toast = () => bodyOf(calls('answerCallbackQuery').at(-1)).text;

  // ── send ───────────────────────────────────────────────────────────────────

  it('renders three tappable buttons and persists the prompt with the message ref', async () => {
    const result = await adapter.send(makeEnvelope('Which one?', { metadata: { choices: ['A', 'B', 'C'] } }));
    expect(result).toMatchObject({ success: true, platformMessageId: '100' });

    const body = bodyOf(calls('sendMessage')[0]);
    const markup = body.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
    const buttons = markup.inline_keyboard.flat();
    expect(buttons.map((b) => b.text)).toEqual(['A', 'B', 'C']);

    const [prompt] = store.list();
    expect(prompt).toMatchObject({
      status: 'open',
      labels: ['A', 'B', 'C'],
      platform_message_id: '12345:100',
      bus_message_id: 'bus-msg-1',
      contact_id: 'chris',
      channel: 'telegram',
    });
    expect(buttons[1]!.callback_data).toBe(`choice:${prompt!.id}:1`);
    expect(Date.parse(prompt!.expires_at) - Date.parse(prompt!.created_at)).toBe(24 * 60 * 60 * 1000);
  });

  it('honours choice_ttl_hours from the instance config', async () => {
    const custom = new TelegramAdapter({
      config: makeConfig(),
      queue: {} as unknown as MessageQueue,
      pipeline: {} as unknown as PipelineEngine,
      db,
      instanceConfig: { token: 'test:token', poll_timeout: 30, choice_ttl_hours: 2 },
    });
    await custom.send(makeEnvelope('Pick', { metadata: { choices: ['A'] } }));
    const [prompt] = store.list();
    expect(Date.parse(prompt!.expires_at) - Date.parse(prompt!.created_at)).toBe(2 * 60 * 60 * 1000);
  });

  it('puts the keyboard on the last part of a split message only', async () => {
    const long = Array.from({ length: 10 }, (_, i) => `line ${i}`.repeat(500)).join('\n');
    await adapter.send(makeEnvelope(long, { metadata: { choices: ['A', 'B'] } }));
    const sends = calls('sendMessage');
    expect(sends.length).toBeGreaterThan(1);
    sends.slice(0, -1).forEach((c) => expect(bodyOf(c)).not.toHaveProperty('reply_markup'));
    expect(bodyOf(sends.at(-1))).toHaveProperty('reply_markup');
  });

  it('sends no keyboard and stores nothing without choices, or with invalid choices', async () => {
    await adapter.send(makeEnvelope('plain'));
    await adapter.send(makeEnvelope('bad', { metadata: { choices: ['A', ''] } }));
    for (const c of calls('sendMessage')) expect(bodyOf(c)).not.toHaveProperty('reply_markup');
    expect(store.list()).toHaveLength(0);
  });

  // ── tap ────────────────────────────────────────────────────────────────────

  it('a valid tap injects exactly one "[tapped] <label>" message and edits the original', async () => {
    seedPrompt();
    expect(await tap(12345, `choice:${PROMPT_ID}:1`)).toBe(true);

    expect(inbound).toHaveLength(1);
    expect(inbound[0]).toMatchObject({
      channel: 'telegram',
      sender: '12345',
      reply_to: 'bus-msg-1',
      payload: { type: 'text', body: '[tapped] B' },
      metadata: { choice_prompt_id: PROMPT_ID, choice_index: 1 },
    });

    const edit = bodyOf(calls('editMessageText')[0]);
    expect(edit).toMatchObject({ chat_id: 12345, message_id: 100, reply_markup: { inline_keyboard: [] } });
    expect(edit.text).toBe('Which one?\n\nYou chose: B');
    expect(toast()).toBe('Chose: B');
    expect(store.getById(PROMPT_ID)).toMatchObject({ status: 'answered', chosen_index: 1, platform_message_id: null });
  });

  it('routes the injected message into the prompt\'s group channel and topic', async () => {
    seedPrompt({ channel: 'telegram:group:-100777', topic: 'thread:abc123' });
    await tap(12345, `choice:${PROMPT_ID}:0`);
    expect(inbound).toHaveLength(1);
    expect(inbound[0]).toMatchObject({ channel: 'telegram:group:-100777', topic: 'thread:abc123' });
  });

  it('replaying the same callback injects nothing and answers "Already answered"', async () => {
    seedPrompt();
    await tap(12345, `choice:${PROMPT_ID}:1`);
    const editsBefore = calls('editMessageText').length;

    await tap(12345, `choice:${PROMPT_ID}:2`);

    expect(inbound).toHaveLength(1);
    expect(calls('editMessageText')).toHaveLength(editsBefore);
    expect(toast()).toBe('Already answered');
  });

  it('a tap after expiry is rejected with "Expired", clears the keyboard, and injects nothing', async () => {
    seedPrompt({}, 60_000, new Date(Date.now() - 3_600_000));
    await tap(12345, `choice:${PROMPT_ID}:0`);

    expect(inbound).toHaveLength(0);
    expect(toast()).toBe('Expired');
    expect(bodyOf(calls('editMessageReplyMarkup')[0])).toMatchObject({
      chat_id: 12345,
      message_id: 100,
      reply_markup: { inline_keyboard: [] },
    });
    expect(store.getById(PROMPT_ID)!.status).toBe('expired');
  });

  it('a tap by an allow-listed non-addressee is rejected and injects nothing', async () => {
    seedPrompt({ contactId: 'chris' });
    await tap(67890, `choice:${PROMPT_ID}:0`);

    expect(inbound).toHaveLength(0);
    expect(toast()).toBe('Not authorized');
    expect(store.getById(PROMPT_ID)!.status).toBe('open');
    expect(calls('editMessageText')).toHaveLength(0);
  });

  it('a tap by a sender not on the allow-list is rejected and injects nothing', async () => {
    seedPrompt();
    await tap(99999, `choice:${PROMPT_ID}:0`);
    expect(inbound).toHaveLength(0);
    expect(toast()).toBe('Not authorized');
    expect(store.getById(PROMPT_ID)!.status).toBe('open');
  });

  it('an unknown prompt id and an out-of-range index are rejected without injecting', async () => {
    await tap(12345, `choice:${PROMPT_ID}:0`);
    expect(toast()).toBe('Prompt not found');

    seedPrompt();
    await tap(12345, `choice:${PROMPT_ID}:7`);
    expect(toast()).toBe('Unrecognized choice');
    expect(inbound).toHaveLength(0);
    expect(store.getById(PROMPT_ID)!.status).toBe('open');
  });

  it('reopens the prompt when injection fails so the human can tap again', async () => {
    seedPrompt();
    injectFails = true;
    await tap(12345, `choice:${PROMPT_ID}:0`);
    expect(toast()).toBe('Failed — try again');
    expect(store.getById(PROMPT_ID)!.status).toBe('open');
    expect(calls('editMessageText')).toHaveLength(0);

    injectFails = false;
    await tap(12345, `choice:${PROMPT_ID}:0`);
    expect(inbound).toHaveLength(1);
  });

  it('falls back to just clearing the keyboard when the tapped message carries no text', async () => {
    seedPrompt();
    await tap(12345, `choice:${PROMPT_ID}:0`, '');
    expect(calls('editMessageText')).toHaveLength(0);
    expect(calls('editMessageReplyMarkup')).toHaveLength(1);
    expect(inbound).toHaveLength(1);
  });

  it('data that is not an approval or a well-formed choice is still "Unrecognized action"', async () => {
    await tap(12345, 'choice:not-a-uuid:1');
    expect(toast()).toBe('Unrecognized action');
    expect(inbound).toHaveLength(0);
  });

  // ── cleanup ────────────────────────────────────────────────────────────────

  it('finalizeChoicePrompt clears the keyboard and swallows a 400', async () => {
    const prompt = seedPrompt();
    await adapter.finalizeChoicePrompt(prompt);
    expect(bodyOf(calls('editMessageReplyMarkup')[0])).toMatchObject({
      chat_id: 12345,
      message_id: 100,
      reply_markup: { inline_keyboard: [] },
    });

    fetchFn.mockImplementationOnce(async () => ({
      ok: false,
      status: 400,
      json: async () => ({ ok: false, description: 'message is not modified' }),
    }));
    await expect(adapter.finalizeChoicePrompt(prompt)).resolves.toBeUndefined();
  });

  it('finalizeChoicePrompt rethrows other failures so the sweep retries', async () => {
    const prompt = seedPrompt();
    fetchFn.mockImplementationOnce(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ ok: false, description: 'server error' }),
    }));
    await expect(adapter.finalizeChoicePrompt(prompt)).rejects.toThrow();
  });
});

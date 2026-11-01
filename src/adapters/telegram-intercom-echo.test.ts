/** E90 — the silent Intercom echo is posted as plain text and leaves the live tool-status draft alone. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { TelegramAdapter } from './telegram.js';
import { runMigrations } from '../db/schema.js';
import { upsertThread } from '../pipeline/thread-store.js';
import type { AppConfig } from '../config/schema.js';
import type { MessageQueue } from '../core/queue.js';
import type { PipelineEngine } from '../pipeline/engine.js';
import type { MessageEnvelope } from '../types/envelope.js';

const config = {
  bus: { http_port: 3000 }, adapters: { telegram: { token: 'test:token', poll_timeout: 30 } },
  contacts: { chris: { id: 'chris', displayName: 'Chris', platforms: { telegram: { userId: 12345 } } } },
  topics: ['general'], agents: {}, memory: {}, schedules: [],
  pipeline: { dedup_window_ms: 30000, drop_unrouted: false, topic_rules: [], routes: [] },
} as unknown as AppConfig;

const echo = (over: Partial<MessageEnvelope> = {}): MessageEnvelope => ({
  id: 'e1', timestamp: new Date(0).toISOString(), channel: 'telegram', topic: 'general', sender: 'system:bus', recipient: 'contact:chris',
  reply_to: null, priority: 'normal', payload: { type: 'text', body: '⌨️ *hello* [x]\n— via Intercom' },
  metadata: { silent: true, no_preview: true, intercom_echo: true }, ...over,
});

describe('TelegramAdapter Intercom echo', () => {
  let db: Database.Database; let adapter: TelegramAdapter; let fetchFn: ReturnType<typeof vi.fn>;
  const bodies = (method: string) => fetchFn.mock.calls.filter((c) => String(c[0]).endsWith(`/${method}`)).map((c) => JSON.parse((c[1] as { body: string }).body) as Record<string, unknown>);

  beforeEach(() => {
    db = new Database(':memory:'); runMigrations(db);
    adapter = new TelegramAdapter({ config, queue: {} as unknown as MessageQueue, pipeline: {} as unknown as PipelineEngine, db, instanceConfig: { token: 'test:token', poll_timeout: 30 } });
    fetchFn = vi.fn(async (url: string) => ({ ok: true, status: 200, json: async () => ({ ok: true, result: String(url).endsWith('/sendMessage') ? { message_id: 77, chat: { id: 12345, type: 'private' }, date: 0 } : true }) }));
    vi.stubGlobal('fetch', fetchFn);
  });
  afterEach(() => { vi.unstubAllGlobals(); db.close(); });

  it('posts one plain-text, silent, preview-free message (no parse_mode, so user text is never reinterpreted)', async () => {
    const res = await adapter.send(echo());
    expect(res).toEqual({ success: true, platformMessageId: '77' });
    const sent = bodies('sendMessage');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ chat_id: 12345, text: '⌨️ *hello* [x]\n— via Intercom', disable_notification: true, link_preview_options: { is_disabled: true } });
    expect(sent[0]).not.toHaveProperty('parse_mode');
    expect(sent[0]).not.toHaveProperty('message_thread_id');
  });

  it('does not take over a running turn\'s status draft', async () => {
    adapter.reportToolCall('chris', 'Checking the calendar', 'telegram', 'general');
    await vi.waitFor(() => expect(bodies('sendMessage')).toHaveLength(1));         // the status draft
    await adapter.send(echo());
    expect(bodies('editMessageText')).toHaveLength(0);
    expect(bodies('sendMessage')).toHaveLength(2);
  });

  it('lands in the followed forum topic', async () => {
    upsertThread(db, { channel: 'telegram', topic: 'thread:abc', threadKey: '12345:9', metadata: { chatId: 12345, messageThreadId: 9 } });
    await adapter.send(echo({ topic: 'thread:abc' }));
    expect(bodies('sendMessage')[0]).toMatchObject({ chat_id: 12345, message_thread_id: 9 });
  });

  it('reports a Telegram failure instead of throwing', async () => {
    fetchFn.mockImplementationOnce(async () => ({ ok: false, status: 500, json: async () => ({ ok: false, description: 'boom' }) }));
    const res = await adapter.send(echo());
    expect(res.success).toBe(false);
  });
});

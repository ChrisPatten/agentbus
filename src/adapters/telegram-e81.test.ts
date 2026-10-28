/**
 * E81 — Telegram integration enhancements at the adapter: send parameters
 * (S81.2), buttons v2 (S81.3), outbound registry + edit (S81.4), pin (S81.5),
 * location/venue/contact (S81.6), documents (S81.7), ask_input (S81.8),
 * rich messages (S81.9).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, truncateSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TelegramAdapter, buildChoiceKeyboard } from './telegram.js';
import { runMigrations } from '../db/schema.js';
import { upsertThread } from '../pipeline/thread-store.js';
import { ChoiceStore } from '../choices/store.js';
import { InputPromptStore } from '../choices/input-store.js';
import { OutboundStore } from '../outbound/store.js';
import type { AppConfig } from '../config/schema.js';
import type { MessageQueue } from '../core/queue.js';
import type { PipelineEngine } from '../pipeline/engine.js';
import type { MessageEnvelope } from '../types/envelope.js';

const PROMPT_ID = '11111111-2222-3333-4444-555555555555';
const GROUP = -1001234567890;

function makeConfig(): AppConfig {
  return {
    bus: { http_port: 3000, db_path: ':memory:', log_level: 'info' },
    adapters: { telegram: { token: 'test:token', poll_timeout: 30 } },
    contacts: {
      chris: { id: 'chris', displayName: 'Chris', platforms: { telegram: { userId: 12345 } } },
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

function env(body: string, overrides: Partial<MessageEnvelope> = {}): MessageEnvelope {
  return {
    id: 'bus-1',
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

const bodyOf = (call: unknown): Record<string, unknown> => JSON.parse((call as [string, { body: string }])[1].body) as Record<string, unknown>;

describe('TelegramAdapter E81', () => {
  let db: Database.Database;
  let adapter: TelegramAdapter;
  let fetchFn: ReturnType<typeof vi.fn>;
  let respond: (method: string, params: unknown) => { ok: boolean; status?: number; result?: unknown; description?: string } | undefined;
  let inbound: MessageEnvelope[];
  let sendDir: string;
  let nextId: number;

  const calls = (method: string) => fetchFn.mock.calls.filter((c) => String(c[0]).endsWith(`/${method}`));

  function build(extra: Record<string, unknown> = {}) {
    return new TelegramAdapter({
      config: makeConfig(),
      queue: {} as unknown as MessageQueue,
      pipeline: {
        process: async (ctx: { envelope: MessageEnvelope }) => {
          inbound.push(ctx.envelope);
          return null;
        },
      } as unknown as PipelineEngine,
      db,
      instanceConfig: { token: 'test:token', poll_timeout: 30, send_paths: [sendDir] },
      ...extra,
    });
  }

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    inbound = [];
    nextId = 100;
    sendDir = realpathSync(mkdtempSync(join(tmpdir(), 'e81-send-')));
    respond = () => undefined;
    adapter = build();
    fetchFn = vi.fn(async (url: string, init?: { body?: unknown }) => {
      const method = String(url).split('/').pop()!;
      const params = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;
      const custom = respond(method, params);
      if (custom) {
        return { ok: custom.ok, status: custom.status ?? (custom.ok ? 200 : 400), json: async () => ({ ok: custom.ok, result: custom.result, description: custom.description }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, result: method.startsWith('send') ? { message_id: nextId++, chat: { id: 12345, type: 'private' }, date: 0 } : true }) };
    });
    vi.stubGlobal('fetch', fetchFn);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    db.close();
    rmSync(sendDir, { recursive: true, force: true });
  });

  // ── S81.2 send parameters ──────────────────────────────────────────────────

  describe('send parameters (S81.2)', () => {
    it('sends silently and without a link card when asked, and not otherwise', async () => {
      await adapter.send(env('see https://example.com', { metadata: { silent: true, no_preview: true } }));
      expect(bodyOf(calls('sendMessage')[0])).toMatchObject({ disable_notification: true, link_preview_options: { is_disabled: true } });

      await adapter.send(env('plain'));
      const second = bodyOf(calls('sendMessage')[1]);
      expect(second).not.toHaveProperty('disable_notification');
      expect(second).not.toHaveProperty('link_preview_options');
    });

    it('each option is independent', async () => {
      await adapter.send(env('a', { metadata: { silent: true } }));
      await adapter.send(env('b', { metadata: { no_preview: true } }));
      expect(bodyOf(calls('sendMessage')[0])).toMatchObject({ disable_notification: true });
      expect(bodyOf(calls('sendMessage')[0])).not.toHaveProperty('link_preview_options');
      expect(bodyOf(calls('sendMessage')[1])).toMatchObject({ link_preview_options: { is_disabled: true } });
      expect(bodyOf(calls('sendMessage')[1])).not.toHaveProperty('disable_notification');
    });

    it('combines with choices and applies silent to every part of a split message', async () => {
      const long = Array.from({ length: 10 }, (_, i) => `line ${i}`.repeat(500)).join('\n');
      await adapter.send(env(long, { metadata: { silent: true, choices: ['A', 'B'] } }));
      const sends = calls('sendMessage');
      expect(sends.length).toBeGreaterThan(1);
      for (const c of sends) expect(bodyOf(c)).toMatchObject({ disable_notification: true });
      expect(bodyOf(sends.at(-1)!)).toHaveProperty('reply_markup');
    });

    it('pins the delivered message silently when pin is set, and a pin failure does not fail the send', async () => {
      const ok = await adapter.send(env('pin me', { metadata: { pin: true } }));
      expect(ok).toMatchObject({ success: true, platformMessageId: '100' });
      expect(bodyOf(calls('pinChatMessage')[0])).toMatchObject({ chat_id: 12345, message_id: 100, disable_notification: true });

      respond = (m) => (m === 'pinChatMessage' ? { ok: false, status: 400, description: 'Bad Request: not enough rights to pin a message' } : undefined);
      const failed = await adapter.send(env('pin me too', { id: 'bus-2', metadata: { pin: true } }));
      expect(failed.success).toBe(true);
    });

    it('applies no_preview to a status-draft overwrite edit', async () => {
      adapter.reportToolCall('chris', 'Checking', 'telegram');
      await new Promise((r) => setTimeout(r, 1200));
      await adapter.send(env('see https://example.com', { metadata: { no_preview: true } }));
      expect(bodyOf(calls('editMessageText')[0])).toMatchObject({ link_preview_options: { is_disabled: true } });
    });
  });

  // ── S81.3 buttons v2 ───────────────────────────────────────────────────────

  describe('buttons v2 (S81.3)', () => {
    it('leaves plain-string keyboards byte-identical to E74', () => {
      expect(buildChoiceKeyboard(PROMPT_ID, ['Yes', 'No'])).toEqual({
        inline_keyboard: [[{ text: 'Yes', callback_data: `choice:${PROMPT_ID}:0` }, { text: 'No', callback_data: `choice:${PROMPT_ID}:1` }]],
      });
    });

    it('renders choice, copy_text and url buttons; only the choice button has callback_data', () => {
      const kb = buildChoiceKeyboard(PROMPT_ID, ['Approve', 'Copy code', 'Docs'], [{ style: 'success' }, { copy_text: '1234' }, { url: 'https://example.com' }]);
      expect(kb.inline_keyboard.flat()).toEqual([
        { text: 'Approve', callback_data: `choice:${PROMPT_ID}:0`, style: 'success' },
        { text: 'Copy code', copy_text: { text: '1234' } },
        { text: 'Docs', url: 'https://example.com' },
      ]);
    });

    it('sends a mixed prompt and persists labels plus button attributes', async () => {
      await adapter.send(env('Pick', { metadata: { choices: ['Go', { label: 'Copy', copy_text: 'abc' }, { label: 'Open', url: 'https://example.com' }] } }));
      const kb = (bodyOf(calls('sendMessage')[0]).reply_markup as { inline_keyboard: Array<Array<Record<string, unknown>>> }).inline_keyboard.flat();
      expect(kb.map((b) => Object.keys(b).filter((k) => k !== 'text'))).toEqual([['callback_data'], ['copy_text'], ['url']]);
      const [prompt] = new ChoiceStore(db).list();
      expect(prompt!.labels).toEqual(['Go', 'Copy', 'Open']);
      expect(prompt!.buttons).toEqual([null, { copy_text: 'abc' }, { url: 'https://example.com' }]);
    });

    it('does not persist a prompt when no button can be tapped', async () => {
      await adapter.send(env('Links', { metadata: { choices: [{ label: 'Open', url: 'https://example.com' }] } }));
      expect(new ChoiceStore(db).list()).toHaveLength(0);
      expect(calls('sendMessage')).toHaveLength(1);
    });

    it('plain-string choices persist no buttons (E74 unchanged)', async () => {
      await adapter.send(env('Pick', { metadata: { choices: ['A', 'B'] } }));
      expect(new ChoiceStore(db).list()[0]!.buttons).toBeNull();
    });

    function tap(data: string) {
      return (adapter as unknown as { processUpdate: (u: unknown) => Promise<boolean> }).processUpdate({
        update_id: 1,
        callback_query: { id: 'cb', from: { id: 12345, first_name: 'C' }, data, message: { message_id: 100, chat: { id: 12345, type: 'private' }, date: 0, text: 'Pick' } },
      });
    }

    it('after a tap on a v2 prompt, keeps the chosen button visible and disabled', async () => {
      await adapter.send(env('Pick', { metadata: { choices: [{ label: 'Approve', style: 'success' }, { label: 'Copy', copy_text: 'x' }] } }));
      const [prompt] = new ChoiceStore(db).list();
      fetchFn.mockClear();
      await tap(`choice:${prompt!.id}:0`);
      const edit = bodyOf(calls('editMessageReplyMarkup')[0]);
      expect(edit.reply_markup).toEqual({ inline_keyboard: [[{ text: '✓ Approve', disabled: {}, style: 'success' }]] });
      expect(calls('editMessageText')).toHaveLength(0);
      expect(inbound).toHaveLength(1);
      expect(inbound[0]!.payload).toMatchObject({ body: '[tapped] Approve' });
    });

    it('falls back to the E74 "You chose" edit when the disabled-button edit is refused', async () => {
      await adapter.send(env('Pick', { metadata: { choices: [{ label: 'Approve', style: 'success' }, 'No'] } }));
      const [prompt] = new ChoiceStore(db).list();
      respond = (m) => (m === 'editMessageReplyMarkup' ? { ok: false, status: 400, description: 'Bad Request: BUTTON_INVALID' } : undefined);
      fetchFn.mockClear();
      await tap(`choice:${prompt!.id}:1`);
      expect(bodyOf(calls('editMessageText')[0])).toMatchObject({ text: 'Pick\n\nYou chose: No', reply_markup: { inline_keyboard: [] } });
    });

    it('a plain E74 prompt still ends with the "You chose" text edit and no disabled button', async () => {
      await adapter.send(env('Pick', { metadata: { choices: ['A', 'B'] } }));
      const [prompt] = new ChoiceStore(db).list();
      fetchFn.mockClear();
      await tap(`choice:${prompt!.id}:1`);
      expect(calls('editMessageReplyMarkup')).toHaveLength(0);
      expect(bodyOf(calls('editMessageText')[0])).toMatchObject({ text: 'Pick\n\nYou chose: B' });
    });
  });

  // ── S81.4 registry and edit ────────────────────────────────────────────────

  describe('outbound registry and edit_message (S81.4)', () => {
    it('records a DM send under the bus message id', async () => {
      await adapter.send(env('hello'));
      expect(new OutboundStore(db).get('bus-1')).toMatchObject({ chat_id: 12345, thread_id: null, platform_message_id: 100, kind: 'text', parts: 1, channel: 'telegram' });
    });

    it('records the last part and the part count of a split message', async () => {
      const long = Array.from({ length: 10 }, (_, i) => `line ${i}`.repeat(500)).join('\n');
      await adapter.send(env(long));
      const row = new OutboundStore(db).get('bus-1')!;
      expect(row.parts).toBe(calls('sendMessage').length);
      expect(row.platform_message_id).toBe(100 + row.parts - 1);
    });

    it('edits a previously sent message in place', async () => {
      await adapter.send(env('first'));
      const res = await adapter.editMessage('bus-1', 'second');
      expect(res).toEqual({ ok: true });
      expect(bodyOf(calls('editMessageText')[0])).toMatchObject({ chat_id: 12345, message_id: 100, text: 'second', reply_markup: { inline_keyboard: [] } });
    });

    it('replaces the keyboard when choices are given and expires the old prompt', async () => {
      await adapter.send(env('Pick', { metadata: { choices: ['A', 'B'] } }));
      const store = new ChoiceStore(db);
      const old = store.list()[0]!;
      const res = await adapter.editMessage('bus-1', 'Pick again', ['X', 'Y']);
      expect(res.ok).toBe(true);
      expect(store.getById(old.id)).toMatchObject({ status: 'expired', platform_message_id: null });
      const open = store.list('open');
      expect(open).toHaveLength(1);
      expect(open[0]).toMatchObject({ labels: ['X', 'Y'], platform_message_id: '12345:100', bus_message_id: 'bus-1', contact_id: 'chris' });
      const kb = (bodyOf(calls('editMessageText')[0]).reply_markup as { inline_keyboard: unknown[][] }).inline_keyboard.flat();
      expect(kb).toHaveLength(2);
    });

    it('treats a no-op edit (same text) as success without leaking the Telegram error', async () => {
      await adapter.send(env('same'));
      respond = (m) => (m === 'editMessageText' ? { ok: false, status: 400, description: 'Bad Request: message is not modified: specified new message content and reply markup are exactly the same' } : undefined);
      const res = await adapter.editMessage('bus-1', 'same');
      expect(res).toMatchObject({ ok: true });
      expect((res as { note: string }).note).toContain('nothing changed');
    });

    it('returns a clear error for an unknown or foreign message id', async () => {
      const unknown = await adapter.editMessage('nope', 'x');
      expect(unknown).toMatchObject({ ok: false });
      expect((unknown as { error: string }).error).toContain('No record');

      new OutboundStore(db).record({ busMessageId: 'other', channel: 'telegram:someone-else', chatId: 1, platformMessageId: 9, kind: 'text' });
      const foreign = await adapter.editMessage('other', 'x');
      expect(foreign).toMatchObject({ ok: false });
      expect((foreign as { error: string }).error).toContain('was not sent by adapter');
      expect(calls('editMessageText')).toHaveLength(0);
    });

    it('refuses to edit multi-part, non-text and over-long messages', async () => {
      const store = new OutboundStore(db);
      store.record({ busMessageId: 'multi', channel: 'telegram', chatId: 1, platformMessageId: 5, kind: 'text', parts: 3 });
      store.record({ busMessageId: 'doc', channel: 'telegram', chatId: 1, platformMessageId: 6, kind: 'document' });
      store.record({ busMessageId: 'txt', channel: 'telegram', chatId: 1, platformMessageId: 7, kind: 'text' });
      expect(((await adapter.editMessage('multi', 'x')) as { error: string }).error).toContain('3 parts');
      expect(((await adapter.editMessage('doc', 'x')) as { error: string }).error).toContain('document');
      expect(((await adapter.editMessage('txt', 'x'.repeat(4097))) as { error: string }).error).toContain('limited to 4096');
      expect(calls('editMessageText')).toHaveLength(0);
    });

    it('rejects invalid choices on edit', async () => {
      await adapter.send(env('x'));
      const res = await adapter.editMessage('bus-1', 'y', []);
      expect(res).toMatchObject({ ok: false });
    });

    it('surfaces a Telegram failure as an error', async () => {
      await adapter.send(env('x'));
      respond = (m) => (m === 'editMessageText' ? { ok: false, status: 400, description: 'Bad Request: message to edit not found' } : undefined);
      expect(await adapter.editMessage('bus-1', 'y')).toEqual({ ok: false, error: 'Bad Request: message to edit not found' });
    });

    it('edits a rich message with rich_message', async () => {
      await adapter.send(env('plain', { metadata: { telegram_send: { kind: 'rich', format: 'markdown', content: '# Hi' } } }));
      expect(new OutboundStore(db).get('bus-1')!.kind).toBe('rich');
      await adapter.editMessage('bus-1', '# Edited');
      expect(bodyOf(calls('editMessageText')[0])).toMatchObject({ rich_message: { markdown: '# Edited' } });
    });
  });

  // ── S81.5 pin ──────────────────────────────────────────────────────────────

  describe('pin_message / unpin_message (S81.5)', () => {
    beforeEach(async () => {
      await adapter.send(env('pin target'));
    });

    it('pins silently by default and audibly when asked', async () => {
      expect(await adapter.pinMessage('bus-1', true)).toEqual({ ok: true });
      expect(bodyOf(calls('pinChatMessage')[0])).toMatchObject({ chat_id: 12345, message_id: 100, disable_notification: true });
      await adapter.pinMessage('bus-1', false);
      expect(bodyOf(calls('pinChatMessage')[1])).toMatchObject({ disable_notification: false });
    });

    it('unpins one message', async () => {
      expect(await adapter.unpinMessage('bus-1', false)).toEqual({ ok: true });
      expect(bodyOf(calls('unpinChatMessage')[0])).toMatchObject({ chat_id: 12345, message_id: 100 });
    });

    it('unpin_all uses the topic for a forum-topic message and the chat otherwise', async () => {
      await adapter.unpinMessage('bus-1', true);
      expect(bodyOf(calls('unpinAllChatMessages')[0])).toEqual({ chat_id: 12345 });
      new OutboundStore(db).record({ busMessageId: 'topic', channel: 'telegram', chatId: GROUP, threadId: 77, platformMessageId: 9, kind: 'text' });
      await adapter.unpinMessage('topic', true);
      expect(bodyOf(calls('unpinAllForumTopicMessages')[0])).toEqual({ chat_id: GROUP, message_thread_id: 77 });
    });

    it('turns a missing-rights error into a readable message naming the fix', async () => {
      respond = (m) => (m === 'pinChatMessage' ? { ok: false, status: 400, description: 'Bad Request: not enough rights to pin a message' } : undefined);
      const res = await adapter.pinMessage('bus-1', true);
      expect(res).toMatchObject({ ok: false });
      expect((res as { error: string }).error).toContain('"Pin Messages" admin right');
    });

    it('errors on an unknown message id', async () => {
      expect(await adapter.pinMessage('nope', true)).toMatchObject({ ok: false });
      expect(await adapter.unpinMessage('nope', false)).toMatchObject({ ok: false });
    });
  });

  // ── S81.6 location / venue / contact ───────────────────────────────────────

  describe('location, venue, contact (S81.6)', () => {
    it('sends a location and honours silent', async () => {
      const res = await adapter.send(env('fallback', { metadata: { silent: true, telegram_send: { kind: 'location', latitude: 42.0334, longitude: -71.2198 } } }));
      expect(res).toMatchObject({ success: true, platformMessageId: '100' });
      expect(bodyOf(calls('sendLocation')[0])).toEqual({ chat_id: 12345, latitude: 42.0334, longitude: -71.2198, disable_notification: true });
      expect(calls('sendMessage')).toHaveLength(0);
      expect(new OutboundStore(db).get('bus-1')!.kind).toBe('location');
    });

    it('sends a venue into a forum topic', async () => {
      upsertThread(db, { channel: `telegram:group:${GROUP}`, topic: 'thread:abc', threadKey: `${GROUP}:55`, metadata: { chatId: GROUP, messageThreadId: 55 } });
      const topicAdapter = build();
      // channel is "telegram:group:..." — the single-bot adapter id is "telegram"
      await topicAdapter.send(env('fb', { channel: `telegram:group:${GROUP}`, topic: 'thread:abc', metadata: { telegram_send: { kind: 'venue', latitude: 1, longitude: 2, title: 'Cafe', address: '1 Main St' } } }));
      expect(bodyOf(calls('sendVenue')[0])).toMatchObject({ chat_id: GROUP, message_thread_id: 55, title: 'Cafe', address: '1 Main St' });
    });

    it('sends a contact with a vCard', async () => {
      await adapter.send(env('fb', { metadata: { telegram_send: { kind: 'contact', phone_number: '+16175551212', first_name: 'Ann', last_name: 'Lee', vcard: 'BEGIN:VCARD' } } }));
      expect(bodyOf(calls('sendContact')[0])).toMatchObject({ phone_number: '+16175551212', first_name: 'Ann', last_name: 'Lee', vcard: 'BEGIN:VCARD' });
    });

    it('rejects out-of-range coordinates and a contact without a number by sending the plain-text fallback instead', async () => {
      await adapter.send(env('Location: 99, 0', { metadata: { telegram_send: { kind: 'location', latitude: 99, longitude: 0 } } }));
      await adapter.send(env('Contact: Ann', { id: 'bus-2', metadata: { telegram_send: { kind: 'contact', first_name: 'Ann' } } }));
      expect(calls('sendLocation')).toHaveLength(0);
      expect(calls('sendContact')).toHaveLength(0);
      expect(calls('sendMessage').map((c) => bodyOf(c).text)).toEqual(['Location: 99, 0', 'Contact: Ann']);
    });

    it('still resolves the recipient from the contact allow-list', async () => {
      const res = await adapter.send(env('fb', { recipient: 'contact:stranger', metadata: { telegram_send: { kind: 'location', latitude: 1, longitude: 2 } } }));
      expect(res).toMatchObject({ success: false, retryable: false });
      expect(calls('sendLocation')).toHaveLength(0);
    });

    it('reports a Telegram rejection as a failed delivery', async () => {
      respond = (m) => (m === 'sendLocation' ? { ok: false, status: 400, description: 'Bad Request: invalid location specified' } : undefined);
      const res = await adapter.send(env('fb', { metadata: { telegram_send: { kind: 'location', latitude: 1, longitude: 2 } } }));
      expect(res).toEqual({ success: false, error: 'Bad Request: invalid location specified', retryable: false });
    });
  });

  // ── S81.7 documents ────────────────────────────────────────────────────────

  describe('send_document (S81.7)', () => {
    const doc = (path: string, extra: Record<string, unknown> = {}) => ({ telegram_send: { kind: 'document', path, ...extra } });
    const formOf = (call: unknown) => (call as [string, { body: FormData }])[1].body;

    it('uploads a PDF inside the allow-list as a document with a caption', async () => {
      const file = join(sendDir, 'report.pdf');
      writeFileSync(file, '%PDF-1.4 test');
      const res = await adapter.send(env('[file: report.pdf]', { metadata: { silent: true, ...doc(file, { caption: 'Here you go' }) } }));
      expect(res).toMatchObject({ success: true, platformMessageId: '100' });
      const form = formOf(calls('sendDocument')[0]);
      expect(form.get('chat_id')).toBe('12345');
      expect(form.get('caption')).toBe('Here you go');
      expect(form.get('disable_notification')).toBe('true');
      expect((form.get('document') as File).name).toBe('report.pdf');
      expect(new OutboundStore(db).get('bus-1')!.kind).toBe('document');
    });

    it('sends a photo by path through sendPhoto', async () => {
      const file = join(sendDir, 'p.png');
      writeFileSync(file, 'png');
      await adapter.send(env('x', { metadata: { telegram_send: { kind: 'photo', path: file } } }));
      expect(calls('sendPhoto')).toHaveLength(1);
      expect(calls('sendDocument')).toHaveLength(0);
    });

    it('rejects a path outside the allow-list before any upload', async () => {
      const outside = realpathSync(mkdtempSync(join(tmpdir(), 'e81-out-')));
      writeFileSync(join(outside, 'secret.txt'), 'secret');
      const res = await adapter.send(env('x', { metadata: doc(join(outside, 'secret.txt')) }));
      expect(res).toMatchObject({ success: false, retryable: false });
      expect((res as { error: string }).error).toContain('outside the allowed');
      expect(calls('sendDocument')).toHaveLength(0);
      rmSync(outside, { recursive: true, force: true });
    });

    it('rejects ../ traversal', async () => {
      mkdirSync(join(sendDir, 'sub'));
      writeFileSync(join(sendDir, '..', 'e81-escape.txt'), 'x');
      const res = await adapter.send(env('x', { metadata: doc(join(sendDir, 'sub', '..', '..', 'e81-escape.txt')) }));
      expect(res.success).toBe(false);
      expect(calls('sendDocument')).toHaveLength(0);
      rmSync(join(sendDir, '..', 'e81-escape.txt'), { force: true });
    });

    it('rejects a symlink that escapes the allow-list', async () => {
      const outside = realpathSync(mkdtempSync(join(tmpdir(), 'e81-out-')));
      writeFileSync(join(outside, 'secret.txt'), 'secret');
      symlinkSync(join(outside, 'secret.txt'), join(sendDir, 'link.txt'));
      const res = await adapter.send(env('x', { metadata: doc(join(sendDir, 'link.txt')) }));
      expect(res).toMatchObject({ success: false, retryable: false });
      expect((res as { error: string }).error).toContain('outside the allowed');
      expect(calls('sendDocument')).toHaveLength(0);
      rmSync(outside, { recursive: true, force: true });
    });

    it('rejects an oversize file (over 50 MB) before uploading, and an oversize photo (over 10 MB)', async () => {
      const big = join(sendDir, 'big.bin');
      writeFileSync(big, '');
      truncateSync(big, 50 * 1024 * 1024 + 1);
      const res = await adapter.send(env('x', { metadata: doc(big) }));
      expect(res).toMatchObject({ success: false, retryable: false });
      expect((res as { error: string }).error).toContain('upload limit');

      const photo = join(sendDir, 'big.png');
      writeFileSync(photo, '');
      truncateSync(photo, 10 * 1024 * 1024 + 1);
      const res2 = await adapter.send(env('x', { id: 'bus-2', metadata: { telegram_send: { kind: 'photo', path: photo } } }));
      expect(res2.success).toBe(false);
      expect(calls('sendDocument')).toHaveLength(0);
      expect(calls('sendPhoto')).toHaveLength(0);
    });

    it('allows nothing when no send directories are configured or defaulted', async () => {
      const bare = new TelegramAdapter({
        config: makeConfig(),
        queue: {} as unknown as MessageQueue,
        pipeline: {} as unknown as PipelineEngine,
        db,
        instanceConfig: { token: 'test:token', poll_timeout: 30 },
      });
      const file = join(sendDir, 'a.txt');
      writeFileSync(file, 'a');
      const res = await bare.send(env('x', { metadata: doc(file) }));
      expect(res.success).toBe(false);
    });
  });

  // ── S81.9 rich ─────────────────────────────────────────────────────────────

  describe('send_rich (S81.9)', () => {
    const rich = (content: string, format = 'markdown', extra: Record<string, unknown> = {}) => ({ telegram_send: { kind: 'rich', format, content }, ...extra });

    it('sends Rich Markdown through sendRichMessage and registers it as rich', async () => {
      const res = await adapter.send(env('plain fallback', { metadata: rich('# Brief\n\n| a | b |\n|--|--|\n| 1 | 2 |', 'markdown', { silent: true }) }));
      expect(res).toMatchObject({ success: true, platformMessageId: '100' });
      expect(bodyOf(calls('sendRichMessage')[0])).toMatchObject({ chat_id: 12345, rich_message: { markdown: '# Brief\n\n| a | b |\n|--|--|\n| 1 | 2 |' }, disable_notification: true });
      expect(calls('sendMessage')).toHaveLength(0);
      expect(new OutboundStore(db).get('bus-1')).toMatchObject({ kind: 'rich', parts: 1 });
    });

    it('sends html in the html field', async () => {
      await adapter.send(env('fb', { metadata: rich('<h2>Hi</h2>', 'html') }));
      expect(bodyOf(calls('sendRichMessage')[0])).toMatchObject({ rich_message: { html: '<h2>Hi</h2>' } });
    });

    it('puts the choice keyboard on the last chunk and persists the prompt', async () => {
      const para = 'p'.repeat(20000);
      await adapter.send(env('fb', { metadata: rich(`${para}\n\n${para}`, 'markdown', { choices: ['A', 'B'] }) }));
      const sends = calls('sendRichMessage');
      expect(sends).toHaveLength(2);
      expect(bodyOf(sends[0]!)).not.toHaveProperty('reply_markup');
      expect(bodyOf(sends[1]!)).toHaveProperty('reply_markup');
      expect(bodyOf(sends[0]!).rich_message).toMatchObject({ markdown: expect.stringContaining('(part 1 of 2)') });
      expect(new ChoiceStore(db).list()[0]).toMatchObject({ labels: ['A', 'B'], platform_message_id: '12345:101' });
      expect(new OutboundStore(db).get('bus-1')).toMatchObject({ parts: 2, platform_message_id: 101 });
    });

    it('falls back to the plain-text body when Telegram rejects the rich call', async () => {
      respond = (m) => (m === 'sendRichMessage' ? { ok: false, status: 404, description: 'Not Found' } : undefined);
      const res = await adapter.send(env('Plain fallback body', { metadata: rich('# Hi') }));
      expect(res).toMatchObject({ success: true });
      expect(calls('sendMessage').map((c) => bodyOf(c).text)).toEqual(['Plain fallback body']);
      expect(new OutboundStore(db).get('bus-1')!.kind).toBe('text');
    });

    it('does not mask a server error as a fallback', async () => {
      respond = (m) => (m === 'sendRichMessage' ? { ok: false, status: 500, description: 'Internal' } : undefined);
      const res = await adapter.send(env('fb', { metadata: rich('# Hi') }));
      expect(res).toMatchObject({ success: false, retryable: true });
      expect(calls('sendMessage')).toHaveLength(0);
    });
  });

  // ── S81.8 ask_input ────────────────────────────────────────────────────────

  describe('ask_input (S81.8)', () => {
    const ask = (input: string, placeholder?: string) => ({ telegram_send: { kind: 'ask_input', input, ...(placeholder ? { placeholder } : {}) } });
    const inputStore = () => new InputPromptStore(db);
    const update = (message: Record<string, unknown>) =>
      (adapter as unknown as { processUpdate: (u: unknown) => Promise<boolean> }).processUpdate({
        update_id: 7,
        message: { message_id: 500, from: { id: 12345, first_name: 'C' }, chat: { id: 12345, type: 'private' }, date: 0, ...message },
      });

    it('shows a one-time request_location keyboard in a private chat and records the prompt', async () => {
      await adapter.send(env('Where are you?', { metadata: ask('location') }));
      expect(bodyOf(calls('sendMessage')[0]).reply_markup).toEqual({
        keyboard: [[{ text: 'Share my location', request_location: true }]],
        one_time_keyboard: true,
        resize_keyboard: true,
      });
      expect(inputStore().getById(inputStore().findOpen('location', 12345, null, 'chris')!.id)).toMatchObject({ kind: 'location', keyboard: 1, bus_message_id: 'bus-1' });
    });

    it('uses request_contact and request_users for contact and person', async () => {
      await adapter.send(env('Number?', { metadata: ask('contact') }));
      await adapter.send(env('Who?', { id: 'bus-2', metadata: ask('person') }));
      const [c, p] = calls('sendMessage').map((x) => (bodyOf(x).reply_markup as { keyboard: Array<Array<Record<string, unknown>>> }).keyboard[0]![0]!);
      expect(c).toMatchObject({ request_contact: true });
      expect(p).toMatchObject({ request_users: { max_quantity: 1, request_name: true, request_username: true } });
    });

    it('uses force_reply with a placeholder for text', async () => {
      await adapter.send(env('Name the dish', { metadata: ask('text', 'e.g. lasagne') }));
      expect(bodyOf(calls('sendMessage')[0]).reply_markup).toEqual({ force_reply: true, input_field_placeholder: 'e.g. lasagne' });
      expect(inputStore().findOpen('text', 12345, null, 'chris')).toMatchObject({ keyboard: 0 });
    });

    it('degrades location/contact/person to force_reply in a group topic (S81.1: private chats only)', async () => {
      await adapter.send(env('Where?', { channel: `telegram:group:${GROUP}`, metadata: ask('location') }));
      const sent = bodyOf(calls('sendMessage')[0]);
      expect(sent.reply_markup).toEqual({ force_reply: true });
      expect(String(sent.text)).toContain('Where?');
      expect(String(sent.text)).toContain('attach menu');
      expect(inputStore().findOpen('location', GROUP, null, 'chris')).toMatchObject({ keyboard: 0 });
    });

    it('forwards a shared location as text with structured metadata, linked to the prompt, and removes the keyboard', async () => {
      await adapter.send(env('Where?', { metadata: ask('location') }));
      fetchFn.mockClear();
      expect(await update({ location: { latitude: 42.03, longitude: -71.22, horizontal_accuracy: 12 } })).toBe(true);
      expect(inbound).toHaveLength(1);
      expect(inbound[0]!.payload).toMatchObject({ body: '[location] 42.03, -71.22' });
      expect(inbound[0]!.reply_to).toBe('bus-1');
      expect(inbound[0]!.metadata).toMatchObject({ location: { latitude: 42.03, longitude: -71.22, horizontal_accuracy: 12 }, input_kind: 'location' });
      await vi.waitFor(() => expect(calls('deleteMessage')).toHaveLength(1));
      expect(bodyOf(calls('sendMessage')[0]).reply_markup).toEqual({ remove_keyboard: true });
      expect(inputStore().findOpen('location', 12345, null, 'chris')).toBeNull();
    });

    it('forwards a shared contact with name and number', async () => {
      await adapter.send(env('Number?', { metadata: ask('contact') }));
      await update({ contact: { phone_number: '+16175551212', first_name: 'Ann', last_name: 'Lee', user_id: 9 } });
      expect(inbound[0]!.payload).toMatchObject({ body: '[contact] Ann Lee, +16175551212' });
      expect(inbound[0]!.metadata).toMatchObject({ contact: { phone_number: '+16175551212', first_name: 'Ann', last_name: 'Lee', user_id: 9 } });
      expect(inbound[0]!.reply_to).toBe('bus-1');
    });

    it('forwards users_shared only for the matching request_id', async () => {
      await adapter.send(env('Who?', { metadata: ask('person') }));
      const prompt = inputStore().findOpen('person', 12345, null, 'chris')!;
      await update({ users_shared: { request_id: prompt.request_id! + 1, users: [{ user_id: 5, first_name: 'Zed' }] } });
      expect(inbound[0]!.reply_to).toBeFalsy();
      expect(inputStore().findOpen('person', 12345, null, 'chris')).not.toBeNull();
      await update({ users_shared: { request_id: prompt.request_id, users: [{ user_id: 5, first_name: 'Zed', username: 'zed' }] } });
      expect(inbound[1]!.payload).toMatchObject({ body: '[shared person] Zed @zed' });
      expect(inbound[1]!.reply_to).toBe('bus-1');
    });

    it('links a force_reply text answer to the prompt through the replied-to message', async () => {
      await adapter.send(env('Name the dish', { metadata: ask('text') }));
      await update({ text: 'lasagne', reply_to_message: { message_id: 100 } });
      expect(inbound[0]!.payload).toMatchObject({ body: 'lasagne' });
      expect(inbound[0]!.reply_to).toBe('bus-1');
      expect(inbound[0]!.metadata).toMatchObject({ input_kind: 'text' });
      expect(inputStore().findOpenByMessage(12345, 100, 'chris')).toBeNull();
    });

    it('does not link an answer once the prompt has expired, and the sweep path removes a lingering keyboard', async () => {
      await adapter.send(env('Where?', { metadata: ask('location') }));
      const prompt = inputStore().findOpen('location', 12345, null, 'chris')!;
      db.prepare(`UPDATE input_prompts SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?`).run(prompt.id);
      await update({ location: { latitude: 1, longitude: 2 } });
      expect(inbound[0]!.reply_to).toBeFalsy();
      fetchFn.mockClear();
      await adapter.finalizeInputPrompt({ ...prompt, keyboard: 1, status: 'expired' });
      expect(bodyOf(calls('sendMessage')[0]).reply_markup).toEqual({ remove_keyboard: true });
      expect(calls('deleteMessage')).toHaveLength(1);
    });

    it('forwards an unsolicited location from an allow-listed sender without a prompt link', async () => {
      await update({ location: { latitude: 1, longitude: 2 } });
      expect(inbound[0]!.payload).toMatchObject({ body: '[location] 1, 2' });
      expect(inbound[0]!.reply_to).toBeFalsy();
    });
  });
});

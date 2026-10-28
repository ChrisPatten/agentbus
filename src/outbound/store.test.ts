import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';
import { OutboundStore } from './store.js';
import { applySendOptions, readSendOptions } from './send-options.js';
import { parseTelegramSend, locationFallback, venueFallback, contactFallback } from './telegram-send.js';

describe('migration 040 — outbound_messages', () => {
  it('creates the table and is idempotent', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const cols = (db.prepare(`PRAGMA table_info(outbound_messages)`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols.sort()).toEqual(
      ['bus_message_id', 'channel', 'chat_id', 'created_at', 'kind', 'parts', 'platform_message_id', 'thread_id'].sort(),
    );
    expect(() => runMigrations(db)).not.toThrow();
  });

  it('applies on top of a database already at migration 39 without touching existing rows', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    db.exec(`DELETE FROM schema_migrations WHERE version >= 40; DROP TABLE outbound_messages; DROP TABLE input_prompts;`);
    db.prepare(
      `INSERT INTO choice_prompts (id, channel, topic, labels, status, created_at, expires_at) VALUES ('p', 'telegram', 'general', '["A"]', 'open', 'x', 'y')`,
    ).run();
    expect(() => db.exec(`ALTER TABLE choice_prompts DROP COLUMN buttons`)).not.toThrow();
    runMigrations(db);
    const row = db.prepare(`SELECT labels, buttons FROM choice_prompts WHERE id = 'p'`).get() as { labels: string; buttons: string | null };
    expect(row).toEqual({ labels: '["A"]', buttons: null });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM outbound_messages`).get()).toEqual({ n: 0 });
  });
});

describe('migration 042 — input_prompts', () => {
  it('creates the table with its open-prompt index', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const cols = (db.prepare(`PRAGMA table_info(input_prompts)`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['id', 'kind', 'chat_id', 'thread_id', 'keyboard', 'status', 'request_id']));
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE name='idx_input_prompts_open'`).get()).toBeTruthy();
  });
});

describe('OutboundStore (S81.4)', () => {
  let db: Database.Database;
  let store: OutboundStore;
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    store = new OutboundStore(db);
  });

  it('records and fetches a delivery by bus message id', () => {
    store.record({ busMessageId: 'm1', channel: 'telegram', chatId: -100, threadId: 7, platformMessageId: 55, kind: 'text' });
    expect(store.get('m1')).toMatchObject({ bus_message_id: 'm1', chat_id: -100, thread_id: 7, platform_message_id: 55, kind: 'text', parts: 1 });
    expect(store.get('nope')).toBeNull();
  });

  it('stores a null thread for a DM and replaces on a repeat id', () => {
    store.record({ busMessageId: 'm1', channel: 'telegram', chatId: 5, platformMessageId: 1, kind: 'text' });
    store.record({ busMessageId: 'm1', channel: 'telegram', chatId: 5, platformMessageId: 2, kind: 'rich', parts: 2 });
    expect(store.get('m1')).toMatchObject({ thread_id: null, platform_message_id: 2, kind: 'rich', parts: 2 });
  });

  it('prunes rows older than the retention window only', () => {
    const now = new Date('2026-11-30T00:00:00Z');
    store.record({ busMessageId: 'old', channel: 'telegram', chatId: 1, platformMessageId: 1, kind: 'text' }, new Date('2026-10-01T00:00:00Z'));
    store.record({ busMessageId: 'new', channel: 'telegram', chatId: 1, platformMessageId: 2, kind: 'text' }, new Date('2026-11-25T00:00:00Z'));
    expect(store.prune(now)).toBe(1);
    expect(store.get('old')).toBeNull();
    expect(store.get('new')).not.toBeNull();
  });
});

describe('send options (S81.2)', () => {
  it('applies only the options that are true and leaves other metadata alone', () => {
    expect(applySendOptions({ a: 1 }, { silent: true })).toEqual({ a: 1, silent: true });
    expect(applySendOptions({}, { silent: true, no_preview: true, pin: true })).toEqual({ silent: true, no_preview: true, pin: true });
    expect(applySendOptions({ a: 1 }, { silent: false })).toEqual({ a: 1 });
    expect(applySendOptions({}, {})).toEqual({});
  });

  it('reads back only literal true values', () => {
    expect(readSendOptions({ silent: true, no_preview: 'yes', pin: 1 })).toEqual({ silent: true, no_preview: false, pin: false });
    expect(readSendOptions(undefined)).toEqual({ silent: false, no_preview: false, pin: false });
  });
});

describe('telegram_send metadata (S81.6)', () => {
  it('is undefined when absent and null when invalid', () => {
    expect(parseTelegramSend(undefined)).toBeUndefined();
    expect(parseTelegramSend({ kind: 'location', latitude: 99, longitude: 0 })).toBeNull();
    expect(parseTelegramSend({ kind: 'location', latitude: 0, longitude: 181 })).toBeNull();
    expect(parseTelegramSend({ kind: 'contact', first_name: 'A' })).toBeNull();
    expect(parseTelegramSend({ kind: 'bogus' })).toBeNull();
    expect(parseTelegramSend('x')).toBeNull();
  });

  it('accepts valid location, venue, contact, document and rich forms', () => {
    expect(parseTelegramSend({ kind: 'location', latitude: 42.03, longitude: -71.2 })).toMatchObject({ kind: 'location' });
    expect(parseTelegramSend({ kind: 'venue', latitude: 1, longitude: 2, title: 'T', address: 'A' })).toMatchObject({ kind: 'venue' });
    expect(parseTelegramSend({ kind: 'contact', phone_number: '+16175551212', first_name: 'A' })).toMatchObject({ kind: 'contact' });
    expect(parseTelegramSend({ kind: 'document', path: '/x' })).toMatchObject({ kind: 'document' });
    expect(parseTelegramSend({ kind: 'photo', path: '/x', caption: 'c' })).toMatchObject({ kind: 'photo' });
    expect(parseTelegramSend({ kind: 'document', path: '/x', caption: 'c'.repeat(1025) })).toBeNull();
    expect(parseTelegramSend({ kind: 'rich', format: 'markdown', content: '# x' })).toMatchObject({ kind: 'rich' });
    expect(parseTelegramSend({ kind: 'ask_input', input: 'location' })).toMatchObject({ kind: 'ask_input' });
  });

  it('builds plain-text fallbacks with Apple Maps links and no tables', () => {
    expect(locationFallback(42.0334, -71.2198)).toBe('Location: 42.0334, -71.2198\nhttps://maps.apple.com/?ll=42.0334,-71.2198');
    expect(venueFallback({ latitude: 1, longitude: 2, title: 'Cafe Uno', address: '1 Main St' })).toBe(
      'Cafe Uno\n1 Main St\nhttps://maps.apple.com/?ll=1,2&q=Cafe%20Uno',
    );
    expect(contactFallback({ phone_number: '+16175551212', first_name: 'Ann', last_name: 'Lee' })).toBe('Contact: Ann Lee, +16175551212');
  });
});

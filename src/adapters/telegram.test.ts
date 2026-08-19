import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { pickLargestPhoto, extensionFor, resolveMediaConfig, buildDraftTrail, TelegramAdapter } from './telegram.js';
import { runMigrations } from '../db/schema.js';
import { upsertThread } from '../pipeline/thread-store.js';
import { topicForThreadKey } from '../pipeline/types.js';
import type { AppConfig } from '../config/schema.js';
import type { MessageQueue } from '../core/queue.js';
import type { PipelineEngine } from '../pipeline/engine.js';
import type { MessageEnvelope } from '../types/envelope.js';

describe('pickLargestPhoto', () => {
  it('returns the entry with the greatest file_size', () => {
    const chosen = pickLargestPhoto([
      { file_id: 's', file_unique_id: 's', width: 100, height: 100, file_size: 1000 },
      { file_id: 'm', file_unique_id: 'm', width: 200, height: 200, file_size: 4000 },
      { file_id: 'l', file_unique_id: 'l', width: 400, height: 400, file_size: 9000 },
    ]);
    expect(chosen.file_id).toBe('l');
  });

  it('falls back to width*height when file_size is missing', () => {
    const chosen = pickLargestPhoto([
      { file_id: 'a', file_unique_id: 'a', width: 50, height: 50 },
      { file_id: 'b', file_unique_id: 'b', width: 1000, height: 1000 },
    ]);
    expect(chosen.file_id).toBe('b');
  });
});

describe('extensionFor', () => {
  it('maps common image mimes to their canonical extensions', () => {
    expect(extensionFor('image/jpeg')).toBe('.jpg');
    expect(extensionFor('image/png')).toBe('.png');
    expect(extensionFor('image/webp')).toBe('.webp');
    expect(extensionFor('image/gif')).toBe('.gif');
  });

  it('falls back to the original filename extension when MIME is unknown', () => {
    expect(extensionFor('application/octet-stream', 'photo.HEIC')).toBe('.heic');
  });

  it('returns .bin for unknown mime + no filename', () => {
    expect(extensionFor('application/octet-stream')).toBe('.bin');
    expect(extensionFor()).toBe('.bin');
  });

  it('rejects filenames that would inject path characters', () => {
    expect(extensionFor(undefined, 'evil.name/with.slash')).toBe('.slash');
    // A filename with no real extension must not be accepted verbatim
    expect(extensionFor(undefined, 'noext')).toBe('.bin');
  });
});

describe('resolveMediaConfig', () => {
  function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
    return {
      bus: { http_port: 3000, db_path: ':memory:', log_level: 'info' },
      adapters: {},
      contacts: {},
      topics: ['general'],
      agents: {},
      memory: {
        summarizer_interval_ms: 60000,
        session_idle_threshold_ms: 1800000,
        context_window_hours: 48,
        claude_api_model: 'claude-opus-4-6',
        summary_max_tokens: 8192,
        session_close_min_messages: 0,
        memory_inject_exclude: [],
      },
      scheduler: { tick_interval_ms: 30000, enabled: true },
      schedules: [],
      pipeline: {
        dedup_window_ms: 30000,
        drop_unrouted: false,
        topic_rules: [],
        priority_weights: {
          base_score: 0,
          topic_bonus: 40,
          vip_sender_bonus: 20,
          urgency_keyword_bonus: 15,
        },
        urgency_keywords: [],
        vip_contacts: [],
        routes: [],
      },
      ...overrides,
    } as unknown as AppConfig;
  }

  it('returns null when no routes are defined', () => {
    expect(resolveMediaConfig(makeConfig(), 'telegram')).toBeNull();
  });

  it('returns null when the matched route target has no media config', () => {
    const config = makeConfig({
      pipeline: {
        dedup_window_ms: 30000,
        drop_unrouted: false,
        topic_rules: [],
        priority_weights: { base_score: 0, topic_bonus: 40, vip_sender_bonus: 20, urgency_keyword_bonus: 15 },
        urgency_keywords: [],
        vip_contacts: [],
        routes: [
          { match: { channel: 'telegram' }, target: { adapterId: 'cc', recipientId: 'agent:claude' } },
        ],
        relays: [],
      },
    });
    expect(resolveMediaConfig(config, 'telegram')).toBeNull();
  });

  it('returns the media config when a matching route targets an agent with media', () => {
    const config = makeConfig({
      agents: {
        'agent:claude': {
          media: { download_path: '/tmp/claude', ttl_seconds: 600 },
        },
      },
      pipeline: {
        dedup_window_ms: 30000,
        drop_unrouted: false,
        topic_rules: [],
        priority_weights: { base_score: 0, topic_bonus: 40, vip_sender_bonus: 20, urgency_keyword_bonus: 15 },
        urgency_keywords: [],
        vip_contacts: [],
        routes: [
          { match: { channel: 'telegram' }, target: { adapterId: 'cc', recipientId: 'agent:claude' } },
        ],
        relays: [],
      },
    });
    const resolved = resolveMediaConfig(config, 'telegram');
    expect(resolved).toEqual({
      agentId: 'agent:claude',
      download_path: '/tmp/claude',
      ttl_seconds: 600,
    });
  });

  it('accepts a catch-all route (no match.channel)', () => {
    const config = makeConfig({
      agents: { 'agent:claude': { media: { download_path: '/tmp/c', ttl_seconds: 60 } } },
      pipeline: {
        dedup_window_ms: 30000,
        drop_unrouted: false,
        topic_rules: [],
        priority_weights: { base_score: 0, topic_bonus: 40, vip_sender_bonus: 20, urgency_keyword_bonus: 15 },
        urgency_keywords: [],
        vip_contacts: [],
        routes: [{ match: {}, target: { adapterId: 'cc', recipientId: 'agent:claude' } }],
        relays: [],
      },
    });
    expect(resolveMediaConfig(config, 'telegram:peggy')?.agentId).toBe('agent:claude');
  });
});

// ── Integration: TelegramAdapter image download flow ─────────────────────────

function makeTestConfig(tmpDownloadDir: string): AppConfig {
  return {
    bus: { http_port: 3000, db_path: ':memory:', log_level: 'info' },
    adapters: { telegram: { token: 'test:token', poll_timeout: 30 } },
    contacts: {
      chris: {
        id: 'chris',
        displayName: 'Chris',
        platforms: { telegram: { userId: 12345 } },
      },
    },
    topics: ['general'],
    agents: {
      'agent:claude': {
        media: { download_path: tmpDownloadDir, ttl_seconds: 3600 },
      },
    },
    memory: {
      summarizer_interval_ms: 60000,
      session_idle_threshold_ms: 1800000,
      context_window_hours: 48,
      claude_api_model: 'claude-opus-4-6',
      summary_max_tokens: 8192,
      session_close_min_messages: 0,
      memory_inject_exclude: [],
    },
    scheduler: { tick_interval_ms: 30000, enabled: true },
    schedules: [],
    pipeline: {
      dedup_window_ms: 30000,
      drop_unrouted: false,
      topic_rules: [],
      priority_weights: { base_score: 0, topic_bonus: 40, vip_sender_bonus: 20, urgency_keyword_bonus: 15 },
      urgency_keywords: [],
      vip_contacts: [],
      routes: [
        { match: { channel: 'telegram' }, target: { adapterId: 'cc', recipientId: 'agent:claude' } },
      ],
    },
  } as unknown as AppConfig;
}

describe('TelegramAdapter inbound image handling', () => {
  let db: Database.Database;
  let tmpDir: string;
  let adapter: TelegramAdapter;
  let fetchMock: ReturnType<typeof vi.fn>;
  let processInboundCalls: Array<Record<string, unknown>>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentbus-test-'));
    db = new Database(':memory:');
    runMigrations(db);

    const config = makeTestConfig(tmpDir);

    // Stub pipeline + queue — we spy on processInbound via adapter.deps wiring,
    // but the easier path is to record the full InboundMessage handed to it.
    processInboundCalls = [];
    const pipeline = {
      process: async (ctx: { envelope: Record<string, unknown> }) => {
        processInboundCalls.push(ctx.envelope);
        return null; // abort so we don't hit the queue
      },
    } as unknown as PipelineEngine;

    const queue = {} as unknown as MessageQueue;

    adapter = new TelegramAdapter({
      config,
      queue,
      pipeline,
      db,
      instanceConfig: { token: 'test:token', poll_timeout: 30 },
    });

    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function mockGetFileAndDownload(filePath: string, body: Uint8Array) {
    // First call: getFile returns { file_path }
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { file_id: 'f', file_unique_id: 'fu', file_path: filePath } }),
    });
    // Second call: raw file download returns a ReadableStream
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(body);
          controller.close();
        },
      }),
    });
  }

  it('downloads a photo, records the attachments row, and attaches metadata to the envelope', async () => {
    const body = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]); // jpeg magic bytes
    mockGetFileAndDownload('photos/abc.jpg', body);

    await (adapter as unknown as {
      processUpdate: (u: unknown) => Promise<boolean>;
    }).processUpdate({
      update_id: 1,
      message: {
        message_id: 100,
        from: { id: 12345, first_name: 'Chris' },
        chat: { id: 555, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        caption: 'check this',
        photo: [
          { file_id: 'small', file_unique_id: 'u1', width: 90, height: 90, file_size: 1000 },
          { file_id: 'large', file_unique_id: 'u2', width: 1280, height: 1280, file_size: 80000 },
        ],
      },
    });

    // File was written
    const files = readdirSync(tmpDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.jpg$/);
    const written = readFileSync(join(tmpDir, files[0]!));
    expect(written.equals(Buffer.from(body))).toBe(true);
    expect(statSync(join(tmpDir, files[0]!)).size).toBe(body.length);

    // DB row was inserted with correct agent + TTL
    const row = db
      .prepare(`SELECT * FROM attachments`)
      .get() as {
        agent_id: string;
        local_path: string;
        mime_type: string;
        created_at: number;
        expires_at: number;
      };
    expect(row.agent_id).toBe('agent:claude');
    expect(row.mime_type).toBe('image/jpeg');
    expect(row.expires_at - row.created_at).toBe(3600 * 1000);
    expect(row.local_path).toBe(join(tmpDir, files[0]!));

    // Pipeline was called with an envelope carrying the attachment in metadata
    expect(processInboundCalls).toHaveLength(1);
    const env = processInboundCalls[0]!;
    const metadata = env['metadata'] as Record<string, unknown>;
    const attachments = metadata['attachments'] as Array<{ type: string; local_path: string; mime_type: string }>;
    expect(attachments).toHaveLength(1);
    expect(attachments[0]!.type).toBe('image');
    expect(attachments[0]!.local_path).toBe(row.local_path);
    expect(attachments[0]!.mime_type).toBe('image/jpeg');
  });

  it('downloads a non-image document and attaches it as type "file"', async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF magic bytes
    mockGetFileAndDownload('documents/abc.pdf', bytes);

    await (adapter as unknown as {
      processUpdate: (u: unknown) => Promise<boolean>;
    }).processUpdate({
      update_id: 2,
      message: {
        message_id: 101,
        from: { id: 12345, first_name: 'Chris' },
        chat: { id: 555, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        caption: 'here is a document',
        document: {
          file_id: 'doc1',
          file_unique_id: 'ud1',
          file_name: 'report.pdf',
          mime_type: 'application/pdf',
        },
      },
    });

    // File was downloaded
    const files = readdirSync(tmpDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.pdf$/);

    // DB row was inserted
    const row = db.prepare(`SELECT * FROM attachments`).get() as {
      agent_id: string;
      local_path: string;
      mime_type: string;
      original_filename: string;
    };
    expect(row.mime_type).toBe('application/pdf');
    expect(row.original_filename).toBe('report.pdf');

    // Envelope carries the attachment as type 'file'
    expect(processInboundCalls).toHaveLength(1);
    const env = processInboundCalls[0]!;
    const metadata = env['metadata'] as Record<string, unknown>;
    const attachments = metadata['attachments'] as Array<{ type: string; local_path: string; original_filename: string }>;
    expect(attachments).toHaveLength(1);
    expect(attachments[0]!.type).toBe('file');
    expect(attachments[0]!.original_filename).toBe('report.pdf');
  });

  it('delivers the message without attachment when the download fails', async () => {
    // First fetch (getFile) rejects
    fetchMock.mockRejectedValueOnce(new Error('network down'));

    await (adapter as unknown as {
      processUpdate: (u: unknown) => Promise<boolean>;
    }).processUpdate({
      update_id: 3,
      message: {
        message_id: 102,
        from: { id: 12345, first_name: 'Chris' },
        chat: { id: 555, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        caption: 'a photo',
        photo: [{ file_id: 'x', file_unique_id: 'ux', width: 100, height: 100, file_size: 500 }],
      },
    });

    // No DB row, no file
    const rows = db.prepare(`SELECT COUNT(*) AS n FROM attachments`).get() as { n: number };
    expect(rows.n).toBe(0);
    expect(readdirSync(tmpDir)).toHaveLength(0);
    // Pipeline still received the envelope (with caption, no attachments)
    expect(processInboundCalls).toHaveLength(1);
    const env = processInboundCalls[0]!;
    expect((env['metadata'] as Record<string, unknown>)['attachments']).toBeUndefined();
  });
});

// ── TelegramAdapter group channel identity (E28) ─────────────────────────────

describe('TelegramAdapter group channel identity (E28)', () => {
  let db: Database.Database;
  let tmpDir: string;
  let adapter: TelegramAdapter;
  let processInboundCalls: Array<Record<string, unknown>>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentbus-group-'));
    db = new Database(':memory:');
    runMigrations(db);

    const config = makeTestConfig(tmpDir);
    processInboundCalls = [];

    const pipeline = {
      process: async (ctx: { envelope: Record<string, unknown> }) => {
        processInboundCalls.push(ctx.envelope);
        return null;
      },
    } as unknown as PipelineEngine;

    const queue = {} as unknown as MessageQueue;

    adapter = new TelegramAdapter({
      config,
      queue,
      pipeline,
      db,
      instanceConfig: { token: 'test:token', poll_timeout: 30 },
    });

    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('keeps a DM on the base channel', async () => {
    await (adapter as unknown as { processUpdate: (u: unknown) => Promise<boolean> }).processUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        from: { id: 12345, first_name: 'Chris' },
        chat: { id: 555, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text: 'hello',
      },
    });

    expect(processInboundCalls).toHaveLength(1);
    expect(processInboundCalls[0]!['channel']).toBe('telegram');
  });

  it('derives a distinct channel for a supergroup message', async () => {
    await (adapter as unknown as { processUpdate: (u: unknown) => Promise<boolean> }).processUpdate({
      update_id: 2,
      message: {
        message_id: 2,
        from: { id: 12345, first_name: 'Chris' },
        chat: { id: -100123, type: 'supergroup' },
        date: Math.floor(Date.now() / 1000),
        text: 'hello group',
      },
    });

    expect(processInboundCalls).toHaveLength(1);
    expect(processInboundCalls[0]!['channel']).toBe('telegram:group:-100123');
  });

  it('derives distinct channels for two different groups', async () => {
    await (adapter as unknown as { processUpdate: (u: unknown) => Promise<boolean> }).processUpdate({
      update_id: 3,
      message: {
        message_id: 3,
        from: { id: 12345, first_name: 'Chris' },
        chat: { id: -100111, type: 'group' },
        date: Math.floor(Date.now() / 1000),
        text: 'group one',
      },
    });
    await (adapter as unknown as { processUpdate: (u: unknown) => Promise<boolean> }).processUpdate({
      update_id: 4,
      message: {
        message_id: 4,
        from: { id: 12345, first_name: 'Chris' },
        chat: { id: -100222, type: 'group' },
        date: Math.floor(Date.now() / 1000),
        text: 'group two',
      },
    });

    expect(processInboundCalls).toHaveLength(2);
    expect(processInboundCalls[0]!['channel']).toBe('telegram:group:-100111');
    expect(processInboundCalls[1]!['channel']).toBe('telegram:group:-100222');
    expect(processInboundCalls[0]!['channel']).not.toBe(processInboundCalls[1]!['channel']);
  });

  it('ownsChannel recognizes the DM channel and any of this bot\'s group channels', () => {
    expect(adapter.ownsChannel('telegram')).toBe(true);
    expect(adapter.ownsChannel('telegram:group:-100123')).toBe(true);
    expect(adapter.ownsChannel('telegram:group:-1')).toBe(true);
    expect(adapter.ownsChannel('bluebubbles')).toBe(false);
    expect(adapter.ownsChannel('telegram:peggy')).toBe(false);
  });
});

// ── TelegramAdapter inbound quoted-reply context (E28) ───────────────────────

describe('TelegramAdapter inbound quoted-reply context (E28)', () => {
  let db: Database.Database;
  let tmpDir: string;
  let adapter: TelegramAdapter;
  let processInboundCalls: Array<Record<string, unknown>>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentbus-quoted-'));
    db = new Database(':memory:');
    runMigrations(db);

    const config = makeTestConfig(tmpDir);
    processInboundCalls = [];

    const pipeline = {
      process: async (ctx: { envelope: Record<string, unknown> }) => {
        processInboundCalls.push(ctx.envelope);
        return null;
      },
    } as unknown as PipelineEngine;

    const queue = {} as unknown as MessageQueue;

    adapter = new TelegramAdapter({
      config,
      queue,
      pipeline,
      db,
      instanceConfig: { token: 'test:token', poll_timeout: 30 },
    });

    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('attaches metadata.quoted_message when reply_to_message is present', async () => {
    await (adapter as unknown as { processUpdate: (u: unknown) => Promise<boolean> }).processUpdate({
      update_id: 1,
      message: {
        message_id: 2,
        from: { id: 12345, first_name: 'Chris' },
        chat: { id: 555, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text: 'I meant this one',
        reply_to_message: {
          message_id: 1,
          from: { id: 999, first_name: 'Peggy' },
          text: 'Original message',
        },
      },
    });

    expect(processInboundCalls).toHaveLength(1);
    const metadata = processInboundCalls[0]!['metadata'] as Record<string, unknown>;
    expect(metadata['quoted_message']).toEqual({
      platform_message_id: '555:1',
      sender_name: 'Peggy',
      text: 'Original message',
    });
  });

  it('truncates quoted text to 200 chars', async () => {
    const longText = 'x'.repeat(500);
    await (adapter as unknown as { processUpdate: (u: unknown) => Promise<boolean> }).processUpdate({
      update_id: 2,
      message: {
        message_id: 3,
        from: { id: 12345, first_name: 'Chris' },
        chat: { id: 555, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text: 'reply',
        reply_to_message: { message_id: 1, from: { id: 999, first_name: 'Peggy' }, text: longText },
      },
    });

    const metadata = processInboundCalls[0]!['metadata'] as Record<string, unknown>;
    const quoted = metadata['quoted_message'] as { text: string };
    expect(quoted.text).toHaveLength(200);
  });

  it('does not set quoted_message when there is no reply_to_message', async () => {
    await (adapter as unknown as { processUpdate: (u: unknown) => Promise<boolean> }).processUpdate({
      update_id: 3,
      message: {
        message_id: 4,
        from: { id: 12345, first_name: 'Chris' },
        chat: { id: 555, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text: 'a plain message',
      },
    });

    const metadata = processInboundCalls[0]!['metadata'] as Record<string, unknown>;
    expect(metadata['quoted_message']).toBeUndefined();
  });

  it('does not affect topic/session routing', async () => {
    await (adapter as unknown as { processUpdate: (u: unknown) => Promise<boolean> }).processUpdate({
      update_id: 4,
      message: {
        message_id: 5,
        from: { id: 12345, first_name: 'Chris' },
        chat: { id: -100123, type: 'supergroup' },
        date: Math.floor(Date.now() / 1000),
        text: 'reply in group General',
        reply_to_message: { message_id: 1, from: { id: 999, first_name: 'Peggy' }, text: 'x' },
      },
    });

    expect(processInboundCalls[0]!['channel']).toBe('telegram:group:-100123');
    expect(processInboundCalls[0]!['topic']).toBe('');
    const count = db.prepare(`SELECT COUNT(*) AS n FROM threads`).get() as { n: number };
    expect(count.n).toBe(0);
  });
});

// ── TelegramAdapter forum topics on the generic thread store (E28) ──────────

describe('TelegramAdapter forum topics on the generic thread store (E28)', () => {
  let db: Database.Database;
  let tmpDir: string;
  let adapter: TelegramAdapter;
  let processInboundCalls: Array<Record<string, unknown>>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentbus-topics-'));
    db = new Database(':memory:');
    runMigrations(db);

    const config = makeTestConfig(tmpDir);
    processInboundCalls = [];

    const pipeline = {
      process: async (ctx: { envelope: Record<string, unknown> }) => {
        processInboundCalls.push(ctx.envelope);
        return null;
      },
    } as unknown as PipelineEngine;

    const queue = {} as unknown as MessageQueue;

    adapter = new TelegramAdapter({
      config,
      queue,
      pipeline,
      db,
      instanceConfig: { token: 'test:token', poll_timeout: 30 },
    });

    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('upserts a threads row keyed by the group channel for a topic message', async () => {
    await (adapter as unknown as { processUpdate: (u: unknown) => Promise<boolean> }).processUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        from: { id: 12345, first_name: 'Chris' },
        chat: { id: -100123, type: 'supergroup' },
        date: Math.floor(Date.now() / 1000),
        text: 'in a topic',
        is_topic_message: true,
        message_thread_id: 42,
      },
    });

    expect(processInboundCalls).toHaveLength(1);
    const topic = processInboundCalls[0]!['topic'] as string;
    expect(topic).toMatch(/^thread:/);

    const row = db
      .prepare(`SELECT channel, thread_key, metadata FROM threads WHERE channel = ? AND topic = ?`)
      .get('telegram:group:-100123', topic) as { channel: string; thread_key: string; metadata: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.thread_key).toBe('-100123:42');
    expect(JSON.parse(row!.metadata)).toEqual({ chatId: -100123, messageThreadId: 42 });
  });

  it('creates no thread row for a General-topic message (no message_thread_id)', async () => {
    await (adapter as unknown as { processUpdate: (u: unknown) => Promise<boolean> }).processUpdate({
      update_id: 2,
      message: {
        message_id: 2,
        from: { id: 12345, first_name: 'Chris' },
        chat: { id: -100123, type: 'supergroup' },
        date: Math.floor(Date.now() / 1000),
        text: 'general area',
      },
    });

    expect(processInboundCalls).toHaveLength(1);
    expect(processInboundCalls[0]!['topic']).toBe('');
    const count = db.prepare(`SELECT COUNT(*) AS n FROM threads`).get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('gives two different message_thread_ids in the same chat two different topics', async () => {
    await (adapter as unknown as { processUpdate: (u: unknown) => Promise<boolean> }).processUpdate({
      update_id: 3,
      message: {
        message_id: 3,
        from: { id: 12345, first_name: 'Chris' },
        chat: { id: -100123, type: 'supergroup' },
        date: Math.floor(Date.now() / 1000),
        text: 'topic A',
        is_topic_message: true,
        message_thread_id: 1,
      },
    });
    await (adapter as unknown as { processUpdate: (u: unknown) => Promise<boolean> }).processUpdate({
      update_id: 4,
      message: {
        message_id: 4,
        from: { id: 12345, first_name: 'Chris' },
        chat: { id: -100123, type: 'supergroup' },
        date: Math.floor(Date.now() / 1000),
        text: 'topic B',
        is_topic_message: true,
        message_thread_id: 2,
      },
    });

    const topicA = processInboundCalls[0]!['topic'];
    const topicB = processInboundCalls[1]!['topic'];
    expect(topicA).not.toBe(topicB);
    const count = db.prepare(`SELECT COUNT(*) AS n FROM threads`).get() as { n: number };
    expect(count.n).toBe(2);
  });
});

// ── TelegramAdapter inbound reaction handling ────────────────────────────────

describe('TelegramAdapter inbound reaction handling', () => {
  let db: Database.Database;
  let tmpDir: string;
  let adapter: TelegramAdapter;
  let processInboundCalls: Array<Record<string, unknown>>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentbus-reactions-'));
    db = new Database(':memory:');
    runMigrations(db);

    const config = makeTestConfig(tmpDir);
    processInboundCalls = [];

    const pipeline = {
      process: async (ctx: { envelope: Record<string, unknown> }) => {
        processInboundCalls.push(ctx.envelope);
        return null;
      },
    } as unknown as PipelineEngine;

    const queue = {} as unknown as MessageQueue;

    adapter = new TelegramAdapter({
      config,
      queue,
      pipeline,
      db,
      instanceConfig: { token: 'test:token', poll_timeout: 30 },
    });
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('delivers an emoji reaction addition to the pipeline', async () => {
    await (adapter as unknown as {
      processUpdate: (u: unknown) => Promise<boolean>;
    }).processUpdate({
      update_id: 10,
      message_reaction: {
        chat: { id: 555, type: 'private' },
        message_id: 42,
        user: { id: 12345, first_name: 'Chris' },
        date: Math.floor(Date.now() / 1000),
        old_reaction: [],
        new_reaction: [{ type: 'emoji', emoji: '👍' }],
      },
    });

    expect(processInboundCalls).toHaveLength(1);
    const env = processInboundCalls[0]!;
    const payload = env['payload'] as { type: string; emoji: string; removed: boolean; target_message_id: string };
    expect(payload.type).toBe('reaction');
    expect(payload.emoji).toBe('👍');
    expect(payload.removed).toBe(false);
    expect(payload.target_message_id).toBe('555:42');
    expect((env['metadata'] as Record<string, unknown>)['telegram_chat_id']).toBe(555);
  });

  it('delivers a reaction removal to the pipeline', async () => {
    await (adapter as unknown as {
      processUpdate: (u: unknown) => Promise<boolean>;
    }).processUpdate({
      update_id: 11,
      message_reaction: {
        chat: { id: 555, type: 'private' },
        message_id: 42,
        user: { id: 12345, first_name: 'Chris' },
        date: Math.floor(Date.now() / 1000),
        old_reaction: [{ type: 'emoji', emoji: '❤' }],
        new_reaction: [],
      },
    });

    expect(processInboundCalls).toHaveLength(1);
    const payload = processInboundCalls[0]!['payload'] as { emoji: string; removed: boolean };
    expect(payload.emoji).toBe('❤');
    expect(payload.removed).toBe(true);
  });

  it('picks the added emoji when user switches reaction', async () => {
    await (adapter as unknown as {
      processUpdate: (u: unknown) => Promise<boolean>;
    }).processUpdate({
      update_id: 12,
      message_reaction: {
        chat: { id: 555, type: 'private' },
        message_id: 42,
        user: { id: 12345, first_name: 'Chris' },
        date: Math.floor(Date.now() / 1000),
        old_reaction: [{ type: 'emoji', emoji: '👍' }],
        new_reaction: [{ type: 'emoji', emoji: '🔥' }],
      },
    });

    const payload = processInboundCalls[0]!['payload'] as { emoji: string; removed: boolean };
    expect(payload.emoji).toBe('🔥');
    expect(payload.removed).toBe(false);
  });

  it('skips reactions from unknown senders', async () => {
    await (adapter as unknown as {
      processUpdate: (u: unknown) => Promise<boolean>;
    }).processUpdate({
      update_id: 13,
      message_reaction: {
        chat: { id: 555, type: 'private' },
        message_id: 42,
        user: { id: 99999, first_name: 'Stranger' },
        date: Math.floor(Date.now() / 1000),
        old_reaction: [],
        new_reaction: [{ type: 'emoji', emoji: '👍' }],
      },
    });

    expect(processInboundCalls).toHaveLength(0);
  });

  it('skips anonymous reactions (no user field)', async () => {
    await (adapter as unknown as {
      processUpdate: (u: unknown) => Promise<boolean>;
    }).processUpdate({
      update_id: 14,
      message_reaction: {
        chat: { id: 555, type: 'private' },
        message_id: 42,
        date: Math.floor(Date.now() / 1000),
        old_reaction: [],
        new_reaction: [{ type: 'emoji', emoji: '👍' }],
      },
    });

    expect(processInboundCalls).toHaveLength(0);
  });

  it('skips custom-emoji-only reaction changes', async () => {
    await (adapter as unknown as {
      processUpdate: (u: unknown) => Promise<boolean>;
    }).processUpdate({
      update_id: 15,
      message_reaction: {
        chat: { id: 555, type: 'private' },
        message_id: 42,
        user: { id: 12345, first_name: 'Chris' },
        date: Math.floor(Date.now() / 1000),
        old_reaction: [],
        new_reaction: [{ type: 'custom_emoji', custom_emoji_id: 'abc123' }],
      },
    });

    expect(processInboundCalls).toHaveLength(0);
  });
});

// ── TelegramAdapter outbound send() (E29 baseline regression) ───────────────

function makeTextEnvelope(body: string, overrides: Partial<MessageEnvelope> = {}): MessageEnvelope {
  return {
    id: 'env-1',
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

/** Fetch mock for the Telegram Bot API: succeeds for sendMessage/editMessageText
 * with an incrementing message_id, unless a call is queued via `queueFailure`. */
function makeTelegramFetchMock() {
  let nextMessageId = 100;
  const failures = new Map<string, { status: number; description: string }>();

  const fn = vi.fn(async (url: string, init?: { body?: string }) => {
    const method = url.split('/').pop() ?? '';
    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const key = method === 'sendMessage' || method === 'editMessageText'
      ? `${method}:${'parse_mode' in body ? 'markdown' : 'plain'}`
      : method;

    const failure = failures.get(key) ?? failures.get(method);
    if (failure) {
      return {
        ok: false,
        status: failure.status,
        json: async () => ({ ok: false, description: failure.description }),
      } as unknown as Response;
    }

    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        result: { message_id: nextMessageId++, chat: { id: 555, type: 'private' }, date: 0 },
      }),
    } as unknown as Response;
  });

  return {
    fn,
    /** Fail every call to `method` (optionally scoped to markdown vs. plain-text retry). */
    queueFailure(method: string, status: number, description = 'boom') {
      failures.set(method, { status, description });
    },
  };
}

function getDraftState(adapter: TelegramAdapter, chatId: number, messageThreadId?: number) {
  return (
    adapter as unknown as {
      draftMessages: Map<string, { messageId: number | null; lines: string[]; creating: Promise<void> | null }>;
    }
  ).draftMessages.get(`${chatId}:${messageThreadId ?? 'general'}`);
}

function isTypingLoopActive(adapter: TelegramAdapter, chatId: number, messageThreadId?: number): boolean {
  return (adapter as unknown as { typingLoops: Map<string, unknown> }).typingLoops.has(
    `${chatId}:${messageThreadId ?? 'general'}`,
  );
}

function callsTo(fetchMock: ReturnType<typeof vi.fn>, method: string): unknown[] {
  return fetchMock.mock.calls.filter((c) => String(c[0]).endsWith(`/${method}`));
}

describe('TelegramAdapter send() (outbound, baseline regression)', () => {
  let adapter: TelegramAdapter;
  let telegramFetch: ReturnType<typeof makeTelegramFetchMock>;

  beforeEach(() => {
    const config = makeTestConfig('/tmp/unused-e29-outbound');
    adapter = new TelegramAdapter({
      config,
      queue: {} as unknown as MessageQueue,
      pipeline: {} as unknown as PipelineEngine,
      db: {} as unknown as Database.Database,
      instanceConfig: { token: 'test:token', poll_timeout: 30 },
    });
    telegramFetch = makeTelegramFetchMock();
    vi.stubGlobal('fetch', telegramFetch.fn);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends a single short message via sendMessage', async () => {
    const result = await adapter.send(makeTextEnvelope('hello'));
    expect(result.success).toBe(true);
    expect(callsTo(telegramFetch.fn, 'sendMessage')).toHaveLength(1);
    expect(callsTo(telegramFetch.fn, 'editMessageText')).toHaveLength(0);
  });

  it('splits a long message into multiple sendMessage calls', async () => {
    const body = Array.from({ length: 10 }, (_, i) => `line ${i}`.repeat(500)).join('\n');
    const result = await adapter.send(makeTextEnvelope(body));
    expect(result.success).toBe(true);
    expect(callsTo(telegramFetch.fn, 'sendMessage').length).toBeGreaterThan(1);
  });

  it('retries without parse_mode when Telegram rejects Markdown with HTTP 400', async () => {
    telegramFetch.queueFailure('sendMessage:markdown', 400, 'Bad Request: can\'t parse entities');
    const result = await adapter.send(makeTextEnvelope('some *bad markdown'));
    expect(result.success).toBe(true);
    expect(callsTo(telegramFetch.fn, 'sendMessage')).toHaveLength(2);
  });

  it('fails with a non-retryable error for an unknown contact', async () => {
    const result = await adapter.send(makeTextEnvelope('hi', { recipient: 'contact:nobody' }));
    expect(result.success).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.error).toContain('No Telegram chat_id');
  });

  it('fails with a non-retryable error for a non-text payload', async () => {
    const result = await adapter.send(
      makeTextEnvelope('unused', {
        payload: { type: 'reaction', emoji: '👍', removed: false, target_message_id: '555:1' },
      }),
    );
    expect(result.success).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.error).toContain('Unsupported payload type');
  });
});

// ── TelegramAdapter send() group/topic resolution (E28) ──────────────────────

describe('TelegramAdapter send() group/topic resolution (E28)', () => {
  let db: Database.Database;
  let adapter: TelegramAdapter;
  let telegramFetch: ReturnType<typeof makeTelegramFetchMock>;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    const config = makeTestConfig('/tmp/unused-e28-outbound');
    adapter = new TelegramAdapter({
      config,
      queue: {} as unknown as MessageQueue,
      pipeline: {} as unknown as PipelineEngine,
      db,
      instanceConfig: { token: 'test:token', poll_timeout: 30 },
    });
    telegramFetch = makeTelegramFetchMock();
    vi.stubGlobal('fetch', telegramFetch.fn);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    db.close();
  });

  function lastSendMessageBody(): Record<string, unknown> {
    const calls = callsTo(telegramFetch.fn, 'sendMessage') as Array<[string, { body: string }]>;
    return JSON.parse(calls[calls.length - 1]![1].body) as Record<string, unknown>;
  }

  it('sends to a group\'s General area (no thread topic) using the channel\'s own chat_id', async () => {
    const result = await adapter.send(
      makeTextEnvelope('hi group', { channel: 'telegram:group:-100123', topic: 'general', recipient: 'contact:chris' }),
    );
    expect(result.success).toBe(true);
    const body = lastSendMessageBody();
    expect(body['chat_id']).toBe(-100123);
    expect(body['message_thread_id']).toBeUndefined();
  });

  it('sends into a forum topic using thread metadata from the generic thread store (E27)', async () => {
    const threadKey = '-100123:42';
    const topic = topicForThreadKey(threadKey);
    upsertThread(db, {
      channel: 'telegram:group:-100123',
      topic,
      threadKey,
      metadata: { chatId: -100123, messageThreadId: 42 },
    });

    const result = await adapter.send(
      makeTextEnvelope('hi topic', { channel: 'telegram:group:-100123', topic, recipient: 'contact:chris' }),
    );
    expect(result.success).toBe(true);
    const body = lastSendMessageBody();
    expect(body['chat_id']).toBe(-100123);
    expect(body['message_thread_id']).toBe(42);
  });

  it('fails with a non-retryable error for a thread topic with no stored metadata', async () => {
    const result = await adapter.send(
      makeTextEnvelope('hi', { channel: 'telegram:group:-100123', topic: 'thread:doesnotexist', recipient: 'contact:chris' }),
    );
    expect(result.success).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.error).toContain('No thread metadata');
  });

  it('a two-topic group conversation round-trips independently', async () => {
    const keyA = '-100123:1';
    const keyB = '-100123:2';
    const topicA = topicForThreadKey(keyA);
    const topicB = topicForThreadKey(keyB);
    upsertThread(db, { channel: 'telegram:group:-100123', topic: topicA, threadKey: keyA, metadata: { chatId: -100123, messageThreadId: 1 } });
    upsertThread(db, { channel: 'telegram:group:-100123', topic: topicB, threadKey: keyB, metadata: { chatId: -100123, messageThreadId: 2 } });

    await adapter.send(makeTextEnvelope('to A', { channel: 'telegram:group:-100123', topic: topicA, recipient: 'contact:chris' }));
    const bodyA = lastSendMessageBody();
    await adapter.send(makeTextEnvelope('to B', { channel: 'telegram:group:-100123', topic: topicB, recipient: 'contact:chris' }));
    const bodyB = lastSendMessageBody();

    expect(bodyA['message_thread_id']).toBe(1);
    expect(bodyB['message_thread_id']).toBe(2);
  });

  it('a DM send for the same contact never resolves to a group chat_id', async () => {
    // A group row exists in `threads`, but a plain DM envelope (channel: 'telegram') must
    // still resolve via contactChatIdMap, never accidentally picking up group state.
    upsertThread(db, {
      channel: 'telegram:group:-100123',
      topic: 'thread:abc',
      threadKey: '-100123:1',
      metadata: { chatId: -100123, messageThreadId: 1 },
    });

    const result = await adapter.send(makeTextEnvelope('dm hello', { channel: 'telegram', topic: 'general', recipient: 'contact:chris' }));
    expect(result.success).toBe(true);
    const body = lastSendMessageBody();
    expect(body['chat_id']).toBe(12345); // chris's DM chat_id from makeTestConfig
  });

  it('includes reply_parameters when reply_to_platform_message_id matches the resolved chat', async () => {
    const result = await adapter.send(
      makeTextEnvelope('a reply', {
        channel: 'telegram',
        topic: 'general',
        recipient: 'contact:chris',
        metadata: { reply_to_platform_message_id: '12345:99' },
      }),
    );
    expect(result.success).toBe(true);
    const body = lastSendMessageBody();
    expect(body['reply_parameters']).toEqual({ message_id: 99, allow_sending_without_reply: true });
  });

  it('drops reply_parameters when the platform message id is for a different chat', async () => {
    const result = await adapter.send(
      makeTextEnvelope('a reply', {
        channel: 'telegram',
        topic: 'general',
        recipient: 'contact:chris',
        metadata: { reply_to_platform_message_id: '999:99' }, // foreign chat_id
      }),
    );
    expect(result.success).toBe(true);
    const body = lastSendMessageBody();
    expect(body['reply_parameters']).toBeUndefined();
  });

  it('is a no-op when reply_to_platform_message_id is malformed', async () => {
    const result = await adapter.send(
      makeTextEnvelope('a reply', {
        channel: 'telegram',
        topic: 'general',
        recipient: 'contact:chris',
        metadata: { reply_to_platform_message_id: 'not-a-valid-id' },
      }),
    );
    expect(result.success).toBe(true);
    const body = lastSendMessageBody();
    expect(body['reply_parameters']).toBeUndefined();
  });

  it('only applies reply_parameters to the first part of a multi-part reply', async () => {
    const longBody = Array.from({ length: 10 }, (_, i) => `line ${i}`.repeat(500)).join('\n');
    await adapter.send(
      makeTextEnvelope(longBody, {
        channel: 'telegram',
        topic: 'general',
        recipient: 'contact:chris',
        metadata: { reply_to_platform_message_id: '12345:99' },
      }),
    );
    const calls = callsTo(telegramFetch.fn, 'sendMessage') as Array<[string, { body: string }]>;
    expect(calls.length).toBeGreaterThan(1);
    const firstBody = JSON.parse(calls[0]![1].body) as Record<string, unknown>;
    const secondBody = JSON.parse(calls[1]![1].body) as Record<string, unknown>;
    expect(firstBody['reply_parameters']).toEqual({ message_id: 99, allow_sending_without_reply: true });
    expect(secondBody['reply_parameters']).toBeUndefined();
  });
});

describe('TelegramAdapter channel-aware typing/tool-status/finalizeDraft (E28)', () => {
  let adapter: TelegramAdapter;
  let telegramFetch: ReturnType<typeof makeTelegramFetchMock>;

  beforeEach(() => {
    const config = makeTestConfig('/tmp/unused-e28-status');
    adapter = new TelegramAdapter({
      config,
      queue: {} as unknown as MessageQueue,
      pipeline: {} as unknown as PipelineEngine,
      db: {} as unknown as Database.Database,
      instanceConfig: { token: 'test:token', poll_timeout: 30 },
    });
    telegramFetch = makeTelegramFetchMock();
    vi.stubGlobal('fetch', telegramFetch.fn);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('startTyping targets the group chat, not the sender\'s DM, when a channel is given', () => {
    adapter.startTyping!('contact:chris', 'telegram:group:-100123');
    const calls = callsTo(telegramFetch.fn, 'sendChatAction') as Array<[string, { body: string }]>;
    expect(calls.length).toBeGreaterThan(0);
    const body = JSON.parse(calls[0]![1].body) as Record<string, unknown>;
    expect(body['chat_id']).toBe(-100123);
  });

  it('startTyping without a channel keeps targeting the contact\'s DM (unchanged)', () => {
    adapter.startTyping!('contact:chris');
    const calls = callsTo(telegramFetch.fn, 'sendChatAction') as Array<[string, { body: string }]>;
    const body = JSON.parse(calls[0]![1].body) as Record<string, unknown>;
    expect(body['chat_id']).toBe(12345);
  });

  it('reportToolCall creates its draft message in the group chat when a channel is given', async () => {
    adapter.reportToolCall!('contact:chris', 'Bash: ls', 'telegram:group:-100123');
    const state = getDraftState(adapter, -100123);
    expect(state).toBeDefined();
    if (state?.creating) await state.creating.catch(() => {});
    const calls = callsTo(telegramFetch.fn, 'sendMessage');
    expect(calls).toHaveLength(1);
  });
});

describe('TelegramAdapter topic-aware typing/tool-status/finalizeDraft (E28)', () => {
  let db: Database.Database;
  let adapter: TelegramAdapter;
  let telegramFetch: ReturnType<typeof makeTelegramFetchMock>;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    const config = makeTestConfig('/tmp/unused-e28-topic-status');
    adapter = new TelegramAdapter({
      config,
      queue: {} as unknown as MessageQueue,
      pipeline: {} as unknown as PipelineEngine,
      db,
      instanceConfig: { token: 'test:token', poll_timeout: 30 },
    });
    telegramFetch = makeTelegramFetchMock();
    vi.stubGlobal('fetch', telegramFetch.fn);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    db.close();
  });

  it('startTyping targets the specific forum topic when topic is a thread:<hash>', () => {
    const threadKey = '-100123:42';
    const topic = topicForThreadKey(threadKey);
    upsertThread(db, {
      channel: 'telegram:group:-100123',
      topic,
      threadKey,
      metadata: { chatId: -100123, messageThreadId: 42 },
    });

    adapter.startTyping!('contact:chris', 'telegram:group:-100123', topic);
    const calls = callsTo(telegramFetch.fn, 'sendChatAction') as Array<[string, { body: string }]>;
    const body = JSON.parse(calls[0]![1].body) as Record<string, unknown>;
    expect(body['chat_id']).toBe(-100123);
    expect(body['message_thread_id']).toBe(42);
  });

  it('startTyping targets General (no message_thread_id) when the topic is not thread-prefixed', () => {
    adapter.startTyping!('contact:chris', 'telegram:group:-100123', 'general');
    const calls = callsTo(telegramFetch.fn, 'sendChatAction') as Array<[string, { body: string }]>;
    const body = JSON.parse(calls[0]![1].body) as Record<string, unknown>;
    expect(body['chat_id']).toBe(-100123);
    expect(body['message_thread_id']).toBeUndefined();
  });

  it('reportToolCall posts the draft into the specific topic', async () => {
    const threadKey = '-100123:42';
    const topic = topicForThreadKey(threadKey);
    upsertThread(db, {
      channel: 'telegram:group:-100123',
      topic,
      threadKey,
      metadata: { chatId: -100123, messageThreadId: 42 },
    });

    adapter.reportToolCall!('contact:chris', 'Bash: ls', 'telegram:group:-100123', topic);
    const state = getDraftState(adapter, -100123, 42);
    expect(state).toBeDefined();
    if (state?.creating) await state.creating.catch(() => {});
    const calls = callsTo(telegramFetch.fn, 'sendMessage') as Array<[string, { body: string }]>;
    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0]![1].body) as Record<string, unknown>;
    expect(body['message_thread_id']).toBe(42);
  });

  it('two different topics in the same group get independent drafts, never colliding', async () => {
    const keyA = '-100123:1';
    const keyB = '-100123:2';
    const topicA = topicForThreadKey(keyA);
    const topicB = topicForThreadKey(keyB);
    upsertThread(db, { channel: 'telegram:group:-100123', topic: topicA, threadKey: keyA, metadata: { chatId: -100123, messageThreadId: 1 } });
    upsertThread(db, { channel: 'telegram:group:-100123', topic: topicB, threadKey: keyB, metadata: { chatId: -100123, messageThreadId: 2 } });

    adapter.reportToolCall!('contact:chris', 'line A', 'telegram:group:-100123', topicA);
    adapter.reportToolCall!('contact:chris', 'line B', 'telegram:group:-100123', topicB);

    const stateA = getDraftState(adapter, -100123, 1);
    const stateB = getDraftState(adapter, -100123, 2);
    expect(stateA).toBeDefined();
    expect(stateB).toBeDefined();
    expect(stateA).not.toBe(stateB);
    if (stateA?.creating) await stateA.creating.catch(() => {});
    if (stateB?.creating) await stateB.creating.catch(() => {});
    expect(callsTo(telegramFetch.fn, 'sendMessage')).toHaveLength(2);
  });

  it("finalizeDraft targets the specific topic's draft", async () => {
    const threadKey = '-100123:42';
    const topic = topicForThreadKey(threadKey);
    upsertThread(db, {
      channel: 'telegram:group:-100123',
      topic,
      threadKey,
      metadata: { chatId: -100123, messageThreadId: 42 },
    });

    adapter.reportToolCall!('contact:chris', 'Bash: ls', 'telegram:group:-100123', topic);
    await getDraftState(adapter, -100123, 42)?.creating;

    const finalized = adapter.finalizeDraft!('contact:chris', 'Stopped by user', 'telegram:group:-100123', topic);
    expect(finalized).toBe(true);
    expect(getDraftState(adapter, -100123, 42)).toBeUndefined();
  });
});

// ── TelegramAdapter createTopic (E28) ────────────────────────────────────────

function setBotUserId(adapter: TelegramAdapter, id: number | null) {
  (adapter as unknown as { botUserId: number | null }).botUserId = id;
}

/** Fetch mock for getChatMember/createForumTopic, used by createTopic tests. */
function makeCreateTopicFetchMock(opts: {
  canManageTopics?: boolean;
  getChatMemberFails?: boolean;
  createForumTopicFails?: boolean;
  createForumTopicResult?: { message_thread_id: number; name: string };
}) {
  return vi.fn(async (url: string) => {
    const method = url.split('/').pop() ?? '';
    if (method === 'getChatMember') {
      if (opts.getChatMemberFails) {
        return { ok: false, status: 500, json: async () => ({ ok: false, description: 'boom' }) } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { status: 'administrator', can_manage_topics: opts.canManageTopics ?? true } }),
      } as unknown as Response;
    }
    if (method === 'createForumTopic') {
      if (opts.createForumTopicFails) {
        return { ok: false, status: 500, json: async () => ({ ok: false, description: 'boom' }) } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: opts.createForumTopicResult ?? { message_thread_id: 42, name: 'Test topic' } }),
      } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) } as unknown as Response;
  });
}

describe('TelegramAdapter createTopic (E28)', () => {
  let db: Database.Database;
  let adapter: TelegramAdapter;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    const config = makeTestConfig('/tmp/unused-e28-createtopic');
    adapter = new TelegramAdapter({
      config,
      queue: {} as unknown as MessageQueue,
      pipeline: {} as unknown as PipelineEngine,
      db,
      instanceConfig: { token: 'test:token', poll_timeout: 30 },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    db.close();
  });

  it('rejects a DM channel outright', async () => {
    setBotUserId(adapter, 999);
    const result = await adapter.createTopic('telegram', 'x');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('group-only');
  });

  it('fails closed with a clear error when the bot\'s own user id is unknown', async () => {
    setBotUserId(adapter, null);
    const result = await adapter.createTopic('telegram:group:-100123', 'x');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('own Telegram user id');
  });

  it('fails with a clear, actionable error when the bot lacks Manage Topics', async () => {
    setBotUserId(adapter, 999);
    vi.stubGlobal('fetch', makeCreateTopicFetchMock({ canManageTopics: false }));

    const result = await adapter.createTopic('telegram:group:-100123', 'x');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Manage Topics');
      expect(result.error).toContain('Edit Admin Rights');
    }
  });

  it('creates the topic and upserts a threads row on success', async () => {
    setBotUserId(adapter, 999);
    vi.stubGlobal(
      'fetch',
      makeCreateTopicFetchMock({ canManageTopics: true, createForumTopicResult: { message_thread_id: 42, name: 'Wanda prep' } }),
    );

    const result = await adapter.createTopic('telegram:group:-100123', 'Wanda prep');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.message_thread_id).toBe(42);
      expect(result.name).toBe('Wanda prep');
      expect(result.topic).toMatch(/^thread:/);

      const row = db
        .prepare(`SELECT thread_key, metadata FROM threads WHERE channel = ? AND topic = ?`)
        .get('telegram:group:-100123', result.topic) as { thread_key: string; metadata: string } | undefined;
      expect(row).toBeDefined();
      expect(row!.thread_key).toBe('-100123:42');
      expect(JSON.parse(row!.metadata)).toEqual({ chatId: -100123, messageThreadId: 42 });
    }
  });

  it('surfaces a clear error when createForumTopic itself fails', async () => {
    setBotUserId(adapter, 999);
    vi.stubGlobal('fetch', makeCreateTopicFetchMock({ canManageTopics: true, createForumTopicFails: true }));

    const result = await adapter.createTopic('telegram:group:-100123', 'x');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Failed to create forum topic');
  });

  it('stores an optional context as pendingContext on the thread row', async () => {
    setBotUserId(adapter, 999);
    vi.stubGlobal(
      'fetch',
      makeCreateTopicFetchMock({ canManageTopics: true, createForumTopicResult: { message_thread_id: 42, name: 'Wanda prep' } }),
    );

    const result = await adapter.createTopic('telegram:group:-100123', 'Wanda prep', 'Track Wanda birthday planning here');
    expect(result.ok).toBe(true);
    if (result.ok) {
      const row = db
        .prepare(`SELECT metadata FROM threads WHERE channel = ? AND topic = ?`)
        .get('telegram:group:-100123', result.topic) as { metadata: string };
      expect(JSON.parse(row.metadata)).toEqual({
        chatId: -100123,
        messageThreadId: 42,
        pendingContext: 'Track Wanda birthday planning here',
      });
    }
  });

  it('omits pendingContext entirely when no context is given', async () => {
    setBotUserId(adapter, 999);
    vi.stubGlobal(
      'fetch',
      makeCreateTopicFetchMock({ canManageTopics: true, createForumTopicResult: { message_thread_id: 42, name: 'x' } }),
    );

    const result = await adapter.createTopic('telegram:group:-100123', 'x');
    expect(result.ok).toBe(true);
    if (result.ok) {
      const row = db
        .prepare(`SELECT metadata FROM threads WHERE channel = ? AND topic = ?`)
        .get('telegram:group:-100123', result.topic) as { metadata: string };
      expect(JSON.parse(row.metadata)).not.toHaveProperty('pendingContext');
    }
  });
});

// ── TelegramAdapter create_telegram_topic context injection (E28) ───────────

describe('TelegramAdapter create_telegram_topic context injection (E28)', () => {
  let db: Database.Database;
  let tmpDir: string;
  let adapter: TelegramAdapter;
  let processInboundCalls: Array<Record<string, unknown>>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentbus-topic-context-'));
    db = new Database(':memory:');
    runMigrations(db);

    const config = makeTestConfig(tmpDir);
    processInboundCalls = [];

    const pipeline = {
      process: async (ctx: { envelope: Record<string, unknown> }) => {
        processInboundCalls.push(ctx.envelope);
        return null;
      },
    } as unknown as PipelineEngine;

    const queue = {} as unknown as MessageQueue;

    adapter = new TelegramAdapter({
      config,
      queue,
      pipeline,
      db,
      instanceConfig: { token: 'test:token', poll_timeout: 30 },
    });

    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('injects pendingContext into the first message that lands on the topic, then clears it', async () => {
    const threadKey = '-100123:42';
    const topic = topicForThreadKey(threadKey);
    upsertThread(db, {
      channel: 'telegram:group:-100123',
      topic,
      threadKey,
      metadata: { chatId: -100123, messageThreadId: 42, pendingContext: 'Track Wanda birthday planning here' },
    });

    await (adapter as unknown as { processUpdate: (u: unknown) => Promise<boolean> }).processUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        from: { id: 12345, first_name: 'Chris' },
        chat: { id: -100123, type: 'supergroup' },
        date: Math.floor(Date.now() / 1000),
        text: 'first message in the new topic',
        is_topic_message: true,
        message_thread_id: 42,
      },
    });

    expect(processInboundCalls).toHaveLength(1);
    const metadata = processInboundCalls[0]!['metadata'] as Record<string, unknown>;
    expect(metadata['injected_topic_context']).toBe('Track Wanda birthday planning here');

    // One-shot: cleared from the thread row after the first delivery.
    const row = db.prepare(`SELECT metadata FROM threads WHERE channel = ? AND topic = ?`).get(
      'telegram:group:-100123',
      topic,
    ) as { metadata: string };
    expect(JSON.parse(row.metadata)).not.toHaveProperty('pendingContext');

    // A second message on the same topic never sees it again.
    await (adapter as unknown as { processUpdate: (u: unknown) => Promise<boolean> }).processUpdate({
      update_id: 2,
      message: {
        message_id: 2,
        from: { id: 12345, first_name: 'Chris' },
        chat: { id: -100123, type: 'supergroup' },
        date: Math.floor(Date.now() / 1000),
        text: 'second message',
        is_topic_message: true,
        message_thread_id: 42,
      },
    });
    const secondMetadata = processInboundCalls[1]!['metadata'] as Record<string, unknown>;
    expect(secondMetadata['injected_topic_context']).toBeUndefined();
  });

  it('does not set injected_topic_context when the thread has none', async () => {
    const threadKey = '-100123:42';
    const topic = topicForThreadKey(threadKey);
    upsertThread(db, {
      channel: 'telegram:group:-100123',
      topic,
      threadKey,
      metadata: { chatId: -100123, messageThreadId: 42 },
    });

    await (adapter as unknown as { processUpdate: (u: unknown) => Promise<boolean> }).processUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        from: { id: 12345, first_name: 'Chris' },
        chat: { id: -100123, type: 'supergroup' },
        date: Math.floor(Date.now() / 1000),
        text: 'hello',
        is_topic_message: true,
        message_thread_id: 42,
      },
    });

    const metadata = processInboundCalls[0]!['metadata'] as Record<string, unknown>;
    expect(metadata['injected_topic_context']).toBeUndefined();
  });

  it('does not consume pendingContext on a skipped update (no text/attachment)', async () => {
    const threadKey = '-100123:42';
    const topic = topicForThreadKey(threadKey);
    upsertThread(db, {
      channel: 'telegram:group:-100123',
      topic,
      threadKey,
      metadata: { chatId: -100123, messageThreadId: 42, pendingContext: 'seed context' },
    });

    // A sticker/no-text update in the topic — skipped before ever reaching processInbound.
    await (adapter as unknown as { processUpdate: (u: unknown) => Promise<boolean> }).processUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        from: { id: 12345, first_name: 'Chris' },
        chat: { id: -100123, type: 'supergroup' },
        date: Math.floor(Date.now() / 1000),
        is_topic_message: true,
        message_thread_id: 42,
      },
    });
    expect(processInboundCalls).toHaveLength(0);

    const rowAfterSkip = db
      .prepare(`SELECT metadata FROM threads WHERE channel = ? AND topic = ?`)
      .get('telegram:group:-100123', topic) as { metadata: string };
    expect(JSON.parse(rowAfterSkip.metadata)).toHaveProperty('pendingContext', 'seed context');

    // The real first message still gets it.
    await (adapter as unknown as { processUpdate: (u: unknown) => Promise<boolean> }).processUpdate({
      update_id: 2,
      message: {
        message_id: 2,
        from: { id: 12345, first_name: 'Chris' },
        chat: { id: -100123, type: 'supergroup' },
        date: Math.floor(Date.now() / 1000),
        text: 'actual first message',
        is_topic_message: true,
        message_thread_id: 42,
      },
    });
    expect(processInboundCalls).toHaveLength(1);
    const metadata = processInboundCalls[0]!['metadata'] as Record<string, unknown>;
    expect(metadata['injected_topic_context']).toBe('seed context');
  });
});

// ── buildDraftTrail (E29 length cap / truncation) ────────────────────────────

describe('buildDraftTrail', () => {
  it('returns an empty, non-truncated trail for no lines', () => {
    expect(buildDraftTrail([])).toEqual({ text: '', truncated: false });
  });

  it('joins lines as-is when they fit under the budget', () => {
    const { text, truncated } = buildDraftTrail(['🐚 one', '📖 two', '✏️ three'], 1000);
    expect(text).toBe('🐚 one\n📖 two\n✏️ three');
    expect(truncated).toBe(false);
  });

  it('drops oldest whole lines and prefixes a notice when the trail exceeds the budget', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
    const { text, truncated } = buildDraftTrail(lines, 100);
    expect(truncated).toBe(true);
    expect(text.startsWith('… (earlier steps omitted)')).toBe(true);
    expect(text.length).toBeLessThanOrEqual(100);
    // Never cuts mid-line — every remaining line is intact
    const kept = text.split('\n').slice(1);
    for (const line of kept) {
      expect(lines).toContain(line);
    }
    // The most recent line must always survive truncation
    expect(text).toContain('line 49');
  });
});

// ── TelegramAdapter draft-message lifecycle (E29) ────────────────────────────

describe('TelegramAdapter draft-message lifecycle (E29)', () => {
  let adapter: TelegramAdapter;
  let telegramFetch: ReturnType<typeof makeTelegramFetchMock>;

  beforeEach(() => {
    vi.useFakeTimers();
    const config = makeTestConfig('/tmp/unused-e29-draft');
    adapter = new TelegramAdapter({
      config,
      queue: {} as unknown as MessageQueue,
      pipeline: {} as unknown as PipelineEngine,
      db: {} as unknown as Database.Database,
      instanceConfig: { token: 'test:token', poll_timeout: 30 },
    });
    telegramFetch = makeTelegramFetchMock();
    vi.stubGlobal('fetch', telegramFetch.fn);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('a single tool call sends one message and issues no edits', async () => {
    adapter.reportToolCall('chris', 'first line');
    await getDraftState(adapter, 12345)?.creating;

    expect(callsTo(telegramFetch.fn, 'sendMessage')).toHaveLength(1);
    expect(callsTo(telegramFetch.fn, 'editMessageText')).toHaveLength(0);
  });

  it('batches lines arriving within one window into a single edit', async () => {
    adapter.reportToolCall('chris', 'line1');
    await getDraftState(adapter, 12345)?.creating;

    adapter.reportToolCall('chris', 'line2');
    adapter.reportToolCall('chris', 'line3');
    await vi.advanceTimersByTimeAsync(1000);

    expect(callsTo(telegramFetch.fn, 'sendMessage')).toHaveLength(1);
    expect(callsTo(telegramFetch.fn, 'editMessageText')).toHaveLength(1);
    const [, init] = callsTo(telegramFetch.fn, 'editMessageText')[0] as [string, { body: string }];
    const editedText = (JSON.parse(init.body) as { text: string }).text;
    expect(editedText).toContain('line1');
    expect(editedText).toContain('line2');
    expect(editedText).toContain('line3');
  });

  it('three calls spread across three windows issue one send and two edits', async () => {
    adapter.reportToolCall('chris', 'line1');
    await getDraftState(adapter, 12345)?.creating;

    adapter.reportToolCall('chris', 'line2');
    await vi.advanceTimersByTimeAsync(1000);

    adapter.reportToolCall('chris', 'line3');
    await vi.advanceTimersByTimeAsync(1000);

    expect(callsTo(telegramFetch.fn, 'sendMessage')).toHaveLength(1);
    expect(callsTo(telegramFetch.fn, 'editMessageText')).toHaveLength(2);
  });

  it('two tool calls arriving before the first sendMessage resolves create only one draft', () => {
    let resolveSend!: () => void;
    telegramFetch.fn.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSend = () =>
            resolve({
              ok: true,
              status: 200,
              json: async () => ({ ok: true, result: { message_id: 999, chat: { id: 12345, type: 'private' }, date: 0 } }),
            } as unknown as Response);
        }),
    );

    adapter.reportToolCall('chris', 'line1');
    adapter.reportToolCall('chris', 'line2'); // arrives before the mocked sendMessage settles

    expect(telegramFetch.fn).toHaveBeenCalledTimes(1);
    resolveSend();
  });

  it('overwrites the draft with the final answer and clears it', async () => {
    adapter.reportToolCall('chris', 'first line');
    const draft = getDraftState(adapter, 12345);
    await draft?.creating;
    const draftMessageId = draft?.messageId;

    const result = await adapter.send(makeTextEnvelope('the final answer'));

    expect(result.success).toBe(true);
    expect(callsTo(telegramFetch.fn, 'sendMessage')).toHaveLength(1); // only the draft's original send
    expect(callsTo(telegramFetch.fn, 'editMessageText')).toHaveLength(1);
    const [, init] = callsTo(telegramFetch.fn, 'editMessageText')[0] as [string, { body: string }];
    const body = JSON.parse(init.body) as { message_id: number; text: string };
    expect(body.message_id).toBe(draftMessageId);
    expect(body.text).toBe('the final answer');
    expect(getDraftState(adapter, 12345)).toBeUndefined();

    // A subsequent tool call starts a brand-new draft, proving no stale state leaked.
    adapter.reportToolCall('chris', 'next turn line');
    await getDraftState(adapter, 12345)?.creating;
    expect(callsTo(telegramFetch.fn, 'sendMessage')).toHaveLength(2);
  });

  it('send() behaves exactly as today when no draft exists', async () => {
    const result = await adapter.send(makeTextEnvelope('no tool calls happened'));
    expect(result.success).toBe(true);
    expect(callsTo(telegramFetch.fn, 'sendMessage')).toHaveLength(1);
    expect(callsTo(telegramFetch.fn, 'editMessageText')).toHaveLength(0);
  });

  it('falls back to sendMessage when the draft overwrite edit fails', async () => {
    adapter.reportToolCall('chris', 'first line');
    await getDraftState(adapter, 12345)?.creating;

    // A non-400 failure isn't retried without parse_mode — it's thrown straight
    // through deliverText, so send() falls back to a fresh sendMessage.
    telegramFetch.queueFailure('editMessageText:markdown', 500, 'internal error');

    const result = await adapter.send(makeTextEnvelope('the final answer'));

    expect(result.success).toBe(true);
    expect(callsTo(telegramFetch.fn, 'editMessageText')).toHaveLength(1);
    expect(callsTo(telegramFetch.fn, 'sendMessage')).toHaveLength(2); // draft creation + fallback send
    expect(getDraftState(adapter, 12345)).toBeUndefined();
  });
});

// ── TelegramAdapter finalizeDraft (/stop) ────────────────────────────────────

describe('TelegramAdapter finalizeDraft (/stop)', () => {
  let adapter: TelegramAdapter;
  let telegramFetch: ReturnType<typeof makeTelegramFetchMock>;

  beforeEach(() => {
    vi.useFakeTimers();
    const config = makeTestConfig('/tmp/unused-e29-stop');
    adapter = new TelegramAdapter({
      config,
      queue: {} as unknown as MessageQueue,
      pipeline: {} as unknown as PipelineEngine,
      db: {} as unknown as Database.Database,
      instanceConfig: { token: 'test:token', poll_timeout: 30 },
    });
    telegramFetch = makeTelegramFetchMock();
    vi.stubGlobal('fetch', telegramFetch.fn);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('appends the note and edits the open draft with it', async () => {
    adapter.reportToolCall('chris', 'first line');
    await getDraftState(adapter, 12345)?.creating;
    const draftMessageId = getDraftState(adapter, 12345)?.messageId;

    expect(adapter.finalizeDraft('chris', 'Stopped by user')).toBe(true);
    await vi.advanceTimersByTimeAsync(0); // flush finalizeDraft's internal edit call

    const [, init] = callsTo(telegramFetch.fn, 'editMessageText')[0] as [string, { body: string }];
    const body = JSON.parse(init.body) as { message_id: number; text: string };
    expect(body.message_id).toBe(draftMessageId);
    expect(body.text).toContain('first line');
    expect(body.text).toContain('Stopped by user');
  });

  it('clears the draft so a later tool call starts fresh, not a new edit', async () => {
    adapter.reportToolCall('chris', 'first line');
    await getDraftState(adapter, 12345)?.creating;

    adapter.finalizeDraft('chris', 'Stopped by user');
    await vi.advanceTimersByTimeAsync(0); // flush finalizeDraft's internal edit call
    expect(getDraftState(adapter, 12345)).toBeUndefined();

    adapter.reportToolCall('chris', 'a new turn begins');
    await getDraftState(adapter, 12345)?.creating;
    expect(callsTo(telegramFetch.fn, 'sendMessage')).toHaveLength(2); // original draft + this fresh one
    expect(callsTo(telegramFetch.fn, 'editMessageText')).toHaveLength(1); // unchanged — no stray edit from the old draft
  });

  it('cancels a pending batch timer so it never fires after finalize', async () => {
    adapter.reportToolCall('chris', 'first line');
    await getDraftState(adapter, 12345)?.creating;
    adapter.reportToolCall('chris', 'second line'); // arms the batch timer

    adapter.finalizeDraft('chris', 'Stopped by user');
    await vi.advanceTimersByTimeAsync(0); // flush finalizeDraft's internal edit call

    // Advance well past the batch window — the old timer must not fire a second edit.
    await vi.advanceTimersByTimeAsync(2000);
    expect(callsTo(telegramFetch.fn, 'editMessageText')).toHaveLength(1);
  });

  it('is a no-op when no draft is open for the contact', () => {
    expect(adapter.finalizeDraft('chris', 'Stopped by user')).toBe(false);
    expect(telegramFetch.fn).not.toHaveBeenCalled();
  });

  it('is a no-op for an unknown contact', () => {
    expect(adapter.finalizeDraft('nobody', 'Stopped by user')).toBe(false);
    expect(telegramFetch.fn).not.toHaveBeenCalled();
  });

  it('stops a running typing indicator even when a draft is open', async () => {
    adapter.startTyping('chris');
    expect(isTypingLoopActive(adapter, 12345)).toBe(true);

    adapter.reportToolCall('chris', 'first line');
    await getDraftState(adapter, 12345)?.creating;

    adapter.finalizeDraft('chris', 'Stopped by user');
    expect(isTypingLoopActive(adapter, 12345)).toBe(false);
  });

  it('stops a running typing indicator even when there is no draft to finalize', () => {
    adapter.startTyping('chris');
    expect(isTypingLoopActive(adapter, 12345)).toBe(true);

    expect(adapter.finalizeDraft('chris', 'Stopped by user')).toBe(false);
    expect(isTypingLoopActive(adapter, 12345)).toBe(false);
  });
});

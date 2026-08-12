import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { pickLargestPhoto, extensionFor, resolveMediaConfig, TelegramAdapter } from './telegram.js';
import { runMigrations } from '../db/schema.js';
import type { AppConfig } from '../config/schema.js';
import type { MessageQueue } from '../core/queue.js';
import type { PipelineEngine } from '../pipeline/engine.js';

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

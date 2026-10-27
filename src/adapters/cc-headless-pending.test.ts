import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import RealDatabase from 'better-sqlite3';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { runMigrations } from '../db/schema.js';
import { ensureOutboundAppSession } from '../app/outbound.js';
import { readWatermark, PENDING_CONTEXT_INTRO, REPLY_TARGET_MARK } from '../app/pending-context.js';
import type { AppConfig } from '../config/schema.js';

// E69 — cc-headless wiring for origin stamping (S69.1) and pending-context
// injection (S69.4). Same module mocks as cc-headless.test.ts.

const config = {
  bus: { http_port: 4321, db_path: ':memory:', log_level: 'info' },
  adapters: {
    'cc-headless': {
      agent_id: 'peggy',
      poll_interval_ms: 15,
      max_concurrent_turns: 5,
      reserved_system_slots: 1,
      system_prompt: 'You are Peggy.',
      claude_bin: 'claude',
      error_reply: 'err',
      error_passthrough: false,
      memory: { dir: 'memory', index_file: 'MEMORY.md', daily_subdir: 'daily', journal_lookback_days: 3 },
      journaling: { enabled: true, threshold_ms: 1_800_000, prompt: 'journal' },
    },
  },
  contacts: {},
  topics: ['general'],
  agents: {},
  memory: { session_close_min_messages: 0 },
  pipeline: { routes: [] },
} as unknown as AppConfig;

vi.mock('../config/loader.js', () => ({ loadConfig: vi.fn(() => config) }));
vi.mock('./cc.js', () => ({ formatMessagesForSampling: vi.fn(() => 'FORMATTED') }));
const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

function makeFakeChild() {
  const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn> };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  return child;
}

const writeEvent = (stream: PassThrough, obj: unknown) => stream.write(JSON.stringify(obj) + '\n');
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const okResponse = (json: unknown = {}) => ({ ok: true, json: async () => json }) as unknown as Response;

describe('cc-headless E69 wiring', () => {
  let db: InstanceType<typeof RealDatabase>;
  let fetchMock: ReturnType<typeof vi.fn>;
  let spawned: { prompt: string; mcp: { mcpServers: { agentbus: { env: Record<string, string> } } }; env: NodeJS.ProcessEnv } | null;

  function transcript(opts: { conv: string; session: string; at: string; direction: 'inbound' | 'outbound'; messageId?: string; body?: string; metadata?: Record<string, unknown> }) {
    db.prepare(`INSERT INTO transcripts (id, message_id, conversation_id, session_id, created_at, channel, contact_id, direction, body, metadata)
      VALUES (?, ?, ?, ?, ?, 'app', 'chris', ?, ?, ?)`).run(randomUUID(), opts.messageId ?? randomUUID(), opts.conv, opts.session,
      opts.at, opts.direction, opts.body ?? 'x', JSON.stringify(opts.metadata ?? {}));
  }

  /** Hand out one pending envelope, then none. */
  function pollOnce(envelope: Record<string, unknown>) {
    let calls = 0;
    fetchMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes('/messages/pending')) {
        calls += 1;
        return Promise.resolve(okResponse({ ok: true, messages: calls === 1 ? [envelope] : [] }));
      }
      return Promise.resolve(okResponse({ ok: true }));
    });
  }

  function envelope(id: string, channel: string, metadata: Record<string, unknown> = {}) {
    return {
      id, timestamp: new Date().toISOString(), channel, topic: 'general', sender: 'contact:chris', recipient: 'agent:peggy',
      reply_to: null, priority: 'normal', payload: { type: 'text', body: 'hi' }, metadata,
    };
  }

  /** Main with one earlier external scan and the batch's inbound row. */
  function seedMain(batchId: string) {
    const { conversationId, sessionId } = ensureOutboundAppSession(db, 'chris', 'agent:peggy', 'general');
    transcript({ conv: conversationId, session: sessionId, at: '2026-10-05T15:06:00.000Z', direction: 'outbound', messageId: 'scan-1',
      body: 'Two calendar items', metadata: { origin: { kind: 'external', label: 'Ambient scan' } } });
    transcript({ conv: conversationId, session: sessionId, at: '2026-10-05T15:07:00.000Z', direction: 'outbound', messageId: 'own-1',
      body: 'my own reply', metadata: { origin: { kind: 'turn', agent_id: 'peggy', conversation_id: conversationId } } });
    transcript({ conv: conversationId, session: sessionId, at: new Date().toISOString(), direction: 'inbound', messageId: batchId });
    return conversationId;
  }

  function postedMessages() {
    return fetchMock.mock.calls
      .filter(([url, init]) => String(url).endsWith('/api/v1/messages') && (init as RequestInit | undefined)?.method === 'POST')
      .map(([, init]) => JSON.parse((init as { body: string }).body) as { metadata: Record<string, unknown> });
  }

  let child: ReturnType<typeof makeFakeChild>;

  beforeEach(() => {
    vi.resetModules();
    db = new RealDatabase(':memory:');
    runMigrations(db);
    spawned = null;
    child = makeFakeChild();
    spawnMock.mockReset();
    spawnMock.mockImplementation((_bin: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
      spawned = {
        prompt: args[args.indexOf('-p') + 1]!,
        mcp: JSON.parse(readFileSync(args[args.indexOf('--mcp-config') + 1]!, 'utf-8')),
        env: opts.env,
      };
      return child;
    });
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(async () => {
    const { stopHeadless } = await import('./cc-headless.js');
    stopHeadless();
    db.close();
    vi.restoreAllMocks();
  });

  it('injects pending context in Main, stamps the turn conversation, and advances the watermark once the turn starts', async () => {
    const conv = seedMain('m1');
    pollOnce(envelope('m1', 'app'));
    const { startHeadless } = await import('./cc-headless.js');
    startHeadless(db as unknown as Database.Database);
    await tick();

    expect(spawned).not.toBeNull();
    expect(spawned!.prompt).toContain(PENDING_CONTEXT_INTRO);
    expect(spawned!.prompt).toContain('Ambient scan: Two calendar items');
    expect(spawned!.prompt).not.toContain('my own reply');
    expect(spawned!.prompt.endsWith('\n\nFORMATTED')).toBe(true);
    expect(spawned!.mcp.mcpServers.agentbus.env['AGENTBUS_TURN_CONVERSATION_ID']).toBe(conv);
    expect(spawned!.env['AGENTBUS_TURN_CONVERSATION_ID']).toBeUndefined();
    expect(readWatermark(db, conv)).toBeNull();

    writeEvent(child.stdout, { type: 'system', subtype: 'init', session_id: 'claude-1' });
    await tick(10);
    expect(readWatermark(db, conv)?.created_at).toBe('2026-10-05T15:06:00.000Z');

    writeEvent(child.stdout, { type: 'result', session_id: 'claude-1', result: 'Sure' });
    child.emit('close', 0);
    await tick();

    // Fallback delivery carries the turn origin.
    const posted = postedMessages();
    expect(posted).toHaveLength(1);
    expect(posted[0]!.metadata['origin']).toEqual({ kind: 'turn', agent_id: 'peggy', conversation_id: conv });
  });

  it('leaves the watermark when the spawn fails before a session id', async () => {
    const conv = seedMain('m1');
    pollOnce(envelope('m1', 'app'));
    const { startHeadless } = await import('./cc-headless.js');
    startHeadless(db as unknown as Database.Database);
    await tick();

    child.emit('error', new Error('ENOENT'));
    child.emit('close', 1);
    await tick();

    expect(readWatermark(db, conv)).toBeNull();
    // The error reply is still a turn send.
    expect(postedMessages()[0]!.metadata['origin']).toMatchObject({ kind: 'turn', conversation_id: conv });
  });

  it('marks the pending message the operator is replying to', async () => {
    seedMain('m1');
    pollOnce(envelope('m1', 'app', { quoted_message: { message_id: 'scan-1', sender_name: 'agent', text: 'Two calendar items' } }));
    const { startHeadless } = await import('./cc-headless.js');
    startHeadless(db as unknown as Database.Database);
    await tick();
    expect(spawned!.prompt).toContain(`Ambient scan ${REPLY_TARGET_MARK}: Two calendar items`);
    child.emit('close', 0);
  });

  it('injects nothing outside Main but still stamps the turn conversation', async () => {
    const { conversationId, sessionId } = ensureOutboundAppSession(db, 'chris', 'agent:peggy', 'thread:abc');
    transcript({ conv: conversationId, session: sessionId, at: '2026-10-05T15:06:00.000Z', direction: 'outbound',
      metadata: { origin: { kind: 'external', label: 'Ambient scan' } } });
    transcript({ conv: conversationId, session: sessionId, at: new Date().toISOString(), direction: 'inbound', messageId: 'm1' });
    pollOnce({ ...envelope('m1', 'app'), topic: 'thread:abc' });
    const { startHeadless } = await import('./cc-headless.js');
    startHeadless(db as unknown as Database.Database);
    await tick();
    expect(spawned!.prompt).not.toContain(PENDING_CONTEXT_INTRO);
    expect(spawned!.mcp.mcpServers.agentbus.env['AGENTBUS_TURN_CONVERSATION_ID']).toBe(conversationId);
    child.emit('close', 0);
  });

  it('buildMcpConfig omits the turn conversation when none is given (journaling turns)', async () => {
    const { buildMcpConfig } = await import('./cc-headless.js');
    const cfg = buildMcpConfig('peggy') as { mcpServers: { agentbus: { env: Record<string, string> } } };
    expect(cfg.mcpServers.agentbus.env).not.toHaveProperty('AGENTBUS_TURN_CONVERSATION_ID');
  });
});

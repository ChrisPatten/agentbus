import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { runMigrations } from '../db/schema.js';
import { MessageQueue } from '../core/queue.js';
import { AdapterRegistry } from '../core/registry.js';
import type { AdapterInstance } from '../core/registry.js';
import { createHttpServer } from './api.js';
import { PipelineEngine } from '../pipeline/engine.js';
import type { AppConfig, CcPoolInstanceConfig } from '../config/schema.js';
import { LeaseStore } from '../pool/lease-store.js';
import { computeConversationId } from '../pipeline/conversation-id.js';
import type { AcquireResult } from '../pool/types.js';
import { PoolManager } from '../pool/pool-manager.js';
import type { MessageEnvelope } from '../types/envelope.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

const stubConfig = {
  bus: { http_port: 0, db_path: ':memory:', log_level: 'info' },
  adapters: {},
  contacts: {},
  topics: ['general'],
  memory: {
    summarizer_interval_ms: 60000,
    session_idle_threshold_ms: 1800000,
    context_window_hours: 48,
    claude_api_model: 'claude-opus-4-6',
  },
  pipeline: { dedup_window_ms: 30000, drop_unrouted: false, topic_rules: [], priority_weights: { base_score: 0, topic_bonus: 40, vip_sender_bonus: 20, urgency_keyword_bonus: 15 }, urgency_keywords: [], vip_contacts: [], routes: [] },
} as unknown as AppConfig;

async function makeServer(
  opts: { poolManagers?: Map<string, PoolManager>; db?: Database.Database } = {},
): Promise<{ server: FastifyInstance; queue: MessageQueue; db: Database.Database; registry: AdapterRegistry }> {
  const db = opts.db ?? makeDb();
  const queue = new MessageQueue(db);
  const registry = new AdapterRegistry();
  const pipeline = new PipelineEngine(); // no-op pipeline for existing tests
  const server = await createHttpServer({
    queue,
    registry,
    config: stubConfig,
    pipeline,
    db,
    poolManagers: opts.poolManagers,
  });
  return { server, queue, db, registry };
}

/** Minimal stub adapter for testing adapter-aware endpoints */
function makeStubAdapter(opts: {
  id: string;
  channels: string[];
  canReact?: boolean;
  reactFn?: (id: string, emoji: string) => Promise<void>;
  ownsChannel?: (channel: string) => boolean;
  canType?: boolean;
  startTypingFn?: (contactId: string, channel?: string) => void;
  canToolStatus?: boolean;
  reportToolCallFn?: (contactId: string, text: string, channel?: string) => void;
  createTopicFn?: (
    channel: string,
    name: string,
    context?: string,
  ) => Promise<{ ok: true; topic: string; message_thread_id: number; name: string } | { ok: false; error: string }>;
}): AdapterInstance {
  return {
    id: opts.id,
    name: opts.id,
    capabilities: {
      send: true,
      react: opts.canReact ?? false,
      typing: opts.canType ?? false,
      toolStatus: opts.canToolStatus ?? false,
      channels: opts.channels,
    },
    start: async () => {},
    stop: async () => {},
    health: async () => ({ status: 'healthy' as const }),
    send: async () => ({ success: true }),
    react: opts.canReact ? opts.reactFn ?? (async () => {}) : undefined,
    ownsChannel: opts.ownsChannel,
    startTyping: opts.canType ? opts.startTypingFn ?? (() => {}) : undefined,
    reportToolCall: opts.canToolStatus ? opts.reportToolCallFn ?? (() => {}) : undefined,
    createTopic: opts.createTopicFn,
  };
}

const validMessage = {
  channel: 'telegram',
  sender: 'contact:alice',
  recipient: 'agent:claude',
  payload: { type: 'text', body: 'hello' },
};

async function makeSecureServer(): Promise<{ server: FastifyInstance; queue: MessageQueue }> {
  const db = makeDb();
  const queue = new MessageQueue(db);
  const registry = new AdapterRegistry();
  const pipeline = new PipelineEngine();
  const config = { ...stubConfig, bus: { ...stubConfig.bus, auth_token: 'secret-token' } } as unknown as AppConfig;
  const server = await createHttpServer({ queue, registry, config, pipeline, db });
  return { server, queue };
}

describe('HTTP API — auth middleware', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    ({ server } = await makeSecureServer());
  });

  afterEach(async () => {
    await server.close();
  });

  it('returns 401 when X-Bus-Token header is absent', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/v1/messages/pending?agent=claude' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 when X-Bus-Token header is wrong', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/v1/messages/pending?agent=claude', headers: { 'x-bus-token': 'wrong' } });
    expect(res.statusCode).toBe(401);
  });

  it('allows access with correct X-Bus-Token header', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/v1/messages/pending?agent=claude', headers: { 'x-bus-token': 'secret-token' } });
    expect(res.statusCode).toBe(200);
  });

  it('health endpoint is always accessible without token', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res.statusCode).toBe(200);
  });
});

describe('HTTP API', () => {
  let server: FastifyInstance;
  let queue: MessageQueue;

  beforeEach(async () => {
    ({ server, queue } = await makeServer());
  });

  afterEach(async () => {
    await server.close();
  });

  // Fix #4/#7: negative and NaN limit values previously bypassed the 100-message
  // cap. Math.max(1, ...) ensures the floor is 1; `|| 10` catches NaN.
  describe('GET /api/v1/messages/pending — limit clamping', () => {
    beforeEach(async () => {
      // Enqueue 3 messages so we can observe clamping
      for (let i = 0; i < 3; i++) {
        await server.inject({
          method: 'POST',
          url: '/api/v1/messages',
          payload: { ...validMessage, payload: { type: 'text', body: `msg ${i}` } },
        });
      }
    });

    it('clamps limit=-1 to 1 (previously returned all messages via SQLite LIMIT -1)', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/messages/pending?agent=claude&limit=-1',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { count: number };
      expect(body.count).toBe(1);
    });

    it('falls back to 10 on NaN limit (previously returned 0 via SQLite LIMIT NaN)', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/messages/pending?agent=claude&limit=abc',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { count: number };
      // 3 messages enqueued, default limit=10, so all 3 returned
      expect(body.count).toBe(3);
    });

    it('treats limit=0 as the default (0 is falsy, falls back to 10)', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/messages/pending?agent=claude&limit=0',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { count: number };
      expect(body.count).toBe(3); // 0 || 10 = 10, all 3 messages returned
    });
  });

  describe('GET /api/v1/messages/pending — ?recipient= parameter', () => {
    beforeEach(async () => {
      // Enqueue one message for a contact recipient (as the Telegram adapter would see)
      await server.inject({
        method: 'POST',
        url: '/api/v1/messages',
        payload: {
          channel: 'telegram',
          sender: 'agent:claude',
          recipient: 'contact:alice',
          payload: { type: 'text', body: 'hi from claude' },
        },
      });
    });

    it('returns messages for a raw contact: recipient via ?recipient=', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/messages/pending?recipient=contact:alice',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { count: number };
      expect(body.count).toBe(1);
    });

    it('returns 400 when neither ?agent= nor ?recipient= is provided', async () => {
      const res = await server.inject({ method: 'GET', url: '/api/v1/messages/pending' });
      expect(res.statusCode).toBe(400);
    });

    it('?recipient= takes precedence when both ?agent= and ?recipient= are provided', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/messages/pending?agent=claude&recipient=contact:alice',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { count: number };
      expect(body.count).toBe(1); // message is for contact:alice, not agent:claude
    });

    it('?agent= still works as before (returns messages for agent:claude)', async () => {
      // Enqueue a message for agent:claude
      await server.inject({
        method: 'POST',
        url: '/api/v1/messages',
        payload: { ...validMessage, payload: { type: 'text', body: 'hi' } },
      });
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/messages/pending?agent=claude',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { count: number };
      expect(body.count).toBe(1); // only the agent:claude message
    });
  });

  // E48 (S48.4) — GET /api/v1/messages/pending records a poll for the
  // requesting bare agent id, and GET /api/v1/agents/:agentId/last-poll
  // surfaces it. Uses agent ids not touched by any other describe block in
  // this file, since the tracker's module state is shared process-wide.
  describe('GET /api/v1/agents/:agentId/last-poll (E48 S48.4)', () => {
    it('returns lastPollAt: null before the agent has ever polled', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/agents/s48-4-never-polled/last-poll',
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({
        ok: true,
        agentId: 's48-4-never-polled',
        lastPollAt: null,
      });
    });

    it('returns a recent ISO timestamp after the agent polls pending messages via ?agent=', async () => {
      const beforePoll = Date.now();
      const pollRes = await server.inject({
        method: 'GET',
        url: '/api/v1/messages/pending?agent=s48-4-polled-via-agent',
      });
      expect(pollRes.statusCode).toBe(200);

      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/agents/s48-4-polled-via-agent/last-poll',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { ok: boolean; agentId: string; lastPollAt: string | null };
      expect(body.lastPollAt).not.toBeNull();
      expect(new Date(body.lastPollAt!).getTime()).toBeGreaterThanOrEqual(beforePoll);
    });

    it('records the bare agent id even when the poll only supplied ?recipient=', async () => {
      const pollRes = await server.inject({
        method: 'GET',
        url: '/api/v1/messages/pending?recipient=agent:s48-4-polled-via-recipient',
      });
      expect(pollRes.statusCode).toBe(200);

      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/agents/s48-4-polled-via-recipient/last-poll',
      });
      const body = JSON.parse(res.body) as { lastPollAt: string | null };
      expect(body.lastPollAt).not.toBeNull();
    });
  });

  // Fix #11: expires_at was not validated as a future timestamp, so messages
  // could be submitted already expired. The schema now rejects past values.
  describe('POST /api/v1/messages — expires_at validation', () => {
    it('rejects a message with expires_at in the past', async () => {
      const past = new Date(Date.now() - 1000).toISOString();
      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/messages',
        payload: { ...validMessage, expires_at: past },
      });
      expect(res.statusCode).toBe(400);
    });

    it('accepts a message with expires_at in the future', async () => {
      const future = new Date(Date.now() + 60_000).toISOString();
      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/messages',
        payload: { ...validMessage, expires_at: future },
      });
      expect(res.statusCode).toBe(201);
    });

    it('accepts a message with no expires_at', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/messages',
        payload: validMessage,
      });
      expect(res.statusCode).toBe(201);
    });
  });
});

describe('POST /api/v1/messages — reply_to resolution (E28)', () => {
  let server: FastifyInstance;
  let db: Database.Database;

  beforeEach(async () => {
    ({ server, db } = await makeServer());
  });

  afterEach(async () => {
    await server.close();
  });

  function insertTranscript(
    msgId: string,
    channel: string,
    metadata = '{}',
    opts: { direction?: 'inbound' | 'outbound'; createdAt?: string; conversationId?: string } = {},
  ) {
    const conversationId = opts.conversationId ?? 'conv-1';
    const sessionId = randomUUID();
    db.prepare(
      `INSERT OR IGNORE INTO sessions (id, conversation_id, channel, contact_id, started_at, last_activity, message_count)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(sessionId, conversationId, channel, 'contact:alice', new Date().toISOString(), new Date().toISOString(), 1);
    db.prepare(
      `INSERT INTO transcripts (id, message_id, conversation_id, session_id, created_at, channel, contact_id, direction, body, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      msgId,
      conversationId,
      sessionId,
      opts.createdAt ?? new Date().toISOString(),
      channel,
      'contact:alice',
      opts.direction ?? 'inbound',
      'hi',
      metadata,
    );
  }

  async function enqueueAndFetch(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const postRes = await server.inject({ method: 'POST', url: '/api/v1/messages', payload });
    const { id } = JSON.parse(postRes.body) as { id: string };
    const getRes = await server.inject({ method: 'GET', url: `/api/v1/messages/${id}` });
    const { message } = JSON.parse(getRes.body) as { message: Record<string, unknown> };
    return message;
  }

  it('resolves reply_to to reply_to_platform_message_id when replying to an earlier (not the latest) inbound message', async () => {
    const origId = randomUUID();
    const laterId = randomUUID();
    insertTranscript(origId, 'telegram', JSON.stringify({ platform_message_id: '555:42' }), {
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    insertTranscript(laterId, 'telegram', JSON.stringify({ platform_message_id: '555:43' }), {
      createdAt: '2026-01-01T00:01:00.000Z',
    });

    const message = await enqueueAndFetch({ ...validMessage, reply_to: origId });
    const metadata = message['metadata'] as Record<string, unknown>;
    expect(metadata['reply_to_platform_message_id']).toBe('555:42');
  });

  it('is a no-op (plain message) when replying to the latest inbound message — the quote would be redundant', async () => {
    const latestId = randomUUID();
    insertTranscript(latestId, 'telegram', JSON.stringify({ platform_message_id: '555:99' }));

    const message = await enqueueAndFetch({ ...validMessage, reply_to: latestId });
    const metadata = message['metadata'] as Record<string, unknown>;
    expect(metadata['reply_to_platform_message_id']).toBeUndefined();
  });

  it('is a no-op when reply_to references an unknown message', async () => {
    const message = await enqueueAndFetch({ ...validMessage, reply_to: 'no-such-message' });
    const metadata = message['metadata'] as Record<string, unknown>;
    expect(metadata['reply_to_platform_message_id']).toBeUndefined();
  });

  it('is a no-op when the transcript has no platform_message_id (even though not the latest)', async () => {
    const origId = randomUUID();
    const laterId = randomUUID();
    insertTranscript(origId, 'telegram', '{}', { createdAt: '2026-01-01T00:00:00.000Z' });
    insertTranscript(laterId, 'telegram', '{}', { createdAt: '2026-01-01T00:01:00.000Z' });

    const message = await enqueueAndFetch({ ...validMessage, reply_to: origId });
    const metadata = message['metadata'] as Record<string, unknown>;
    expect(metadata['reply_to_platform_message_id']).toBeUndefined();
  });

  it('does nothing when reply_to is absent', async () => {
    const message = await enqueueAndFetch(validMessage);
    const metadata = message['metadata'] as Record<string, unknown>;
    expect(metadata['reply_to_platform_message_id']).toBeUndefined();
  });
});

describe('POST /api/v1/messages — stale-pane guard (E48 S48.6)', () => {
  let server: FastifyInstance;
  let queue: MessageQueue;
  let db: Database.Database;

  beforeEach(async () => {
    ({ server, queue, db } = await makeServer());
  });

  afterEach(async () => {
    await server.close();
  });

  /** Seeds one pane in `poolId`, acquires it for `conversationId`, and confirms it `leased`. */
  function seedLeasedPane(poolId: string, paneAgentId: string, conversationId: string): void {
    const leaseStore = new LeaseStore(db);
    leaseStore.seedPanes(poolId, [{ paneId: `${poolId}:1`, agentId: paneAgentId }]);
    const result: AcquireResult = leaseStore.acquire(poolId, conversationId, {
      poolAgentId: poolId,
      panes: 1,
      maxPanes: 1,
      growth: 'fixed',
      idleEvictMs: 15 * 60 * 1000,
    });
    if (result.kind !== 'bound') {
      throw new Error(`test setup: expected acquire() to return "bound", got "${result.kind}"`);
    }
    leaseStore.confirmReady(poolId, result.lease.pane_id);
  }

  it('has zero effect when sender matches no pool lease at all (non-pool traffic)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/messages',
      payload: { ...validMessage, sender: 'agent:peggy-pool-99', metadata: { conversation_id: 'conv-x' } },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { ok: boolean; queued: boolean };
    expect(body.ok).toBe(true);
    expect(body.queued).toBe(true);
  });

  it('succeeds when sender is not an "agent:"-prefixed id at all (e.g. a contact sender)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/messages',
      payload: validMessage, // sender: 'contact:alice'
    });

    expect(res.statusCode).toBe(201);
  });

  it('succeeds when sender matches a leased row with the SAME conversation_id', async () => {
    seedLeasedPane('peggy', 'agent:peggy-pool-1', 'conv-match');

    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/messages',
      payload: { ...validMessage, sender: 'agent:peggy-pool-1', metadata: { conversation_id: 'conv-match' } },
    });

    expect(res.statusCode).toBe(201);
  });

  it('rejects with 409 when sender matches a leased row with a DIFFERENT conversation_id, and does not enqueue', async () => {
    seedLeasedPane('peggy', 'agent:peggy-pool-1', 'conv-current');
    const countsBefore = queue.counts();

    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/messages',
      payload: { ...validMessage, sender: 'agent:peggy-pool-1', metadata: { conversation_id: 'conv-stale' } },
    });

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('agent:peggy-pool-1');

    const countsAfter = queue.counts();
    expect(countsAfter['pending'] ?? 0).toBe(countsBefore['pending'] ?? 0);
  });

  it('triggers the guard on mismatch when conversationId is derivable only via the fallback hash-derivation path', async () => {
    seedLeasedPane('peggy', 'agent:peggy-pool-1', 'conv-current');

    // No reply_to, no metadata.conversation_id — forces the derivation path:
    // computeConversationId(bareContactId, channel, topic).
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/messages',
      payload: {
        channel: 'telegram',
        sender: 'agent:peggy-pool-1',
        recipient: 'contact:alice',
        payload: { type: 'text', body: 'stale reply' },
      },
    });

    expect(res.statusCode).toBe(409);
  });

  it('succeeds via the fallback hash-derivation path when the derived conversationId matches the lease', async () => {
    const expectedConversationId = computeConversationId('alice', 'telegram', 'general');
    seedLeasedPane('peggy', 'agent:peggy-pool-1', expectedConversationId);

    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/messages',
      payload: {
        channel: 'telegram',
        sender: 'agent:peggy-pool-1',
        recipient: 'contact:alice',
        payload: { type: 'text', body: 'legit reply' },
      },
    });

    expect(res.statusCode).toBe(201);
  });

  it('does not block when the matching lease row is not yet "leased" (e.g. still launching)', async () => {
    const leaseStore = new LeaseStore(db);
    leaseStore.seedPanes('peggy', [{ paneId: 'peggy:1', agentId: 'agent:peggy-pool-1' }]);
    const result = leaseStore.acquire('peggy', 'conv-launching', {
      poolAgentId: 'peggy',
      panes: 1,
      maxPanes: 1,
      growth: 'fixed',
      idleEvictMs: 15 * 60 * 1000,
    });
    if (result.kind !== 'bound') throw new Error(`expected "bound", got "${result.kind}"`);
    // Deliberately no confirmReady() — row stays in 'launching', not 'leased'.

    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/messages',
      payload: { ...validMessage, sender: 'agent:peggy-pool-1', metadata: { conversation_id: 'conv-different' } },
    });

    expect(res.statusCode).toBe(201);
  });
});

// ── E7 endpoint tests ─────────────────────────────────────────────────────────

describe('GET /api/v1/adapters', () => {
  let server: FastifyInstance;
  let registry: AdapterRegistry;

  beforeEach(async () => {
    ({ server, registry } = await makeServer());
  });

  afterEach(async () => {
    await server.close();
  });

  it('returns empty adapters when none registered', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/v1/adapters' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { ok: boolean; adapters: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.adapters).toEqual([]);
  });

  it('returns registered adapter with id, name, channels, capabilities', async () => {
    registry.register(makeStubAdapter({ id: 'telegram', channels: ['telegram'] }));
    const res = await server.inject({ method: 'GET', url: '/api/v1/adapters' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { ok: boolean; adapters: Array<{ id: string; channels: string[] }> };
    expect(body.adapters).toHaveLength(1);
    expect(body.adapters[0]!.id).toBe('telegram');
    expect(body.adapters[0]!.channels).toEqual(['telegram']);
  });
});

describe('GET /api/v1/adapters/resolve', () => {
  let server: FastifyInstance;
  let registry: AdapterRegistry;

  beforeEach(async () => {
    ({ server, registry } = await makeServer());
  });

  afterEach(async () => {
    await server.close();
  });

  it('400s when channel is missing', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/v1/adapters/resolve' });
    expect(res.statusCode).toBe(400);
  });

  it('resolves a channel in capabilities.channels', async () => {
    registry.register(makeStubAdapter({ id: 'telegram', channels: ['telegram'] }));
    const res = await server.inject({ method: 'GET', url: '/api/v1/adapters/resolve?channel=telegram' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, exists: true });
  });

  it('resolves a dynamically-derived channel via ownsChannel (E28)', async () => {
    registry.register(
      makeStubAdapter({
        id: 'telegram',
        channels: ['telegram'],
        ownsChannel: (channel) => channel.startsWith('telegram:group:'),
      }),
    );
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/adapters/resolve?channel=telegram:group:-100123',
    });
    expect(JSON.parse(res.body)).toEqual({ ok: true, exists: true });
  });

  it('reports a channel no adapter owns as not existing', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/v1/adapters/resolve?channel=nope' });
    expect(JSON.parse(res.body)).toEqual({ ok: true, exists: false });
  });
});

describe('POST /api/v1/adapters/:id/typing and /tool-status', () => {
  let server: FastifyInstance;
  let registry: AdapterRegistry;

  beforeEach(async () => {
    ({ server, registry } = await makeServer());
  });

  afterEach(async () => {
    await server.close();
  });

  it('resolves :id by exact adapter id, unchanged for a plain channel', async () => {
    const calls: Array<[string, string | undefined]> = [];
    registry.register(
      makeStubAdapter({
        id: 'telegram',
        channels: ['telegram'],
        canType: true,
        startTypingFn: (contactId, channel) => calls.push([contactId, channel]),
      }),
    );
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/adapters/telegram/typing',
      payload: { contact_id: 'contact:chris' },
    });
    expect(res.statusCode).toBe(200);
    expect(calls).toEqual([['contact:chris', 'telegram']]);
  });

  it('resolves :id as a dynamically-derived group channel via ownsChannel (E28)', async () => {
    const calls: Array<[string, string, string | undefined]> = [];
    registry.register(
      makeStubAdapter({
        id: 'telegram',
        channels: ['telegram'],
        ownsChannel: (channel) => channel.startsWith('telegram:group:'),
        canToolStatus: true,
        reportToolCallFn: (contactId, text, channel) => calls.push([contactId, text, channel]),
      }),
    );
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/adapters/telegram:group:-100123/tool-status',
      payload: { contact_id: 'contact:chris', text: 'Bash: ls' },
    });
    expect(res.statusCode).toBe(200);
    expect(calls).toEqual([['contact:chris', 'Bash: ls', 'telegram:group:-100123']]);
  });

  it('no-ops (still 200) for an unresolvable channel', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/adapters/unknown/typing',
      payload: { contact_id: 'contact:chris' },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('POST /api/v1/adapters/:id/topics (E28)', () => {
  let server: FastifyInstance;
  let registry: AdapterRegistry;

  beforeEach(async () => {
    ({ server, registry } = await makeServer());
  });

  afterEach(async () => {
    await server.close();
  });

  it('400s when name is missing', async () => {
    const res = await server.inject({ method: 'POST', url: '/api/v1/adapters/telegram/topics', payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it('404s when no adapter resolves the channel', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/adapters/telegram/topics',
      payload: { name: 'x' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('400s when the resolved adapter has no createTopic', async () => {
    registry.register(makeStubAdapter({ id: 'telegram', channels: ['telegram'] }));
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/adapters/telegram/topics',
      payload: { name: 'x' },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain('not supported');
  });

  it('resolves via ownsChannel and forwards to createTopic with the group channel', async () => {
    const calls: Array<[string, string]> = [];
    registry.register(
      makeStubAdapter({
        id: 'telegram',
        channels: ['telegram'],
        ownsChannel: (channel) => channel.startsWith('telegram:group:'),
        createTopicFn: async (channel, name) => {
          calls.push([channel, name]);
          return { ok: true, topic: 'thread:abc', message_thread_id: 42, name };
        },
      }),
    );
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/adapters/telegram:group:-100123/topics',
      payload: { name: 'Wanda prep' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, topic: 'thread:abc', message_thread_id: 42, name: 'Wanda prep' });
    expect(calls).toEqual([['telegram:group:-100123', 'Wanda prep']]);
  });

  it('forwards an optional context param to createTopic', async () => {
    const calls: Array<[string, string, string | undefined]> = [];
    registry.register(
      makeStubAdapter({
        id: 'telegram',
        channels: ['telegram'],
        ownsChannel: (channel) => channel.startsWith('telegram:group:'),
        createTopicFn: async (channel, name, context) => {
          calls.push([channel, name, context]);
          return { ok: true, topic: 'thread:abc', message_thread_id: 42, name };
        },
      }),
    );
    await server.inject({
      method: 'POST',
      url: '/api/v1/adapters/telegram:group:-100123/topics',
      payload: { name: 'Wanda prep', context: 'Track Wanda birthday planning here' },
    });
    expect(calls).toEqual([['telegram:group:-100123', 'Wanda prep', 'Track Wanda birthday planning here']]);
  });

  it('surfaces an ok:false result (e.g. missing admin rights) as-is', async () => {
    registry.register(
      makeStubAdapter({
        id: 'telegram',
        channels: ['telegram'],
        ownsChannel: (channel) => channel.startsWith('telegram:group:'),
        createTopicFn: async () => ({ ok: false, error: 'missing Manage Topics' }),
      }),
    );
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/adapters/telegram:group:-100123/topics',
      payload: { name: 'x' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: false, error: 'missing Manage Topics' });
  });
});

describe('GET /api/v1/transcripts/search', () => {
  let server: FastifyInstance;
  let db: Database.Database;

  beforeEach(async () => {
    ({ server, db } = await makeServer());
  });

  afterEach(async () => {
    await server.close();
  });

  it('returns 400 when q is missing', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/v1/transcripts/search' });
    expect(res.statusCode).toBe(400);
  });

  it('returns empty results when no transcripts match', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/transcripts/search?q=nonexistent',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { ok: boolean; results: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.results).toEqual([]);
  });

  it('returns matching transcripts', async () => {
    // Insert a session + transcript for FTS5 to index
    const sessionId = randomUUID();
    db.prepare(
      `INSERT INTO sessions (id, conversation_id, channel, contact_id, started_at, last_activity, message_count)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(sessionId, 'conv-1', 'telegram', 'contact:alice', new Date().toISOString(), new Date().toISOString(), 1);
    const msgId = randomUUID();
    db.prepare(
      `INSERT INTO transcripts (id, message_id, conversation_id, session_id, created_at, channel, contact_id, direction, body, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(randomUUID(), msgId, 'conv-1', sessionId, new Date().toISOString(), 'telegram', 'contact:alice', 'inbound', 'hello world fts test', '{}');

    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/transcripts/search?q=fts+test',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { ok: boolean; results: Array<{ body: string }> };
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.results[0]!.body).toContain('fts test');
  });

  it('returns 400 on malformed FTS query', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/transcripts/search?q=' + encodeURIComponent('"unclosed quote'),
    });
    expect(res.statusCode).toBe(400);
  });

  it('finds an outbound transcript row by its body text (E31)', async () => {
    const sessionId = randomUUID();
    db.prepare(
      `INSERT INTO sessions (id, conversation_id, channel, contact_id, started_at, last_activity, message_count)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(sessionId, 'conv-2', 'telegram', 'contact:alice', new Date().toISOString(), new Date().toISOString(), 1);
    const msgId = randomUUID();
    db.prepare(
      `INSERT INTO transcripts (id, message_id, conversation_id, session_id, created_at, channel, contact_id, direction, body, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(randomUUID(), msgId, 'conv-2', sessionId, new Date().toISOString(), 'telegram', 'contact:alice', 'outbound', 'the scheduled reminder went out fine', '{}');

    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/transcripts/search?q=scheduled+reminder',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { ok: boolean; results: Array<{ body: string; direction: string }> };
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.results[0]!.direction).toBe('outbound');
    expect(body.results[0]!.body).toContain('scheduled reminder');
  });
});

describe('GET /api/v1/sessions and GET /api/v1/sessions/:id', () => {
  let server: FastifyInstance;
  let db: Database.Database;

  beforeEach(async () => {
    ({ server, db } = await makeServer());
  });

  afterEach(async () => {
    await server.close();
  });

  function insertSession(overrides: Partial<{
    id: string; channel: string; contact_id: string; started_at: string; conversationId: string;
  }> = {}) {
    const id = overrides.id ?? randomUUID();
    db.prepare(
      `INSERT INTO sessions (id, conversation_id, channel, contact_id, started_at, last_activity, message_count)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      overrides.conversationId ?? 'conv-1',
      overrides.channel ?? 'telegram',
      overrides.contact_id ?? 'contact:alice',
      overrides.started_at ?? new Date().toISOString(),
      new Date().toISOString(),
      5
    );
    return id;
  }

  function insertConversationRegistry(overrides: {
    id: string; contactId: string; channel: string; topic: string;
  }) {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO conversation_registry (id, contact_id, channel, topic, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(overrides.id, overrides.contactId, overrides.channel, overrides.topic, now, now);
  }

  it('returns empty sessions list when none exist', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/v1/sessions' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { ok: boolean; sessions: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.sessions).toEqual([]);
  });

  it('returns sessions ordered by started_at DESC', async () => {
    insertSession({ id: 's1', started_at: '2026-01-01T00:00:00.000Z' });
    insertSession({ id: 's2', started_at: '2026-01-02T00:00:00.000Z' });
    const res = await server.inject({ method: 'GET', url: '/api/v1/sessions' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { sessions: Array<{ id: string }> };
    expect(body.sessions[0]!.id).toBe('s2');
    expect(body.sessions[1]!.id).toBe('s1');
  });

  it('filters sessions by channel', async () => {
    insertSession({ id: 's1', channel: 'telegram' });
    insertSession({ id: 's2', channel: 'bluebubbles' });
    const res = await server.inject({ method: 'GET', url: '/api/v1/sessions?channel=telegram' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { sessions: Array<{ id: string }> };
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]!.id).toBe('s1');
  });

  it('GET /api/v1/sessions/:id returns 404 for unknown session', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/v1/sessions/no-such-session' });
    expect(res.statusCode).toBe(404);
  });

  it('GET /api/v1/sessions/:id returns the session', async () => {
    const id = insertSession();
    const res = await server.inject({ method: 'GET', url: `/api/v1/sessions/${id}` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { ok: boolean; session: { id: string; summary: null } };
    expect(body.ok).toBe(true);
    expect(body.session.id).toBe(id);
    expect(body.session.summary).toBeNull();
  });

  it('exposes the session topic via conversation_registry on the default topic (E32)', async () => {
    insertConversationRegistry({ id: 'conv-general', contactId: 'alice', channel: 'telegram', topic: 'general' });
    const id = insertSession({ conversationId: 'conv-general' });

    const listRes = await server.inject({ method: 'GET', url: '/api/v1/sessions' });
    const listBody = JSON.parse(listRes.body) as { sessions: Array<{ id: string; topic: string | null }> };
    expect(listBody.sessions[0]!.topic).toBe('general');

    const getRes = await server.inject({ method: 'GET', url: `/api/v1/sessions/${id}` });
    const getBody = JSON.parse(getRes.body) as { session: { topic: string | null } };
    expect(getBody.session.topic).toBe('general');
  });

  it('exposes a non-default (forum thread) topic via conversation_registry (E32)', async () => {
    insertConversationRegistry({ id: 'conv-thread', contactId: 'alice', channel: 'telegram', topic: 'thread:abc123' });
    const id = insertSession({ conversationId: 'conv-thread' });

    const listRes = await server.inject({ method: 'GET', url: '/api/v1/sessions' });
    const listBody = JSON.parse(listRes.body) as { sessions: Array<{ id: string; topic: string | null }> };
    expect(listBody.sessions[0]!.topic).toBe('thread:abc123');

    const getRes = await server.inject({ method: 'GET', url: `/api/v1/sessions/${id}` });
    const getBody = JSON.parse(getRes.body) as { session: { topic: string | null } };
    expect(getBody.session.topic).toBe('thread:abc123');
  });

  it('returns topic: null when conversation_registry has no matching row', async () => {
    const id = insertSession({ conversationId: 'conv-orphan' });
    const res = await server.inject({ method: 'GET', url: `/api/v1/sessions/${id}` });
    const body = JSON.parse(res.body) as { session: { topic: string | null } };
    expect(body.session.topic).toBeNull();
  });
});

describe('GET /api/v1/sessions/:id/transcript (E35)', () => {
  let server: FastifyInstance;
  let db: Database.Database;

  beforeEach(async () => {
    ({ server, db } = await makeServer());
  });

  afterEach(async () => {
    await server.close();
  });

  function insertSession(id: string) {
    db.prepare(
      `INSERT INTO sessions (id, conversation_id, channel, contact_id, started_at, last_activity, message_count)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, 'conv-1', 'telegram', 'contact:alice', new Date().toISOString(), new Date().toISOString(), 0);
  }

  function insertTranscript(sessionId: string, overrides: {
    messageId?: string; direction?: string; body?: string; createdAt?: string;
  } = {}) {
    db.prepare(
      `INSERT INTO transcripts (id, message_id, conversation_id, session_id, created_at, channel, contact_id, direction, body, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      randomUUID(),
      overrides.messageId ?? randomUUID(),
      'conv-1',
      sessionId,
      overrides.createdAt ?? new Date().toISOString(),
      'telegram',
      'contact:alice',
      overrides.direction ?? 'inbound',
      overrides.body ?? 'hello',
      '{}'
    );
  }

  it('returns 404 for an unknown session', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/v1/sessions/no-such-session/transcript' });
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
  });

  it('returns an empty array for a session with no transcript rows', async () => {
    insertSession('s1');
    const res = await server.inject({ method: 'GET', url: '/api/v1/sessions/s1/transcript' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { ok: boolean; transcript: unknown[]; count: number };
    expect(body.ok).toBe(true);
    expect(body.transcript).toEqual([]);
    expect(body.count).toBe(0);
  });

  it('returns transcript rows in chronological (ASC) order, both directions', async () => {
    insertSession('s1');
    insertTranscript('s1', { direction: 'inbound', body: 'first', createdAt: '2026-01-01T00:00:00.000Z' });
    insertTranscript('s1', { direction: 'outbound', body: 'second', createdAt: '2026-01-01T00:01:00.000Z' });
    insertTranscript('s1', { direction: 'inbound', body: 'third', createdAt: '2026-01-01T00:02:00.000Z' });

    const res = await server.inject({ method: 'GET', url: '/api/v1/sessions/s1/transcript' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      transcript: Array<{ body: string; direction: string }>;
      count: number;
    };
    expect(body.count).toBe(3);
    expect(body.transcript.map((t) => t.body)).toEqual(['first', 'second', 'third']);
    expect(body.transcript[1]!.direction).toBe('outbound');
  });

  it('does not mix in rows from another session', async () => {
    insertSession('s1');
    insertSession('s2');
    insertTranscript('s1', { body: 'mine' });
    insertTranscript('s2', { body: 'not mine' });

    const res = await server.inject({ method: 'GET', url: '/api/v1/sessions/s1/transcript' });
    const body = JSON.parse(res.body) as { transcript: Array<{ body: string }> };
    expect(body.transcript).toHaveLength(1);
    expect(body.transcript[0]!.body).toBe('mine');
  });

  it('truncates to ?limit=', async () => {
    insertSession('s1');
    for (let i = 0; i < 5; i++) {
      insertTranscript('s1', { body: `msg-${i}`, createdAt: `2026-01-01T00:0${i}:00.000Z` });
    }
    const res = await server.inject({ method: 'GET', url: '/api/v1/sessions/s1/transcript?limit=2' });
    const body = JSON.parse(res.body) as { transcript: Array<{ body: string }>; count: number };
    expect(body.count).toBe(2);
    expect(body.transcript.map((t) => t.body)).toEqual(['msg-0', 'msg-1']);
  });

  it('filters by ?since= and ?before= cursors', async () => {
    insertSession('s1');
    insertTranscript('s1', { body: 'early', createdAt: '2026-01-01T00:00:00.000Z' });
    insertTranscript('s1', { body: 'middle', createdAt: '2026-01-01T00:05:00.000Z' });
    insertTranscript('s1', { body: 'late', createdAt: '2026-01-01T00:10:00.000Z' });

    const sinceRes = await server.inject({
      method: 'GET',
      url: '/api/v1/sessions/s1/transcript?since=2026-01-01T00:00:00.000Z',
    });
    const sinceBody = JSON.parse(sinceRes.body) as { transcript: Array<{ body: string }> };
    expect(sinceBody.transcript.map((t) => t.body)).toEqual(['middle', 'late']);

    const beforeRes = await server.inject({
      method: 'GET',
      url: '/api/v1/sessions/s1/transcript?before=2026-01-01T00:10:00.000Z',
    });
    const beforeBody = JSON.parse(beforeRes.body) as { transcript: Array<{ body: string }> };
    expect(beforeBody.transcript.map((t) => t.body)).toEqual(['early', 'middle']);
  });
});

describe('GET /api/v1/attachments/:id', () => {
  let server: FastifyInstance;
  let db: Database.Database;

  beforeEach(async () => {
    ({ server, db } = await makeServer());
  });

  afterEach(async () => {
    await server.close();
  });

  function insertAttachment(id: string, expiresAt: number) {
    const now = Date.now();
    db.prepare(
      `INSERT INTO attachments (id, agent_id, local_path, original_filename, mime_type, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, 'agent:claude', '/tmp/logo.png', 'logo.png', 'image/png', now, expiresAt);
  }

  it('returns the attachment for a live row', async () => {
    insertAttachment('att-1', Date.now() + 60_000);
    const res = await server.inject({ method: 'GET', url: '/api/v1/attachments/att-1' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; attachment: { local_path: string; mime_type: string } };
    expect(body.ok).toBe(true);
    expect(body.attachment.local_path).toBe('/tmp/logo.png');
    expect(body.attachment.mime_type).toBe('image/png');
  });

  it('returns 404 for an unknown id', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/v1/attachments/nope' });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 for an expired attachment', async () => {
    insertAttachment('att-old', Date.now() - 1000);
    const res = await server.inject({ method: 'GET', url: '/api/v1/attachments/att-old' });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /api/v1/messages/:id/react', () => {
  let server: FastifyInstance;
  let db: Database.Database;
  let registry: AdapterRegistry;

  beforeEach(async () => {
    ({ server, db, registry } = await makeServer());
  });

  afterEach(async () => {
    await server.close();
  });

  function insertTranscript(msgId: string, channel: string, metadata = '{}') {
    const sessionId = randomUUID();
    db.prepare(
      `INSERT INTO sessions (id, conversation_id, channel, contact_id, started_at, last_activity, message_count)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(sessionId, 'conv-1', channel, 'contact:alice', new Date().toISOString(), new Date().toISOString(), 1);
    db.prepare(
      `INSERT INTO transcripts (id, message_id, conversation_id, session_id, created_at, channel, contact_id, direction, body, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(randomUUID(), msgId, 'conv-1', sessionId, new Date().toISOString(), channel, 'contact:alice', 'inbound', 'hi', metadata);
  }

  it('returns 404 for unknown message', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/messages/no-such-msg/react',
      payload: { emoji: '👍' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 400 when adapter does not support reactions', async () => {
    const msgId = randomUUID();
    insertTranscript(msgId, 'telegram');
    registry.register(makeStubAdapter({ id: 'telegram', channels: ['telegram'], canReact: false }));

    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/messages/${msgId}/react`,
      payload: { emoji: '👍' },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { success: boolean; reason: string };
    expect(body.success).toBe(false);
    expect(body.reason).toContain('Reactions not supported');
  });

  it('calls adapter.react() and returns success', async () => {
    const msgId = randomUUID();
    insertTranscript(msgId, 'telegram', JSON.stringify({ platform_message_id: 'plat-123' }));

    let calledWith: { platformId: string; emoji: string } | null = null;
    registry.register(
      makeStubAdapter({
        id: 'telegram',
        channels: ['telegram'],
        canReact: true,
        reactFn: async (platformId, emoji) => {
          calledWith = { platformId, emoji };
        },
      })
    );

    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/messages/${msgId}/react`,
      payload: { emoji: '❤️' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { ok: boolean; success: boolean };
    expect(body.success).toBe(true);
    expect(calledWith).toEqual({ platformId: 'plat-123', emoji: '❤️' });
  });

  it('uses message_id as fallback when platform_message_id is absent', async () => {
    const msgId = randomUUID();
    insertTranscript(msgId, 'telegram', '{}');

    let calledPlatformId: string | null = null;
    registry.register(
      makeStubAdapter({
        id: 'telegram',
        channels: ['telegram'],
        canReact: true,
        reactFn: async (platformId) => {
          calledPlatformId = platformId;
        },
      })
    );

    await server.inject({
      method: 'POST',
      url: `/api/v1/messages/${msgId}/react`,
      payload: { emoji: '👍' },
    });
    expect(calledPlatformId).toBe(msgId);
  });
});

// ── Memory API (E8) ───────────────────────────────────────────────────────────

describe('POST /api/v1/memories', () => {
  let server: FastifyInstance;
  let db: Database.Database;

  beforeEach(async () => {
    ({ server, db } = await makeServer());
  });

  afterEach(async () => {
    await server.close();
  });

  it('creates a memory and returns 201', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/memories',
      payload: { contact_id: 'alice', content: 'Alice prefers morning meetings', category: 'preference' },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { ok: boolean; id: string; superseded: string | null };
    expect(body.ok).toBe(true);
    expect(typeof body.id).toBe('string');
    expect(body.superseded).toBeNull();
  });

  it('supersedes the previous active memory for same contact+category', async () => {
    const r1 = await server.inject({
      method: 'POST',
      url: '/api/v1/memories',
      payload: { contact_id: 'alice', content: 'Alice likes tea', category: 'preference' },
    });
    const { id: firstId } = JSON.parse(r1.body) as { id: string };

    const r2 = await server.inject({
      method: 'POST',
      url: '/api/v1/memories',
      payload: { contact_id: 'alice', content: 'Alice now likes coffee', category: 'preference' },
    });
    expect(r2.statusCode).toBe(201);
    const body2 = JSON.parse(r2.body) as { id: string; superseded: string };
    expect(body2.superseded).toBe(firstId);

    const first = db.prepare('SELECT superseded_by FROM memories WHERE id = ?').get(firstId) as { superseded_by: string };
    expect(first.superseded_by).toBe(body2.id);
  });

  it('does not supersede memories of a different category', async () => {
    await server.inject({
      method: 'POST',
      url: '/api/v1/memories',
      payload: { contact_id: 'alice', content: 'Alice is a developer', category: 'fact' },
    });
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/memories',
      payload: { contact_id: 'alice', content: 'Alice prefers mornings', category: 'preference' },
    });
    expect(JSON.parse(res.body).superseded).toBeNull();
  });

  it('rejects an invalid category with 400', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/memories',
      payload: { contact_id: 'alice', content: 'foo', category: 'admin' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects missing contact_id with 400', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/memories',
      payload: { content: 'foo', category: 'general' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects missing content with 400', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/memories',
      payload: { contact_id: 'alice', category: 'general' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /api/v1/memories/recall', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    ({ server } = await makeServer());
    // Seed memories
    await server.inject({
      method: 'POST',
      url: '/api/v1/memories',
      payload: { contact_id: 'alice', content: 'Alice enjoys hiking on weekends', category: 'preference' },
    });
    await server.inject({
      method: 'POST',
      url: '/api/v1/memories',
      payload: { contact_id: 'bob', content: 'Bob is a software engineer', category: 'work' },
    });
  });

  afterEach(async () => {
    await server.close();
  });

  it('returns 400 when q is missing', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/v1/memories/recall' });
    expect(res.statusCode).toBe(400);
  });

  it('returns memories matching the query', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/v1/memories/recall?q=hiking' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { ok: boolean; memories: { content: string }[]; count: number };
    expect(body.ok).toBe(true);
    expect(body.count).toBeGreaterThan(0);
    expect(body.memories[0]!.content).toContain('hiking');
  });

  it('filters results by contact_id', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/v1/memories/recall?q=engineer&contact_id=bob' });
    const body = JSON.parse(res.body) as { memories: { contact_id: string }[] };
    expect(body.memories.every((m) => m.contact_id === 'bob')).toBe(true);
  });

  it('filters results by category', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/v1/memories/recall?q=hiking&category=preference' });
    const body = JSON.parse(res.body) as { memories: { category: string }[] };
    expect(body.memories.every((m) => m.category === 'preference')).toBe(true);
  });

  it('does not return superseded memories', async () => {
    // Create a memory then supersede it
    const r1 = await server.inject({
      method: 'POST',
      url: '/api/v1/memories',
      payload: { contact_id: 'carol', content: 'Carol drives a sedan', category: 'fact' },
    });
    const { id: oldId } = JSON.parse(r1.body) as { id: string };
    await server.inject({
      method: 'POST',
      url: '/api/v1/memories',
      payload: { contact_id: 'carol', content: 'Carol now drives an EV', category: 'fact' },
    });

    const res = await server.inject({ method: 'GET', url: '/api/v1/memories/recall?q=sedan' });
    const body = JSON.parse(res.body) as { memories: { id: string }[] };
    expect(body.memories.find((m) => m.id === oldId)).toBeUndefined();
  });

  it('clamps limit to a maximum of 50', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/v1/memories/recall?q=hiking&limit=999' });
    expect(res.statusCode).toBe(200);
  });
});

// ── Schedule endpoints (E18) ──────────────────────────────────────────────────

describe('Schedule CRUD endpoints', () => {
  let server: FastifyInstance;
  let db: Database.Database;

  beforeEach(async () => {
    ({ server, db } = await makeServer());
  });

  afterEach(async () => {
    await server.close();
  });

  const futureAt = new Date(Date.now() + 3_600_000).toISOString(); // 1 hour ahead

  // ── POST /api/v1/schedules ────────────────────────────────────────────────

  it('creates a once schedule and returns 201', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/schedules',
      payload: {
        type: 'once',
        fire_at: futureAt,
        channel: 'telegram',
        sender: 'contact:chris',
        payload_body: 'Remind me',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { ok: boolean; id: string; fire_at: string };
    expect(body.ok).toBe(true);
    expect(body.id).toBeTruthy();
    expect(body.fire_at).toBe(futureAt);
  });

  it('creates a cron schedule and returns 201', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/schedules',
      payload: {
        type: 'cron',
        cron_expr: '0 8 * * 1-5',
        timezone: 'UTC',
        channel: 'telegram',
        sender: 'contact:chris',
        payload_body: 'Morning briefing',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { ok: boolean; id: string; fire_at: string };
    expect(body.ok).toBe(true);
    expect(body.fire_at).toBeTruthy();
  });

  it('rejects a once schedule with fire_at in the past', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/schedules',
      payload: {
        type: 'once',
        fire_at: '2020-01-01T00:00:00Z',
        channel: 'telegram',
        sender: 'contact:chris',
        payload_body: 'Old reminder',
      },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { ok: false; error: string };
    expect(body.error).toMatch(/future/i);
  });

  it('rejects a cron schedule with an invalid expression', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/schedules',
      payload: {
        type: 'cron',
        cron_expr: 'NOT_A_CRON',
        channel: 'telegram',
        sender: 'contact:chris',
        payload_body: 'Bad cron',
      },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { ok: false; error: string };
    expect(body.error).toMatch(/cron/i);
  });

  it('rejects a once schedule missing fire_at', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/schedules',
      payload: { type: 'once', channel: 'telegram', sender: 'contact:chris', payload_body: 'Hi' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a cron schedule missing cron_expr', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/schedules',
      payload: { type: 'cron', channel: 'telegram', sender: 'contact:chris', payload_body: 'Hi' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('creates a once schedule with stale_after_ms', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/schedules',
      payload: {
        type: 'once',
        fire_at: futureAt,
        channel: 'telegram',
        sender: 'contact:chris',
        payload_body: 'Wake up',
        stale_after_ms: 45 * 60 * 1000,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { ok: boolean; id: string };
    const row = db.prepare(`SELECT stale_after_ms FROM scheduled_items WHERE id = ?`).get(body.id) as {
      stale_after_ms: number;
    };
    expect(row.stale_after_ms).toBe(45 * 60 * 1000);
  });

  // ── E53 S53.3: model + default topic ──────────────────────────────────────

  it('creates a schedule with a model and persists it', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/schedules',
      payload: {
        type: 'once',
        fire_at: futureAt,
        channel: 'telegram',
        sender: 'contact:chris',
        payload_body: 'Wake up',
        model: 'haiku',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { id: string };
    const row = db.prepare(`SELECT model FROM scheduled_items WHERE id = ?`).get(body.id) as {
      model: string | null;
    };
    expect(row.model).toBe('haiku');
  });

  it('rejects an empty-string model', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/schedules',
      payload: {
        type: 'once',
        fire_at: futureAt,
        channel: 'telegram',
        sender: 'contact:chris',
        payload_body: 'Wake up',
        model: '',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a model longer than 100 characters', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/schedules',
      payload: {
        type: 'once',
        fire_at: futureAt,
        channel: 'telegram',
        sender: 'contact:chris',
        payload_body: 'Wake up',
        model: 'x'.repeat(101),
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('a cron schedule created without a topic gets sched:<label-slug>', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/schedules',
      payload: {
        type: 'cron',
        cron_expr: '0 8 * * 1-5',
        channel: 'telegram',
        sender: 'system:scheduler',
        payload_body: 'Check the inbox',
        label: 'Email Watch!!',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { id: string; topic: string };
    expect(body.topic).toBe('sched:email-watch');
    const row = db.prepare(`SELECT topic FROM scheduled_items WHERE id = ?`).get(body.id) as {
      topic: string;
    };
    expect(row.topic).toBe('sched:email-watch');
  });

  it('a cron schedule created without a topic or label falls back to sched:<id8>', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/schedules',
      payload: {
        type: 'cron',
        cron_expr: '0 8 * * 1-5',
        channel: 'telegram',
        sender: 'system:scheduler',
        payload_body: 'Check the inbox',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { id: string; topic: string };
    expect(body.topic).toBe(`sched:${body.id.slice(0, 8)}`);
  });

  it('a once schedule created without a topic stays general', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/schedules',
      payload: {
        type: 'once',
        fire_at: futureAt,
        channel: 'telegram',
        sender: 'contact:chris',
        payload_body: 'Reminder',
        label: 'Some label',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { id: string; topic: string };
    expect(body.topic).toBe('general');
  });

  it('honors an explicit topic over the D1 default', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/schedules',
      payload: {
        type: 'cron',
        cron_expr: '0 8 * * 1-5',
        channel: 'telegram',
        sender: 'system:scheduler',
        payload_body: 'Check the inbox',
        label: 'Email Watch',
        topic: 'custom-topic',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { topic: string };
    expect(body.topic).toBe('custom-topic');
  });

  it('rejects stale_after_ms set alongside type: cron', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/schedules',
      payload: {
        type: 'cron',
        cron_expr: '0 8 * * 1-5',
        channel: 'telegram',
        sender: 'contact:chris',
        payload_body: 'Morning briefing',
        stale_after_ms: 60_000,
      },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { ok: false; error: string };
    expect(body.error).toMatch(/stale_after_ms/i);
  });

  // ── GET /api/v1/schedules ─────────────────────────────────────────────────

  it('lists schedules filtered by status', async () => {
    // Create two schedules
    await server.inject({
      method: 'POST',
      url: '/api/v1/schedules',
      payload: { type: 'once', fire_at: futureAt, channel: 'telegram', sender: 'contact:chris', payload_body: 'A' },
    });
    await server.inject({
      method: 'POST',
      url: '/api/v1/schedules',
      payload: { type: 'once', fire_at: futureAt, channel: 'telegram', sender: 'contact:chris', payload_body: 'B' },
    });

    const res = await server.inject({ method: 'GET', url: '/api/v1/schedules?status=active' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { schedules: unknown[]; count: number };
    expect(body.count).toBe(2);
  });

  it('returns empty list when no schedules match', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/v1/schedules?status=cancelled' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { schedules: unknown[]; count: number };
    expect(body.count).toBe(0);
  });

  // ── GET /api/v1/schedules/:id ─────────────────────────────────────────────

  it('returns a specific schedule by id', async () => {
    const createRes = await server.inject({
      method: 'POST',
      url: '/api/v1/schedules',
      payload: { type: 'once', fire_at: futureAt, channel: 'telegram', sender: 'contact:chris', payload_body: 'X' },
    });
    const { id } = JSON.parse(createRes.body) as { id: string };

    const res = await server.inject({ method: 'GET', url: `/api/v1/schedules/${id}` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { ok: boolean; schedule: { id: string } };
    expect(body.schedule.id).toBe(id);
  });

  it('returns 404 for an unknown schedule id', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/v1/schedules/no-such-id' });
    expect(res.statusCode).toBe(404);
  });

  // ── DELETE /api/v1/schedules/:id ─────────────────────────────────────────

  it('cancels an active schedule', async () => {
    const createRes = await server.inject({
      method: 'POST',
      url: '/api/v1/schedules',
      payload: { type: 'once', fire_at: futureAt, channel: 'telegram', sender: 'contact:chris', payload_body: 'Y' },
    });
    const { id } = JSON.parse(createRes.body) as { id: string };

    const res = await server.inject({ method: 'DELETE', url: `/api/v1/schedules/${id}` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { ok: boolean; id: string };
    expect(body.ok).toBe(true);
    expect(body.id).toBe(id);

    // Verify status in DB
    const row = db.prepare(`SELECT status FROM scheduled_items WHERE id = ?`).get(id) as { status: string };
    expect(row.status).toBe('cancelled');
  });

  it('returns 404 when cancelling a non-existent schedule', async () => {
    const res = await server.inject({ method: 'DELETE', url: '/api/v1/schedules/ghost' });
    expect(res.statusCode).toBe(404);
  });

  // ── PATCH /api/v1/schedules/:id ───────────────────────────────────────────

  it('updates label on an active schedule', async () => {
    const createRes = await server.inject({
      method: 'POST',
      url: '/api/v1/schedules',
      payload: { type: 'once', fire_at: futureAt, channel: 'telegram', sender: 'contact:chris', payload_body: 'Z' },
    });
    const { id } = JSON.parse(createRes.body) as { id: string };

    const res = await server.inject({
      method: 'PATCH',
      url: `/api/v1/schedules/${id}`,
      payload: { label: 'My label' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { ok: boolean; schedule: { label: string } };
    expect(body.schedule.label).toBe('My label');
  });

  it('pauses an active schedule via PATCH', async () => {
    const createRes = await server.inject({
      method: 'POST',
      url: '/api/v1/schedules',
      payload: { type: 'once', fire_at: futureAt, channel: 'telegram', sender: 'contact:chris', payload_body: 'W' },
    });
    const { id } = JSON.parse(createRes.body) as { id: string };

    const res = await server.inject({
      method: 'PATCH',
      url: `/api/v1/schedules/${id}`,
      payload: { status: 'paused' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { ok: boolean; schedule: { status: string } };
    expect(body.schedule.status).toBe('paused');
  });

  it('completes a schedule immediately when max_fires is set <= fire_count', async () => {
    const createRes = await server.inject({
      method: 'POST',
      url: '/api/v1/schedules',
      payload: {
        type: 'cron',
        cron_expr: '0 8 * * *',
        channel: 'telegram',
        sender: 'contact:chris',
        payload_body: 'Daily',
      },
    });
    const { id } = JSON.parse(createRes.body) as { id: string };

    // Manually bump fire_count to 5
    db.prepare(`UPDATE scheduled_items SET fire_count = 5 WHERE id = ?`).run(id);

    const res = await server.inject({
      method: 'PATCH',
      url: `/api/v1/schedules/${id}`,
      payload: { max_fires: 3 },   // 3 <= 5
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { ok: boolean; schedule: { status: string } };
    expect(body.schedule.status).toBe('completed');
  });

  it('returns 400 when no updatable fields are provided', async () => {
    const createRes = await server.inject({
      method: 'POST',
      url: '/api/v1/schedules',
      payload: { type: 'once', fire_at: futureAt, channel: 'telegram', sender: 'contact:chris', payload_body: 'V' },
    });
    const { id } = JSON.parse(createRes.body) as { id: string };

    const res = await server.inject({ method: 'PATCH', url: `/api/v1/schedules/${id}`, payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it('updates topic and model on an active schedule', async () => {
    const createRes = await server.inject({
      method: 'POST',
      url: '/api/v1/schedules',
      payload: { type: 'once', fire_at: futureAt, channel: 'telegram', sender: 'contact:chris', payload_body: 'Q' },
    });
    const { id } = JSON.parse(createRes.body) as { id: string };

    const res = await server.inject({
      method: 'PATCH',
      url: `/api/v1/schedules/${id}`,
      payload: { topic: 'sched:custom', model: 'haiku' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { ok: boolean; schedule: { topic: string; model: string } };
    expect(body.schedule.topic).toBe('sched:custom');
    expect(body.schedule.model).toBe('haiku');
  });

  it('clears model via PATCH with model: null', async () => {
    const createRes = await server.inject({
      method: 'POST',
      url: '/api/v1/schedules',
      payload: {
        type: 'once',
        fire_at: futureAt,
        channel: 'telegram',
        sender: 'contact:chris',
        payload_body: 'R',
        model: 'haiku',
      },
    });
    const { id } = JSON.parse(createRes.body) as { id: string };

    const res = await server.inject({
      method: 'PATCH',
      url: `/api/v1/schedules/${id}`,
      payload: { model: null },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { ok: boolean; schedule: { model: string | null } };
    expect(body.schedule.model).toBeNull();
  });

  it('rejects an empty-string topic via PATCH', async () => {
    const createRes = await server.inject({
      method: 'POST',
      url: '/api/v1/schedules',
      payload: { type: 'once', fire_at: futureAt, channel: 'telegram', sender: 'contact:chris', payload_body: 'S' },
    });
    const { id } = JSON.parse(createRes.body) as { id: string };

    const res = await server.inject({
      method: 'PATCH',
      url: `/api/v1/schedules/${id}`,
      payload: { topic: '' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 for PATCH on an unknown schedule', async () => {
    const res = await server.inject({
      method: 'PATCH',
      url: '/api/v1/schedules/ghost',
      payload: { label: 'X' },
    });
    expect(res.statusCode).toBe(404);
  });
});

// ── GET /api/v1/pool (E48 S48.8) ─────────────────────────────────────────────

describe('GET /api/v1/pool', () => {
  /** Mirrors pool-manager.test.ts's own makeCfg — a fully-populated CcPoolInstanceConfig fixture. */
  function makeCfg(overrides: Partial<CcPoolInstanceConfig> = {}): CcPoolInstanceConfig {
    return {
      name: null,
      agent_id: 'peggy',
      tmux_session: 'peggy-pool',
      panes: 2,
      growth: 'fixed',
      max_panes: 2,
      claude_bin: '/usr/local/bin/claude',
      model: undefined,
      working_dir: '/work/dir',
      launch_args: [],
      poll_interval_ms: 1000,
      system_prompt: undefined,
      lease: { idle_evict_ms: 1_800_000, hard_idle_ms: 21_600_000, park_timeout_ms: 300_000 },
      on_evict: 'clear',
      launch_ack_delay_ms: 500,
      launch_ack_max_attempts: 3,
      launch_ack_pattern: 'experimental',
      pane_env: {},
      ...overrides,
    };
  }

  /** A no-op PaneLauncher stub — these tests only exercise leaseStore/parkedStatus
   *  reads, never launch()/release(), so a fake is enough (mirrors pool-manager.test.ts). */
  function makeFakePaneLauncher() {
    return { launch: async () => {}, release: async () => {} };
  }

  function makeManager(db: Database.Database, cfgOverrides: Partial<CcPoolInstanceConfig> = {}): PoolManager {
    const cfg = makeCfg(cfgOverrides);
    return new PoolManager({ cfg, db, busBaseUrl: 'http://127.0.0.1:3000', paneLauncher: makeFakePaneLauncher() });
  }

  /** A minimal MessageEnvelope parked under `recipient` (normally a pool's parkedRecipientId()). */
  function parkEnvelope(conversationId: string, recipient: string): MessageEnvelope {
    return {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      channel: 'telegram',
      topic: 'general',
      sender: 'contact:bob',
      recipient,
      reply_to: null,
      priority: 'normal',
      payload: { type: 'text', body: 'hello' },
      metadata: { conversation_id: conversationId },
    };
  }

  let server: FastifyInstance;

  afterEach(async () => {
    await server.close();
  });

  it('returns { ok: true, pools: [] } when no poolManagers are configured', async () => {
    ({ server } = await makeServer());

    const res = await server.inject({ method: 'GET', url: '/api/v1/pool' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, pools: [] });
  });

  it('returns pane rows with correct shape/values for one configured pool with mixed pane states', async () => {
    const fixtureDb = makeDb();
    const manager = makeManager(fixtureDb);
    manager.leaseStore.seedPanes('peggy', [
      { paneId: 'peggy-pool:1', agentId: 'agent:peggy-pool-1' },
      { paneId: 'peggy-pool:2', agentId: 'agent:peggy-pool-2' },
    ]);
    const acquired = manager.leaseStore.acquire('peggy', 'conv-a', {
      poolAgentId: 'peggy',
      panes: 2,
      maxPanes: 2,
      growth: 'fixed',
      idleEvictMs: 1_800_000,
    });
    if (acquired.kind !== 'bound') throw new Error(`test setup: expected "bound", got "${acquired.kind}"`);
    manager.leaseStore.confirmReady('peggy', acquired.lease.pane_id);

    const poolManagers = new Map([['agent:peggy', manager]]);
    ({ server } = await makeServer({ poolManagers }));

    const res = await server.inject({ method: 'GET', url: '/api/v1/pool' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      ok: boolean;
      pools: Array<{
        pool_id: string;
        agent_id: string;
        panes: Array<{ pane_id: string; agent_id: string; state: string; conversation_id: string | null }>;
        parked: { count: number; oldest_parked_at: string | null };
      }>;
    };
    expect(body.ok).toBe(true);
    expect(body.pools).toHaveLength(1);
    const pool = body.pools[0]!;
    expect(pool.pool_id).toBe('peggy');
    expect(pool.agent_id).toBe('agent:peggy');
    expect(pool.panes).toHaveLength(2);

    const leasedPane = pool.panes.find((p) => p.pane_id === 'peggy-pool:1')!;
    expect(leasedPane.state).toBe('leased');
    expect(leasedPane.agent_id).toBe('agent:peggy-pool-1');
    expect(leasedPane.conversation_id).toBe('conv-a');

    const freePane = pool.panes.find((p) => p.pane_id === 'peggy-pool:2')!;
    expect(freePane.state).toBe('free');
    expect(freePane.conversation_id).toBeNull();

    expect(pool.parked).toEqual({ count: 0, oldest_parked_at: null });
  });

  it('?pool= narrows the result to the matching pool', async () => {
    const fixtureDb = makeDb();
    const peggy = makeManager(fixtureDb, { agent_id: 'peggy', tmux_session: 'peggy-pool' });
    const otherbot = makeManager(fixtureDb, { agent_id: 'otherbot', tmux_session: 'otherbot-pool' });
    peggy.leaseStore.seedPanes('peggy', [{ paneId: 'peggy-pool:1', agentId: 'agent:peggy-pool-1' }]);
    otherbot.leaseStore.seedPanes('otherbot', [{ paneId: 'otherbot-pool:1', agentId: 'agent:otherbot-pool-1' }]);
    const poolManagers = new Map([
      ['agent:peggy', peggy],
      ['agent:otherbot', otherbot],
    ]);
    ({ server } = await makeServer({ poolManagers }));

    const res = await server.inject({ method: 'GET', url: '/api/v1/pool?pool=agent:peggy' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { ok: boolean; pools: Array<{ pool_id: string }> };
    expect(body.pools).toHaveLength(1);
    expect(body.pools[0]!.pool_id).toBe('peggy');
  });

  it('?pool= for a nonexistent pool returns 404', async () => {
    const fixtureDb = makeDb();
    const manager = makeManager(fixtureDb);
    manager.leaseStore.seedPanes('peggy', [{ paneId: 'peggy-pool:1', agentId: 'agent:peggy-pool-1' }]);
    const poolManagers = new Map([['agent:peggy', manager]]);
    ({ server } = await makeServer({ poolManagers }));

    const res = await server.inject({ method: 'GET', url: '/api/v1/pool?pool=agent:ghost' });
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('agent:ghost');
  });

  it('reflects parked count and oldest-parked timestamp', async () => {
    const fixtureDb = makeDb();
    const manager = makeManager(fixtureDb);
    manager.leaseStore.seedPanes('peggy', [{ paneId: 'peggy-pool:1', agentId: 'agent:peggy-pool-1' }]);
    const fixtureQueue = new MessageQueue(fixtureDb);
    fixtureQueue.enqueue(parkEnvelope('conv-parked-1', manager.parkedRecipientId()));
    fixtureQueue.enqueue(parkEnvelope('conv-parked-2', manager.parkedRecipientId()));

    const poolManagers = new Map([['agent:peggy', manager]]);
    ({ server } = await makeServer({ poolManagers }));

    const res = await server.inject({ method: 'GET', url: '/api/v1/pool' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      pools: Array<{ parked: { count: number; oldest_parked_at: string | null } }>;
    };
    expect(body.pools[0]!.parked.count).toBe(2);
    expect(body.pools[0]!.parked.oldest_parked_at).not.toBeNull();
  });
});

// ── POST /api/v1/pool/:agentId/turn-ended ────────────────────────────────────

describe('POST /api/v1/pool/:agentId/turn-ended', () => {
  function makeCfg(overrides: Partial<CcPoolInstanceConfig> = {}): CcPoolInstanceConfig {
    return {
      name: null,
      agent_id: 'peggy',
      tmux_session: 'peggy-pool',
      panes: 2,
      growth: 'fixed',
      max_panes: 2,
      claude_bin: '/usr/local/bin/claude',
      model: undefined,
      working_dir: '/work/dir',
      launch_args: [],
      poll_interval_ms: 1000,
      system_prompt: undefined,
      lease: { idle_evict_ms: 1_800_000, hard_idle_ms: 21_600_000, park_timeout_ms: 300_000 },
      on_evict: 'clear',
      launch_ack_delay_ms: 500,
      launch_ack_max_attempts: 3,
      launch_ack_pattern: 'experimental',
      pane_env: {},
      ...overrides,
    };
  }

  function makeFakePaneLauncher() {
    return { launch: async () => {}, release: async () => {} };
  }

  function makeManager(db: Database.Database, cfgOverrides: Partial<CcPoolInstanceConfig> = {}): PoolManager {
    const cfg = makeCfg(cfgOverrides);
    return new PoolManager({ cfg, db, busBaseUrl: 'http://127.0.0.1:3000', paneLauncher: makeFakePaneLauncher() });
  }

  let server: FastifyInstance;

  afterEach(async () => {
    await server.close();
  });

  it('touches the pane whose claude_session_id matches the body', async () => {
    const fixtureDb = makeDb();
    const manager = makeManager(fixtureDb);
    manager.leaseStore.seedPanes('peggy', [{ paneId: 'peggy-pool:1', agentId: 'agent:peggy-pool-1' }]);
    const acquired = manager.leaseStore.acquire('peggy', 'conv-a', {
      poolAgentId: 'peggy',
      panes: 1,
      maxPanes: 1,
      growth: 'fixed',
      idleEvictMs: 1_800_000,
    });
    if (acquired.kind !== 'bound') throw new Error(`test setup: expected "bound", got "${acquired.kind}"`);
    manager.leaseStore.confirmReady('peggy', acquired.lease.pane_id);
    manager.leaseStore.setClaudeSessionId('peggy', acquired.lease.pane_id, 'sess-123');
    const before = manager.leaseStore.list('peggy').find((p) => p.pane_id === acquired.lease.pane_id)!.last_activity_at;

    const poolManagers = new Map([['agent:peggy', manager]]);
    ({ server } = await makeServer({ poolManagers }));

    // Ensure the clock advances so a touch is observable even on a fast test run.
    await new Promise((r) => setTimeout(r, 5));
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/pool/peggy/turn-ended',
      payload: { session_id: 'sess-123' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });

    const after = manager.leaseStore.list('peggy').find((p) => p.pane_id === acquired.lease.pane_id)!.last_activity_at;
    expect(after).not.toBe(before);
    const paneRow = manager.leaseStore.list('peggy').find((p) => p.pane_id === acquired.lease.pane_id)!;
    expect(paneRow.last_turn_ended_at).not.toBeNull();
    expect(paneRow.last_turn_ended_at).toBe(paneRow.last_activity_at);
  });

  it('no-ops with 200 when the agentId has no configured pool', async () => {
    ({ server } = await makeServer());

    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/pool/ghost/turn-ended',
      payload: { session_id: 'sess-123' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });

  it('no-ops with 200 when no pane matches the given session_id', async () => {
    const fixtureDb = makeDb();
    const manager = makeManager(fixtureDb);
    manager.leaseStore.seedPanes('peggy', [{ paneId: 'peggy-pool:1', agentId: 'agent:peggy-pool-1' }]);
    const poolManagers = new Map([['agent:peggy', manager]]);
    ({ server } = await makeServer({ poolManagers }));

    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/pool/peggy/turn-ended',
      payload: { session_id: 'sess-unknown' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });
});

// ── Approval requests (E51) ──────────────────────────────────────────────────

describe('approval requests (E51)', () => {
  const DIALOG = 'Do you want to proceed?\n ❯ 1. Yes\n   2. No\nEsc to cancel · Tab to amend';
  let server: FastifyInstance;

  afterEach(async () => {
    await server.close();
  });

  function makeCfg(): CcPoolInstanceConfig {
    return {
      name: null,
      agent_id: 'peggy',
      tmux_session: 'peggy-pool',
      panes: 1,
      growth: 'fixed',
      max_panes: 1,
      claude_bin: '/usr/local/bin/claude',
      model: undefined,
      working_dir: '/work/dir',
      launch_args: [],
      poll_interval_ms: 1000,
      system_prompt: undefined,
      lease: { idle_evict_ms: 1_800_000, hard_idle_ms: 21_600_000, park_timeout_ms: 300_000 },
      on_evict: 'clear',
      launch_ack_delay_ms: 500,
      launch_ack_max_attempts: 3,
      launch_ack_pattern: 'experimental',
      pane_env: {},
    };
  }

  /** A server over one leased cc-pool pane (session "sess-1", conversation conv-a) with a notifying stub adapter. */
  async function setup(opts: { notify?: boolean } = {}) {
    const db = makeDb();
    const sendKeys = vi.fn(async (_target: string, _keys: string) => {});
    const manager = new PoolManager({
      cfg: makeCfg(),
      db,
      busBaseUrl: 'http://127.0.0.1:3000',
      paneLauncher: { launch: async () => {}, release: async () => {} },
      tmux: {
        ensureSession: async () => {},
        listWindows: async () => [],
        createWindow: async () => '',
        killWindow: async () => {},
        sendKeys,
        sendCommand: async () => {},
        paneAlive: async () => true,
        paneCommand: async () => null,
        capturePane: async () => DIALOG,
      },
    });
    manager.leaseStore.seedPanes('peggy', [{ paneId: 'peggy-pool:1', agentId: 'agent:peggy-pool-1' }]);
    const acquired = manager.leaseStore.acquire('peggy', 'conv-a', {
      poolAgentId: 'peggy',
      panes: 1,
      maxPanes: 1,
      growth: 'fixed',
      idleEvictMs: 1_800_000,
    });
    if (acquired.kind !== 'bound') throw new Error('test setup: expected "bound"');
    manager.leaseStore.confirmReady('peggy', acquired.lease.pane_id);
    manager.leaseStore.setClaudeSessionId('peggy', acquired.lease.pane_id, 'sess-1');
    db.prepare(
      `INSERT INTO sessions (id, conversation_id, channel, contact_id, started_at, last_activity, message_count)
       VALUES (?, 'conv-a', 'telegram', 'chris', ?, ?, 0)`,
    ).run(randomUUID(), new Date().toISOString(), new Date().toISOString());

    const notified: unknown[] = [];
    const made = await makeServer({ poolManagers: new Map([['agent:peggy', manager]]), db });
    server = made.server;
    made.registry.register({
      id: 'telegram',
      name: 'telegram',
      capabilities: { send: true, interactiveApproval: opts.notify !== false, channels: ['telegram'] },
      start: async () => {},
      stop: async () => {},
      health: async () => ({ status: 'healthy' as const }),
      send: async () => ({ success: true }),
      notifyApproval: async (req) => {
        notified.push(req);
        return { channel: 'telegram', messageId: '12345:9' };
      },
    });
    return { sendKeys, notified, db };
  }

  const body = { adapterId: 'cc-pool', sessionId: 'sess-1', toolName: 'Bash', summary: 'rm -rf build/' };
  const post = (payload: unknown) => server.inject({ method: 'POST', url: '/api/v1/approvals', payload: payload as object });

  it('creates a pending request from a session id, notifies the addressed contact, and records the message ref', async () => {
    const { notified } = await setup();

    const res = await post(body);

    expect(res.statusCode).toBe(200);
    const { id } = JSON.parse(res.body) as { id: string };
    expect(notified).toHaveLength(1);
    const got = await server.inject({ method: 'GET', url: `/api/v1/approvals/${id}` });
    expect(JSON.parse(got.body).approval).toMatchObject({
      status: 'pending',
      agent_id: 'peggy-pool-1',
      contact_id: 'chris',
      conversation_id: 'conv-a',
      notify_message_id: '12345:9',
    });
  });

  it('collapses a repeat of the same still-pending request into one notification', async () => {
    const { notified } = await setup();

    const first = JSON.parse((await post(body)).body) as { id: string };
    const second = JSON.parse((await post(body)).body) as { id: string; duplicate?: boolean };

    expect(second.id).toBe(first.id);
    expect(second.duplicate).toBe(true);
    expect(notified).toHaveLength(1);
  });

  it('marks the request stale, with a reason, when no adapter can notify', async () => {
    await setup({ notify: false });

    const { id } = JSON.parse((await post(body)).body) as { id: string };

    const got = JSON.parse((await server.inject({ method: 'GET', url: `/api/v1/approvals/${id}` })).body);
    expect(got.approval.status).toBe('stale');
    expect(got.approval.raw_context).toContain('interactiveApproval');
  });

  it('rejects a body with neither agentId nor sessionId (400)', async () => {
    await setup();
    expect((await post({ adapterId: 'cc-pool', toolName: 'Bash', summary: 'x' })).statusCode).toBe(400);
  });

  it('returns 422 for a session that belongs to no pane', async () => {
    await setup();
    expect((await post({ ...body, sessionId: 'unknown' })).statusCode).toBe(422);
  });

  it('lists requests, filtered by status', async () => {
    await setup();
    await post(body);

    const pending = JSON.parse((await server.inject({ method: 'GET', url: '/api/v1/approvals?status=pending' })).body);
    const approved = JSON.parse((await server.inject({ method: 'GET', url: '/api/v1/approvals?status=approved' })).body);

    expect(pending.approvals).toHaveLength(1);
    expect(approved.approvals).toHaveLength(0);
    expect((await server.inject({ method: 'GET', url: '/api/v1/approvals?status=bogus' })).statusCode).toBe(400);
  });

  it('resolve sends Enter into the pane for approve and reports the outcome', async () => {
    const { sendKeys } = await setup();
    const { id } = JSON.parse((await post(body)).body) as { id: string };

    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/approvals/${id}/resolve`,
      payload: { decision: 'approve', resolvedBy: 'contact:chris' },
    });

    expect(JSON.parse(res.body)).toMatchObject({ ok: true, outcome: 'approved' });
    expect(sendKeys).toHaveBeenCalledExactlyOnceWith('peggy-pool:1', 'Enter');
  });

  it('resolve validates the decision and 404s an unknown id', async () => {
    await setup();
    const { id } = JSON.parse((await post(body)).body) as { id: string };

    const bad = await server.inject({ method: 'POST', url: `/api/v1/approvals/${id}/resolve`, payload: { decision: 'maybe' } });
    const missing = await server.inject({ method: 'POST', url: '/api/v1/approvals/nope/resolve', payload: { decision: 'deny' } });

    expect(bad.statusCode).toBe(400);
    expect(missing.statusCode).toBe(404);
  });
});

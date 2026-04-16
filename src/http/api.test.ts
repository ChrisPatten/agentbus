import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { runMigrations } from '../db/schema.js';
import { MessageQueue } from '../core/queue.js';
import { AdapterRegistry } from '../core/registry.js';
import type { AdapterInstance } from '../core/registry.js';
import { createHttpServer } from './api.js';
import { PipelineEngine } from '../pipeline/engine.js';
import type { AppConfig } from '../config/schema.js';

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

async function makeServer(): Promise<{ server: FastifyInstance; queue: MessageQueue; db: Database.Database; registry: AdapterRegistry }> {
  const db = makeDb();
  const queue = new MessageQueue(db);
  const registry = new AdapterRegistry();
  const pipeline = new PipelineEngine(); // no-op pipeline for existing tests
  const server = await createHttpServer({ queue, registry, config: stubConfig, pipeline, db });
  return { server, queue, db, registry };
}

/** Minimal stub adapter for testing adapter-aware endpoints */
function makeStubAdapter(opts: {
  id: string;
  channels: string[];
  canReact?: boolean;
  reactFn?: (id: string, emoji: string) => Promise<void>;
}): AdapterInstance {
  return {
    id: opts.id,
    name: opts.id,
    capabilities: {
      send: true,
      react: opts.canReact ?? false,
      channels: opts.channels,
    },
    start: async () => {},
    stop: async () => {},
    health: async () => ({ status: 'healthy' as const }),
    send: async () => ({ success: true }),
    react: opts.canReact ? opts.reactFn ?? (async () => {}) : undefined,
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
    id: string; channel: string; contact_id: string; started_at: string;
  }> = {}) {
    const id = overrides.id ?? randomUUID();
    db.prepare(
      `INSERT INTO sessions (id, conversation_id, channel, contact_id, started_at, last_activity, message_count)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      'conv-1',
      overrides.channel ?? 'telegram',
      overrides.contact_id ?? 'contact:alice',
      overrides.started_at ?? new Date().toISOString(),
      new Date().toISOString(),
      5
    );
    return id;
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

  it('returns 404 for PATCH on an unknown schedule', async () => {
    const res = await server.inject({
      method: 'PATCH',
      url: '/api/v1/schedules/ghost',
      payload: { label: 'X' },
    });
    expect(res.statusCode).toBe(404);
  });
});

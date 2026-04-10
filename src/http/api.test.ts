import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { runMigrations } from '../db/schema.js';
import { MessageQueue } from '../core/queue.js';
import { AdapterRegistry } from '../core/registry.js';
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

async function makeServer(): Promise<{ server: FastifyInstance; queue: MessageQueue }> {
  const db = makeDb();
  const queue = new MessageQueue(db);
  const registry = new AdapterRegistry();
  const pipeline = new PipelineEngine(); // no-op pipeline for existing tests
  const server = await createHttpServer({ queue, registry, config: stubConfig, pipeline, db });
  return { server, queue };
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

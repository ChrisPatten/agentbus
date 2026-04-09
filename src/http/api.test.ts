import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { runMigrations } from '../db/schema.js';
import { MessageQueue } from '../core/queue.js';
import { AdapterRegistry } from '../core/registry.js';
import { createHttpServer } from './api.js';
import type { AppConfig } from '../config/schema.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

// Minimal config stub — createHttpServer no longer reads any config fields
// after the dead-code removal, but the signature still requires AppConfig.
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
  pipeline: {},
} as unknown as AppConfig;

async function makeServer(): Promise<{ server: FastifyInstance; queue: MessageQueue }> {
  const db = makeDb();
  const queue = new MessageQueue(db);
  const registry = new AdapterRegistry();
  const server = await createHttpServer(queue, registry, stubConfig);
  return { server, queue };
}

const validMessage = {
  channel: 'telegram',
  sender: 'contact:chris',
  recipient: 'agent:peggy',
  payload: { type: 'text', body: 'hello' },
};

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
        url: '/api/v1/messages/pending?agent=peggy&limit=-1',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { count: number };
      expect(body.count).toBe(1);
    });

    it('falls back to 10 on NaN limit (previously returned 0 via SQLite LIMIT NaN)', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/messages/pending?agent=peggy&limit=abc',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { count: number };
      // 3 messages enqueued, default limit=10, so all 3 returned
      expect(body.count).toBe(3);
    });

    it('treats limit=0 as the default (0 is falsy, falls back to 10)', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/messages/pending?agent=peggy&limit=0',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { count: number };
      expect(body.count).toBe(3); // 0 || 10 = 10, all 3 messages returned
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

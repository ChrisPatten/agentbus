/**
 * Integration tests for POST /api/v1/webhooks/pebble (E25).
 *
 * Exercises the full path: multipart request → bearer-token auth/identity
 * resolution → envelope construction → pipeline (normalize, dedup,
 * route-resolve, transcript-log) → queue.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { runMigrations } from '../db/schema.js';
import { MessageQueue } from '../core/queue.js';
import { AdapterRegistry } from '../core/registry.js';
import { createHttpServer } from './api.js';
import { PipelineEngine } from '../pipeline/engine.js';
import { normalize } from '../pipeline/stages/normalize.js';
import { createDedup } from '../pipeline/stages/dedup.js';
import { createRouteResolve } from '../pipeline/stages/route-resolve.js';
import { createTranscriptLog } from '../pipeline/stages/transcript-log.js';
import type { AppConfig } from '../config/schema.js';

const BOUNDARY = '----pebbletestboundary';

function multipartBody(fields: Record<string, string | undefined>): string {
  const parts = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(
      ([name, value]) =>
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    );
  return parts.join('') + `--${BOUNDARY}--\r\n`;
}

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    bus: { http_port: 0, db_path: ':memory:', log_level: 'info' },
    adapters: { pebble: { enabled: true, max_body_bytes: 65536 } },
    contacts: {
      chris: { id: 'chris', displayName: 'Chris', platforms: { pebble: { token: 'tok-chris' } } },
    },
    topics: ['general'],
    memory: { summarizer_interval_ms: 60000, session_idle_threshold_ms: 1800000, context_window_hours: 48, claude_api_model: 'claude-opus-4-6' },
    pipeline: {
      dedup_window_ms: 30000,
      drop_unrouted: false,
      topic_rules: [],
      priority_weights: { base_score: 0, topic_bonus: 40, vip_sender_bonus: 20, urgency_keyword_bonus: 15 },
      urgency_keywords: [],
      vip_contacts: [],
      routes: [{ match: { channel: 'pebble' }, target: { adapterId: 'cc-headless', recipientId: 'agent:peggy' } }],
    },
    ...overrides,
  } as unknown as AppConfig;
}

async function makeServer(config: AppConfig) {
  const db = makeDb();
  const queue = new MessageQueue(db);
  const registry = new AdapterRegistry();
  const pipeline = new PipelineEngine();
  pipeline.use({ slot: 10, name: 'normalize', stage: normalize });
  pipeline.use({ slot: 30, name: 'dedup', stage: createDedup(db, config.pipeline.dedup_window_ms) });
  pipeline.use({ slot: 70, name: 'route-resolve', stage: createRouteResolve(config, db) });
  pipeline.use({ slot: 80, name: 'transcript-log', stage: createTranscriptLog(db, config), critical: false });
  const server = await createHttpServer({ queue, registry, config, pipeline, db });
  return { server, queue, db };
}

describe('POST /api/v1/webhooks/pebble', () => {
  let server: FastifyInstance;
  let queue: MessageQueue;

  afterEach(async () => {
    await server?.close();
  });

  it('enqueues a message for the resolved contact on a valid request', async () => {
    ({ server, queue } = await makeServer(makeConfig()));

    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/webhooks/pebble',
      headers: {
        authorization: 'Bearer tok-chris',
        'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: multipartBody({ transcription: 'buy oat milk', recordedAt: '1735000000', client: 'ring' }),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.queued).toBe(true);

    const messages = queue.dequeue('agent:peggy', 'general', 10);
    expect(messages).toHaveLength(1);
    const envelope = messages[0]!.envelope;
    expect(envelope.channel).toBe('pebble');
    expect(envelope.sender).toBe('contact:chris');
    expect(envelope.payload).toEqual({ type: 'text', body: 'buy oat milk' });
    expect(envelope.metadata['recordedAt']).toBe(1735000000);
    expect(envelope.metadata['client']).toBe('ring');
    expect(envelope.metadata['source']).toBe('pebble');
  });

  it('rejects a missing Authorization header with 401 and enqueues nothing', async () => {
    ({ server, queue } = await makeServer(makeConfig()));

    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/webhooks/pebble',
      headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
      payload: multipartBody({ transcription: 'hello', recordedAt: '1735000000', client: 'ring' }),
    });

    expect(res.statusCode).toBe(401);
    expect(queue.dequeue('agent:peggy', 'general', 10)).toHaveLength(0);
  });

  it('rejects an unrecognized bearer token with 401', async () => {
    ({ server, queue } = await makeServer(makeConfig()));

    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/webhooks/pebble',
      headers: {
        authorization: 'Bearer not-a-real-token',
        'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: multipartBody({ transcription: 'hello', recordedAt: '1735000000', client: 'ring' }),
    });

    expect(res.statusCode).toBe(401);
  });

  it('rejects an empty transcription field with 400', async () => {
    ({ server, queue } = await makeServer(makeConfig()));

    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/webhooks/pebble',
      headers: {
        authorization: 'Bearer tok-chris',
        'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: multipartBody({ transcription: '', recordedAt: '1735000000', client: 'ring' }),
    });

    expect(res.statusCode).toBe(400);
    expect(queue.dequeue('agent:peggy', 'general', 10)).toHaveLength(0);
  });

  it('rejects a non-numeric recordedAt field with 400', async () => {
    ({ server, queue } = await makeServer(makeConfig()));

    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/webhooks/pebble',
      headers: {
        authorization: 'Bearer tok-chris',
        'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: multipartBody({ transcription: 'hello', recordedAt: 'not-a-number', client: 'ring' }),
    });

    expect(res.statusCode).toBe(400);
  });

  it('deduplicates a retried identical delivery', async () => {
    ({ server, queue } = await makeServer(makeConfig()));
    const payload = multipartBody({ transcription: 'buy oat milk', recordedAt: '1735000000', client: 'ring' });
    const headers = {
      authorization: 'Bearer tok-chris',
      'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
    };

    const first = await server.inject({ method: 'POST', url: '/api/v1/webhooks/pebble', headers, payload });
    const second = await server.inject({ method: 'POST', url: '/api/v1/webhooks/pebble', headers, payload });

    expect(first.statusCode).toBe(200);
    expect(first.json().queued).toBe(true);
    expect(second.statusCode).toBe(200);
    expect(second.json().queued).toBe(false);
    expect(queue.dequeue('agent:peggy', 'general', 10)).toHaveLength(1);
  });

  it('rejects a request with no matching route (404) when adapters.pebble is not configured', async () => {
    ({ server, queue } = await makeServer(makeConfig({ adapters: {} } as Partial<AppConfig>)));

    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/webhooks/pebble',
      headers: {
        authorization: 'Bearer tok-chris',
        'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: multipartBody({ transcription: 'hello', recordedAt: '1735000000', client: 'ring' }),
    });

    expect(res.statusCode).toBe(404);
  });
});

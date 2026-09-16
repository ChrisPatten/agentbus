/**
 * Integration tests for /api/v1/siri/* (E42).
 *
 * Exercises the full path: JSON ask → bearer-token auth/identity → envelope →
 * pipeline (normalize, dedup, slash-command, route-resolve, transcript-log) →
 * queue, with the reply simulated by calling `SiriAdapter.send()` the way
 * `DeliveryWorker` would.
 */
import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { runMigrations } from '../db/schema.js';
import { MessageQueue } from '../core/queue.js';
import { AdapterRegistry } from '../core/registry.js';
import { CommandRegistry } from '../commands/registry.js';
import { createHttpServer } from './api.js';
import { PipelineEngine } from '../pipeline/engine.js';
import { normalize } from '../pipeline/stages/normalize.js';
import { createDedup } from '../pipeline/stages/dedup.js';
import { slashCommandDetect } from '../pipeline/stages/slash-command.js';
import { createRouteResolve } from '../pipeline/stages/route-resolve.js';
import { createTranscriptLog } from '../pipeline/stages/transcript-log.js';
import { SiriAdapter } from '../adapters/siri.js';
import type { AppConfig } from '../config/schema.js';
import type { MessageEnvelope } from '../types/envelope.js';

const TOKEN = 'siri-token-for-chris-0123456789';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    bus: { http_port: 0, db_path: ':memory:', log_level: 'info' },
    adapters: {
      siri: {
        enabled: true,
        reply_timeout_ms: 2000,
        late_reply_ttl_ms: 86_400_000,
        max_body_bytes: 8192,
        rate_limit: { per_minute: 20, max_in_flight: 4 },
        debug_delay_ms: 0,
      },
    },
    contacts: {
      chris: { id: 'chris', displayName: 'Chris', platforms: { siri: { token: TOKEN } } },
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
      routes: [{ match: { channel: 'siri' }, target: { adapterId: 'claude-code', recipientId: 'agent:peggy' } }],
    },
    ...overrides,
  } as unknown as AppConfig;
}

async function makeServer(config: AppConfig, opts: { registerAdapter?: boolean; targetAdapterOnline?: boolean } = {}) {
  const db = makeDb();
  const queue = new MessageQueue(db);
  const registry = new AdapterRegistry();
  const commandRegistry = new CommandRegistry();
  commandRegistry.register({
    name: 'ping',
    description: 'test command',
    usage: '/ping',
    scope: 'bus',
    handler: async () => ({ body: 'pong' }),
  });
  const pipeline = new PipelineEngine();
  pipeline.use({ slot: 10, name: 'normalize', stage: normalize });
  pipeline.use({ slot: 30, name: 'dedup', stage: createDedup(db, config.pipeline.dedup_window_ms) });
  pipeline.use({ slot: 40, name: 'slash-command', stage: slashCommandDetect });
  pipeline.use({ slot: 70, name: 'route-resolve', stage: createRouteResolve(config, db) });
  pipeline.use({ slot: 80, name: 'transcript-log', stage: createTranscriptLog(db, config), critical: false });

  const siri = config.adapters.siri ? new SiriAdapter(config.adapters.siri) : undefined;
  if (siri && opts.registerAdapter !== false) registry.register(siri);
  if (opts.targetAdapterOnline) {
    registry.register({
      id: 'claude-code',
      name: 'Claude Code (fake)',
      capabilities: { send: true, channels: ['claude-code'] },
      start: async () => {},
      stop: async () => {},
      health: async () => ({ status: 'healthy' }),
      send: async () => ({ success: true }),
    });
  }
  const server = await createHttpServer({ queue, registry, config, pipeline, db, commandRegistry, siri });
  return { server, queue, db, siri: siri!, registry };
}

/** `token: null` sends no Authorization header at all. */
function ask(server: FastifyInstance, body: unknown, token: string | null = TOKEN) {
  return server.inject({
    method: 'POST',
    url: '/api/v1/siri/ask',
    headers: {
      'content-type': 'application/json',
      ...(token !== null ? { authorization: `Bearer ${token}` } : {}),
    },
    payload: body as Record<string, unknown>,
  });
}

/** Build the outbound envelope Peggy's `reply` tool would produce for a dequeued ask. */
function peggyReply(inbound: MessageEnvelope, body: string): MessageEnvelope {
  return {
    id: `reply-${inbound.id}`,
    timestamp: new Date().toISOString(),
    channel: inbound.channel,
    topic: inbound.topic,
    sender: inbound.recipient,
    recipient: inbound.sender,
    reply_to: inbound.id,
    priority: 'normal',
    payload: { type: 'text', body },
    metadata: {},
  };
}

describe('POST /api/v1/siri/ask', () => {
  let server: FastifyInstance;

  afterEach(async () => {
    await server?.close();
  });

  it('rejects a missing Authorization header with 401 and enqueues nothing', async () => {
    const made = await makeServer(makeConfig());
    server = made.server;
    const res = await ask(server, { text: 'hello' }, null);
    expect(res.statusCode).toBe(401);
    expect(made.queue.dequeue('agent:peggy', 'general', 10)).toHaveLength(0);
    expect(made.siri.pendingCount()).toBe(0);
  });

  it('rejects an unknown bearer token with 401', async () => {
    const made = await makeServer(makeConfig());
    server = made.server;
    const res = await ask(server, { text: 'hello' }, 'not-the-token');
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ ok: false, error: 'Unauthorized' });
  });

  it('rejects an empty or missing text with 400', async () => {
    const made = await makeServer(makeConfig());
    server = made.server;
    expect((await ask(server, { text: '' })).statusCode).toBe(400);
    expect((await ask(server, {})).statusCode).toBe(400);
    expect((await ask(server, { text: 'x'.repeat(2001) })).statusCode).toBe(400);
    expect(made.siri.pendingCount()).toBe(0);
  });

  it('rejects an oversized body with 413 before doing any work', async () => {
    const made = await makeServer(makeConfig());
    server = made.server;
    // 9 KB body: over max_body_bytes (8192) but well under Fastify's own 1 MiB limit,
    // so it is our handler — not the framework — that answers.
    const res = await ask(server, { text: 'x'.repeat(9000) });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({ ok: false, error: 'Request body too large' });
    expect(made.siri.pendingCount()).toBe(0);
  });

  it('is not mounted (404) when adapters.siri is absent', async () => {
    const made = await makeServer(makeConfig({ adapters: {} } as Partial<AppConfig>));
    server = made.server;
    const res = await ask(server, { text: 'hello' });
    expect(res.statusCode).toBe(404);
  });

  it('is not mounted (404) when adapters.siri.enabled is false', async () => {
    const cfg = makeConfig();
    (cfg.adapters.siri as { enabled: boolean }).enabled = false;
    const made = await makeServer(cfg);
    server = made.server;
    const res = await ask(server, { text: 'hello' });
    expect(res.statusCode).toBe(404);
  });

  it('answers with the agent reply delivered through siri.send() and reports timing', async () => {
    const made = await makeServer(makeConfig());
    server = made.server;

    const pendingResponse = ask(server, {
      text: 'What is on my calendar tomorrow?',
      wait_ms: 1500,
      request_id: '6c0a9e9b-5c62-4e1b-9b7b-2c4f9e1b3f0a',
      client: { device: 'iphone', app_version: '0.1.0' },
    });

    // Simulate the agent: dequeue the ask, reply, and let DeliveryWorker hand it to the adapter.
    let inbound: MessageEnvelope | undefined;
    for (let i = 0; i < 50 && !inbound; i++) {
      await new Promise((r) => setTimeout(r, 10));
      inbound = made.queue.dequeue('agent:peggy', 'general', 10)[0]?.envelope;
    }
    expect(inbound).toBeDefined();
    expect(inbound!.channel).toBe('siri');
    expect(inbound!.sender).toBe('contact:chris');
    expect(inbound!.payload).toEqual({ type: 'text', body: 'What is on my calendar tomorrow?' });
    expect(inbound!.metadata['source']).toBe('siri');
    expect(inbound!.metadata['request_id']).toBe('6c0a9e9b-5c62-4e1b-9b7b-2c4f9e1b3f0a');
    expect(inbound!.metadata['client']).toEqual({ device: 'iphone', app_version: '0.1.0' });

    await new Promise((r) => setTimeout(r, 30));
    await made.siri.send(peggyReply(inbound!, 'Dentist at nine, then the review at two.'));

    const res = await pendingResponse;
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.status).toBe('answered');
    expect(body.request_id).toBe('6c0a9e9b-5c62-4e1b-9b7b-2c4f9e1b3f0a');
    expect(body.message_id).toBe(inbound!.id);
    expect(body.reply.body).toBe('Dentist at nine, then the review at two.');
    expect(body.reply.message_id).toBe(`reply-${inbound!.id}`);
    expect(typeof body.timing.queued_ms).toBe('number');
    expect(body.timing.answered_ms).toBeGreaterThanOrEqual(30);
    expect(body.timing.answered_ms).toBeLessThan(1500);
    expect(made.siri.pendingCount()).toBe(0);
  });

  it('generates a request_id when the client omits one', async () => {
    const made = await makeServer(makeConfig());
    server = made.server;
    const res = await ask(server, { text: 'quick one', wait_ms: 0 });
    expect(res.statusCode).toBe(200);
    expect(res.json().request_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('returns status pending when no reply arrives within wait_ms', async () => {
    const made = await makeServer(makeConfig());
    server = made.server;
    const res = await ask(server, { text: 'slow question', wait_ms: 100 });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('pending');
    expect(body.reply).toBeUndefined();
    expect(body.timing.waited_ms).toBeGreaterThanOrEqual(100);
    expect(made.siri.pendingCount()).toBe(0);
    // The ask itself was still queued for the agent.
    expect(made.queue.dequeue('agent:peggy', 'general', 10)).toHaveLength(1);
  });

  it('caps wait_ms at reply_timeout_ms', async () => {
    const cfg = makeConfig();
    (cfg.adapters.siri as { reply_timeout_ms: number }).reply_timeout_ms = 1000;
    const made = await makeServer(cfg);
    server = made.server;
    const started = Date.now();
    const res = await ask(server, { text: 'capped', wait_ms: 60_000 });
    expect(res.json().status).toBe('pending');
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('returns 409 for the same text within the dedup window', async () => {
    const made = await makeServer(makeConfig());
    server = made.server;
    const first = await ask(server, { text: 'repeat me', wait_ms: 0 });
    expect(first.statusCode).toBe(200);
    const second = await ask(server, { text: 'repeat me', wait_ms: 0 });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ ok: false, error: 'duplicate', reason: 'duplicate' });
    expect(made.siri.pendingCount()).toBe(0);
    expect(made.queue.dequeue('agent:peggy', 'general', 10)).toHaveLength(1);
  });

  it('answers a bus-scope slash command inline with command_handled', async () => {
    const made = await makeServer(makeConfig());
    server = made.server;
    const res = await ask(server, { text: '/ping', wait_ms: 0 });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('answered');
    expect(body.command_handled).toBe(true);
    expect(body.reply.body).toBe('pong');
    expect(made.queue.dequeue('agent:peggy', 'general', 10)).toHaveLength(0);
    expect(made.siri.pendingCount()).toBe(0);
  });

  it('returns 503 when the pipeline drops an unrouted ask', async () => {
    const cfg = makeConfig();
    cfg.pipeline.routes = [];
    cfg.pipeline.drop_unrouted = true;
    const made = await makeServer(cfg);
    server = made.server;
    const res = await ask(server, { text: 'nowhere to go', wait_ms: 0 });
    expect(res.statusCode).toBe(503);
    expect(res.json().ok).toBe(false);
    expect(made.siri.pendingCount()).toBe(0);
  });

  it('holds the response for debug_delay_ms before answering', async () => {
    const cfg = makeConfig();
    (cfg.adapters.siri as { debug_delay_ms: number }).debug_delay_ms = 150;
    const made = await makeServer(cfg);
    server = made.server;
    const started = Date.now();
    const res = await ask(server, { text: 'delayed', wait_ms: 0 });
    expect(res.statusCode).toBe(200);
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
  });
});

describe('GET /api/v1/siri/health', () => {
  let server: FastifyInstance;

  afterEach(async () => {
    await server?.close();
  });

  it('requires the bearer token', async () => {
    const made = await makeServer(makeConfig());
    server = made.server;
    const res = await server.inject({ method: 'GET', url: '/api/v1/siri/health' });
    expect(res.statusCode).toBe(401);
  });

  it('reports the matched route, its adapter presence, and the bus version', async () => {
    const made = await makeServer(makeConfig(), { targetAdapterOnline: true });
    server = made.server;
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/siri/health',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.routed).toBe(true);
    expect(body.agent).toBe('agent:peggy');
    expect(body.adapters).toEqual({ 'claude-code': 'online' });
    expect(typeof body.version).toBe('string');
    expect(body.limits.reply_timeout_ms).toBe(2000);
    expect(body.pending).toBe(0);
  });

  it('reports the out-of-process claude-code connector as external when it is not registered', async () => {
    const made = await makeServer(makeConfig());
    server = made.server;
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/siri/health',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.json().adapters).toEqual({ 'claude-code': 'external' });
  });

  it('reports an in-process target adapter as missing when it is not registered', async () => {
    const cfg = makeConfig();
    cfg.pipeline.routes = [{ match: { channel: 'siri' }, target: { adapterId: 'cc-headless', recipientId: 'agent:peggy' } }];
    const made = await makeServer(cfg);
    server = made.server;
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/siri/health',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.json().adapters).toEqual({ 'cc-headless': 'missing' });
  });

  it('reports routed:false when no pipeline route matches channel siri', async () => {
    const cfg = makeConfig();
    cfg.pipeline.routes = [{ match: { channel: 'telegram' }, target: { adapterId: 'claude-code', recipientId: 'agent:peggy' } }];
    const made = await makeServer(cfg);
    server = made.server;
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/siri/health',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const body = res.json();
    expect(body.routed).toBe(false);
    expect(body.agent).toBeNull();
    expect(body.adapters).toEqual({});
  });
});

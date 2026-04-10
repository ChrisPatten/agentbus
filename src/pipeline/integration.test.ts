/**
 * End-to-end integration tests for the full inbound pipeline.
 * Tests POST /api/v1/inbound through all 8 stages against real in-memory SQLite.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { runMigrations } from '../db/schema.js';
import { MessageQueue } from '../core/queue.js';
import { AdapterRegistry } from '../core/registry.js';
import { createHttpServer } from '../http/api.js';
import { PipelineEngine } from './engine.js';
import { normalize } from './stages/normalize.js';
import { createContactResolve } from './stages/contact-resolve.js';
import { createDedup } from './stages/dedup.js';
import { slashCommandDetect } from './stages/slash-command.js';
import { createTopicClassify } from './stages/topic-classify.js';
import { createPriorityScore } from './stages/priority-score.js';
import { createRouteResolve } from './stages/route-resolve.js';
import { createTranscriptLog } from './stages/transcript-log.js';
import type { AppConfig } from '../config/schema.js';

const testConfig: AppConfig = {
  bus: { http_port: 0, db_path: ':memory:', log_level: 'info' },
  adapters: {},
  contacts: {
    chris: {
      id: 'chris',
      displayName: 'Chris',
      platforms: {
        telegram: { userId: 123456789, username: 'chrispatten' },
      },
    },
  },
  topics: ['general', 'code'],
  memory: { summarizer_interval_ms: 60000, session_idle_threshold_ms: 1800000, context_window_hours: 48, claude_api_model: 'claude-opus-4-6' },
  pipeline: {
    dedup_window_ms: 30000,
    drop_unrouted: false,
    topic_rules: [{ topic: 'code', keywords: ['bug', 'typescript', 'python'] }],
    priority_weights: { base_score: 0, topic_bonus: 40, vip_sender_bonus: 20, urgency_keyword_bonus: 15 },
    urgency_keywords: ['urgent', 'asap', 'emergency', 'critical'],
    vip_contacts: ['chris'],
    routes: [],
  },
} as unknown as AppConfig;

function buildPipeline(db: Database.Database, config: AppConfig): PipelineEngine {
  const p = new PipelineEngine();
  p.use({ slot: 10, name: 'normalize',       stage: normalize });
  p.use({ slot: 20, name: 'contact-resolve', stage: createContactResolve(config) });
  p.use({ slot: 30, name: 'dedup',           stage: createDedup(db, config.pipeline.dedup_window_ms) });
  p.use({ slot: 40, name: 'slash-command',   stage: slashCommandDetect });
  p.use({ slot: 50, name: 'topic-classify',  stage: createTopicClassify(config) });
  p.use({ slot: 60, name: 'priority-score',  stage: createPriorityScore(config) });
  p.use({ slot: 70, name: 'route-resolve',   stage: createRouteResolve(config, db) });
  p.use({ slot: 80, name: 'transcript-log',  stage: createTranscriptLog(db, config), critical: false });
  return p;
}

async function makeServer(config = testConfig): Promise<{
  server: FastifyInstance;
  queue: MessageQueue;
  db: Database.Database;
}> {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const queue = new MessageQueue(db);
  const registry = new AdapterRegistry();
  const pipeline = buildPipeline(db, config);
  const server = await createHttpServer({ queue, registry, config, pipeline, db });
  return { server, queue, db };
}

describe('inbound pipeline — integration', () => {
  let server: FastifyInstance;
  let queue: MessageQueue;
  let db: Database.Database;

  beforeEach(async () => {
    ({ server, queue, db } = await makeServer());
  });

  afterEach(async () => {
    await server.close();
  });

  it('returns 400 for missing required fields', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/inbound',
      payload: { channel: 'telegram' }, // missing sender and payload
    });
    expect(res.statusCode).toBe(400);
  });

  it('processes a raw telegram message end-to-end', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/inbound',
      payload: {
        channel: 'telegram',
        sender: '123456789',
        payload: { type: 'text', body: 'hello world' },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { ok: boolean; queued: boolean; id: string; enqueued_count: number };
    expect(body.ok).toBe(true);
    expect(body.queued).toBe(true);
    expect(body.enqueued_count).toBe(1);
    expect(body.id).toBeTruthy();
  });

  it('resolves telegram sender to contact:alice', async () => {
    await server.inject({
      method: 'POST',
      url: '/api/v1/inbound',
      payload: {
        channel: 'telegram',
        sender: '123456789',
        payload: { type: 'text', body: 'hello' },
      },
    });

    const msgs = queue.dequeue('agent:claude', undefined, 10);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.envelope.sender).toBe('contact:alice');
  });

  it('creates a transcript row in the database', async () => {
    await server.inject({
      method: 'POST',
      url: '/api/v1/inbound',
      payload: {
        channel: 'telegram',
        sender: '123456789',
        payload: { type: 'text', body: 'hello from integration test' },
      },
    });

    const row = db.prepare('SELECT * FROM transcripts LIMIT 1').get() as { body: string; direction: string } | undefined;
    expect(row).toBeTruthy();
    expect(row!.body).toBe('hello from integration test');
    expect(row!.direction).toBe('inbound');
  });

  it('creates a session row in the database', async () => {
    await server.inject({
      method: 'POST',
      url: '/api/v1/inbound',
      payload: {
        channel: 'telegram',
        sender: '123456789',
        payload: { type: 'text', body: 'hello' },
      },
    });

    const session = db.prepare('SELECT * FROM sessions LIMIT 1').get();
    expect(session).toBeTruthy();
  });

  it('returns queued: false on duplicate within dedup window', async () => {
    // First message
    const res1 = await server.inject({
      method: 'POST',
      url: '/api/v1/inbound',
      payload: {
        channel: 'telegram',
        sender: '123456789',
        payload: { type: 'text', body: 'duplicate message' },
      },
    });
    expect((JSON.parse(res1.body) as { queued: boolean }).queued).toBe(true);

    // Same message again — dedup should fire
    const res2 = await server.inject({
      method: 'POST',
      url: '/api/v1/inbound',
      payload: {
        channel: 'telegram',
        sender: '123456789',
        payload: { type: 'text', body: 'duplicate message' },
      },
    });
    const body2 = JSON.parse(res2.body) as { ok: boolean; queued: boolean };
    expect(body2.ok).toBe(true);
    expect(body2.queued).toBe(false);
  });

  it('detects slash commands through full pipeline', async () => {
    await server.inject({
      method: 'POST',
      url: '/api/v1/inbound',
      payload: {
        channel: 'telegram',
        sender: '123456789',
        payload: { type: 'text', body: '/status' },
      },
    });

    const msgs = queue.dequeue('agent:claude', undefined, 10);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.envelope.payload.type).toBe('slash_command');
  });

  it('classifies topic from message body keywords', async () => {
    await server.inject({
      method: 'POST',
      url: '/api/v1/inbound',
      payload: {
        channel: 'telegram',
        sender: '123456789',
        payload: { type: 'text', body: 'I found a bug in the typescript code' },
      },
    });

    const msgs = queue.dequeue('agent:claude', undefined, 10);
    expect(msgs[0]!.envelope.topic).toBe('code');
  });

  it('fan-out: routes to multiple targets when also_notify is configured', async () => {
    const config: AppConfig = {
      ...testConfig,
      pipeline: {
        ...testConfig.pipeline,
        routes: [
          {
            match: { channel: 'telegram' },
            target: { adapterId: 'claude-code', recipientId: 'agent:claude' },
            also_notify: [{ adapterId: 'log-adapter', recipientId: 'log:sink' }],
          },
        ],
      },
    };
    const { server: s2, queue: q2 } = await makeServer(config);

    await s2.inject({
      method: 'POST',
      url: '/api/v1/inbound',
      payload: {
        channel: 'telegram',
        sender: '123456789',
        payload: { type: 'text', body: 'fan-out test' },
      },
    });

    // Dequeue from both recipients
    const msgs1 = q2.dequeue('agent:claude', undefined, 10);
    const msgs2 = q2.dequeue('log:sink', undefined, 10);
    expect(msgs1).toHaveLength(1);
    expect(msgs2).toHaveLength(1);

    const res = JSON.parse((await s2.inject({ method: 'GET', url: '/api/v1/health' })).body) as { ok: boolean };
    expect(res.ok).toBe(true);

    await s2.close();
  });

  it('existing POST /api/v1/messages still works (direct enqueue path)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/messages',
      payload: {
        channel: 'telegram',
        sender: 'contact:alice',
        recipient: 'agent:claude',
        payload: { type: 'text', body: 'direct enqueue' },
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { ok: boolean; queued: boolean };
    expect(body.ok).toBe(true);
    expect(body.queued).toBe(true);
  });
});

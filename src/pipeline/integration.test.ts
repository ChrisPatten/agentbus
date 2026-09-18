/**
 * End-to-end integration tests for the full inbound pipeline.
 * Tests POST /api/v1/inbound through all 8 stages against real in-memory SQLite.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
import { createPoolRouteResolve } from './stages/pool-route-resolve.js';
import { createTranscriptLog } from './stages/transcript-log.js';
import type { AppConfig } from '../config/schema.js';
import type { PoolManager } from '../pool/pool-manager.js';

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
    expect(msgs[0]!.envelope.sender).toBe('contact:chris');
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
    // Slash command payloads are restored to text before enqueue (D5);
    // parsed command info lands in metadata.slash_command.
    expect(msgs[0]!.envelope.payload.type).toBe('text');
    expect((msgs[0]!.envelope.payload as { body: string }).body).toBe('/status');
    expect(msgs[0]!.envelope.metadata['slash_command']).toEqual({ command: 'status', args_raw: '' });
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

  it('two envelopes for different conversations through the same static cc-pool route resolve to distinct panes, with no cross-contamination (regression for shared route-target reference bug)', async () => {
    const config: AppConfig = {
      ...testConfig,
      pipeline: {
        ...testConfig.pipeline,
        routes: [
          {
            match: { channel: 'telegram' },
            target: { adapterId: 'cc-pool', recipientId: 'agent:peggy' },
          },
        ],
      },
    };

    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    const queue = new MessageQueue(db);
    const registry = new AdapterRegistry();

    // Fake PoolManager: first call resolves to pane 1, second call (a
    // different conversation, same static route rule) resolves to pane 2 —
    // exactly like the real per-conversation lease logic would.
    const resolveRoute = vi.fn(async (_conversationId: string, _promptContext: { contact_id: string; channel: string }) => '');
    resolveRoute.mockResolvedValueOnce('agent:peggy-pool-1').mockResolvedValueOnce('agent:peggy-pool-2');
    const fakeManager = { resolveRoute } as unknown as PoolManager;
    const poolManagers = new Map([['agent:peggy', fakeManager]]);

    const pipeline = new PipelineEngine();
    pipeline.use({ slot: 10, name: 'normalize',          stage: normalize });
    pipeline.use({ slot: 20, name: 'contact-resolve',    stage: createContactResolve(config) });
    pipeline.use({ slot: 30, name: 'dedup',              stage: createDedup(db, config.pipeline.dedup_window_ms) });
    pipeline.use({ slot: 40, name: 'slash-command',      stage: slashCommandDetect });
    pipeline.use({ slot: 50, name: 'topic-classify',     stage: createTopicClassify(config) });
    pipeline.use({ slot: 60, name: 'priority-score',     stage: createPriorityScore(config) });
    pipeline.use({ slot: 70, name: 'route-resolve',      stage: createRouteResolve(config, db) });
    pipeline.use({ slot: 72, name: 'pool-route-resolve', stage: createPoolRouteResolve(poolManagers) });
    pipeline.use({ slot: 80, name: 'transcript-log',     stage: createTranscriptLog(db, config), critical: false });

    const s = await createHttpServer({ queue, registry, config, pipeline, db });

    // Two different senders (contacts) on the same channel/topic produce two
    // different conversation_ids and both match the single static route rule.
    const res1 = await s.inject({
      method: 'POST',
      url: '/api/v1/inbound',
      payload: { channel: 'telegram', sender: '123456789', payload: { type: 'text', body: 'first conversation' } },
    });
    const res2 = await s.inject({
      method: 'POST',
      url: '/api/v1/inbound',
      payload: { channel: 'telegram', sender: 'contact:someone-else', payload: { type: 'text', body: 'second conversation' } },
    });

    expect(res1.statusCode).toBe(200);
    expect(res2.statusCode).toBe(200);
    expect(resolveRoute).toHaveBeenCalledTimes(2);

    // The two envelopes must have been resolved with two different
    // conversationIds (proving they were treated as separate conversations,
    // not deduped or merged).
    const [call1Args, call2Args] = resolveRoute.mock.calls;
    expect(call1Args![0]).not.toBe(call2Args![0]);

    // Each envelope must have actually been enqueued to ITS OWN resolved
    // pane — not both on whatever the first call resolved to (the exact
    // failure mode of the shared-reference bug: the second call's lookup
    // would miss, log an error, and leave the route pointed at pane 1).
    const msgsPane1 = queue.dequeue('agent:peggy-pool-1', undefined, 10);
    const msgsPane2 = queue.dequeue('agent:peggy-pool-2', undefined, 10);
    expect(msgsPane1).toHaveLength(1);
    expect(msgsPane2).toHaveLength(1);
    expect((msgsPane1[0]!.envelope.payload as { body: string }).body).toBe('first conversation');
    expect((msgsPane2[0]!.envelope.payload as { body: string }).body).toBe('second conversation');

    // And the static config route target itself must remain untouched
    // throughout — still the pool's logical id, never overwritten by either
    // resolution.
    expect(config.pipeline.routes[0]!.target.recipientId).toBe('agent:peggy');

    await s.close();
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

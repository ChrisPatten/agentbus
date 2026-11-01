/**
 * E88 — launch fencing on the bus side: `GET /api/v1/messages/pending`
 * refuses polls from any launch but the registered one, `/last-poll` reports
 * the launch id, and (S88.2 integration) two real cc.ts poll loops sharing
 * one pane agent id: only the registered launch gets the message and the
 * other stops polling.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { runMigrations } from '../db/schema.js';
import { MessageQueue } from '../core/queue.js';
import { AdapterRegistry } from '../core/registry.js';
import { createHttpServer } from './api.js';
import { PipelineEngine } from '../pipeline/engine.js';
import type { AppConfig } from '../config/schema.js';
import type { MessageEnvelope } from '../types/envelope.js';
import type { HealthState } from '../mcp/tools/index.js';
import { registerAgentLaunch, resetAgentLivenessForTests, warnStalePoll, STALE_POLL_WARN_INTERVAL_MS } from './agent-liveness.js';
import { startPollLoop } from '../adapters/cc-poller.js';

const stubConfig = {
  bus: { http_port: 0, db_path: ':memory:', log_level: 'info' },
  adapters: {},
  contacts: {},
  topics: ['general'],
  memory: { summarizer_interval_ms: 60000, session_idle_threshold_ms: 1800000, claude_api_model: 'claude-opus-4-6' },
  pipeline: {
    dedup_window_ms: 30000, drop_unrouted: false, topic_rules: [],
    priority_weights: { base_score: 0, topic_bonus: 40, vip_sender_bonus: 20, urgency_keyword_bonus: 15 },
    urgency_keywords: [], vip_contacts: [], routes: [],
  },
} as unknown as AppConfig;

let server: FastifyInstance;

beforeEach(async () => {
  resetAgentLivenessForTests();
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  server = await createHttpServer({
    queue: new MessageQueue(db), registry: new AdapterRegistry(), config: stubConfig, pipeline: new PipelineEngine(), db,
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  await server.close();
  resetAgentLivenessForTests();
  vi.restoreAllMocks();
});

async function enqueueFor(agent: string, body = 'hello'): Promise<void> {
  const res = await server.inject({
    method: 'POST',
    url: '/api/v1/messages',
    payload: { channel: 'telegram', sender: 'contact:alice', recipient: `agent:${agent}`, payload: { type: 'text', body } },
  });
  expect(res.statusCode).toBeLessThan(300);
}

describe('GET /api/v1/messages/pending — E88 launch fence', () => {
  it('with no launch id registered, a poll with or without a launch id behaves as before', async () => {
    await enqueueFor('peggy-pool-2');
    const plain = await server.inject({ method: 'GET', url: '/api/v1/messages/pending?agent=peggy-pool-2' });
    expect(plain.statusCode).toBe(200);
    expect(plain.json().count).toBe(1);

    await enqueueFor('peggy-pool-2');
    const tagged = await server.inject({ method: 'GET', url: '/api/v1/messages/pending?agent=peggy-pool-2&launch_id=L1' });
    expect(tagged.statusCode).toBe(200);
    expect(tagged.json().count).toBe(1);
  });

  it('once a launch id is registered, other launch ids and untagged polls get 409 stale_launch and no messages', async () => {
    registerAgentLaunch('peggy-pool-2', 'L-current');
    await enqueueFor('peggy-pool-2');

    for (const url of [
      '/api/v1/messages/pending?agent=peggy-pool-2&launch_id=L-old',
      '/api/v1/messages/pending?agent=peggy-pool-2',
    ]) {
      const res = await server.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ ok: false, error: 'stale_launch', stale_launch: true, messages: [], count: 0 });
    }

    const current = await server.inject({ method: 'GET', url: '/api/v1/messages/pending?agent=peggy-pool-2&launch_id=L-current' });
    expect(current.statusCode).toBe(200);
    expect(current.json().count).toBe(1);
  });

  it('accepts the launch id as an X-Agentbus-Launch-Id header too', async () => {
    registerAgentLaunch('peggy-pool-3', 'L-h');
    const res = await server.inject({ method: 'GET', url: '/api/v1/messages/pending?agent=peggy-pool-3', headers: { 'x-agentbus-launch-id': 'L-h' } });
    expect(res.statusCode).toBe(200);
  });

  it('a stale poll is not recorded: /last-poll still shows the current launch', async () => {
    registerAgentLaunch('peggy-pool-2', 'L-current');
    await server.inject({ method: 'GET', url: '/api/v1/messages/pending?agent=peggy-pool-2&launch_id=L-current' });
    const before = (await server.inject({ method: 'GET', url: '/api/v1/agents/peggy-pool-2/last-poll' })).json();
    expect(before).toMatchObject({ ok: true, lastLaunchId: 'L-current', registeredLaunchId: 'L-current' });

    await server.inject({ method: 'GET', url: '/api/v1/messages/pending?agent=peggy-pool-2&launch_id=L-orphan' });
    const after = (await server.inject({ method: 'GET', url: '/api/v1/agents/peggy-pool-2/last-poll' })).json();
    expect(after.lastLaunchId).toBe('L-current');
    expect(after.lastPollAt).toBe(before.lastPollAt);
  });

  it('/last-poll for a never-seen agent reports nulls', async () => {
    const res = (await server.inject({ method: 'GET', url: '/api/v1/agents/nobody/last-poll' })).json();
    expect(res).toEqual({ ok: true, agentId: 'nobody', lastPollAt: null, lastLaunchId: null, registeredLaunchId: null });
  });

  it('logs a stale poll at most once a minute per agent id + launch id', () => {
    registerAgentLaunch('peggy-pool-2', 'L-current');
    const t0 = 1_000_000;
    expect(warnStalePoll('peggy-pool-2', 'L-orphan', t0)).toBe(true);
    expect(warnStalePoll('peggy-pool-2', 'L-orphan', t0 + 1000)).toBe(false);
    expect(warnStalePoll('peggy-pool-2', 'L-other', t0 + 1000)).toBe(true);
    expect(warnStalePoll('peggy-pool-2', 'L-orphan', t0 + STALE_POLL_WARN_INTERVAL_MS)).toBe(true);
  });
});

describe('S88.2 integration — two pollers share peggy-pool-2', () => {
  function health(): HealthState {
    return { status: 'healthy', busReachable: false, lastPollAt: null, consecutiveFailures: 0 };
  }

  it('only the registered launch receives the queued message; the other exits its poll loop within one interval', async () => {
    await server.listen({ port: 0, host: '127.0.0.1' });
    const addr = server.server.address();
    const busBaseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    const pollIntervalMs = 100;

    registerAgentLaunch('peggy-pool-2', 'L-new');
    const gotNew: MessageEnvelope[] = [];
    const gotOrphan: MessageEnvelope[] = [];
    const log = vi.fn();
    const orphan = startPollLoop({
      busBaseUrl, agentId: 'peggy-pool-2', launchId: 'L-orphan', pollIntervalMs, healthState: health(),
      onMessages: (m) => gotOrphan.push(...m), log,
    });
    const startedAt = Date.now();
    const current = startPollLoop({
      busBaseUrl, agentId: 'peggy-pool-2', launchId: 'L-new', pollIntervalMs, healthState: health(),
      onMessages: (m) => gotNew.push(...m), log,
    });

    try {
      await expect(orphan.stopped).resolves.toBe('stale_launch');
      expect(Date.now() - startedAt).toBeLessThan(pollIntervalMs + 500);

      await enqueueFor('peggy-pool-2', 'for the current launch');
      for (let i = 0; i < 50 && gotNew.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
      expect(gotNew.map((m) => (m.payload as { body: string }).body)).toEqual(['for the current launch']);
      expect(gotOrphan).toEqual([]);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('is stale'));
    } finally {
      orphan.stop();
      current.stop();
    }
    await expect(current.stopped).resolves.toBe('shutdown');
  });

  it('a poller with no launch id keeps polling as before when no launch is registered', async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, messages: [], count: 0 }) }) as unknown as Response);
    const loop = startPollLoop({ busBaseUrl: 'http://x', agentId: 'claude', pollIntervalMs: 10, healthState: health(), onMessages: () => {}, fetchFn });
    await new Promise((r) => setTimeout(r, 60));
    loop.stop();
    expect(fetchFn.mock.calls.length).toBeGreaterThan(2);
    expect(String((fetchFn.mock.calls[0] as unknown[])[0])).toBe('http://x/api/v1/messages/pending?agent=claude&limit=10');
  });
});

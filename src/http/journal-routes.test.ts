/** E66 S66.8 — HTTP side of System Message journal runs: hold, outbound block, journal_complete, instruction delivery. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { runMigrations } from '../db/schema.js';
import { MessageQueue } from '../core/queue.js';
import { AdapterRegistry } from '../core/registry.js';
import { PipelineEngine } from '../pipeline/engine.js';
import type { AppConfig } from '../config/schema.js';
import { createHttpServer, processInbound } from './api.js';
import { JournalRunGate } from '../journaling/journalers/system-message.js';
import { createJournalInstructionDelivery } from '../journaling/delivery.js';
import { OwnerDirectory } from '../core/owners.js';

const config = {
  bus: { http_port: 0, db_path: ':memory:', log_level: 'info' },
  adapters: {}, contacts: {}, topics: ['general'], agents: {},
  memory: { summarizer_interval_ms: 60000, session_idle_threshold_ms: 1800000 },
  pipeline: { dedup_window_ms: 30000, drop_unrouted: false, topic_rules: [], priority_weights: { base_score: 0, topic_bonus: 40, vip_sender_bonus: 20, urgency_keyword_bonus: 15 }, urgency_keywords: [], vip_contacts: [], routes: [] },
} as unknown as AppConfig;

let db: Database.Database;
let queue: MessageQueue;
let gate: JournalRunGate;
let server: FastifyInstance;
let pipeline: PipelineEngine;

const run = { runId: 'run-1', agentId: 'agent:peggy', recipient: 'agent:peggy-pool-1', startedAt: 'x', conversationId: 'conv-1', channel: 'telegram', contactId: 'chris', topic: 'general' };

function enqueue(id: string, recipient: string, metadata: Record<string, unknown>) {
  queue.enqueue({
    id, timestamp: new Date().toISOString(), channel: 'telegram', topic: 'general', sender: 'contact:chris', recipient,
    reply_to: null, priority: 'normal', payload: { type: 'text', body: id }, metadata,
  });
}

beforeEach(async () => {
  db = new Database(':memory:');
  runMigrations(db);
  queue = new MessageQueue(db);
  gate = new JournalRunGate();
  pipeline = new PipelineEngine();
  // Route everything to one pane, as pool-route-resolve would.
  pipeline.use({ slot: 70, name: 'route', stage: async (ctx) => {
    ctx.routes = [{ adapterId: 'cc-pool', recipientId: 'agent:peggy-pool-1' }, { adapterId: 'claude-code', recipientId: 'agent:other' }];
    ctx.conversationId = 'conv-1';
    return ctx;
  } });
  server = await createHttpServer({ queue, registry: new AdapterRegistry(), config, pipeline, db, journalGate: gate });
});
afterEach(async () => { await server.close(); db.close(); });

describe('journal hold in GET /api/v1/messages/pending', () => {
  it('skips held messages for the run agent and delivers them once the run ends', async () => {
    void gate.start(run);
    enqueue('held', 'agent:peggy-pool-1', { conversation_id: 'conv-1' });
    enqueue('instruction', 'agent:peggy-pool-1', { conversation_id: 'conv-1', journal_run_id: 'run-1' });
    const first = await server.inject({ method: 'GET', url: '/api/v1/messages/pending?agent=peggy-pool-1' });
    expect(first.json().messages.map((m: { id: string }) => m.id)).toEqual(['instruction']);
    gate.end('run-1');
    const second = await server.inject({ method: 'GET', url: '/api/v1/messages/pending?agent=peggy-pool-1' });
    expect(second.json().messages.map((m: { id: string }) => m.id)).toEqual(['held']);
  });
});

describe('outbound block in POST /api/v1/messages', () => {
  const send = (sender: string) => server.inject({
    method: 'POST', url: '/api/v1/messages',
    payload: { channel: 'telegram', topic: 'general', sender, recipient: 'contact:chris', payload: { type: 'text', body: 'hi' } },
  });

  it('rejects the run agent with 409 and a reason, and lets other agents through', async () => {
    void gate.start(run);
    const blocked = await send('agent:peggy-pool-1');
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ ok: false, error: 'journal_run_in_progress', reason: expect.stringContaining('journal_complete') });
    expect((await send('agent:peggy-pool-2')).statusCode).toBe(201);
    gate.end('run-1');
    expect((await send('agent:peggy-pool-1')).statusCode).toBe(201);
  });
});

describe('POST /api/v1/journal/complete', () => {
  it('completes the open run, and rejects unknown, stale, foreign and repeated calls', async () => {
    const completion = gate.start(run);
    const post = (body: Record<string, unknown>) => server.inject({ method: 'POST', url: '/api/v1/journal/complete', payload: body });
    expect((await post({ run_id: 'nope', agent_id: 'peggy-pool-1' })).statusCode).toBe(404);
    expect((await post({ run_id: 'run-1', agent_id: 'baxter' })).statusCode).toBe(403);
    expect((await post({ run_id: 'run-1' })).statusCode).toBe(400);
    const ok = await post({ run_id: 'run-1', agent_id: 'peggy-pool-1', files_changed: ['memory/MEMORY.md'], notes: 'done' });
    expect(ok.statusCode).toBe(200);
    await expect(completion).resolves.toMatchObject({ filesChanged: ['memory/MEMORY.md'], notes: 'done', nothingNew: false });
    expect((await post({ run_id: 'run-1', agent_id: 'peggy-pool-1' })).json()).toMatchObject({ error: 'already_completed' });
    gate.end('run-1');
    const stale = await post({ run_id: 'run-1', agent_id: 'peggy-pool-1' });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: 'stale_run' });
  });
});

describe('journal instruction delivery', () => {
  it('queues a system-only turn for the journaled agent only, with the block and run id', async () => {
    const owners = new OwnerDirectory(config);
    const deliver = createJournalInstructionDelivery({ queue, registry: new AdapterRegistry(), owners, pipeline, config, db });
    const result = await deliver({
      runId: 'run-1', agentId: 'agent:peggy-pool-1',
      target: { conversationId: 'conv-1', channel: 'telegram', contactId: 'chris', topic: 'general' },
      block: '<agentbus-system kind="journal" run_id="run-1">\nJournal.\n</agentbus-system>',
    });
    expect(result).toMatchObject({ queued: true, conversationId: 'conv-1' });
    const pane = queue.dequeue('agent:peggy-pool-1');
    expect(pane).toHaveLength(1);
    expect(pane[0]!.envelope.metadata).toMatchObject({ system_only: true, journal_run_id: 'run-1', system_blocks: [expect.stringContaining('kind="journal"')] });
    expect(queue.dequeue('agent:other')).toHaveLength(0);
  });

  it('strips a caller-supplied journal_run_id at ingress', async () => {
    await processInbound(
      { channel: 'telegram', sender: 'contact:chris', payload: { type: 'text', body: 'hi' }, metadata: { journal_run_id: 'run-1', system_only: true } },
      { queue, pipeline, config, db },
    );
    const [msg] = queue.dequeue('agent:peggy-pool-1');
    expect(msg!.envelope.metadata).not.toHaveProperty('journal_run_id');
    expect(msg!.envelope.metadata).not.toHaveProperty('system_only');
  });
});

describe('session transcript hides bus-originated turns', () => {
  it('leaves system-only rows out of GET /api/v1/sessions/:id/transcript', async () => {
    db.prepare(`INSERT INTO sessions (id, conversation_id, channel, contact_id, started_at, last_activity) VALUES ('s1','conv-1','telegram','chris','x','x')`).run();
    const add = (id: string, meta: Record<string, unknown>, at: string) => db.prepare(`INSERT INTO transcripts
      (id, message_id, conversation_id, session_id, created_at, channel, contact_id, direction, body, metadata)
      VALUES (?, ?, 'conv-1', 's1', ?, 'telegram', 'chris', 'inbound', ?, ?)`).run(id, id, at, id, JSON.stringify(meta));
    add('visible', {}, '2026-10-06T10:00:00.000Z');
    add('journal-turn', { system_only: true, journal_run_id: 'r' }, '2026-10-06T10:01:00.000Z');
    const res = await server.inject({ method: 'GET', url: '/api/v1/sessions/s1/transcript' });
    expect(res.json().transcript.map((m: { message_id: string }) => m.message_id)).toEqual(["visible"]);
  });
});

describe('GET /api/v1/journal/runs and the health summary (S66.10)', () => {
  it('lists runs by agent (pane ids map to the pool) and adds journaling to /api/v1/health', async () => {
    const { AppConfigSchema } = await import('../config/schema.js');
    const { RuntimeResolver } = await import('../core/runtime-resolver.js');
    const { JournalEngine } = await import('../journaling/engine.js');
    const { JournalerRegistry } = await import('../journaling/registry.js');
    const cfg = AppConfigSchema.parse({
      bus: { db_path: ':memory:' }, memory: {},
      adapters: { 'cc-pool': { agent_id: 'peggy', tmux_session: 'peggy-pool', claude_bin: '/usr/local/bin/claude' } },
      agents: { 'agent:peggy': { journaling: { chain: ['cc-headless'] } } },
    });
    const resolver = new RuntimeResolver(cfg);
    const engine = new JournalEngine({ db, config: cfg, resolver, registry: new JournalerRegistry(), log: () => {} });
    engine.store.insertRun({
      runId: 'r1', agentId: 'agent:peggy', sessionId: 's1', conversationId: 'conv-1', kind: 'session', trigger: 'pause',
      journaler: 'cc-headless', chainPosition: 0, fallbackFrom: null, outcome: 'done', messageCount: 3,
      startedAt: '2026-10-06T10:00:00.000Z', filesChanged: ['memory/MEMORY.md'], costUsd: 0.02,
    });
    const app = await createHttpServer({ queue, registry: new AdapterRegistry(), config, pipeline, db, journalStatus: { db, engine, resolver } });
    try {
      const res = await app.inject({ method: 'GET', url: '/api/v1/journal/runs?agent=peggy-pool-3&limit=10' });
      expect(res.json()).toMatchObject({ ok: true, count: 1, runs: [{ run_id: 'r1', journaler: 'cc-headless', files_changed: ['memory/MEMORY.md'], cost_usd: 0.02 }] });
      expect((await app.inject({ method: 'GET', url: '/api/v1/journal/runs?conversation=other' })).json().count).toBe(0);
      const health = (await app.inject({ method: 'GET', url: '/api/v1/health' })).json();
      expect(health.journaling).toMatchObject({ status: 'ok', agents: { 'agent:peggy': { chain: ['cc-headless'], consecutive_exhaustions: 0 } } });
    } finally {
      await app.close();
    }
  });
});

describe('GET /api/v1/memory/recent (E67 S67.4)', () => {
  it('passes the parsed query to the freshness check and maps its result', async () => {
    const calls: unknown[] = [];
    const memoryRecent = {
      check: (req: { harnessSessionId: string }) => {
        calls.push(req);
        return req.harnessSessionId === 'known'
          ? { ok: true as const, agent_id: 'agent:peggy', changed: true, hash: 'h', context: 'ctx' }
          : { ok: false as const, status: 404, error: 'no agent for this harness_session_id' };
      },
    };
    const s = await createHttpServer({ queue, registry: new AdapterRegistry(), config, pipeline, db, memoryRecent });
    try {
      const ok = await s.inject({ method: 'GET', url: '/api/v1/memory/recent?harness_session_id=known&event=prompt&agent=peggy' });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ ok: true, changed: true, context: 'ctx' });
      expect(calls[0]).toEqual({ harnessSessionId: 'known', event: 'prompt', agentId: 'peggy' });
      expect((await s.inject({ method: 'GET', url: '/api/v1/memory/recent?harness_session_id=nope' })).statusCode).toBe(404);
      expect((await s.inject({ method: 'GET', url: '/api/v1/memory/recent' })).statusCode).toBe(400);
    } finally {
      await s.close();
    }
  });
});

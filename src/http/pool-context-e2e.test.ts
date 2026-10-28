import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../adapters/cc-headless.js', () => ({ getHeadlessSnapshots: () => [] }));
vi.mock('../adapters/claude-transcript.js', () => ({ claudeTranscriptExists: () => true }));
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { runMigrations } from '../db/schema.js';
import { MessageQueue } from '../core/queue.js';
import { AdapterRegistry, type AdapterInstance } from '../core/registry.js';
import { DeliveryWorker } from '../core/delivery.js';
import { PipelineEngine } from '../pipeline/engine.js';
import { createHttpServer } from './api.js';
import { AppConfigSchema, type AppConfig, type CcPoolInstanceConfig } from '../config/schema.js';
import { normalize } from '../pipeline/stages/normalize.js';
import { createRouteResolve } from '../pipeline/stages/route-resolve.js';
import { createPoolRouteResolve } from '../pipeline/stages/pool-route-resolve.js';
import { createTranscriptLog } from '../pipeline/stages/transcript-log.js';
import { createPendingContextInject } from '../pipeline/stages/pending-context-inject.js';
import { computeConversationId } from '../pipeline/conversation-id.js';
import { LeaseStore } from '../pool/lease-store.js';
import { PoolManager } from '../pool/pool-manager.js';
import { primaryChannels } from '../app/main.js';
import { formatMessagesForSampling } from '../adapters/message-format.js';
import { readWatermark } from '../app/pending-context.js';
import { isForeignOrigin, readOrigin } from '../core/origin.js';
import { readPendingContext } from '../core/system-block.js';
import type { MessageEnvelope } from '../types/envelope.js';

// E80 review follow-ups: end-to-end paths through the real routes, delivery logging and (where noted) a real PoolManager.

const DM = 'telegram:peggy';
const HOUR = 3_600_000;

function makeConfig(channels: string[] = [DM]): AppConfig {
  return AppConfigSchema.parse({
    bus: { db_path: ':memory:' },
    adapters: { telegram: { peggy: { token: 'peggy-token' }, pokeclaude: { token: 'poke-token' } } },
    memory: {},
    contacts: {
      alice: { id: 'alice', displayName: 'Alice', platforms: { telegram: { userId: 1001 } } },
      bob: { id: 'bob', displayName: 'Bob', platforms: {} },
    },
    agents: { 'agent:peggy': { pending_context: { channels } } },
    pipeline: { routes: [
      { match: { channel: DM }, target: { adapterId: 'cc-pool', recipientId: 'agent:peggy' } },
      { match: { channel: 'telegram:other' }, target: { adapterId: 'cc-pool', recipientId: 'agent:peggy' } },
      { match: { channel: 'telegram:pokeclaude' }, target: { adapterId: 'cc-pool', recipientId: 'agent:peggy' } },
    ] },
  }) as AppConfig;
}

function poolCfg(overrides: Partial<CcPoolInstanceConfig> = {}): CcPoolInstanceConfig {
  return {
    name: null, agent_id: 'peggy', tmux_session: 'peggy-pool', panes: 1, growth: 'fixed', max_panes: 1,
    claude_bin: '/usr/local/bin/claude', model: undefined, working_dir: '/work/dir', launch_args: [], poll_interval_ms: 1000,
    system_prompt: undefined, lease: { idle_evict_ms: 0, hard_idle_ms: 21_600_000, park_timeout_ms: 300_000 },
    on_evict: 'clear', launch_ack_delay_ms: 500, launch_ack_max_attempts: 3, launch_ack_pattern: 'experimental', pane_env: {},
    ...overrides,
  } as CcPoolInstanceConfig;
}

const live: { server: FastifyInstance; db: Database.Database }[] = [];
afterEach(async () => { for (const x of live.splice(0)) { await x.server.close(); x.db.close(); } });

/** `realPool`: use a real PoolManager (fake pane launcher) instead of a stub that returns `resolved.recipient`. */
async function fixture(opts: { config?: AppConfig; realPool?: boolean } = {}) {
  const config = opts.config ?? makeConfig();
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON'); runMigrations(db);
  const queue = new MessageQueue(db);
  const resolved = { recipient: 'agent:peggy-pool-1' };
  const launcher = { launch: vi.fn(async () => {}), release: vi.fn(async () => {}) };
  const pool = new PoolManager({ transcriptExists: () => true, cfg: poolCfg(), db, busBaseUrl: 'http://127.0.0.1:3000', paneLauncher: launcher, queue });
  if (opts.realPool) await pool.ensureStarted();
  const managers = new Map([['agent:peggy', opts.realPool ? pool : { resolveRoute: async () => resolved.recipient }]]) as unknown as Map<string, PoolManager>;
  const pipeline = new PipelineEngine();
  pipeline.use({ slot: 10, name: 'normalize', stage: normalize });
  pipeline.use({ slot: 70, name: 'route-resolve', stage: createRouteResolve(config, db) });
  pipeline.use({ slot: 72, name: 'pool-route-resolve', stage: createPoolRouteResolve(managers) });
  pipeline.use({ slot: 80, name: 'transcript-log', stage: createTranscriptLog(db, config) });
  pipeline.use({ slot: 88, name: 'pending-context-inject', stage: createPendingContextInject(db, config) });
  const server = await createHttpServer({ config, db, registry: new AdapterRegistry(), queue, pipeline });
  live.push({ server, db });
  const inbound = async (body: string, channel = DM) => (await server.inject({ method: 'POST', url: '/api/v1/inbound',
    payload: { channel, sender: 'contact:alice', payload: { type: 'text', body } } })).json() as { id: string; queued: boolean };
  const share = (payload: Record<string, unknown> = {}) => server.inject({ method: 'POST', url: '/api/v1/context',
    payload: { to: 'contact:alice', body: 'Finished the migration plan', source: 'Claude Code: peggy', channel: DM, ...payload } });
  const take = (recipient = 'agent:peggy-pool-1') => queue.dequeue(recipient, undefined, 20);
  const ack = (id: string) => server.inject({ method: 'POST', url: `/api/v1/messages/${id}/ack`, payload: { status: 'delivered' } });
  const send = (sender: string, metadata: Record<string, unknown> = {}, channel = DM, recipient = 'contact:alice') => server.inject({
    method: 'POST', url: '/api/v1/messages', payload: { channel, topic: 'general', sender, recipient, payload: { type: 'text', body: 'Two calendar items need you' }, metadata } });
  const dm = computeConversationId('alice', DM, 'general');
  /** Run the delivery worker over one contact-bound message, with a Telegram stand-in that accepts it. */
  const deliver = async () => {
    const registry = new AdapterRegistry();
    const adapter: AdapterInstance = { id: DM, name: DM, capabilities: { send: true, channels: [DM] }, start: async () => {}, stop: async () => {},
      health: async () => ({ status: 'healthy' as const }), send: async () => ({ success: true }) };
    registry.register(adapter);
    const worker = new DeliveryWorker({ queue, registry, db, primaryChannels: primaryChannels(config) });
    for (const m of queue.dequeueByPrefix('contact:', 10)) {
      await (worker as unknown as { deliver: (id: string, e: MessageEnvelope) => Promise<void> }).deliver(m.messageId, m.envelope);
    }
  };
  /** A pane lease row, as the pool would leave it. */
  const lease = (pane: number, conversation: string | null, state: 'leased' | 'free' | 'dead' | 'launching' | 'draining' = 'leased') => {
    new LeaseStore(db).seedPanes('peggy', [{ paneId: `peggy:${pane}`, agentId: `agent:peggy-pool-${pane}` }]);
    db.prepare(`UPDATE pool_leases SET state = ?, conversation_id = ? WHERE pane_id = ?`).run(state, conversation, `peggy:${pane}`);
  };
  /** A scheduled conversation whose newest inbound message is a fire of the named schedule. */
  const scheduled = (conversation: string, meta: Record<string, unknown>) => {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO conversation_registry(id,contact_id,channel,topic,first_seen,last_seen) VALUES (?,?,?,?,?,?)`).run(conversation, 'alice', 'system:peggy', 'sched:morning', now, now);
    db.prepare(`INSERT INTO sessions(id,conversation_id,channel,contact_id,started_at,last_activity,message_count,agent_id) VALUES (?,?,?,?,?,?,1,'agent:peggy-pool-2')`).run(`s-${conversation}`, conversation, 'system:peggy', 'alice', now, now);
    db.prepare(`INSERT INTO transcripts (id,message_id,conversation_id,session_id,created_at,channel,contact_id,direction,body,metadata) VALUES (?,?,?,?,?,?,?,'inbound','run the scan',?)`)
      .run(randomUUID(), randomUUID(), conversation, `s-${conversation}`, now, 'system:peggy', 'alice', JSON.stringify(meta));
  };
  const originOf = async (res: Awaited<ReturnType<typeof send>>) => {
    expect(res.statusCode).toBe(201);
    return new MessageQueue(db).getById(res.json().id)!.envelope.metadata['origin'];
  };
  return { server, db, queue, resolved, launcher, pool, inbound, share, take, ack, send, deliver, lease, scheduled, originOf, dm, config };
}

const block = (e: MessageEnvelope) => readPendingContext(e.metadata)?.block ?? null;

describe('a routine pane messaging the DM reaches the DM\'s next turn, labelled (E80 exit criteria 1 and 3)', () => {
  const sched = 'sched-morning-conversation';

  it('end to end: real route, delivery logging into the DM conversation, then the DM turn\'s block names the schedule', async () => {
    const f = await fixture();
    await f.inbound('good morning'); // the DM's session
    const [first] = f.take();
    await f.ack(first!.messageId);
    f.scheduled(sched, { scheduled: true, schedule_label: 'Morning scan', schedule_id: 'ambient-scan' });
    f.lease(2, sched);
    // A second, newer registry row for the same contact and channel must not catch the logged send.
    f.db.prepare(`INSERT INTO conversation_registry(id,contact_id,channel,topic,first_seen,last_seen) VALUES ('forum','alice',?,?, ?, ?)`)
      .run(DM, 'thread:0123456789abcdef', new Date(Date.now() + 1000).toISOString(), new Date(Date.now() + 1000).toISOString());
    f.db.prepare(`INSERT INTO sessions(id,conversation_id,channel,contact_id,started_at,last_activity,message_count) VALUES ('forum-s','forum',?,'alice',?,?,1)`)
      .run(DM, new Date().toISOString(), new Date().toISOString());

    // The pane sends with the default external origin its MCP server stamped.
    const origin = await f.originOf(await f.send('agent:peggy-pool-2', { origin: { kind: 'external', label: 'another agent session' } }));
    expect(origin).toEqual({ kind: 'turn', agent_id: 'peggy-pool-2', conversation_id: sched, label: 'Morning scan' });
    await f.deliver();
    const logged = f.db.prepare(`SELECT conversation_id, metadata FROM transcripts WHERE direction = 'outbound'`).all() as Array<{ conversation_id: string; metadata: string }>;
    expect(logged.map((r) => r.conversation_id)).toEqual([f.dm]);
    expect(isForeignOrigin(readOrigin(JSON.parse(logged[0]!.metadata)), f.dm)).toBe(true);

    await f.inbound('what is on today?');
    const [turn] = f.take();
    expect(block(turn!.envelope)).toContain('Morning scan: Two calendar items need you');
    expect(formatMessagesForSampling([turn!.envelope])).toContain('Morning scan: Two calendar items need you');
  });

  it('labels with a config schedule id, or "scheduled job <id8>" for a generated one, and lets an explicit source win', async () => {
    const f = await fixture();
    const label = async (sender: string, origin: Record<string, unknown>) => ((await f.originOf(await f.send(sender, { origin }))) as { label?: string }).label;
    f.scheduled('c-id', { scheduled: true, schedule_id: 'ambient-scan' });
    f.lease(1, 'c-id');
    expect(await label('agent:peggy-pool-1', { kind: 'external', label: 'another agent session' })).toBe('ambient-scan');
    f.scheduled('c-uuid', { scheduled: true, schedule_id: '3f2b8a1c-0d4e-4f6a-9b7c-1a2b3c4d5e6f' });
    f.lease(2, 'c-uuid');
    expect(await label('agent:peggy-pool-2', { kind: 'external', label: 'another agent session' })).toBe('scheduled job 3f2b8a1c');
    f.scheduled('c-src', { scheduled: true, schedule_label: 'Morning scan' });
    f.lease(3, 'c-src');
    expect(await label('agent:peggy-pool-3', { kind: 'external', label: 'Ambient scan' })).toBe('Ambient scan');
  });

  it('does not label a pane whose newest inbound message is from a person, or one that was never scheduled', async () => {
    const f = await fixture();
    f.scheduled('c-after', { scheduled: true, schedule_label: 'Morning scan' });
    f.db.prepare(`INSERT INTO transcripts (id,message_id,conversation_id,session_id,created_at,channel,contact_id,direction,body,metadata) VALUES ('h','h','c-after','s-c-after',?,?,?,'inbound','thanks','{}')`)
      .run(new Date(Date.now() + 5000).toISOString(), 'system:peggy', 'alice');
    f.lease(1, 'c-after');
    expect(await f.originOf(await f.send('agent:peggy-pool-1', { origin: { kind: 'external', label: 'another agent session' } })))
      .toEqual({ kind: 'turn', agent_id: 'peggy-pool-1', conversation_id: 'c-after' });
    f.lease(2, 'no-such-conversation');
    expect(await f.originOf(await f.send('agent:peggy-pool-2'))).toEqual({ kind: 'turn', agent_id: 'peggy-pool-2', conversation_id: 'no-such-conversation' });
  });
});

describe('a reply that outlives its lease is still its conversation\'s own (E80 S80.3, review follow-up)', () => {
  it('stamps metadata.conversation_id as the turn\'s conversation when the pane was evicted (free, dead, launching, draining)', async () => {
    const f = await fixture();
    let pane = 0;
    for (const state of ['free', 'dead', 'launching', 'draining'] as const) {
      pane += 1;
      f.lease(pane, state === 'free' ? null : 'someone-elses-conversation', state);
      const origin = await f.originOf(await f.send(`agent:peggy-pool-${pane}`, { conversation_id: f.dm, origin: { kind: 'external', label: 'another agent session' } }));
      expect(origin).toEqual({ kind: 'turn', agent_id: `peggy-pool-${pane}`, conversation_id: f.dm });
      expect(isForeignOrigin(readOrigin({ origin } as Record<string, unknown>), f.dm)).toBe(false);
    }
  });

  it('evicted and resumed on another pane: the old pane\'s late reply is the DM\'s own, and the new pane\'s reply too', async () => {
    const f = await fixture();
    f.lease(1, null, 'free'); // evicted
    f.lease(2, f.dm); // the DM resumed here
    const late = await f.originOf(await f.send('agent:peggy-pool-1', { conversation_id: f.dm }));
    expect(isForeignOrigin(readOrigin({ origin: late } as Record<string, unknown>), f.dm)).toBe(false);
    const current = await f.originOf(await f.send('agent:peggy-pool-2', { conversation_id: f.dm }));
    expect(isForeignOrigin(readOrigin({ origin: current } as Record<string, unknown>), f.dm)).toBe(false);
    await f.deliver();
    // Neither reply is fed back to the DM as foreign context.
    await f.inbound('thanks');
    expect(f.take()[0]!.envelope.metadata['pending_context']).toBeUndefined();
  });

  it('keeps the stale-pane 409 for a pane now leased to another conversation, enqueueing nothing', async () => {
    const f = await fixture();
    f.lease(1, 'another-conversation');
    const res = await f.send('agent:peggy-pool-1', { conversation_id: f.dm });
    expect(res.statusCode).toBe(409);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM message_queue').get()).toEqual({ n: 0 });
  });

  it('uses the lease for sends without a conversation id (launching and draining leases leave the origin alone), and ignores the hint for non-panes', async () => {
    const f = await fixture();
    f.lease(1, 'x', 'launching');
    f.lease(2, 'x', 'draining');
    const stamped = { origin: { kind: 'external', label: 'Ambient scan' } };
    expect(await f.originOf(await f.send('agent:peggy-pool-1', stamped))).toEqual(stamped.origin);
    expect(await f.originOf(await f.send('agent:peggy-pool-2', stamped))).toEqual(stamped.origin);
    expect(await f.originOf(await f.send('agent:claude', { ...stamped, conversation_id: f.dm }))).toEqual(stamped.origin);
    f.lease(3, f.dm);
    expect((await f.originOf(await f.send('agent:peggy-pool-3', stamped)) as { conversation_id: string }).conversation_id).toBe(f.dm);
  });
});

describe('share_context target (E80 review follow-up)', () => {
  it('writes nothing for a contact with no Telegram identity, or a bot that is not configured', async () => {
    const f = await fixture({ config: makeConfig([DM, 'telegram:ghost']) });
    const bob = await f.share({ to: 'contact:bob' });
    expect(bob.statusCode).toBe(400);
    expect(bob.json().error).toContain('has no Telegram identity');
    const ghost = await f.share({ channel: 'telegram:ghost' });
    expect(ghost.statusCode).toBe(400);
    expect(ghost.json().error).toContain('No Telegram bot is configured');
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 });
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM transcripts').get()).toEqual({ n: 0 });
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM conversation_registry').get()).toEqual({ n: 0 });
    expect((await f.share()).statusCode).toBe(201); // alice has an identity on peggy's bot
  });
});

describe('with a real PoolManager (E80 exit criteria 4 and 5)', () => {
  it('a placeholder session: the first real message launches a fresh --session-id on the same row, then carries the shared note', async () => {
    const f = await fixture({ realPool: true });
    const shared = await f.share({ body: 'Chose SQLite for the store' });
    const placeholder = shared.json().session_id as string;
    expect(f.db.prepare('SELECT claude_session_id, message_count FROM sessions WHERE id = ?').get(placeholder)).toEqual({ claude_session_id: null, message_count: 0 });

    const sent = await f.inbound('hello Peggy');
    expect(sent.queued).toBe(true);
    expect(f.launcher.launch).toHaveBeenCalledTimes(1);
    const launch = (f.launcher.launch.mock.calls[0] as unknown as [{ resume: boolean; sessionId: string; paneAgentId: string }])[0];
    expect(launch.resume).toBe(false);
    expect(launch.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    // The placeholder is the DM's one session: the pool stored the new id on it and transcript-log extended it.
    expect(f.db.prepare('SELECT id, claude_session_id, message_count, ended_at FROM sessions WHERE conversation_id = ?').all(f.dm))
      .toEqual([{ id: placeholder, claude_session_id: launch.sessionId, message_count: 1, ended_at: null }]);
    expect(f.db.prepare(`SELECT session_id FROM transcripts WHERE direction = 'inbound' AND conversation_id = ?`).get(f.dm)).toEqual({ session_id: placeholder });
    const [msg] = f.take(launch.paneAgentId.startsWith('agent:') ? launch.paneAgentId : `agent:${launch.paneAgentId}`);
    expect(block(msg!.envelope)).toContain('Claude Code: peggy: Chose SQLite for the store');
  });

  it('context shared while the DM has no pane survives an eviction, and the resumed DM still gets it', async () => {
    const f = await fixture({ realPool: true });
    // The DM is on the pane (idle_evict_ms 0: any other conversation may take it).
    await f.inbound('first');
    await f.inbound('second');
    for (const m of f.take()) await f.ack(m.messageId);
    // Another conversation evicts it.
    await f.inbound('elsewhere', 'telegram:other');
    expect(f.db.prepare(`SELECT conversation_id FROM pool_leases`).get()).toMatchObject({ conversation_id: computeConversationId('alice', 'telegram:other', 'general') });
    // The note is shared while the DM holds no pane; the pending state is keyed by conversation, not pane.
    await f.share({ body: 'shared while evicted' });
    expect(readWatermark(f.db, f.dm)).toBeNull();
    await f.inbound('back again');
    expect(f.launcher.launch).toHaveBeenCalledTimes(3); // first, the other conversation, the DM resumed
    // Not asserted: whether the DM's own Claude session resumes. `sessions.claude_session_id` stays NULL in this
    // flow (the first-message gap noted in PoolManager.persistSessionId), so the pool launches fresh. That is
    // pre-existing and the live spike's to examine; what E80 owns is that the pending context survives it.
    const resumed = f.take().find((m) => m.envelope.channel === DM && m.envelope.payload.type === 'text' && m.envelope.payload.body === 'back again');
    expect(block(resumed!.envelope)).toContain('shared while evicted');
    await f.ack(resumed!.messageId);
    expect(readWatermark(f.db, f.dm)).not.toBeNull();
  });
});

void HOUR;

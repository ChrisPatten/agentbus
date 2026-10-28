import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../adapters/cc-headless.js', () => ({ getHeadlessSnapshots: () => [] }));
vi.mock('../adapters/claude-transcript.js', () => ({ claudeTranscriptExists: () => true }));
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { runMigrations } from '../db/schema.js';
import { MessageQueue } from '../core/queue.js';
import { AdapterRegistry } from '../core/registry.js';
import { PipelineEngine } from '../pipeline/engine.js';
import { createHttpServer } from './api.js';
import { AppConfigSchema, type AppConfig } from '../config/schema.js';
import { normalize } from '../pipeline/stages/normalize.js';
import { createRouteResolve } from '../pipeline/stages/route-resolve.js';
import { createPoolRouteResolve } from '../pipeline/stages/pool-route-resolve.js';
import { createTranscriptLog } from '../pipeline/stages/transcript-log.js';
import { createPendingContextInject } from '../pipeline/stages/pending-context-inject.js';
import { computeConversationId } from '../pipeline/conversation-id.js';
import { LeaseStore } from '../pool/lease-store.js';
import type { PoolManager } from '../pool/pool-manager.js';
import { formatMessagesForSampling } from '../adapters/message-format.js';
import { CONTEXT_SHARED_INTRO, PENDING_CONTEXT_INTRO, readWatermark } from '../app/pending-context.js';
import { isForeignOrigin, readOrigin } from '../core/origin.js';
import { PENDING_CONTEXT_KEY, readPendingContext } from '../core/system-block.js';
import type { MessageEnvelope } from '../types/envelope.js';

// E80 S80.3-S80.5 — pending context and share_context for a Telegram DM served by cc-pool.

const DM = 'telegram:peggy';
const PANE = 'agent:peggy-pool-1';
const PARKED = 'agent:peggy-pool-parked';
const HOUR = 3_600_000;

function makeConfig(opts: { agents?: Record<string, unknown>; routes?: unknown[]; app?: Record<string, unknown> } = {}): AppConfig {
  return AppConfigSchema.parse({
    bus: { db_path: ':memory:' },
    adapters: { telegram: { peggy: { token: 'peggy-token' }, pokeclaude: { token: 'poke-token' } }, ...(opts.app ? { app: opts.app } : {}) },
    memory: {},
    contacts: {
      alice: { id: 'alice', displayName: 'Alice', platforms: { telegram: { userId: 1001 } } },
      bob: { id: 'bob', displayName: 'Bob', platforms: {} },
    },
    agents: opts.agents ?? { 'agent:peggy': { pending_context: { channels: [DM] } } },
    pipeline: { routes: opts.routes ?? [
      { match: { channel: DM }, target: { adapterId: 'cc-pool', recipientId: 'agent:peggy' } },
      { match: { channel: 'telegram:pokeclaude' }, target: { adapterId: 'cc-pool', recipientId: 'agent:poke' } },
      { match: { channel: 'app' }, target: { adapterId: 'cc-headless', recipientId: 'agent:work' } },
    ] },
  }) as AppConfig;
}

const live: { server: FastifyInstance; db: Database.Database }[] = [];
afterEach(async () => { for (const x of live.splice(0)) { await x.server.close(); x.db.close(); } });

async function fixture(config: AppConfig = makeConfig()) {
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON'); runMigrations(db);
  const queue = new MessageQueue(db);
  // The pool manager decides which pane (or the parked bucket) serves the conversation; a stub is enough here.
  const resolved = { recipient: PANE };
  const managers = new Map(['agent:peggy', 'agent:poke'].map((id) => [id, { resolveRoute: async () => resolved.recipient }])) as unknown as Map<string, PoolManager>;
  const pipeline = new PipelineEngine();
  pipeline.use({ slot: 10, name: 'normalize', stage: normalize });
  pipeline.use({ slot: 70, name: 'route-resolve', stage: createRouteResolve(config, db) });
  pipeline.use({ slot: 72, name: 'pool-route-resolve', stage: createPoolRouteResolve(managers) });
  pipeline.use({ slot: 80, name: 'transcript-log', stage: createTranscriptLog(db, config) });
  pipeline.use({ slot: 88, name: 'pending-context-inject', stage: createPendingContextInject(db, config) });
  const server = await createHttpServer({ config, db, registry: new AdapterRegistry(), queue, pipeline });
  live.push({ server, db });
  const inbound = async (body: string, channel = DM, metadata: Record<string, unknown> = {}) => {
    const res = await server.inject({ method: 'POST', url: '/api/v1/inbound',
      payload: { channel, sender: 'contact:alice', payload: { type: 'text', body }, metadata } });
    return res.json() as { ok: boolean; id: string; queued: boolean };
  };
  const share = (payload: Record<string, unknown>) => server.inject({ method: 'POST', url: '/api/v1/context',
    payload: { to: 'contact:alice', body: 'Finished the migration plan', source: 'Claude Code: peggy', channel: DM, ...payload } });
  const take = (recipient = PANE) => queue.dequeue(recipient, undefined, 20);
  const ack = (id: string, status: 'delivered' | 'failed' = 'delivered') => server.inject({ method: 'POST', url: `/api/v1/messages/${id}/ack`, payload: { status } });
  const dmConversation = computeConversationId('alice', DM, 'general');
  /** An outbound row in the DM as the transcripts store it. */
  const outbound = (session: string, body: string, metadata: Record<string, unknown>, ageMs = 0) => db.prepare(
    `INSERT INTO transcripts (id, message_id, conversation_id, session_id, created_at, channel, contact_id, direction, body, metadata)
     VALUES (?, ?, ?, ?, ?, ?, 'alice', 'outbound', ?, ?)`).run(randomUUID(), randomUUID(), dmConversation, session,
    new Date(Date.now() - ageMs).toISOString(), DM, body, JSON.stringify(metadata));
  const sessionRows = () => db.prepare('SELECT * FROM sessions WHERE conversation_id = ?').all(dmConversation) as Array<Record<string, unknown>>;
  return { server, db, queue, resolved, inbound, share, take, ack, dmConversation, outbound, sessionRows, config };
}

const external = (label = 'Ambient scan') => ({ origin: { kind: 'external', label } });
const attachment = (e: MessageEnvelope) => readPendingContext(e.metadata);

describe('pending-context stage for a pane (E80 S80.4)', () => {
  it('attaches the block to a leased pane\'s copy: visible foreign sends first, then shared notes, outside any system block', async () => {
    const f = await fixture();
    expect((await f.share({ body: 'Chose SQLite for the store' })).statusCode).toBe(201);
    const [placeholder] = f.sessionRows();
    f.outbound(placeholder!['id'] as string, 'Two calendar items need you today', external());
    const sent = await f.inbound('what is on today?');
    expect(sent.queued).toBe(true);

    const [msg] = f.take();
    const a = attachment(msg!.envelope)!;
    expect(a.conversation_id).toBe(f.dmConversation);
    expect(a.block).toContain(PENDING_CONTEXT_INTRO);
    expect(a.block).toContain('Ambient scan: Two calendar items need you today');
    expect(a.block).toContain(CONTEXT_SHARED_INTRO);
    expect(a.block).toContain('Claude Code: peggy: Chose SQLite for the store');
    expect(a.block!.indexOf(PENDING_CONTEXT_INTRO)).toBeLessThan(a.block!.indexOf(CONTEXT_SHARED_INTRO));

    const text = formatMessagesForSampling([msg!.envelope]);
    expect(text.startsWith(PENDING_CONTEXT_INTRO)).toBe(true);
    expect(text).not.toContain('<agentbus-system');
    expect(text.indexOf(CONTEXT_SHARED_INTRO)).toBeLessThan(text.indexOf('New message from contact:alice'));
    // The block rides the envelope only: the transcript keeps the user's own words.
    const row = f.db.prepare(`SELECT body, metadata FROM transcripts WHERE message_id = ? AND direction = 'inbound'`).get(sent.id) as { body: string; metadata: string };
    expect(row.body).toBe('what is on today?');
    expect(row.metadata).not.toContain('Two calendar items');
    expect(row.metadata).not.toContain(PENDING_CONTEXT_KEY);
  });

  it('attaches nothing for a conversation that is not primary (another agent\'s DM, a group, an unlisted config)', async () => {
    const f = await fixture();
    f.resolved.recipient = 'agent:poke-pool-1';
    await f.inbound('hello', 'telegram:pokeclaude');
    expect(attachment(f.take('agent:poke-pool-1')[0]!.envelope)).toBeNull();

    const bare = await fixture(makeConfig({ agents: {} }));
    await bare.inbound('hello');
    expect(attachment(bare.take()[0]!.envelope)).toBeNull();
  });

  it('never hands a pane its own sends back, and does hand it a send from a pane leased elsewhere', async () => {
    const f = await fixture();
    await f.inbound('first'); // creates the DM session
    const [session] = f.sessionRows();
    const sid = session!['id'] as string;
    f.take(); // the first message is on its way; not interesting here
    // Peggy's own reply from the DM pane (stamped by the bus from the lease), and a routine from a scheduled pane.
    f.outbound(sid, 'my own reply', { origin: { kind: 'turn', agent_id: 'peggy-pool-1', conversation_id: f.dmConversation } });
    f.outbound(sid, 'from the scheduled pane', { origin: { kind: 'turn', agent_id: 'peggy-pool-2', conversation_id: 'sched-conversation', label: 'Morning scan' } });
    await f.inbound('second');
    const block = attachment(f.take()[0]!.envelope)!.block!;
    expect(block).toContain('Morning scan: from the scheduled pane');
    expect(block).not.toContain('my own reply');
  });

  it('moves the watermark on ack only, and a dead-lettered message leaves the context pending', async () => {
    const f = await fixture();
    await f.share({ body: 'note one' });
    const first = await f.inbound('hi');
    expect(readWatermark(f.db, f.dmConversation)).toBeNull();
    const [m1] = f.take();
    expect(m1!.messageId).toBe(first.id);
    expect(readWatermark(f.db, f.dmConversation)).toBeNull(); // taken, not acked

    expect((await f.ack(first.id, 'failed')).statusCode).toBe(200);
    expect(readWatermark(f.db, f.dmConversation)).toBeNull();
    // The next message still carries the note.
    await f.inbound('hi again');
    const [m2] = f.take();
    expect(attachment(m2!.envelope)!.block).toContain('note one');

    expect((await f.ack(m2!.messageId)).statusCode).toBe(200);
    expect(readWatermark(f.db, f.dmConversation)).toEqual(attachment(m2!.envelope)!.through);
    // Delivered once: the next message has nothing pending.
    await f.inbound('third');
    expect(attachment(f.take()[0]!.envelope)).toBeNull();
  });

  it('renders one block for messages polled together, and each ack advances only to its own mark', async () => {
    const f = await fixture();
    await f.share({ body: 'note one' });
    await f.inbound('a');
    await f.inbound('b');
    const batch = f.take();
    expect(batch).toHaveLength(2);
    expect(batch.every((m) => attachment(m.envelope)!.block!.includes('note one'))).toBe(true);
    const text = formatMessagesForSampling(batch.map((m) => m.envelope));
    expect(text.split(CONTEXT_SHARED_INTRO)).toHaveLength(2); // once, not twice
    expect(text.split('note one')).toHaveLength(2);
    for (const m of batch) expect((await f.ack(m.messageId)).statusCode).toBe(200);
    expect(readWatermark(f.db, f.dmConversation)).toEqual(attachment(batch[0]!.envelope)!.through);
  });

  it('shows the freshest block when envelopes in a batch differ, one per conversation', () => {
    const env = (id: string, block: string | null, through: string, conversation = 'c1'): MessageEnvelope => ({
      id, timestamp: '2026-10-28T12:00:00.000Z', channel: DM, topic: 'general', sender: 'contact:alice', recipient: PANE, reply_to: null,
      priority: 'normal', payload: { type: 'text', body: `body ${id}` },
      metadata: { [PENDING_CONTEXT_KEY]: { conversation_id: conversation, block, through: { created_at: through, id: `t-${through}` } } },
    });
    const text = formatMessagesForSampling([env('1', 'OLD BLOCK', '2026-10-28T10:00:00.000Z'), env('2', 'NEW BLOCK', '2026-10-28T11:00:00.000Z'),
      env('3', 'OTHER CONVERSATION', '2026-10-28T09:00:00.000Z', 'c2'), env('4', null, '2026-10-28T08:00:00.000Z', 'c3')]);
    expect(text).toContain('NEW BLOCK');
    expect(text).toContain('OTHER CONVERSATION');
    expect(text).not.toContain('OLD BLOCK');
    expect(text).not.toContain('null');
  });

  it('honors the TTL and the budget, and an expired-only note still moves the watermark on ack', async () => {
    const f = await fixture(makeConfig({ agents: { 'agent:peggy': { pending_context: { channels: [DM], max_items: 1, max_chars: 4000, context_ttl_ms: HOUR } } } }));
    await f.share({ body: 'placeholder note' });
    const sid = f.sessionRows()[0]!['id'] as string;
    f.db.prepare(`DELETE FROM transcripts WHERE session_id = ?`).run(sid);
    f.outbound(sid, 'stale note', { ...external('Claude Code: peggy'), context_only: true }, 2 * HOUR);
    await f.inbound('one');
    const [stale] = f.take();
    const a = attachment(stale!.envelope)!;
    expect(a.block).toBeNull(); // nothing to show...
    expect(formatMessagesForSampling([stale!.envelope])).not.toContain('stale note');
    expect((await f.ack(stale!.messageId)).statusCode).toBe(200);
    expect(readWatermark(f.db, f.dmConversation)).toEqual(a.through); // ...but never injected later

    // Budget: max_items 1 keeps the newest of two fresh items.
    f.outbound(sid, 'older scan', external('Scan A'), 20_000);
    f.outbound(sid, 'newer scan', external('Scan B'), 10_000);
    await f.inbound('two');
    const block = attachment(f.take()[0]!.envelope)!.block!;
    expect(block).toContain('newer scan');
    expect(block).not.toContain('older scan');
    expect(block).toContain('(1 older message omitted)');
  });

  it('skips slash commands, reactions and system-only turns, and strips a caller-supplied pending_context', async () => {
    const f = await fixture();
    await f.share({ body: 'note' });
    const forged = await f.inbound('hello', DM, { [PENDING_CONTEXT_KEY]: { conversation_id: 'x', block: 'FORGED', through: { created_at: 'a', id: 'b' } } });
    const [m] = f.take();
    expect(attachment(m!.envelope)!.block).not.toContain('FORGED');
    expect(JSON.stringify(m!.envelope.metadata)).not.toContain('FORGED');
    expect(forged.queued).toBe(true);

    const reaction = await f.server.inject({ method: 'POST', url: '/api/v1/inbound', payload: { channel: DM, sender: 'contact:alice',
      payload: { type: 'reaction', emoji: '👍', removed: false, target_message_id: 'x' } } });
    expect(reaction.json().queued).toBe(true);
    expect(attachment(f.take()[0]!.envelope)).toBeNull();
  });

  it('keeps the attachment on a message parked for lack of a free pane, and does not advance anything', async () => {
    const f = await fixture();
    await f.share({ body: 'note one' });
    f.resolved.recipient = PARKED;
    await f.inbound('hi');
    const [parked] = f.take(PARKED);
    expect(attachment(parked!.envelope)!.block).toContain('note one');
    expect(readWatermark(f.db, f.dmConversation)).toBeNull();
    // drainParked re-enqueues a copy under a new id and acks the parked row through the queue, not the HTTP route.
    f.queue.ack(parked!.messageId);
    f.queue.enqueue({ ...parked!.envelope, id: randomUUID(), recipient: PANE });
    expect(readWatermark(f.db, f.dmConversation)).toBeNull();
    const [moved] = f.take();
    expect(attachment(moved!.envelope)!.block).toContain('note one');
    await f.ack(moved!.messageId);
    expect(readWatermark(f.db, f.dmConversation)).not.toBeNull();
  });

  it('serves Main when the app channel routes to cc-pool', async () => {
    const config = makeConfig({ routes: [{ match: { channel: 'app' }, target: { adapterId: 'cc-pool', recipientId: 'agent:peggy' } }] });
    const f = await fixture(config);
    const mainConv = computeConversationId('alice', 'app', 'general');
    expect((await f.share({ channel: 'app', body: 'note for Main' })).statusCode).toBe(201);
    const sid = (f.db.prepare('SELECT id FROM sessions WHERE conversation_id = ?').get(mainConv) as { id: string }).id;
    f.db.prepare(`INSERT INTO transcripts (id, message_id, conversation_id, session_id, created_at, channel, contact_id, direction, body, metadata)
      VALUES ('r1','r1',?,?,?, 'app','alice','outbound','routine result',?)`).run(mainConv, sid, new Date().toISOString(), JSON.stringify(external()));
    await f.inbound('and now?', 'app');
    const block = attachment(f.take()[0]!.envelope)!.block!;
    expect(block).toContain('note for Main');
    expect(block).toContain('Ambient scan: routine result');
  });
});

describe('bus-side origin for pane sends (E80 S80.3)', () => {
  /** A pool lease row for `pane` on `conversation`; `state` leased by default. */
  function lease(db: Database.Database, pane: string, conversation: string, state: 'leased' | 'free' | 'dead' = 'leased') {
    const store = new LeaseStore(db);
    store.seedPanes('peggy', [{ paneId: `peggy:${pane}`, agentId: `agent:peggy-pool-${pane}` }]);
    db.prepare(`UPDATE pool_leases SET state = ?, conversation_id = ? WHERE pane_id = ?`).run(state, state === 'free' ? null : conversation, `peggy:${pane}`);
  }
  const send = async (f: Awaited<ReturnType<typeof fixture>>, sender: string, metadata: Record<string, unknown> = {}) => {
    const res = await f.server.inject({ method: 'POST', url: '/api/v1/messages', payload: {
      channel: DM, topic: 'general', sender, recipient: 'contact:alice', payload: { type: 'text', body: 'hello' }, metadata } });
    expect(res.statusCode).toBe(201);
    return new MessageQueue(f.db).getById(res.json().id)!.envelope.metadata;
  };

  it('stamps a pane\'s send to its own conversation as that turn\'s own', async () => {
    const f = await fixture();
    lease(f.db, '1', f.dmConversation);
    const meta = await send(f, PANE, { origin: { kind: 'external', label: 'another agent session' } });
    expect(meta['origin']).toEqual({ kind: 'turn', agent_id: 'peggy-pool-1', conversation_id: f.dmConversation });
    expect(isForeignOrigin(readOrigin(meta), f.dmConversation)).toBe(false);
  });

  it('makes a pane\'s send into another conversation foreign to it, keeping an explicit label', async () => {
    const f = await fixture();
    lease(f.db, '2', 'scheduled-conversation');
    const meta = await send(f, 'agent:peggy-pool-2', { origin: { kind: 'external', label: 'Morning scan' } });
    expect(meta['origin']).toEqual({ kind: 'turn', agent_id: 'peggy-pool-2', conversation_id: 'scheduled-conversation', label: 'Morning scan' });
    expect(isForeignOrigin(readOrigin(meta), f.dmConversation)).toBe(true);
  });

  it('replaces a spoofed origin', async () => {
    const f = await fixture();
    lease(f.db, '1', f.dmConversation);
    const meta = await send(f, PANE, { origin: { kind: 'turn', agent_id: 'someone', conversation_id: 'victim-conversation', label: 'Trusted' } });
    expect(meta['origin']).toMatchObject({ kind: 'turn', conversation_id: f.dmConversation });
  });

  it('leaves origin as stamped for a stale, free or dead lease, an unknown sender and a non-pane sender', async () => {
    const f = await fixture();
    const stamped = { origin: { kind: 'external', label: 'Ambient scan' } };
    lease(f.db, '3', 'x', 'free');
    lease(f.db, '4', 'x', 'dead');
    for (const sender of ['agent:peggy-pool-3', 'agent:peggy-pool-4', 'agent:peggy-pool-99', 'agent:claude', 'contact:alice']) {
      expect((await send(f, sender, stamped))['origin']).toEqual(stamped.origin);
    }
  });
});

describe('share_context into a Telegram DM (E80 S80.5)', () => {
  it('creates the conversation and a message-less placeholder session when the DM has none, with no queue row and no visible event', async () => {
    const f = await fixture();
    const res = await f.share({});
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ conversation_id: f.dmConversation });
    expect(f.db.prepare('SELECT channel, topic, contact_id FROM conversation_registry WHERE id = ?').get(f.dmConversation))
      .toEqual({ channel: DM, topic: 'general', contact_id: 'alice' });
    expect(f.sessionRows()).toEqual([expect.objectContaining({ id: res.json().session_id, channel: DM, contact_id: 'alice', agent_id: 'agent:peggy',
      claude_session_id: null, ended_at: null, message_count: 0 })]);
    const hidden = f.db.prepare(`SELECT channel, direction, body, metadata FROM transcripts WHERE conversation_id = ?`).all(f.dmConversation) as Array<Record<string, string>>;
    expect(hidden).toEqual([expect.objectContaining({ channel: DM, direction: 'outbound', body: 'Finished the migration plan' })]);
    expect(JSON.parse(hidden[0]!['metadata']!)).toEqual({ origin: { kind: 'external', label: 'Claude Code: peggy' }, context_only: true });
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM message_queue').get()).toEqual({ n: 0 });
  });

  it('attaches to an open session without touching it, and to an ended one', async () => {
    const f = await fixture();
    await f.inbound('hello');
    f.take();
    const [open] = f.sessionRows();
    const before = { ...open };
    const res = await f.share({});
    expect(res.json().session_id).toBe(open!['id']);
    expect(f.sessionRows()).toEqual([before]);
    expect(f.sessionRows()).toHaveLength(1);

    f.db.prepare('UPDATE sessions SET ended_at = ? WHERE id = ?').run(new Date().toISOString(), open!['id']);
    const afterEnd = { ...f.sessionRows()[0] };
    expect((await f.share({ body: 'second' })).json().session_id).toBe(open!['id']);
    expect(f.sessionRows()).toEqual([afterEnd]);
  });

  it('is rejected from the pane leased to the target conversation, and accepted from a pane leased elsewhere', async () => {
    const f = await fixture();
    const lease = (pane: string, conversation: string) => {
      new LeaseStore(f.db).seedPanes('peggy', [{ paneId: `peggy:${pane}`, agentId: `agent:peggy-pool-${pane}` }]);
      f.db.prepare(`UPDATE pool_leases SET state = 'leased', conversation_id = ? WHERE pane_id = ?`).run(conversation, `peggy:${pane}`);
    };
    lease('1', f.dmConversation);
    lease('2', 'scheduled-conversation');
    const own = await f.share({ sender: PANE });
    expect(own.statusCode).toBe(409);
    expect(own.json().error).toContain(`turn in ${DM}`);
    expect(f.sessionRows()).toHaveLength(0);
    const elsewhere = await f.share({ sender: 'agent:peggy-pool-2' });
    expect(elsewhere.statusCode).toBe(201);
    const row = f.db.prepare(`SELECT metadata FROM transcripts WHERE conversation_id = ?`).get(f.dmConversation) as { metadata: string };
    expect(JSON.parse(row.metadata).origin).toEqual({ kind: 'turn', agent_id: 'peggy-pool-2', conversation_id: 'scheduled-conversation', label: 'Claude Code: peggy' });
  });

  it('hides the note from the transcript API and transcript search', async () => {
    const f = await fixture();
    const sessionId = (await f.share({ body: 'quillfeather handoff' })).json().session_id as string;
    const search = (await f.server.inject({ method: 'GET', url: '/api/v1/transcripts/search?q=quillfeather' })).json();
    expect(search.results).toEqual([]);
    const transcript = (await f.server.inject({ method: 'GET', url: `/api/v1/sessions/${sessionId}/transcript` })).json();
    expect(transcript.transcript).toEqual([]);
    expect(f.db.prepare(`SELECT COUNT(*) AS n FROM transcripts WHERE json_extract(metadata,'$.context_only') = 1`).get()).toEqual({ n: 1 });
  });

  it('rejects channels that are not primary, unrouted, or served by a runtime that cannot read it', async () => {
    const f = await fixture();
    for (const channel of ['telegram:pokeclaude', `${DM}:group:-1001`, 'telegram', 'email:peggy']) {
      const res = await f.share({ channel });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('not a primary channel');
    }
    const mcp = await fixture(makeConfig({ routes: [{ match: { channel: DM }, target: { adapterId: 'claude-code', recipientId: 'agent:peggy' } }] }));
    const res = await mcp.share({});
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain(`${DM} is served by claude-code`);
    const unrouted = await fixture(makeConfig({ routes: [] }));
    expect((await unrouted.share({})).statusCode).toBe(400);
    expect(f.sessionRows()).toHaveLength(0);
  });

  it('defaults to Main, so E79 callers are unchanged', async () => {
    const f = await fixture();
    const res = await f.server.inject({ method: 'POST', url: '/api/v1/context',
      payload: { to: 'contact:alice', body: 'to Main', source: 'Claude Code: peggy' } });
    expect(res.statusCode).toBe(201);
    expect(res.json().conversation_id).toBe(computeConversationId('alice', 'app', 'general'));
  });

  it('feeds the DM\'s next pane message, whether or not a pane was leased when it was shared', async () => {
    const f = await fixture();
    await f.share({ body: 'shared with no pane' });
    await f.inbound('first');
    expect(attachment(f.take()[0]!.envelope)!.block).toContain('shared with no pane');
  });
});

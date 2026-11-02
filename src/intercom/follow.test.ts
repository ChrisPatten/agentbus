import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';
import { MessageQueue } from '../core/queue.js';
import { AdapterRegistry, type AdapterInstance } from '../core/registry.js';
import { PipelineEngine } from '../pipeline/engine.js';
import { normalize } from '../pipeline/stages/normalize.js';
import { createContactResolve } from '../pipeline/stages/contact-resolve.js';
import { createDedup } from '../pipeline/stages/dedup.js';
import { createRouteResolve } from '../pipeline/stages/route-resolve.js';
import { createTranscriptLog } from '../pipeline/stages/transcript-log.js';
import { processInbound } from '../http/api.js';
import { computeConversationId } from '../pipeline/conversation-id.js';
import { IntercomAdapterSchema, type AppConfig } from '../config/schema.js';
import type { MessageEnvelope } from '../types/envelope.js';
import type { CalendarFeed } from './calendar.js';
import { IntercomService, type Client } from './service.js';
import { readEvents } from './store.js';

const TOKEN = 'a'.repeat(40);
const CHANNEL = 'telegram:peggy';
const GROUP = 'telegram:peggy:group:-1003977797157';

function makeConfig(follow: Record<string, unknown> = { contact: 'chris', channel: CHANNEL }, extra: Record<string, unknown> = {}) {
  return IntercomAdapterSchema.parse({ interaction_grace_s: 120, ...extra, surfaces: [{ id: 'iphone-proto', token_env: 'T', follow }] });
}
const appConfig = {
  memory: { session_idle_threshold_ms: 1_800_000 },
  contacts: { chris: { id: 'chris', displayName: 'Chris', platforms: { telegram: { userId: 8375562990 } } } },
  pipeline: { dedup_window_ms: 30000, drop_unrouted: false, routes: [
    { match: { channel: CHANNEL }, target: { adapterId: 'cc-pool', recipientId: 'agent:peggy' } },
    { match: { channel: GROUP }, target: { adapterId: 'cc-pool', recipientId: 'agent:peggy' } },
  ] },
} as unknown as AppConfig;

function fakeSocket() {
  const frames: any[] = [];
  const socket = { readyState: 1, send: (d: string) => frames.push(JSON.parse(d)), close: vi.fn() };
  return { frames, socket };
}

describe('Intercom follow engine', () => {
  let db: Database.Database; let queue: MessageQueue; let registry: AdapterRegistry;
  let echoes: MessageEnvelope[]; let service: IntercomService;

  const calendar = { today: async () => ({ date: '2026-11-01', tz: 'America/New_York', generated_at: 'x', events: [] }) } as unknown as CalendarFeed;

  function build(follow?: Record<string, unknown>, extra?: Record<string, unknown>) {
    const pipeline = new PipelineEngine();
    pipeline.use({ slot: 10, name: 'normalize', stage: normalize });
    pipeline.use({ slot: 20, name: 'contact', stage: createContactResolve(appConfig) });
    pipeline.use({ slot: 30, name: 'dedup', stage: createDedup(db) });
    pipeline.use({ slot: 70, name: 'route', stage: createRouteResolve(appConfig, db) });
    pipeline.use({ slot: 80, name: 'transcript', stage: createTranscriptLog(db, appConfig) });
    service = new IntercomService({
      config: makeConfig(follow, extra), db, registry, calendar, env: { T: TOKEN }, log: () => {},
      submitInbound: (m, s) => processInbound(m, { queue, pipeline, config: appConfig, db, registry }, s),
    });
  }
  async function connect(cursor = 0, keep = false) {
    const { frames, socket } = fakeSocket();
    const client: Client = { socket, surface: service.surfaces.get('iphone-proto')!, ready: false, cursor: 0, lastPong: Date.now() };
    await service.attach(client, cursor);
    if (!keep) frames.length = 0;
    return { frames, client };
  }
  const surface = () => service.surfaces.get('iphone-proto')!;
  const agentMsg = (over: Partial<MessageEnvelope> = {}): MessageEnvelope => ({
    id: `m-${Math.random()}`, timestamp: new Date().toISOString(), channel: CHANNEL, topic: 'general', sender: 'agent:peggy-pool-1',
    recipient: 'contact:chris', reply_to: null, priority: 'normal', payload: { type: 'text', body: 'Done, Mr. Patten. More follows.' }, metadata: {}, ...over,
  });
  const ev = (frames: any[], name: string) => frames.filter((f) => f.type === 'event' && f.event === name);

  beforeEach(() => {
    db = new Database(':memory:'); db.pragma('foreign_keys = ON'); runMigrations(db);
    queue = new MessageQueue(db); registry = new AdapterRegistry(); echoes = [];
    const telegram: AdapterInstance = {
      id: CHANNEL, name: 'tg', capabilities: { send: true, channels: [CHANNEL, GROUP] },
      start: async () => {}, stop: async () => {}, health: async () => ({ status: 'healthy' }),
      send: async (e) => { echoes.push(e); return { success: true }; },
    };
    registry.register(telegram);
    build();
  });
  afterEach(() => { service.stop(); vi.useRealTimers(); db.close(); });

  it('skips a surface whose token env var is missing or short', () => {
    const s = new IntercomService({ config: makeConfig(), db, submitInbound: async () => ({ ok: true, queued: false, reason: 'x' }), env: { T: 'short' }, log: () => {} });
    expect(s.surfaces.size).toBe(0);
  });

  describe('surface send', () => {
    it('arrives as a Telegram DM message from the contact, with origin metadata and an agent-visible note', async () => {
      const ack = await service.handleSend(surface(), { client_msg_id: 'c1', body: 'What is on today?' });
      expect(ack).toMatchObject({ type: 'ack', client_msg_id: 'c1', status: 'queued', interaction_id: expect.any(String) });
      const [msg] = queue.dequeueByPrefix('agent:', 10);
      const env = msg!.envelope;
      expect(env).toMatchObject({ id: ack['message_id'], channel: CHANNEL, topic: 'general', sender: 'contact:chris', recipient: 'agent:peggy', payload: { type: 'text', body: 'What is on today?' } });
      expect(env.metadata).toMatchObject({ origin: 'intercom', surface_id: 'iphone-proto', interaction_id: ack['interaction_id'], adapter_id: 'cc-pool', conversation_id: computeConversationId('chris', CHANNEL, 'general') });
      const blocks = env.metadata['system_blocks'] as string[];
      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toContain('Sent from Intercom (iphone-proto)');
      expect(blocks[0]).toContain('glance');
      // Same conversation a real Telegram message from this contact would land in; the note is not stored.
      const row = db.prepare(`SELECT conversation_id, channel, direction, metadata FROM transcripts WHERE message_id = ?`).get(ack['message_id']) as any;
      expect(row).toMatchObject({ conversation_id: computeConversationId('chris', CHANNEL, 'general'), channel: CHANNEL, direction: 'inbound' });
      expect(row.metadata).not.toContain('Sent from Intercom');
    });

    it('echoes silently into the followed chat, outside the queue and never as an agent reply', async () => {
      const { frames } = await connect();
      await service.handleSend(surface(), { client_msg_id: 'c1', body: 'hello there' });
      await vi.waitFor(() => expect(echoes).toHaveLength(1));
      expect(echoes[0]).toMatchObject({ channel: CHANNEL, topic: 'general', recipient: 'contact:chris', sender: 'system:bus' });
      expect(echoes[0]!.payload).toEqual({ type: 'text', body: '⌨️ hello there\n— via Intercom' });
      expect(echoes[0]!.metadata).toMatchObject({ silent: true, intercom_echo: true, no_preview: true });
      expect(queue.dequeueByPrefix('contact:', 10)).toHaveLength(0);
      // Even if the echo were delivered through the worker it would not become a reply.
      service.onDelivered(echoes[0]!);
      expect(ev(frames, 'reply')).toHaveLength(0);
    });

    it('does not echo when echo_to_followed is false', async () => {
      build(undefined, { echo_to_followed: false });
      await service.handleSend(surface(), { client_msg_id: 'c1', body: 'quiet' });
      await new Promise((r) => setTimeout(r, 10));
      expect(echoes).toHaveLength(0);
    });

    it('is idempotent on client_msg_id: one inbound, one echo, the same ack', async () => {
      const a = await service.handleSend(surface(), { client_msg_id: 'c1', body: 'once' });
      const b = await service.handleSend(surface(), { client_msg_id: 'c1', body: 'once' });
      expect(b).toEqual(a);
      expect(queue.dequeueByPrefix('agent:', 10)).toHaveLength(1);
      await vi.waitFor(() => expect(echoes).toHaveLength(1));
      const [c, d] = await Promise.all([
        service.handleSend(surface(), { client_msg_id: 'c2', body: 'parallel' }),
        service.handleSend(surface(), { client_msg_id: 'c2', body: 'parallel' }),
      ]);
      expect(d).toEqual(c);
      expect(queue.dequeueByPrefix('agent:', 10)).toHaveLength(1);
    });

    it('survives the pipeline dedupe: a retry with the same id is acked again, a second identical text with a new id is rejected cleanly', async () => {
      const first = await service.handleSend(surface(), { client_msg_id: 'c1', body: 'same text' });
      const retry = await service.handleSend(surface(), { client_msg_id: 'c1', body: 'same text' });
      expect(retry).toEqual(first);
      const dup = await service.handleSend(surface(), { client_msg_id: 'c2', body: 'same text' });
      expect(dup).toMatchObject({ status: 'rejected', client_msg_id: 'c2' });
      expect(String(dup['reason'])).toContain('dedup');
      expect(queue.dequeueByPrefix('agent:', 10)).toHaveLength(1);
    });

    it('rejects empty, blank and over-long bodies and malformed frames', async () => {
      expect(await service.handleSend(surface(), { client_msg_id: 'c1', body: '' })).toMatchObject({ status: 'rejected', reason: 'invalid_body' });
      expect(await service.handleSend(surface(), { client_msg_id: 'c2', body: '   ' })).toMatchObject({ status: 'rejected' });
      expect(await service.handleSend(surface(), { client_msg_id: 'c3', body: 'x'.repeat(4001) })).toMatchObject({ status: 'rejected' });
      expect((await service.handleSend(surface(), { client_msg_id: 'c4', body: 'x'.repeat(4000) }))['status']).toBe('queued');
      expect(await service.handleSend(surface(), { body: 'no id' })).toMatchObject({ type: 'error', code: 'invalid_frame' });
    });

    it('closes the window again when the message never reached the agent', async () => {
      const { frames } = await connect();
      db.prepare('DELETE FROM transcripts').run();
      const unrouted = new IntercomService({ config: makeConfig(), db, env: { T: TOKEN }, log: () => {}, calendar,
        submitInbound: async () => ({ ok: true, queued: false, reason: 'pipeline_abort' }) });
      const ack = await unrouted.handleSend(unrouted.surfaces.get('iphone-proto')!, { client_msg_id: 'x', body: 'hi' });
      expect(ack).toMatchObject({ status: 'rejected', reason: 'pipeline_abort' });
      expect(unrouted.inspect('iphone-proto').interaction_id).toBeNull();
      expect(frames).toHaveLength(0);
      unrouted.stop();
    });
  });

  describe('interaction window and replies', () => {
    it('does not deliver agent messages outside a window', async () => {
      const { frames } = await connect();
      service.onDelivered(agentMsg());
      expect(ev(frames, 'reply')).toHaveLength(0);
      expect(readEvents(db, 'iphone-proto', 0)).toHaveLength(0);
    });

    it('turns agent outbound in the followed conversation into durable reply events while open', async () => {
      const { frames } = await connect();
      const ack = await service.handleSend(surface(), { client_msg_id: 'c1', body: 'hi' });
      expect(ev(frames, 'interaction')[0].data).toEqual({ interaction_id: ack['interaction_id'], state: 'open' });
      const m = agentMsg({ metadata: { glance: 'Two on the book today' }, payload: { type: 'text', body: '**Two** appointments today.\n\n- Dentist at 3\n- School at 5' } });
      service.onDelivered(m);
      const [reply] = ev(frames, 'reply');
      expect(reply.seq).toBe(1);
      expect(reply.data).toEqual({
        message_id: m.id, interaction_id: ack['interaction_id'], glance: 'Two on the book today',
        body: 'Two appointments today.\n\n• Dentist at 3\n• School at 5', has_attachments: false, more_on_telegram: false, created_at: expect.any(String),
      });
      expect(readEvents(db, 'iphone-proto', 0)).toHaveLength(1);
    });

    it('derives a glance when the agent gave none, and flags long, choice and attachment messages', async () => {
      const { frames } = await connect();
      await service.handleSend(surface(), { client_msg_id: 'c1', body: 'hi' });
      service.onDelivered(agentMsg({ payload: { type: 'text', body: 'Very good, Mr. Patten. Details follow.' } }));
      service.onDelivered(agentMsg({ payload: { type: 'text', body: 'Pick one' }, metadata: { choices: ['A', 'B'] } }));
      service.onDelivered(agentMsg({ payload: { type: 'text', body: 'Here is the file' }, metadata: { telegram_send: { kind: 'document', path: '/x.pdf' } } }));
      service.onDelivered(agentMsg({ payload: { type: 'text', body: 'word '.repeat(400) } }));
      const replies = ev(frames, 'reply').map((f) => f.data);
      expect(replies[0].glance).toBe('Very good, Mr. Patten.');
      expect(replies[1]).toMatchObject({ more_on_telegram: true, has_attachments: false });
      expect(replies[2]).toMatchObject({ more_on_telegram: true, has_attachments: true });
      expect(replies[3].more_on_telegram).toBe(true);
      expect(Array.from(replies[3].body as string).length).toBeLessThanOrEqual(1200);
    });

    it('ignores other conversations, bus notices, system-only rows and non-agent senders', async () => {
      const { frames } = await connect();
      await service.handleSend(surface(), { client_msg_id: 'c1', body: 'hi' });
      service.onDelivered(agentMsg({ channel: GROUP }));
      service.onDelivered(agentMsg({ topic: 'thread:abc' }));
      service.onDelivered(agentMsg({ recipient: 'contact:kate' }));
      service.onDelivered(agentMsg({ sender: 'system:bus' }));
      service.onDelivered(agentMsg({ metadata: { bus_notice: true } }));
      service.onDelivered(agentMsg({ metadata: { context_only: true } }));
      service.onDelivered(agentMsg({ metadata: { intercom_echo: true } }));
      expect(ev(frames, 'reply')).toHaveLength(0);
      service.onDelivered(agentMsg({ topic: '' }));      // empty topic is the main conversation
      expect(ev(frames, 'reply')).toHaveLength(1);
    });

    it('closes the window grace seconds after the turn ends, and a follow-up refreshes it', async () => {
      vi.useFakeTimers();
      const { frames } = await connect();
      await service.handleSend(surface(), { client_msg_id: 'c1', body: 'hi' });
      const conv = surface().conversationId;
      service.onTyping({ channel: CHANNEL, contactId: 'chris', topic: 'general' });
      service.onTurnEnded(conv);
      vi.advanceTimersByTime(119_000);
      service.onDelivered(agentMsg());                                  // still inside the grace period
      expect(ev(frames, 'reply')).toHaveLength(1);
      expect(ev(frames, 'interaction').some((f) => f.data.state === 'closed')).toBe(false);
      // a new surface message refreshes the window
      await service.handleSend(surface(), { client_msg_id: 'c2', body: 'and also' });
      vi.advanceTimersByTime(130_000);
      expect(ev(frames, 'interaction').some((f) => f.data.state === 'closed')).toBe(false);
      service.onTurnEnded(conv);
      vi.advanceTimersByTime(121_000);
      expect(ev(frames, 'interaction').filter((f) => f.data.state === 'closed')).toHaveLength(1);
      service.onDelivered(agentMsg());
      expect(ev(frames, 'reply')).toHaveLength(1);
    });

    it('a new running signal cancels a pending close', async () => {
      vi.useFakeTimers();
      const { frames } = await connect();
      await service.handleSend(surface(), { client_msg_id: 'c1', body: 'hi' });
      service.onTurnEnded(surface().conversationId);
      vi.advanceTimersByTime(60_000);
      service.onToolStatus({ channel: CHANNEL, contactId: 'chris', topic: 'general', text: 'Checking the calendar' });
      vi.advanceTimersByTime(200_000);
      expect(ev(frames, 'interaction').some((f) => f.data.state === 'closed')).toBe(false);
    });

    it('replays missed replies to a reconnecting surface by cursor', async () => {
      const first = await connect();
      await service.handleSend(surface(), { client_msg_id: 'c1', body: 'hi' });
      service.onDelivered(agentMsg({ id: 'r1' }));
      service.onDelivered(agentMsg({ id: 'r2' }));
      expect(ev(first.frames, 'reply').map((f) => f.seq)).toEqual([1, 2]);
      service.detach(first.client);
      service.onDelivered(agentMsg({ id: 'r3' }));
      const { frames } = await connect(2, true);
      expect(ev(frames, 'reply').map((f) => f.data.message_id)).toEqual(['r3']);
    });
  });

  describe('activity', () => {
    it('mirrors running, status text and idle for the followed conversation whoever started the turn', async () => {
      const { frames } = await connect();
      service.onTyping({ channel: CHANNEL, contactId: 'chris', topic: 'general' });                  // a plain Telegram turn
      service.onToolStatus({ channel: CHANNEL, contactId: 'chris', topic: 'general', text: 'Checking the calendar' });
      service.onTurnEnded(surface().conversationId);
      expect(ev(frames, 'activity').map((f) => f.data)).toEqual([
        { state: 'running', status_text: null, interaction_id: null },
        { state: 'running', status_text: 'Checking the calendar', interaction_id: null },
        { state: 'idle', status_text: null, interaction_id: null },
      ]);
      expect(ev(frames, 'interaction')).toHaveLength(0);
    });

    it('reports queued after a surface send, then running with the interaction id', async () => {
      const { frames } = await connect();
      const ack = await service.handleSend(surface(), { client_msg_id: 'c1', body: 'hi' });
      service.onToolStatus({ channel: CHANNEL, topic: 'general', conversationId: surface().conversationId, text: 'Reading the file' });
      expect(ev(frames, 'activity').map((f) => f.data)).toEqual([
        { state: 'queued', status_text: null, interaction_id: ack['interaction_id'] },
        { state: 'running', status_text: 'Reading the file', interaction_id: ack['interaction_id'] },
      ]);
    });

    it('ignores other channels and topics, and does not repeat unchanged state', async () => {
      const { frames } = await connect();
      service.onTyping({ channel: GROUP, contactId: 'chris', topic: 'general' });
      service.onTyping({ channel: CHANNEL, contactId: 'chris', topic: 'thread:xyz' });
      service.onTurnEnded('some-other-conversation');
      service.onTyping({ channel: CHANNEL, contactId: 'chris', topic: 'general' });
      service.onTyping({ channel: CHANNEL, contactId: 'chris', topic: 'general' });
      expect(ev(frames, 'activity')).toHaveLength(1);
    });

    it('sends the current activity snapshot after welcome', async () => {
      service.onToolStatus({ channel: CHANNEL, contactId: 'chris', topic: 'general', text: 'Working on it' });
      const { frames, socket } = fakeSocket();
      const client: Client = { socket, surface: surface(), ready: false, cursor: 0, lastPong: Date.now() };
      await service.attach(client, 0);
      expect(frames.map((f) => f.type === 'event' ? f.event : f.type)).toEqual(['welcome', 'activity', 'calendar', 'desk']);
      expect(frames[1].data).toEqual({ state: 'running', status_text: 'Working on it', interaction_id: null });
    });

    it('falls back to idle when no turn-ended ever arrives', async () => {
      vi.useFakeTimers();
      const { frames } = await connect();
      service.onTyping({ channel: CHANNEL, contactId: 'chris', topic: 'general' });
      vi.advanceTimersByTime(901_000);
      expect(ev(frames, 'activity').at(-1).data.state).toBe('idle');
    });
  });

  describe('following a forum topic', () => {
    beforeEach(() => build({ contact: 'chris', channel: GROUP, topic: 'thread:abc123' }));

    it('injects into that topic of that chat and only mirrors it', async () => {
      const { frames } = await connect();
      expect(surface().conversationId).toBe(computeConversationId('chris', GROUP, 'thread:abc123'));
      const ack = await service.handleSend(surface(), { client_msg_id: 'c1', body: 'topic hello' });
      const env = queue.dequeueByPrefix('agent:', 10)[0]!.envelope;
      expect(env).toMatchObject({ channel: GROUP, topic: 'thread:abc123', sender: 'contact:chris' });
      expect(env.metadata['conversation_id']).toBe(surface().conversationId);
      await vi.waitFor(() => expect(echoes).toHaveLength(1));
      expect(echoes[0]).toMatchObject({ channel: GROUP, topic: 'thread:abc123' });
      service.onDelivered(agentMsg({ channel: GROUP, topic: 'general' }));
      service.onDelivered(agentMsg({ channel: CHANNEL, topic: 'thread:abc123' }));
      expect(ev(frames, 'reply')).toHaveLength(0);
      service.onDelivered(agentMsg({ channel: GROUP, topic: 'thread:abc123' }));
      expect(ev(frames, 'reply')).toHaveLength(1);
      expect(ack['status']).toBe('queued');
    });
  });
});

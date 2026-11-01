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
import { createPendingContextInject } from '../pipeline/stages/pending-context-inject.js';
import { processInbound } from '../http/api.js';
import { computeConversationId } from '../pipeline/conversation-id.js';
import { AppConfigSchema, type AppConfig } from '../config/schema.js';
import { pendingContextFor } from '../core/system-block.js';
import type { PipelineContext } from '../pipeline/types.js';
import type { CalendarFeed } from './calendar.js';
import { IntercomService, type Client } from './service.js';
import { UpdateInput, NotifyInput } from './notifications-store.js';

const TOKEN1 = 'a'.repeat(40);
const TOKEN2 = 'b'.repeat(40);
const CHANNEL = 'telegram:peggy';
const GROUP = 'telegram:peggy:group:-1003977797157';
const TOPIC = 'thread:0a024ae00cb857bb';
const OTHER_TOPIC = 'thread:ffffffffffffffff';

function makeConfig(overrides: { notifications?: Record<string, unknown>; intercomEnabled?: boolean } = {}): AppConfig {
  return AppConfigSchema.parse({
    bus: { db_path: ':memory:' }, memory: {},
    adapters: { telegram: { peggy: { token: 't' } }, intercom: {
      enabled: overrides.intercomEnabled ?? true,
      surfaces: [
        { id: 's1', token_env: 'T1', follow: { contact: 'chris', channel: GROUP, topic: TOPIC } },
        { id: 's2', token_env: 'T2', follow: { contact: 'chris', channel: GROUP, topic: TOPIC } },
      ],
    } },
    notifications: { enabled: true, api_tokens_env: [], ...overrides.notifications },
    contacts: { chris: { id: 'chris', displayName: 'Chris', platforms: { telegram: { userId: 1 } } } },
    agents: { 'agent:peggy': { pending_context: { channels: [CHANNEL] } } },
    pipeline: { routes: [
      { match: { channel: CHANNEL }, target: { adapterId: 'cc-pool', recipientId: 'agent:peggy' } },
      { match: { channel: GROUP }, target: { adapterId: 'cc-pool', recipientId: 'agent:peggy' } },
    ] },
  }) as AppConfig;
}

function fakeSocket() {
  const frames: any[] = [];
  return { frames, socket: { readyState: 1, send: (d: string) => frames.push(JSON.parse(d)), close: vi.fn() } };
}
const ev = (frames: any[], name: string) => frames.filter((f) => f.type === 'event' && f.event === name);
const notify = (over: Record<string, unknown> = {}) => NotifyInput.parse({ title: 'Leave for the dentist', body: 'Dr. Alvarez at 9:00', source: 'Mail Watcher', ...over });

describe('Intercom notifications (E89)', () => {
  let db: Database.Database; let queue: MessageQueue; let registry: AdapterRegistry; let service: IntercomService; let config: AppConfig;
  let nowMs: number;
  const calendar = { today: async () => ({ date: '2026-11-01', tz: 'America/New_York', generated_at: 'x', events: [] }) } as unknown as CalendarFeed;

  function build(cfg = makeConfig()) {
    config = cfg;
    const pipeline = new PipelineEngine();
    pipeline.use({ slot: 10, name: 'normalize', stage: normalize });
    pipeline.use({ slot: 20, name: 'contact', stage: createContactResolve(config) });
    pipeline.use({ slot: 30, name: 'dedup', stage: createDedup(db) });
    pipeline.use({ slot: 70, name: 'route', stage: createRouteResolve(config, db) });
    pipeline.use({ slot: 80, name: 'transcript', stage: createTranscriptLog(db, config) });
    service = new IntercomService({
      config: config.adapters.intercom!, db, registry, calendar, env: { T1: TOKEN1, T2: TOKEN2 }, log: () => {}, now: () => nowMs,
      notifications: config.notifications, appConfig: config,
      submitInbound: (m, s) => processInbound(m, { queue, pipeline, config, db, registry }, s),
    });
  }
  async function connect(id: string, cursor = 0, keep = false) {
    const { frames, socket } = fakeSocket();
    const client: Client = { socket, surface: service.surfaces.get(id)!, ready: false, cursor: 0, lastPong: Date.now() };
    await service.attach(client, cursor);
    if (!keep) frames.length = 0;
    return { frames, client };
  }
  const s1 = () => service.surfaces.get('s1')!;

  beforeEach(() => {
    nowMs = Date.parse('2026-11-01T04:41:00Z'); // 12:41 AM EDT (DST ends at 2:00)
    db = new Database(':memory:'); db.pragma('foreign_keys = ON'); runMigrations(db);
    queue = new MessageQueue(db); registry = new AdapterRegistry();
    const tg: AdapterInstance = {
      id: CHANNEL, name: 'tg', capabilities: { send: true, channels: [CHANNEL, GROUP] },
      start: async () => {}, stop: async () => {}, health: async () => ({ status: 'healthy' }), send: async () => ({ success: true }),
    };
    registry.register(tg);
    build();
  });
  afterEach(() => { service.stop(); db.close(); });

  describe('delivery and attention', () => {
    it('sends notification (durable, with seq) and attention only to targeted surfaces', async () => {
      const a = await connect('s1'); const b = await connect('s2');
      service.raise(notify({ targets: ['s2'], level: 'urgent' }));
      expect(ev(a.frames, 'notification')).toHaveLength(0);
      expect(ev(a.frames, 'attention')).toHaveLength(0);
      const n = ev(b.frames, 'notification');
      expect(n).toHaveLength(1);
      expect(n[0]).toMatchObject({ seq: expect.any(Number), data: { title: 'Leave for the dentist', level: 'urgent', state: 'active', source: 'Mail Watcher', actions: [] } });
      expect(n[0].data).not.toHaveProperty('targets');
      expect(ev(b.frames, 'attention')[0]).toEqual({ type: 'event', event: 'attention', data: { level: 'urgent', count: 1 } });
    });

    it('a "*" notification reaches every surface; resolving removes it and updates attention', async () => {
      const a = await connect('s1'); const b = await connect('s2');
      const { notification } = service.raise(notify({ key: 'k' }));
      expect(ev(a.frames, 'notification')).toHaveLength(1);
      expect(ev(b.frames, 'notification')).toHaveLength(1);
      a.frames.length = 0;
      service.patch(UpdateInput.parse({ key: 'k', state: 'resolved' }));
      expect(ev(a.frames, 'notification')[0].data).toMatchObject({ id: notification.id, state: 'resolved' });
      expect(ev(a.frames, 'attention')[0].data).toEqual({ level: 'none', count: 0 });
    });

    it('replays the durable notification event from the cursor', async () => {
      service.raise(notify());
      const { frames } = await connect('s1', 0, true);
      expect(ev(frames, 'notification').length).toBeGreaterThanOrEqual(1);
    });

    it('after welcome (and replay) a fresh client gets every open item, then attention', async () => {
      service.raise(notify({ title: 'one', key: 'a', level: 'info' }));
      const two = service.raise(notify({ title: 'two', key: 'b', level: 'attention' })).notification;
      service.raise(notify({ title: 'gone', key: 'c' }));
      service.patch(UpdateInput.parse({ key: 'c', state: 'resolved' }));
      service.raise(notify({ title: 'other', targets: ['s2'] }));
      service.handleNotificationAck(s1(), { id: two.id });
      const { frames } = await connect('s1', 0, true);
      const kinds = frames.map((f) => (f.type === 'event' ? f.event : f.type));
      expect(kinds[0]).toBe('welcome');
      const snapshot = frames.filter((f) => f.type === 'event' && f.event === 'notification' && f.seq === undefined);
      expect(snapshot.map((f) => f.data.title).sort()).toEqual(['one', 'two']);
      expect(snapshot.find((f) => f.data.title === 'two').data.state).toBe('acknowledged');
      const lastNotification = kinds.lastIndexOf('notification');
      const attentionIdx = kinds.lastIndexOf('attention');
      expect(attentionIdx).toBeGreaterThan(lastNotification);
      expect(frames[attentionIdx].data).toEqual({ level: 'info', count: 1 });
    });

    it('notification_ack moves the item to acknowledged, records the surface, and clears its attention', async () => {
      const { frames } = await connect('s1');
      const { notification } = service.raise(notify({ level: 'urgent' }));
      frames.length = 0;
      expect(service.handleNotificationAck(s1(), { id: notification.id })).toBeNull();
      expect(ev(frames, 'notification')[0].data).toMatchObject({ id: notification.id, state: 'acknowledged' });
      expect(ev(frames, 'attention')[0].data).toEqual({ level: 'none', count: 0 });
      expect(db.prepare(`SELECT acked_by FROM notifications WHERE id = ?`).get(notification.id)).toEqual({ acked_by: 's1' });
      // idempotent
      frames.length = 0;
      expect(service.handleNotificationAck(s1(), { id: notification.id })).toBeNull();
      expect(frames).toHaveLength(0);
    });

    it('unknown, terminal or untargeted ids answer notification_not_found', () => {
      expect(service.handleNotificationAck(s1(), { id: 'nope' })).toEqual({ type: 'error', code: 'notification_not_found' });
      const done = service.raise(notify({ key: 'x' })).notification;
      service.patch(UpdateInput.parse({ id: done.id, state: 'resolved' }));
      expect(service.handleNotificationAck(s1(), { id: done.id })).toEqual({ type: 'error', code: 'notification_not_found' });
      const other = service.raise(notify({ targets: ['s2'] })).notification;
      expect(service.handleNotificationAck(s1(), { id: other.id })).toEqual({ type: 'error', code: 'notification_not_found' });
    });

    it('a re-notify on an acknowledged key brings it back to active', async () => {
      const { frames } = await connect('s1');
      const a = service.raise(notify({ key: 'k' })).notification;
      service.handleNotificationAck(s1(), { id: a.id });
      frames.length = 0;
      service.raise(notify({ key: 'k' }));
      expect(ev(frames, 'attention')[0].data).toEqual({ level: 'attention', count: 1 });
    });
  });

  describe('notification_action', () => {
    const act = (id: string, index: number, cid = 'c1') => service.handleNotificationAction(s1(), { client_msg_id: cid, id, index });

    it('acknowledges, then enters the followed conversation as [tapped] with the extra agent-note line; idempotent', async () => {
      const { frames } = await connect('s1');
      const n = service.raise(notify({ actions: [{ label: 'Leaving now', style: 'success' }, { label: 'Snooze 10' }] })).notification;
      frames.length = 0;
      const ack = await act(n.id, 1);
      expect(ack).toMatchObject({ type: 'ack', client_msg_id: 'c1', status: 'queued', interaction_id: expect.any(String) });
      expect(ev(frames, 'notification')[0].data.state).toBe('acknowledged');
      const [msg] = queue.dequeueByPrefix('agent:', 10);
      expect(msg!.envelope.payload).toEqual({ type: 'text', body: '[tapped] Snooze 10' });
      expect(msg!.envelope).toMatchObject({ channel: GROUP, topic: TOPIC, sender: 'contact:chris' });
      expect(msg!.envelope.metadata).toMatchObject({ origin: 'intercom', surface_id: 's1', notification_id: n.id });
      const block = (msg!.envelope.metadata['system_blocks'] as string[])[0]!;
      expect(block).toContain('Sent from Intercom (s1)');
      expect(block).toContain('On the Intercom notification "Leave for the dentist" (Mail Watcher, raised 12:41 AM)');
      expect(block).toContain('notify()');
      // Same client_msg_id again: same ack, no second inbound, even after the item is resolved.
      service.patch(UpdateInput.parse({ id: n.id, state: 'resolved' }));
      expect(await act(n.id, 1)).toEqual(ack);
      expect(queue.dequeueByPrefix('agent:', 10)).toHaveLength(0);
    });

    it('not_found for an unknown or terminal id; invalid_frame for a bad index or frame', async () => {
      expect(await act('nope', 0)).toEqual({ type: 'error', code: 'notification_not_found' });
      const n = service.raise(notify({ actions: [{ label: 'Go' }] })).notification;
      expect(await act(n.id, 5)).toEqual({ type: 'error', code: 'invalid_frame' });
      expect(await service.handleNotificationAction(s1(), { id: n.id, index: 0 })).toEqual({ type: 'error', code: 'invalid_frame' });
      service.patch(UpdateInput.parse({ id: n.id, state: 'resolved' }));
      expect(await act(n.id, 0, 'c9')).toEqual({ type: 'error', code: 'notification_not_found' });
      expect(queue.dequeueByPrefix('agent:', 10)).toHaveLength(0);
    });
  });

  describe('expiry and limits', () => {
    it('the tick expires due items, tells the surfaces and deletes old terminal rows', async () => {
      const { frames } = await connect('s1');
      service.raise(notify({ expires_in_s: 120 }));
      frames.length = 0;
      nowMs += 60_000; service.notificationTick();
      expect(ev(frames, 'notification')).toHaveLength(0);
      nowMs += 61_000; service.notificationTick();
      expect(ev(frames, 'notification')[0].data.state).toBe('expired');
      expect(ev(frames, 'attention')[0].data).toEqual({ level: 'none', count: 0 });
      nowMs += 15 * 86_400_000; service.notificationTick();
      expect(db.prepare(`SELECT COUNT(*) AS n FROM notifications`).get()).toEqual({ n: 0 });
    });

    it('allows 30 writes per minute per source, then refuses; other sources and later minutes are unaffected', () => {
      for (let i = 0; i < 30; i++) expect(service.writeAllowed('a')).toBe(true);
      expect(service.writeAllowed('a')).toBe(false);
      expect(service.writeAllowed('b')).toBe(true);
      nowMs += 61_000;
      expect(service.writeAllowed('a')).toBe(true);
    });
  });

  describe('context carry-over', () => {
    const topicConv = () => computeConversationId('chris', GROUP, TOPIC);
    const ctxRows = (conv: string) => db.prepare(`SELECT body, metadata, direction FROM transcripts WHERE conversation_id = ? AND json_extract(metadata, '$.context_only') = 1`).all(conv) as { body: string; metadata: string; direction: string }[];

    async function seedConversation() { // one real surface send creates the conversation, its session and the registry row
      await service.handleSend(s1(), { client_msg_id: 'seed', body: 'hello' });
    }
    const paneCtx = (conversationId: string, channel: string, topic: string): PipelineContext => ({
      envelope: { id: 'e1', timestamp: new Date().toISOString(), channel, topic, sender: 'contact:chris', recipient: 'agent:peggy', reply_to: null,
        priority: 'normal', payload: { type: 'text', body: 'what was that about?' }, metadata: {} },
      contact: null, dedupKey: null, isSlashCommand: false, slashCommand: null, topics: [], priorityScore: 0,
      routes: [{ adapterId: 'cc-pool', recipientId: 'agent:peggy-pool-1' }], conversationId, sessionId: 's', sessionCreated: false, config, db,
    } as unknown as PipelineContext);

    it('writes one hidden context-only row into the followed topic, once per conversation, on create and content change only', async () => {
      await seedConversation();
      const a = service.raise(notify({ key: 'k', actions: [{ label: 'Leaving now' }, { label: 'Snooze 10' }] })).notification;
      let rows = ctxRows(topicConv());
      expect(rows).toHaveLength(1); // s1 and s2 follow the same topic: one note
      expect(rows[0]!.direction).toBe('outbound');
      expect(rows[0]!.body).toBe('[Shown on Intercom at 12:41 AM] (attention) Leave for the dentist: Dr. Alvarez at 9:00. Actions: Leaving now / Snooze 10.');
      expect(JSON.parse(rows[0]!.metadata).origin).toEqual({ kind: 'external', label: 'Intercom: Mail Watcher' });
      service.raise(notify({ key: 'k', actions: [{ label: 'Leaving now' }, { label: 'Snooze 10' }] })); // unchanged
      service.handleNotificationAck(s1(), { id: a.id });
      service.patch(UpdateInput.parse({ id: a.id, state: 'resolved' }));
      expect(ctxRows(topicConv())).toHaveLength(1);
      service.raise(notify({ key: 'k2', body: 'v1' }));
      service.raise(notify({ key: 'k2', body: 'v2' }));
      expect(ctxRows(topicConv())).toHaveLength(3);
    });

    it('does not touch app events or the session counters', async () => {
      await seedConversation();
      const before = db.prepare(`SELECT message_count, last_activity FROM sessions WHERE conversation_id = ?`).get(topicConv());
      service.raise(notify());
      expect(db.prepare(`SELECT message_count, last_activity FROM sessions WHERE conversation_id = ?`).get(topicConv())).toEqual(before);
    });

    it('reaches the next inbound in the followed forum topic as pending context (the cc-pool stage)', async () => {
      await seedConversation();
      service.raise(notify());
      const out = await createPendingContextInject(db, config)(paneCtx(topicConv(), GROUP, TOPIC));
      const block = pendingContextFor(out!.envelope.metadata, 'agent:peggy-pool-1')?.block;
      expect(block).toContain('[Shown on Intercom at 12:41 AM] (attention) Leave for the dentist');
    });

    it('a forum topic that is not followed gets no pending context, even with a foreign row in it', async () => {
      const other = computeConversationId('chris', GROUP, OTHER_TOPIC);
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO conversation_registry(id,contact_id,channel,topic,first_seen,last_seen) VALUES (?,?,?,?,?,?)`).run(other, 'chris', GROUP, OTHER_TOPIC, now, now);
      db.prepare(`INSERT INTO sessions(id,conversation_id,channel,contact_id,started_at,last_activity,message_count,agent_id) VALUES ('so',?,?,?,?,?,0,'agent:peggy')`).run(other, GROUP, 'chris', now, now);
      db.prepare(`INSERT INTO transcripts (id, message_id, conversation_id, session_id, created_at, channel, contact_id, direction, body, metadata)
        VALUES ('t1','m1',?,'so',?,?,'chris','outbound','routine result',?)`).run(other, now, GROUP, JSON.stringify({ origin: { kind: 'external', label: 'Ambient scan' } }));
      const out = await createPendingContextInject(db, config)(paneCtx(other, GROUP, OTHER_TOPIC));
      expect(out!.envelope.metadata['pending_context']).toBeUndefined();
    });

    it('the followed topic reads pending context only when notifications and context_to_followed are on', async () => {
      build(makeConfig({ notifications: { context_to_followed: false } }));
      await seedConversation();
      service.raise(notify());
      expect(ctxRows(topicConv())).toHaveLength(0);
      const out = await createPendingContextInject(db, config)(paneCtx(topicConv(), GROUP, TOPIC));
      expect(out!.envelope.metadata['pending_context']).toBeUndefined();
    });

    it('a followed conversation with no session yet gets one created for the note', () => {
      service.raise(notify());
      expect(ctxRows(topicConv())).toHaveLength(1);
    });
  });

  it('agent note carries the notify guidance only when notifications are enabled', async () => {
    const [{ agentNote }] = await Promise.all([import('./service.js')]);
    expect(agentNote('s1')).not.toContain('notify()');
    expect(agentNote('s1', true)).toContain('notify()');
  });
});

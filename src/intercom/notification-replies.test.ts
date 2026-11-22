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
import type { PipelineContext } from '../pipeline/types.js';
import type { CalendarFeed } from './calendar.js';
import { IntercomService, type Client, type VoiceSocket } from './service.js';
import type { Transcriber } from './voice.js';
import type { MessageEnvelope } from '../types/envelope.js';
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


const BOUND_TOPIC = 'thread:00000000000000b1';
const bindingArgs = { channel: GROUP, topic: BOUND_TOPIC };
const ask = (over: Record<string, unknown> = {}) => NotifyInput.parse({
  title: 'Dave call', body: 'He asked for 3:30 or 4:00', source: 'Scheduled job', key: 'dave-call', expires_in_s: 600,
  actions: [{ label: '3:30' }, { label: '4:00' }], reply: { mode: 'both', prompt: 'Say a time', context: 'Book the slot he picks on the calendar', hints: ['Dave', 'Minker'] },
  ...bindingArgs, ...over,
});
const tone = (ms: number): Buffer => { const n = Math.round(16 * ms); const b = Buffer.alloc(n * 2); for (let i = 0; i < n; i++) b.writeInt16LE(i % 16 < 8 ? 4000 : -4000, i * 2); return b; };

describe('Notification replies (E105)', () => {
  let db: Database.Database; let queue: MessageQueue; let registry: AdapterRegistry; let service: IntercomService; let config: AppConfig;
  let nowMs: number; let heard: string; const keytermsSeen: (string[] | undefined)[] = [];
  const calendar = { today: async () => ({ date: '2026-11-01', tz: 'America/New_York', generated_at: 'x', events: [] }) } as unknown as CalendarFeed;
  const transcriber: Transcriber = { name: 'fake', async transcribe(_w, o) { keytermsSeen.push(o.keyterms); return heard; } };

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
      notifications: config.notifications, appConfig: config, transcriber, synthesizer: null,
      submitInbound: (m, s) => processInbound(m, { queue, pipeline, config, db, registry }, s),
    });
  }
  async function connect(id: string) {
    const { frames, socket } = fakeSocket();
    const client: Client = { socket, surface: service.surfaces.get(id)!, ready: false, cursor: 0, lastPong: Date.now() };
    await service.attach(client, 0);
    frames.length = 0;
    return { frames, client };
  }
  const s1 = () => service.surfaces.get('s1')!;
  const bound = () => computeConversationId('chris', GROUP, BOUND_TOPIC);
  /** Raise through the same two steps the HTTP route takes. */
  function raise(input = ask()) {
    const b = service.prepareBinding(input);
    if (!b.ok) throw new Error(`${b.error}: ${b.detail}`);
    return service.raise(input, b.binding).notification;
  }
  const act = (id: string, index: number, cid = 'c1') => service.handleNotificationAction(s1(), { client_msg_id: cid, id, index });
  const row = (id: string) => db.prepare(`SELECT state, reply_via, replied_at, resolution FROM notifications WHERE id = ?`).get(id) as any;
  const next = () => queue.dequeueByPrefix('agent:', 10);
  /** Hidden context-only notes written into the bound conversation. */
  const notes = () => (db.prepare(`SELECT body FROM transcripts WHERE conversation_id = ? AND metadata LIKE '%context_only%'`).all(computeConversationId('chris', GROUP, BOUND_TOPIC)) as { body: string }[]).map((r) => r.body);
  function voiceClient() {
    const frames: any[] = [];
    const c: VoiceSocket = { id: 'v1', surface: s1(), send: (f) => frames.push(f), sendBinary: () => true };
    return { c, frames };
  }
  async function speak(c: VoiceSocket, notificationId: string | undefined, cmid = 'v-1') {
    const err = service.voice.start(c, { type: 'audio_start', client_msg_id: cmid, rate: 16000, ...(notificationId ? { notification_id: notificationId } : {}) });
    service.voice.chunk(c, tone(800));
    await service.voice.end(c, { type: 'audio_end', client_msg_id: cmid });
    return err;
  }
  const outbound = (topic: string, body = 'Booked 3:30'): MessageEnvelope => ({
    id: `out-${Math.random()}`, timestamp: new Date(nowMs).toISOString(), channel: GROUP, topic, sender: 'agent:peggy', recipient: 'contact:chris',
    reply_to: null, priority: 'normal', payload: { type: 'text', body }, metadata: {},
  } as MessageEnvelope);

  beforeEach(() => {
    nowMs = Date.parse('2026-11-22T16:00:00Z'); // 11:00 AM EST
    heard = 'Three thirty';
    keytermsSeen.length = 0;
    db = new Database(':memory:'); db.pragma('foreign_keys = ON'); runMigrations(db);
    queue = new MessageQueue(db); registry = new AdapterRegistry();
    registry.register({
      id: CHANNEL, name: 'tg', capabilities: { send: true, channels: [CHANNEL, GROUP] },
      start: async () => {}, stop: async () => {}, health: async () => ({ status: 'healthy' }), send: async () => ({ success: true }),
    } as AdapterInstance);
    build();
  });
  afterEach(() => { service.stop(); db.close(); });

  describe('fields and binding', () => {
    it('requires expires_in_s (at most 86400) and a real choice with a reply mode; rejects the dropped fields', () => {
      expect(NotifyInput.safeParse({ title: 't', source: 's', reply: { mode: 'voice' } }).success).toBe(false);
      expect(NotifyInput.safeParse({ title: 't', source: 's', expires_in_s: 86_401, reply: { mode: 'voice' } }).success).toBe(false);
      expect(NotifyInput.safeParse({ title: 't', source: 's', expires_in_s: 60, reply: { mode: 'choices' } }).success).toBe(false);
      expect(NotifyInput.safeParse({ title: 't', source: 's', expires_in_s: 60, reply: { mode: 'voice' } }).success).toBe(true);
      expect(NotifyInput.safeParse({ title: 't', source: 's', reply: { mode: 'none' } }).success).toBe(true);
      expect(NotifyInput.safeParse({ title: 't', source: 's', expires_in_s: 60, reply: { mode: 'voice', confirm: true } }).success).toBe(false);
      expect(NotifyInput.safeParse({ title: 't', source: 's', private: true }).success).toBe(false);
      expect(NotifyInput.safeParse({ title: 't', source: 's', expires_in_s: 60, reply: { mode: 'voice', prompt: 'x'.repeat(81) } }).success).toBe(false);
      expect(NotifyInput.safeParse({ title: 't', source: 's', expires_in_s: 60, reply: { mode: 'voice', hints: Array(9).fill('a') } }).success).toBe(false);
    });

    it('needs a binding with a reply mode; resolves conversation_id through the registry, or channel and topic', () => {
      expect(service.prepareBinding(ask({ channel: undefined, topic: undefined }))).toMatchObject({ ok: false, error: 'binding_required' });
      expect(service.prepareBinding(ask({ channel: undefined, topic: undefined, conversation_id: 'nope' }))).toMatchObject({ ok: false, error: 'unknown_conversation' });
      db.prepare(`INSERT INTO conversation_registry(id, contact_id, channel, topic, first_seen, last_seen) VALUES (?,?,?,?,?,?)`).run('conv-1', 'chris', GROUP, BOUND_TOPIC, 'x', 'x');
      expect(service.prepareBinding(ask({ channel: undefined, topic: undefined, conversation_id: 'conv-1' }))).toEqual({ ok: true, binding: { conversation_id: 'conv-1', channel: GROUP, topic: BOUND_TOPIC, contact: 'chris' } });
      expect(service.prepareBinding(ask())).toEqual({ ok: true, binding: { conversation_id: bound(), channel: GROUP, topic: BOUND_TOPIC, contact: 'chris' } });
      expect(service.prepareBinding(notify())).toEqual({ ok: true, binding: null });
    });

    it('the public shape carries reply (without context), reply_state and resolution; the binding never leaves the bus', async () => {
      const { frames } = await connect('s1');
      const n = raise();
      const shown = ev(frames, 'notification').at(-1).data;
      expect(shown).toMatchObject({ id: n.id, state: 'active', reply_state: 'awaiting', replied_at: null, reply_via: null, resolution: null, reply: { mode: 'both', prompt: 'Say a time', hints: ['Dave', 'Minker'], on_expire: 'note' } });
      expect(JSON.stringify(shown)).not.toContain('Book the slot');
      expect(JSON.stringify(shown)).not.toContain(BOUND_TOPIC);
      expect(shown).not.toHaveProperty('conversation_ref');
      const plain = service.raise(notify({ key: 'plain' })).notification;
      expect(ev(frames, 'notification').at(-1).data).toMatchObject({ id: plain.id, reply: null, reply_state: 'none' });
    });
  });

  describe('choice taps', () => {
    it('go into the bound conversation, not the followed one, with the system block and context', async () => {
      const { frames } = await connect('s1');
      const n = raise();
      frames.length = 0;
      const ack = await act(n.id, 0);
      expect(ack).toMatchObject({ type: 'ack', status: 'queued', interaction_id: expect.any(String) });
      const msgs = next();
      expect(msgs).toHaveLength(1);
      const m = msgs[0]!.envelope;
      expect(m).toMatchObject({ channel: GROUP, topic: BOUND_TOPIC, sender: 'contact:chris', payload: { type: 'text', body: '[tapped] 3:30' } });
      expect(m.metadata).toMatchObject({ origin: 'intercom', notification_id: n.id, notification_key: 'dave-call', input: 'choice', reply_mode: 'both' });
      const block = (m.metadata['system_blocks'] as string[])[0]!;
      expect(block).toContain('"Dave call"');
      expect(block).toContain('Context you left for this reply: Book the slot he picks on the calendar');
      expect(block).toContain('never approval to send an outbound message');
      expect(block).toContain('update_notification(key "dave-call"');
      expect(row(n.id)).toMatchObject({ state: 'acknowledged', reply_via: 'choice' });
      expect(ev(frames, 'notification').at(-1).data).toMatchObject({ state: 'acknowledged', reply_state: 'received', reply_via: 'choice', replied_at: expect.any(String) });
    });

    it('the first reply wins: a second tap is already_replied, and a voice press is refused', async () => {
      const n = raise();
      await act(n.id, 0);
      next();
      expect(await act(n.id, 1, 'c2')).toEqual({ type: 'ack', client_msg_id: 'c2', status: 'rejected', reason: 'already_replied' });
      expect(service.voiceReplyCheck(s1(), n.id)).toEqual({ ok: false, reason: 'already_replied' });
      expect(next()).toHaveLength(0);
    });

    it('is idempotent on client_msg_id, even after the job resolves it', async () => {
      const n = raise();
      const ack = await act(n.id, 0);
      next();
      service.patch(UpdateInput.parse({ key: 'dave-call', state: 'resolved', resolution: 'Booked 3:30' }));
      expect(await act(n.id, 0)).toEqual(ack);
      expect(next()).toHaveLength(0);
    });

    it('mode voice refuses a tap; resolved and expired items are refused with their own codes', async () => {
      const v = raise(ask({ key: 'v', reply: { mode: 'voice' }, actions: undefined }));
      expect(await act(v.id, 0)).toEqual({ type: 'error', code: 'invalid_frame' });   // no actions to tap
      const vc = raise(ask({ key: 'vc', reply: { mode: 'voice' } }));
      expect(await act(vc.id, 0)).toMatchObject({ status: 'rejected', reason: 'reply_not_allowed' });
      const r = raise(ask({ key: 'r' }));
      service.patch(UpdateInput.parse({ key: 'r', state: 'resolved' }));
      expect(await act(r.id, 0, 'c3')).toMatchObject({ status: 'rejected', reason: 'notification_not_found' });
      const e = raise(ask({ key: 'e', expires_in_s: 60 }));
      nowMs += 61_000; service.notificationTick();
      expect(await act(e.id, 0, 'c4')).toMatchObject({ status: 'rejected', reason: 'notification_expired' });
      expect(await act('nope', 0, 'c5')).toEqual({ type: 'error', code: 'notification_not_found' });
      expect(next().filter((q) => q.envelope.metadata['notification_id'])).toHaveLength(0);
    });

    it('a failed send gives the single reply back so the device can try again', async () => {
      const n = raise();
      const real = (service as any).deps.submitInbound;
      (service as any).deps.submitInbound = async () => { throw new Error('boom'); };
      expect(await act(n.id, 0)).toMatchObject({ status: 'rejected', reason: 'internal_error' });
      expect(row(n.id)).toMatchObject({ state: 'active', reply_via: null, replied_at: null });
      (service as any).deps.submitInbound = real;
      expect(await act(n.id, 0, 'c2')).toMatchObject({ status: 'queued' });
    });

    it('unbound notifications are unchanged: followed conversation, plain note, taps are not limited', async () => {
      const n = service.raise(notify({ actions: [{ label: 'Go' }, { label: 'Again' }] })).notification;
      await act(n.id, 0);
      await act(n.id, 1, 'c2');
      const msgs = next();
      expect(msgs).toHaveLength(2);
      expect(msgs[0]!.envelope).toMatchObject({ channel: GROUP, topic: TOPIC });
    });

    it('a binding without a reply mode routes taps to the bound conversation, with no reply limit', async () => {
      const { frames } = await connect('s1');
      const n = raise(ask({ reply: undefined, key: 'b', expires_in_s: undefined }));
      await act(n.id, 0);
      await act(n.id, 1, 'c2');
      const msgs = next();
      expect(msgs).toHaveLength(2);
      expect(msgs.every((q) => q.envelope.topic === BOUND_TOPIC)).toBe(true);
      expect(ev(frames, 'notification').at(-1).data).toMatchObject({ reply_state: 'none' });
    });

    it('v2 notice actions pass the refusal reason through', async () => {
      const n = raise();
      await act(n.id, 0);
      const device = { surface_id: 's1' } as any;
      expect(await service.noticeAction(device, n.id, '1', 'k2')).toMatchObject({ status: 'failed', reason: 'already_replied' });
      expect(await service.noticeAction(device, 'nope', '0', 'k3')).toMatchObject({ status: 'failed', reason: 'not_found' });
    });
  });

  describe('the reply event for a conversation that is not followed', () => {
    it('reaches the surface while the interaction holds the binding, and not before or for other conversations', async () => {
      const { frames } = await connect('s1');
      const n = raise();
      service.onDelivered(outbound(BOUND_TOPIC, 'unprompted'));
      expect(ev(frames, 'reply')).toHaveLength(0);                                 // no interaction yet
      const ack: any = await act(n.id, 0);
      service.onDelivered(outbound(BOUND_TOPIC, 'Booked 3:30'));
      service.onDelivered(outbound(OTHER_TOPIC, 'some other topic'));
      const replies = ev(frames, 'reply');
      expect(replies).toHaveLength(1);
      expect(replies[0].data).toMatchObject({ interaction_id: ack.interaction_id, body: 'Booked 3:30' });
    });

    it('the bound conversation\'s typing and turn end drive the window', async () => {
      const { frames } = await connect('s1');
      const n = raise();
      await act(n.id, 0);
      service.onTyping({ channel: GROUP, contactId: 'contact:chris', topic: BOUND_TOPIC });
      expect(service.inspect('s1').activity.state).toBe('running');
      service.onTurnEnded(bound());
      expect(service.inspect('s1').activity.state).toBe('idle');
      expect(ev(frames, 'activity').at(-1).data.state).toBe('idle');
    });
  });

  describe('voice replies', () => {
    it('a bound recording goes into the bound conversation as [reply to "<title>"], with hints and the transcript flag', async () => {
      const n = raise();
      const { c, frames } = voiceClient();
      await speak(c, n.id);
      expect(keytermsSeen).toEqual([['Dave', 'Minker']]);
      expect(frames.find((f) => f.final)).toMatchObject({ type: 'transcript', status: 'ok', text: 'Three thirty', notification_id: n.id });
      expect(frames.at(-1)).toMatchObject({ type: 'ack', status: 'queued', client_msg_id: 'v-1' });
      const m = next()[0]!.envelope;
      expect(m).toMatchObject({ channel: GROUP, topic: BOUND_TOPIC, payload: { body: '[reply to "Dave call"] Three thirty' } });
      expect(m.metadata).toMatchObject({ input: 'voice', transcript_engine: 'fake', notification_id: n.id, notification_key: 'dave-call', reply_mode: 'both' });
      const block = (m.metadata['system_blocks'] as string[])[0]!;
      expect(block).toContain('speech transcript and may contain recognition errors');
      expect(block).toContain('Book the slot he picks on the calendar');
      expect(row(n.id)).toMatchObject({ state: 'acknowledged', reply_via: 'voice' });
    });

    it('is refused at audio_start with a failed transcript, and nothing is recorded or sent', async () => {
      const cases: [string, () => string, string][] = [
        ['unknown', () => 'nope', 'notification_not_found'],
        ['mode choices', () => raise(ask({ key: 'c', reply: { mode: 'choices' } })).id, 'reply_not_allowed'],
        ['mode none', () => service.raise(notify({ key: 'p' })).notification.id, 'reply_not_allowed'],
        ['resolved', () => { const r = raise(ask({ key: 'r' })); service.patch(UpdateInput.parse({ id: r.id, state: 'resolved' })); return r.id; }, 'notification_not_found'],
        ['expired', () => { const e = raise(ask({ key: 'e', expires_in_s: 60 })); nowMs += 61_000; service.notificationTick(); return e.id; }, 'notification_expired'],
      ];
      for (const [label, make, reason] of cases) {
        const id = make();
        const { c, frames } = voiceClient();
        await speak(c, id, `v-${label}`);
        expect(frames, label).toEqual([{ type: 'transcript', client_msg_id: `v-${label}`, final: true, status: 'failed', reason, notification_id: id }]);
      }
      expect(next()).toHaveLength(0);
      expect(keytermsSeen).toHaveLength(0);
    });

    it('is refused when the item is resolved while he speaks: the transcript still arrives, then a rejected ack', async () => {
      const n = raise();
      const { c, frames } = voiceClient();
      service.voice.start(c, { type: 'audio_start', client_msg_id: 'v-9', rate: 16000, notification_id: n.id });
      service.patch(UpdateInput.parse({ key: 'dave-call', state: 'resolved' }));
      service.voice.chunk(c, tone(800));
      await service.voice.end(c, { type: 'audio_end', client_msg_id: 'v-9' });
      expect(frames[0]).toMatchObject({ final: true, status: 'ok', text: 'Three thirty', notification_id: n.id });
      expect(frames[1]).toEqual({ type: 'ack', client_msg_id: 'v-9', status: 'rejected', reason: 'notification_not_found' });
      expect(next()).toHaveLength(0);
    });

    it('an empty or silent recording leaves the item awaiting; an unbound press is unchanged', async () => {
      const n = raise();
      heard = '';
      const a = voiceClient();
      await speak(a.c, n.id);
      expect(a.frames.at(-1)).toMatchObject({ status: 'empty', notification_id: n.id });
      expect(row(n.id).reply_via).toBeNull();
      heard = 'Hello';
      const b = voiceClient();
      await speak(b.c, undefined, 'v-2');
      expect(b.frames.find((f) => f.final)).not.toHaveProperty('notification_id');
      const m = next()[0]!.envelope;
      expect(m).toMatchObject({ channel: GROUP, topic: TOPIC, payload: { body: 'Hello' } });
      expect(m.metadata).not.toHaveProperty('notification_id');
      expect(row(n.id).reply_via).toBeNull();
    });

    it('rejects a malformed notification_id', () => {
      const { c } = voiceClient();
      expect(service.voice.start(c, { type: 'audio_start', client_msg_id: 'x', notification_id: 5 })).toEqual({ type: 'error', code: 'invalid_frame' });
    });
  });

  describe('skip, resolve and re-raise', () => {
    it('SKIP closes the item to replies and leaves a context note, without waking the job', async () => {
      const { frames } = await connect('s1');
      const n = raise();
      frames.length = 0;
      expect(service.handleNotificationAck(s1(), { id: n.id, skip: true })).toBeNull();
      expect(ev(frames, 'notification').at(-1).data).toMatchObject({ state: 'acknowledged', reply_state: 'skipped', reply_via: 'skip' });
      expect(next()).toHaveLength(0);
      expect(notes().join('\n')).toContain('Notification "Dave call" was skipped at 11:00 AM');
      expect(await act(n.id, 0)).toMatchObject({ status: 'rejected', reason: 'already_replied' });
    });

    it('a plain ack ("seen") keeps the item awaiting', async () => {
      const { frames } = await connect('s1');
      const n = raise();
      expect(service.handleNotificationAck(s1(), { id: n.id })).toBeNull();
      expect(ev(frames, 'notification').at(-1).data).toMatchObject({ state: 'acknowledged', reply_state: 'awaiting' });
      expect(await act(n.id, 0)).toMatchObject({ status: 'queued' });
    });

    it('resolving with a resolution closes the loop on the device', async () => {
      const { frames } = await connect('s1');
      const n = raise();
      await act(n.id, 0);
      next();
      frames.length = 0;
      service.patch(UpdateInput.parse({ key: 'dave-call', state: 'resolved', resolution: 'Booked 3:30' }));
      expect(ev(frames, 'notification').at(-1).data).toMatchObject({ state: 'resolved', reply_state: 'closed', resolution: 'Booked 3:30', reply_via: 'choice' });
      expect(UpdateInput.safeParse({ key: 'k', resolution: 'x'.repeat(100) }).success).toBe(true);
      expect((UpdateInput.parse({ key: 'k', resolution: 'x'.repeat(100) }).resolution ?? '').length).toBe(60);
    });

    it('re-raising the same key asks again', async () => {
      const n = raise();
      await act(n.id, 0);
      next();
      const again = raise();
      expect(again.id).toBe(n.id);
      expect(row(n.id)).toMatchObject({ state: 'active', reply_via: null, replied_at: null, resolution: null });
      expect(await act(n.id, 1, 'c2')).toMatchObject({ status: 'queued' });
    });
  });

  describe('expiry', () => {
    const noteText = () => notes().join('\n');

    it('on_expire note (default): a hidden context note, nothing queued', async () => {
      const { frames } = await connect('s1');
      const n = raise(ask({ expires_in_s: 120 }));
      nowMs += 130_000; service.notificationTick();
      expect(ev(frames, 'notification').at(-1).data).toMatchObject({ id: n.id, state: 'expired', reply_state: 'closed' });
      expect(noteText()).toContain('Notification "Dave call" expired unanswered at 11:02 AM');
      expect(next()).toHaveLength(0);
    });

    it('on_expire wake: a system-only turn into the bound conversation, carrying the context', async () => {
      raise(ask({ expires_in_s: 120, reply: { mode: 'both', context: 'Default: book 4:00', on_expire: 'wake' } }));
      nowMs += 130_000; service.notificationTick();
      await new Promise((r) => setTimeout(r, 20));
      const [m] = next();
      expect(m!.envelope).toMatchObject({ channel: GROUP, topic: BOUND_TOPIC, sender: 'contact:chris' });
      expect(m!.envelope.metadata).toMatchObject({ system_only: true, notification_expired: true, notification_key: 'dave-call' });
      const block = (m!.envelope.metadata['system_blocks'] as string[])[0]!;
      expect(block).toContain('expired unanswered at');
      expect(block).toContain('Default: book 4:00');
    });

    it('writes nothing when the reply already came in, or without a binding', async () => {
      const a = raise(ask({ key: 'a', expires_in_s: 120, reply: { mode: 'both', on_expire: 'wake' } }));
      await act(a.id, 0);
      next();
      service.raise(notify({ key: 'plain', expires_in_s: 120 }));
      nowMs += 130_000; service.notificationTick();
      await new Promise((r) => setTimeout(r, 20));
      expect(next()).toHaveLength(0);
      expect(noteText()).not.toContain('expired unanswered');
    });
  });
});

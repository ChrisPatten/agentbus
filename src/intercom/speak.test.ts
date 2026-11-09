import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';
import { IntercomAdapterSchema } from '../config/schema.js';
import { IntercomService, VOICE_NOTE, type VoiceSocket } from './service.js';
import { readEvents } from './store.js';
import { agentSpeechText, stripAudioTags } from './speech.js';
import type { CalendarFeed } from './calendar.js';
import type { MessageEnvelope } from '../types/envelope.js';

const TOKEN = 't'.repeat(48);
const calendar = { today: async () => ({ date: '2026-11-01', tz: 'America/New_York', generated_at: 'now', events: [] }) } as unknown as CalendarFeed;

describe('agentSpeechText (E102)', () => {
  it('passes audio tags through to the voice and removes them from the visible copy', () => {
    const r = agentSpeechText('[warmly] Good morning, Mr. Patten. [short pause] **Two** things.');
    expect(r).toEqual({ tts: '[warmly] Good morning, Mr. Patten. [short pause] Two things.', visible: 'Good morning, Mr. Patten. Two things.' });
    expect(stripAudioTags('Yes [quickly], sir.')).toBe('Yes, sir.');
  });
  it('still strips real Markdown links and emoji, has no length cap, and rejects only empty text', () => {
    expect((agentSpeechText('See [the memo](https://x.test/a) 🙂') as { tts: string }).tts).toBe('See the memo');
    expect(agentSpeechText('a'.repeat(5000))).toHaveProperty('visible');
    expect(agentSpeechText('   🙂 ')).toEqual({ error: 'empty' });
  });
});

describe('speak v2 (E102): any session, no policy limits, reply drives the screen', () => {
  let db: Database.Database; let service: IntercomService; let spoken: string[]; let sock: VoiceSocket; let frames: any[]; let now: number;
  const mkSock = (id: string): VoiceSocket => ({ id, surface: undefined as never, send: (f: unknown) => { frames.push(f); }, sendBinary: () => true, closed: false } as unknown as VoiceSocket);
  const build = (speech: Record<string, unknown> = {}, surfaces = ['compact']) => {
    const cfg = IntercomAdapterSchema.parse({
      voice: { speech: { lead_s: 8, ...speech } },
      surfaces: surfaces.map((id) => ({ id, token_env: 'T', follow: { contact: 'chris', channel: 'telegram:peggy' } })),
    });
    const sink = spoken;
    service = new IntercomService({ config: cfg, db, calendar, env: { T: TOKEN }, log: () => {}, now: () => now,
      synthesizer: { name: 'fake', rate: 16000, async *stream(text) { sink.push(text); yield new Uint8Array(320); } },
      submitInbound: async () => ({ ok: true, id: 'x', queued: true, enqueued_count: 1 }) });
  };
  /** A connected device socket of a surface, as the WebSocket route registers it. */
  const connect = (surfaceId: string, s: VoiceSocket) => { (service as any).clients.add({ socket: {}, surface: service.surfaces.get(surfaceId), ready: true, cursor: 0, lastPong: 0, voice: s }); return s; };
  const voice = async (id: string, metadata: Record<string, unknown> = { input: 'voice' }) => {
    const surface = service.surfaces.get('compact')!;
    return await service.handleSend(surface, { client_msg_id: id, body: 'what time is it' }, { metadata, ...(metadata['input'] === 'voice' ? { speakTo: sock } : {}) }) as { message_id: string; interaction_id: string };
  };
  const reply = (body: string, extra: Record<string, unknown> = {}) => service.onDelivered({ id: `r-${Math.random()}`, timestamp: '', channel: 'telegram:peggy', topic: 'general', sender: 'agent:p', recipient: 'contact:chris', reply_to: null, priority: 'normal', payload: { type: 'text', body }, metadata: extra } as MessageEnvelope);
  const events = (name: string) => readEvents(db, 'compact', 0).filter((e) => e.event === name).map((e) => e.data);
  const tick = () => new Promise((r) => setTimeout(r, 20));

  beforeEach(() => { db = new Database(':memory:'); runMigrations(db); spoken = []; frames = []; now = Date.parse('2026-11-09T03:00:00Z'); sock = mkSock('s1'); });
  afterEach(() => { service?.stop(); service?.speaker.stop(); db.close(); vi.useRealTimers(); });

  it('the per-message note says transcript, speak, and reply with a glance', () => {
    expect(VOICE_NOTE).toMatch(/speech transcript/);
    expect(VOICE_NOTE).toMatch(/speak\(\)/);
    expect(VOICE_NOTE).toMatch(/reply\(\)/);
  });

  it('speaks from a non-Intercom session: default surface, every awake audible socket, audio tags sent, text recorded', async () => {
    build();
    const a = connect('compact', mkSock('a')), b = connect('compact', mkSock('b'));
    void a; void b;
    const r = service.speakFor({ text: '[warmly] Your build is **done**.' });
    expect(r).toMatchObject({ ok: true, status: 'spoken', surface_id: 'compact', devices: 2, text: 'Your build is done.', echo: '🔊 Your build is done.', follow: { channel: 'telegram:peggy', contact: 'chris' } });
    await tick();
    expect(spoken).toEqual(['[warmly] Your build is done.', '[warmly] Your build is done.']);
    expect(frames.filter((f) => f.type === 'speech_start')).toHaveLength(2);
  });

  it('proactive speech skips with asleep / muted / offline, and an asleep device wins', async () => {
    build();
    expect(service.speakFor({ text: 'Hello' })).toEqual({ ok: true, status: 'skipped', reason: 'offline' });
    const a = connect('compact', mkSock('a'));
    a.muted = true;
    expect(service.speakFor({ text: 'Hello' })).toEqual({ ok: true, status: 'skipped', reason: 'muted' });
    a.muted = false; a.asleep = true;
    expect(service.speakFor({ text: 'Hello' })).toEqual({ ok: true, status: 'skipped', reason: 'asleep' });
    a.asleep = false;
    expect(service.speakFor({ text: 'Hello' })).toMatchObject({ status: 'spoken' });
    await tick();
    expect(spoken).toHaveLength(1);
  });

  it('with several speech surfaces it errors listing them unless one is named; a surface with speech off is skipped', () => {
    build({}, ['compact', 'phone']);
    const r = service.speakFor({ text: 'Hello' });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/compact, phone/) });
    expect(service.speakFor({ text: 'Hello', surface: 'nope' })).toMatchObject({ ok: false });
    expect(service.speakFor({ text: 'Hello', surface: 'phone' })).toEqual({ ok: true, status: 'skipped', reason: 'offline' });
  });

  it('answers a push-to-talk message on its own device, even at night, with long text, after a typed send and many calls', async () => {
    build();                                                 // 22:00 New York: the old quiet hours
    const v = await voice('v1');
    const long = `${'This is a sentence that goes on. '.repeat(40)}`.trim();            // far over the old 400 cap
    expect(service.speakFor({ text: long, messageId: v.message_id })).toMatchObject({ ok: true, status: 'spoken', interaction_message: true });
    for (let n = 0; n < 4; n++) expect(service.speakFor({ text: `Again ${n}.`, messageId: v.message_id })).toMatchObject({ ok: true, status: 'queued' });
    await voice('t1', { input: 'typed' });                   // a typed send no longer turns speech off
    expect(service.speakFor({ text: 'After typing.', messageId: v.message_id })).toMatchObject({ ok: true });
    now += 3_600_000;                                        // an hour later: no window
    expect(service.speakFor({ text: 'Much later.', messageId: v.message_id })).toMatchObject({ ok: true });
    await tick();
    expect(spoken[0]).toBe(long);
  });

  it('an unknown message id (e.g. from Telegram) falls back to proactive speech on the surface', async () => {
    build();
    connect('compact', mkSock('a'));
    expect(service.speakFor({ text: 'Done.', messageId: 'telegram-msg-9' })).toMatchObject({ ok: true, status: 'spoken', devices: 1 });
  });

  it('a muted or sleeping originating device skips', async () => {
    build();
    const v = await voice('v1');
    sock.muted = true;
    expect(service.speakFor({ text: 'Hello', messageId: v.message_id })).toEqual({ ok: true, status: 'skipped', reason: 'muted' });
    sock.muted = false; sock.asleep = true;
    expect(service.speakFor({ text: 'Hello', messageId: v.message_id })).toEqual({ ok: true, status: 'skipped', reason: 'asleep' });
    expect(spoken).toEqual([]);
  });

  it('still accepts the removed policy keys in a config file and ignores them', () => {
    const cfg = IntercomAdapterSchema.parse({ voice: { speech: { quiet_hours: { enabled: true }, max_replies: 1, reply_window_s: 10, speak_max_chars: 50, max_seconds: 3, timeout_ms: 2000, timezone: 'UTC' } } });
    expect(cfg.voice.speech).not.toHaveProperty('quiet_hours');
    expect(cfg.voice.speech.fallback).toBe(false);
  });

  it('only empty text is refused', () => {
    build();
    expect(service.speakFor({ text: '🙂' })).toMatchObject({ ok: false });
  });

  it('speak does not touch the screen; reply drives the Understood screen with its own body and glance', async () => {
    build();
    const v = await voice('v1');
    service.speakFor({ text: "Three o'clock.", messageId: v.message_id });
    expect(events('reply')).toEqual([]);
    reply('It is 3:00 PM Eastern. Dave is at 3:30.', { glance: 'Three PM; Dave at 3:30' });
    await tick();
    expect(events('reply')).toEqual([expect.objectContaining({ body: 'It is 3:00 PM Eastern. Dave is at 3:30.', glance: 'Three PM; Dave at 3:30' })]);
    expect(events('reply')[0]).not.toHaveProperty('spoken');
    expect(spoken).toEqual(["Three o'clock."]);              // the reply was not spoken
  });

  it('the recording of a speak call (intercom_spoken) is not turned into a reply event or spoken', async () => {
    build({ fallback: true, fallback_grace_s: 0 });
    await voice('v1');
    reply('🔊 Hello', { intercom_spoken: true });
    await tick();
    expect(events('reply')).toEqual([]);
    expect(spoken).toEqual([]);
  });

  it('queues utterances to one device in order, without cutting one off', async () => {
    build();
    connect('compact', sock);
    service.speakFor({ text: 'First.' });
    expect(service.speakFor({ text: 'Second.' })).toMatchObject({ status: 'queued' });
    await new Promise((r) => setTimeout(r, 80));
    expect(spoken).toEqual(['First.', 'Second.']);
  });

  describe('fallback (off by default)', () => {
    it('is off by default: a reply to a voice message is not spoken', async () => {
      build();
      expect(IntercomAdapterSchema.parse({}).voice.speech.fallback).toBe(false);
      await voice('v1');
      reply('Done. Porch light is on.');
      await tick();
      expect(spoken).toEqual([]);
    });
    it('when on, speaks the first reply after the grace, and a speak call inside the grace cancels it', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      build({ fallback: true });
      await voice('v1');
      reply('Done. Porch light is on.');
      await vi.advanceTimersByTimeAsync(2900);
      expect(spoken).toEqual([]);
      await vi.advanceTimersByTimeAsync(200);
      expect(spoken).toEqual(['Done. Porch light is on.']);
      service.stop(); spoken.length = 0;
      build({ fallback: true });
      const v = await voice('v2');
      reply('A long answer.', { glance: 'Short.' });
      service.speakFor({ text: 'Short answer.', messageId: v.message_id });
      await vi.advanceTimersByTimeAsync(5000);
      expect(spoken).toEqual(['Short answer.']);
    });
    it('is never spoken to a device that is asleep or muted', async () => {
      build({ fallback: true, fallback_grace_s: 0 });
      await voice('v1');
      sock.asleep = true;
      reply('Done.');
      await tick();
      expect(spoken).toEqual([]);
    });
  });
});

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
    const r = agentSpeechText('[warmly] Good morning, Mr. Patten. [short pause] **Two** things.', 400);
    expect(r).toEqual({ tts: '[warmly] Good morning, Mr. Patten. [short pause] Two things.', visible: 'Good morning, Mr. Patten. Two things.' });
    expect(stripAudioTags('Yes [quickly], sir.')).toBe('Yes, sir.');
  });
  it('still strips real Markdown links and emoji, and counts only visible characters', () => {
    expect((agentSpeechText('See [the memo](https://x.test/a) 🙂', 400) as { tts: string }).tts).toBe('See the memo');
    expect(agentSpeechText(`[quickly] ${'a'.repeat(400)}`, 400)).toHaveProperty('visible');
    expect(agentSpeechText('a'.repeat(401), 400)).toEqual({ error: 'too_long', chars: 401 });
    expect(agentSpeechText('   🙂 ', 400)).toEqual({ error: 'empty', chars: 0 });
  });
});

describe('speak and fallback (E102)', () => {
  let db: Database.Database; let service: IntercomService; let spoken: string[]; let sock: VoiceSocket; let frames: any[]; let now: number;
  const build = (speech: Record<string, unknown> = {}) => {
    const cfg = IntercomAdapterSchema.parse({
      voice: { speech: { quiet_hours: { enabled: false }, ...speech } },
      surfaces: [{ id: 'compact', token_env: 'T', follow: { contact: 'chris', channel: 'telegram:peggy' } }],
    });
    service = new IntercomService({ config: cfg, db, calendar, env: { T: TOKEN }, log: () => {}, now: () => now,
      synthesizer: { name: 'fake', rate: 16000, async *stream(text) { spoken.push(text); yield new Uint8Array(3200); } },
      submitInbound: async () => ({ ok: true, id: 'x', queued: true, enqueued_count: 1 }) });
  };
  const voice = async (id: string, metadata: Record<string, unknown> = { input: 'voice' }) => {
    const surface = service.surfaces.get('compact')!;
    const ack = await service.handleSend(surface, { client_msg_id: id, body: 'what time is it' }, { metadata, ...(metadata['input'] === 'voice' ? { speakTo: sock } : {}) });
    return ack as { message_id: string; interaction_id: string };
  };
  const reply = (body: string, extra: Record<string, unknown> = {}) => service.onDelivered({ id: `r-${Math.random()}`, timestamp: '', channel: 'telegram:peggy', topic: 'general', sender: 'agent:p', recipient: 'contact:chris', reply_to: null, priority: 'normal', payload: { type: 'text', body }, metadata: extra } as MessageEnvelope);
  const events = (name: string) => readEvents(db, 'compact', 0).filter((e) => e.event === name).map((e) => e.data);
  const tick = () => new Promise((r) => setTimeout(r, 20));

  beforeEach(() => {
    db = new Database(':memory:'); runMigrations(db); spoken = []; frames = []; now = Date.parse('2026-11-09T15:00:00Z');
    sock = { id: 's1', surface: undefined as never, send: (f: unknown) => { frames.push(f); }, sendBinary: () => true, closed: false } as unknown as VoiceSocket;
  });
  afterEach(() => { service?.stop(); db.close(); vi.useRealTimers(); });

  it('the per-message note tells the agent to call speak', () => {
    expect(VOICE_NOTE).toMatch(/speech transcript/);
    expect(VOICE_NOTE).toMatch(/speak\(message_id, text\)/);
  });

  it('speaks the text, sends audio tags to the voice, shows the plain text as the answer and returns quickly', async () => {
    build();
    const { message_id, interaction_id } = await voice('v1');
    const r = service.speakFor(message_id, '[warmly] It is **three** o\'clock.');
    expect(r).toMatchObject({ ok: true, status: 'spoken', text: "It is three o'clock.", echo: "🔊 It is three o'clock." });
    await tick();
    expect(spoken).toEqual(["[warmly] It is three o'clock."]);
    expect(frames.map((f) => f.type)).toEqual(['speech_start', 'speech_end']);
    expect(events('reply')).toEqual([expect.objectContaining({ interaction_id, body: "It is three o'clock.", spoken: true, more_on_telegram: false })]);
  });

  it('a later reply is not auto-spoken and does not overwrite the spoken answer', async () => {
    build();
    const { message_id } = await voice('v1');
    service.speakFor(message_id, 'Three o\'clock.');
    await tick();
    reply('It is 3:00 PM Eastern. Your 3:30 with Dave is in half an hour, and the Ajax memo is still on your desk.', { glance: 'Three PM; Dave at 3:30' });
    await tick();
    expect(spoken).toHaveLength(1);
    const replies = events('reply');
    expect(replies).toHaveLength(2);
    expect(replies[1]).toMatchObject({ body: "Three o'clock.", glance: "Three o'clock.", spoken: true, more_on_telegram: true });
  });

  it('refuses outside a push-to-talk interaction, and after a typed send', async () => {
    build();
    const typed = await voice('t1', { input: 'typed' });
    expect(service.speakFor(typed.message_id, 'Hello')).toMatchObject({ ok: false });
    expect(service.speakFor('no-such-id', 'Hello')).toMatchObject({ ok: false });
    const v = await voice('v1');
    await voice('t2', {});
    const r = service.speakFor(v.message_id, 'Hello');
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('typed') });
    await tick();
    expect(spoken).toEqual([]);
  });

  it('refuses empty or too-long text, outside the window, and skips with a reason under the guards', async () => {
    build({ reply_window_s: 60 });
    const v = await voice('v1');
    expect(service.speakFor(v.message_id, 'x'.repeat(401))).toMatchObject({ ok: false, error: expect.stringContaining('at most 400') });
    expect(service.speakFor(v.message_id, '🙂')).toMatchObject({ ok: false });
    sock.muted = true;
    expect(service.speakFor(v.message_id, 'Hello')).toEqual({ ok: true, status: 'skipped', reason: 'muted' });
    sock.muted = false; sock.asleep = true;
    expect(service.speakFor(v.message_id, 'Hello')).toEqual({ ok: true, status: 'skipped', reason: 'asleep' });
    sock.asleep = false;
    now += 61_000;
    expect(service.speakFor(v.message_id, 'Hello')).toMatchObject({ ok: false, error: expect.stringContaining('too late') });
    await tick();
    expect(spoken).toEqual([]);
    expect(events('reply')).toEqual([]);
  });

  it('skips in quiet hours', async () => {
    build({ quiet_hours: { enabled: true, start: '00:00', end: '23:59' } });
    const v = await voice('v1');
    expect(service.speakFor(v.message_id, 'Hello')).toEqual({ ok: true, status: 'skipped', reason: 'quiet_hours' });
  });

  it('allows two speak calls (max_replies) and queues the second behind the first', async () => {
    build();
    const v = await voice('v1');
    expect(service.speakFor(v.message_id, 'Checking now.')).toMatchObject({ status: 'spoken' });
    expect(service.speakFor(v.message_id, 'Done.')).toMatchObject({ status: 'queued' });
    expect(service.speakFor(v.message_id, 'Third.')).toEqual({ ok: true, status: 'skipped', reason: 'enough' });
    await tick(); await tick();
    expect(spoken).toEqual(['Checking now.', 'Done.']);
    expect(frames.map((f) => f.type)).toEqual(['speech_start', 'speech_end', 'speech_start', 'speech_end']);
  });

  it('the recording of a speak call (intercom_spoken) is not turned into a reply event or spoken again', async () => {
    build();
    await voice('v1');
    reply('🔊 Hello', { intercom_spoken: true });
    await tick();
    expect(events('reply')).toEqual([]);
    expect(spoken).toEqual([]);
  });

  describe('fallback', () => {
    it('speaks the first reply after the grace when the agent never called speak', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      build();
      await voice('v1');
      reply('Done. Porch light is on.');
      expect(spoken).toEqual([]);
      await vi.advanceTimersByTimeAsync(2900);
      expect(spoken).toEqual([]);
      await vi.advanceTimersByTimeAsync(200);
      expect(spoken).toEqual(['Done. Porch light is on.']);
    });
    it('a speak call inside the grace cancels it', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      build();
      const v = await voice('v1');
      reply('A long answer that goes to the Thread.', { glance: 'Short.' });
      service.speakFor(v.message_id, 'Short answer.');
      await vi.advanceTimersByTimeAsync(5000);
      expect(spoken).toEqual(['Short answer.']);
    });
    it('speaks at once with grace 0 and never with fallback false', async () => {
      build({ fallback_grace_s: 0 });
      await voice('v1');
      reply('Done.');
      await tick();
      expect(spoken).toEqual(['Done.']);
      service.stop(); spoken.length = 0;
      build({ fallback: false });
      await voice('v2');
      reply('Done.');
      await tick();
      expect(spoken).toEqual([]);
    });
  });
});

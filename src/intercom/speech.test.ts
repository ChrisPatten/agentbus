import { describe, expect, it, vi } from 'vitest';
import { IntercomAdapterSchema } from '../config/schema.js';
import { createSynthesizer, ElevenLabsSynthesizer, Speaker, SPEECH_FRAME_BYTES, speechText, splitForTts, type SpeechTarget, type Synthesizer } from './speech.js';

const voiceCfg = (over: Record<string, unknown> = {}) => IntercomAdapterSchema.parse({ voice: over }).voice;
const speechCfg = (over: Record<string, unknown> = {}) => voiceCfg({ speech: over }).speech;

function target(open = true): SpeechTarget & { frames: Record<string, unknown>[]; bytes: number[] } {
  const frames: Record<string, unknown>[] = [], bytes: number[] = [];
  return { id: 't1', frames, bytes, send: (f) => frames.push(f), sendBinary: (b) => { if (!open) return false; bytes.push(b.length); return true; } };
}

/** A synthesizer yielding `chunks` byte counts (optionally waiting first). */
function synth(chunks: number[], opts: { rate?: number; wait?: () => Promise<void>; fail?: boolean } = {}): Synthesizer & { texts: string[] } {
  const texts: string[] = [];
  return {
    name: 'fake', rate: opts.rate ?? 16000, texts,
    async *stream(text, { signal }) {
      texts.push(text);
      if (opts.wait) await opts.wait();
      for (const n of chunks) {
        if (signal.aborted) throw new Error('aborted');
        yield new Uint8Array(n);
      }
      if (opts.fail) throw new Error('boom');
    },
  };
}

describe('speechText', () => {
  it('speaks a short body whole, without markdown, links or emoji', () => {
    expect(speechText('**Done.** The 5:37 is on time 🚆 https://mbta.com/x', 'Done.', 160)).toBe('Done. The 5:37 is on time');
  });
  it('speaks the glance for a long body, and never more than max_chars', () => {
    const long = 'Here is the plan. '.repeat(20);
    expect(speechText(long, 'Plan ready: three steps.', 160)).toBe('Plan ready: three steps.');
    expect(Array.from(speechText(long, long, 40)).length).toBeLessThanOrEqual(40);
  });
  it('drops list markers', () => {
    expect(speechText('• one\n• two', '', 160)).toBe('one two');
  });
});

describe('splitForTts', () => {
  it('leaves short text whole and splits long text at sentence ends, never refusing', () => {
    expect(splitForTts('Short.', 50)).toEqual(['Short.']);
    const long = Array.from({ length: 30 }, (_, i) => `Sentence number ${i}.`).join(' ');
    const parts = splitForTts(long, 100);
    expect(parts.length).toBeGreaterThan(4);
    expect(parts.every((p) => Array.from(p).length <= 100)).toBe(true);
    expect(parts.join(' ')).toBe(long);
    expect(splitForTts('x'.repeat(250), 100).map((p) => p.length)).toEqual([100, 100, 50]);
  });
});

describe('ElevenLabs synthesizer', () => {
  it('needs the key and speech on', () => {
    expect(createSynthesizer(voiceCfg(), { ELEVENLABS_API_KEY: 'k' })?.name).toBe('elevenlabs:eleven_flash_v2_5');
    expect(createSynthesizer(voiceCfg(), {})).toBeNull();
    expect(createSynthesizer(voiceCfg({ speech: { enabled: false } }), { ELEVENLABS_API_KEY: 'k' })).toBeNull();
    expect(createSynthesizer(voiceCfg({ enabled: false }), { ELEVENLABS_API_KEY: 'k' })).toBeNull();
  });
  it('streams raw PCM from the stream endpoint', async () => {
    const fetchImpl = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) => new Response(new ReadableStream({
      start(c) { c.enqueue(new Uint8Array(100)); c.enqueue(new Uint8Array(60)); c.close(); },
    }), { status: 200 }));
    const s = new ElevenLabsSynthesizer({ apiKey: 'k', baseUrl: 'https://x.test/', model: 'eleven_flash_v2_5', voiceId: 'VOICE123', outputFormat: 'pcm_16000', voiceSettings: { speed: 1.05 }, fetchImpl: fetchImpl as unknown as typeof fetch });
    const got: number[] = [];
    for await (const c of s.stream('Hello there.', { signal: new AbortController().signal })) got.push(c.length);
    expect(got).toEqual([100, 60]);
    expect(s.rate).toBe(16000);
    expect(String(fetchImpl.mock.calls[0]![0])).toBe('https://x.test/v1/text-to-speech/VOICE123/stream?output_format=pcm_16000');
    const init = fetchImpl.mock.calls[0]![1]!;
    expect((init.headers as Record<string, string>)['xi-api-key']).toBe('k');
    expect(JSON.parse(init.body as string)).toEqual({ text: 'Hello there.', model_id: 'eleven_flash_v2_5', voice_settings: { speed: 1.05 } });
  });
  it('throws on an HTTP error', async () => {
    const s = new ElevenLabsSynthesizer({ apiKey: 'k', baseUrl: 'https://x.test', model: 'm', voiceId: 'VOICE123', outputFormat: 'pcm_24000', fetchImpl: (async () => new Response('no', { status: 401 })) as unknown as typeof fetch });
    await expect((async () => { for await (const _ of s.stream('x', { signal: new AbortController().signal })) { /* */ } })()).rejects.toThrow('HTTP 401');
    expect(s.rate).toBe(24000);
  });
});

describe('Speaker', () => {
  it('frames PCM in 3,200-byte pieces between speech_start and speech_end', async () => {
    const t = target();
    const sp = new Speaker({ config: speechCfg(), synth: synth([5000, 3001, 1]), log: () => {} });
    const p = sp.speak(t, 'Holding the Aloft.');
    await p;
    expect(t.frames[0]).toMatchObject({ type: 'speech_start', rate: 16000, format: 'pcm_s16le', chars: 18 });
    expect(t.bytes).toEqual([SPEECH_FRAME_BYTES, SPEECH_FRAME_BYTES, 1602]);
    expect(t.frames[1]).toEqual({ type: 'speech_end', id: t.frames[0]!['id'], ms: 250 });
  });

  it('plays arbitrarily long speech in full, paced to at most lead_s ahead of playback', async () => {
    vi.useFakeTimers();
    const t = target(); const sentAt: number[] = [];
    t.sendBinary = (b) => { t.bytes.push(b.length); sentAt.push(Date.now()); return true; };
    const sp = new Speaker({ config: speechCfg({ lead_s: 2 }), synth: synth(Array(20).fill(32000)), log: () => {} });   // 20 s of audio
    const t0 = Date.now();
    const p = sp.speak(t, 'A very long passage.');
    await vi.advanceTimersByTimeAsync(0);
    expect(t.bytes.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(32000 * 2 + SPEECH_FRAME_BYTES);   // only the lead is out at once
    await vi.advanceTimersByTimeAsync(30_000);
    await p;
    vi.useRealTimers();
    expect(t.bytes.reduce((a, b) => a + b, 0)).toBe(640000);
    expect(t.frames.at(-1)).toMatchObject({ type: 'speech_end', ms: 20000 });
    expect(t.frames.some((f) => f['truncated'])).toBe(false);
    // never more than lead ahead: bytes sent by elapsed time e
    let cum = 0;
    sentAt.forEach((at, n) => { cum += t.bytes[n]!; expect(cum / 32000 - (at - t0) / 1000).toBeLessThanOrEqual(2.0001); });
  });

  it('splits text over the per-request ceiling into sequential requests inside one utterance', async () => {
    const t = target();
    const s = synth([3200]);
    await new Speaker({ config: speechCfg(), synth: s, log: () => {} }).speak(t, `${'Word. '.repeat(1500)}`.trim());
    expect(s.texts.length).toBeGreaterThan(1);
    expect(t.frames.filter((f) => f['type'] === 'speech_start')).toHaveLength(1);
    expect(t.bytes).toHaveLength(s.texts.length);
  });

  it('answers speech_cancel on an engine error, a timeout, or a cancel', async () => {
    const t = target();
    await new Speaker({ config: speechCfg(), synth: synth([3200], { fail: true }), log: () => {} }).speak(t, 'x');
    expect(t.frames.at(-1)).toMatchObject({ type: 'speech_cancel', reason: 'tts_error' });

    vi.useFakeTimers();
    const t2 = target();
    const slow = new Speaker({ config: speechCfg({ stall_timeout_s: 2 }), synth: synth([3200], { wait: () => new Promise((r) => setTimeout(r, 5000)) }), log: () => {} });
    const p = slow.speak(t2, 'x');
    await vi.advanceTimersByTimeAsync(5000);
    await p;
    expect(t2.frames.at(-1)).toMatchObject({ type: 'speech_cancel', reason: 'timeout' });

    const t3 = target();
    const sp3 = new Speaker({ config: speechCfg(), synth: synth([3200, 3200], { wait: () => new Promise((r) => setTimeout(r, 100)) }), log: () => {} });
    const p3 = sp3.speak(t3, 'x');
    expect(sp3.speaking('t1')).toBe(true);
    sp3.cancel('t1', 'stopped');
    await vi.advanceTimersByTimeAsync(200);
    await p3;
    vi.useRealTimers();
    expect(t3.bytes).toEqual([]);
    expect(t3.frames.at(-1)).toMatchObject({ type: 'speech_cancel', reason: 'stopped' });
  });

  it('sends nothing more once the socket is gone, and nothing at all without an engine or text', async () => {
    const t = target(false);
    await new Speaker({ config: speechCfg(), synth: synth([6400, 6400]), log: () => {} }).speak(t, 'x');
    expect(t.frames.map((f) => f['type'])).toEqual(['speech_start']);
    const t2 = target();
    await new Speaker({ config: speechCfg(), synth: null, log: () => {} }).speak(t2, 'x');
    await new Speaker({ config: speechCfg(), synth: synth([3200]), log: () => {} }).speak(t2, '');
    expect(t2.frames).toEqual([]);
  });
});

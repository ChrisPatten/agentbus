import { afterEach, describe, expect, it, vi } from 'vitest';
import { IntercomAdapterSchema } from '../config/schema.js';
import { cleanTranscript, createTranscriber, CommandTranscriber, OpenAiTranscriber, pcmPeak, pcmToWav, VoiceSessions, type Transcriber, type VoiceClient } from './voice.js';

const voiceCfg = (over: Record<string, unknown> = {}) => IntercomAdapterSchema.parse({ voice: { partial_interval_ms: 0, ...over } }).voice;

/** `ms` of a 1 kHz-ish square wave at the given amplitude, 16 kHz mono. */
function tone(ms: number, amp = 4000): Buffer {
  const n = Math.round((16000 * ms) / 1000);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(i % 16 < 8 ? amp : -amp, i * 2);
  return b;
}

function client(): VoiceClient & { frames: Record<string, unknown>[] } {
  const frames: Record<string, unknown>[] = [];
  return { id: 'c1', frames, send: (f) => frames.push(f) };
}

function fakeTranscriber(text: string | (() => Promise<string>)): Transcriber & { calls: { bytes: number; language: string }[] } {
  const calls: { bytes: number; language: string }[] = [];
  return {
    name: 'fake', calls,
    async transcribe(wav, { language }) { calls.push({ bytes: wav.length, language }); return typeof text === 'string' ? text : text(); },
  };
}

describe('pcm helpers', () => {
  it('wraps PCM in a 44-byte mono 16-bit WAV header', () => {
    const wav = pcmToWav(Buffer.alloc(320), 16000);
    expect(wav.length).toBe(364);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(16000);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.readUInt32LE(40)).toBe(320);
  });
  it('finds the loudest sample', () => {
    expect(pcmPeak(tone(10, 1234))).toBe(1234);
    expect(pcmPeak(Buffer.alloc(100))).toBe(0);
  });
  it('drops stock captions but keeps real words', () => {
    expect(cleanTranscript('  Book the   Aloft. ')).toBe('Book the Aloft.');
    expect(cleanTranscript('[Music]')).toBe('');
    expect(cleanTranscript('Thanks for watching!')).toBe('');
    expect(cleanTranscript('Thank you.')).toBe('Thank you.');
  });
});

describe('createTranscriber', () => {
  it('prefers OpenAI when its key is set, else the command, else nothing', () => {
    expect(createTranscriber(voiceCfg(), { OPENAI_API_KEY: 'k' })?.name).toBe('openai:gpt-4o-mini-transcribe');
    expect(createTranscriber(voiceCfg({ command: { argv: ['whisper-x', '{wav}'] } }), {})?.name).toBe('command:whisper-x');
    expect(createTranscriber(voiceCfg(), {})).toBeNull();
    expect(createTranscriber(voiceCfg({ enabled: false }), { OPENAI_API_KEY: 'k' })).toBeNull();
    expect(createTranscriber(voiceCfg({ engine: 'command' }), { OPENAI_API_KEY: 'k' })).toBeNull();
    expect(createTranscriber(voiceCfg({ engine: 'openai', openai: { api_key_env: 'MY_KEY' } }), { MY_KEY: 'k' })?.name).toBe('openai:gpt-4o-mini-transcribe');
  });

  it('posts the WAV to the transcription endpoint and returns its text', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const form = init!.body as FormData;
      expect(form.get('model')).toBe('m1');
      expect(form.get('language')).toBe('en');
      expect((form.get('file') as Blob).size).toBe(44 + 640);
      return new Response(JSON.stringify({ text: 'hello there' }), { status: 200 });
    });
    const t = new OpenAiTranscriber({ apiKey: 'k', model: 'm1', baseUrl: 'https://x.test/v1/', fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await t.transcribe(pcmToWav(Buffer.alloc(640), 16000), { language: 'en', signal: new AbortController().signal })).toBe('hello there');
    expect(String(fetchImpl.mock.calls[0]![0])).toBe('https://x.test/v1/audio/transcriptions');
    expect((fetchImpl.mock.calls[0]![1]!.headers as Record<string, string>)['Authorization']).toBe('Bearer k');
  });

  it('rejects on an HTTP error', async () => {
    const t = new OpenAiTranscriber({ apiKey: 'k', model: 'm', baseUrl: 'https://x.test/v1', fetchImpl: (async () => new Response('no', { status: 401 })) as unknown as typeof fetch });
    await expect(t.transcribe(pcmToWav(Buffer.alloc(2), 16000), { language: '', signal: new AbortController().signal })).rejects.toThrow('HTTP 401');
  });

  it('runs a local command on a temporary WAV file and reads its stdout', async () => {
    const t = new CommandTranscriber(['/bin/sh', '-c', 'test -s "$0" && echo " spoken words "', '{wav}']);
    expect(await t.transcribe(pcmToWav(Buffer.alloc(64), 16000), { language: 'en', signal: new AbortController().signal })).toContain('spoken words');
  });
});

describe('VoiceSessions', () => {
  afterEach(() => { vi.useRealTimers(); });

  function setup(t: Transcriber | null, over: Record<string, unknown> = {}) {
    const submitted: { cmid: string; text: string }[] = [];
    const v = new VoiceSessions({
      config: voiceCfg(over), transcriber: t, log: () => {},
      submit: async (_c, cmid, text) => { submitted.push({ cmid, text }); return { type: 'ack', client_msg_id: cmid, status: 'queued' }; },
    });
    return { v, submitted };
  }

  it('transcribes the recording, answers the transcript, then sends it on and answers the ack', async () => {
    const t = fakeTranscriber(' Book the Aloft, two nights ');
    const { v, submitted } = setup(t);
    const c = client();
    expect(v.start(c, { type: 'audio_start', client_msg_id: 'm1', rate: 16000 })).toBeNull();
    v.chunk(c, tone(400)); v.chunk(c, tone(400));
    await v.end(c, { type: 'audio_end', client_msg_id: 'm1' });
    expect(t.calls).toEqual([{ bytes: 44 + 2 * 12800, language: 'en' }]);
    expect(c.frames).toEqual([
      { type: 'transcript', client_msg_id: 'm1', final: true, status: 'ok', text: 'Book the Aloft, two nights', duration_ms: 800 },
      { type: 'ack', client_msg_id: 'm1', status: 'queued' },
    ]);
    expect(submitted).toEqual([{ cmid: 'm1', text: 'Book the Aloft, two nights' }]);
  });

  it('answers empty for a short or silent recording, without transcribing', async () => {
    const t = fakeTranscriber('x');
    const { v, submitted } = setup(t);
    const c = client();
    v.start(c, { type: 'audio_start', client_msg_id: 'a' }); v.chunk(c, tone(100)); await v.end(c, { type: 'audio_end', client_msg_id: 'a' });
    v.start(c, { type: 'audio_start', client_msg_id: 'b' }); v.chunk(c, tone(900, 50)); await v.end(c, { type: 'audio_end', client_msg_id: 'b' });
    expect(t.calls).toEqual([]);
    expect(submitted).toEqual([]);
    expect(c.frames.map((f) => [f['client_msg_id'], f['status']])).toEqual([['a', 'empty'], ['b', 'empty']]);
  });

  it('answers empty when nothing was recognised', async () => {
    const { v, submitted } = setup(fakeTranscriber('[Music]'));
    const c = client();
    v.start(c, { type: 'audio_start', client_msg_id: 'a' }); v.chunk(c, tone(800)); await v.end(c, { type: 'audio_end', client_msg_id: 'a' });
    expect(c.frames).toEqual([{ type: 'transcript', client_msg_id: 'a', final: true, status: 'empty', duration_ms: 800 }]);
    expect(submitted).toEqual([]);
  });

  it('answers failed when the engine fails, when voice is unavailable, or for an unknown recording', async () => {
    const { v } = setup(fakeTranscriber(async () => { throw new Error('boom'); }));
    const c = client();
    v.start(c, { type: 'audio_start', client_msg_id: 'a' }); v.chunk(c, tone(800)); await v.end(c, { type: 'audio_end', client_msg_id: 'a' });
    await v.end(c, { type: 'audio_end', client_msg_id: 'zz' });
    expect(c.frames).toEqual([
      { type: 'transcript', client_msg_id: 'a', final: true, status: 'failed', reason: 'stt_error', duration_ms: 800 },
      { type: 'transcript', client_msg_id: 'zz', final: true, status: 'failed', reason: 'no_recording' },
    ]);
    const none = setup(null).v;
    const c2 = client();
    expect(none.start(c2, { type: 'audio_start', client_msg_id: 'n' })).toBeNull();
    expect(c2.frames).toEqual([{ type: 'transcript', client_msg_id: 'n', final: true, status: 'failed', reason: 'unavailable' }]);
  });

  it('refuses a malformed audio_start', () => {
    const { v } = setup(fakeTranscriber('x'));
    const c = client();
    expect(v.start(c, { type: 'audio_start' })).toEqual({ type: 'error', code: 'invalid_frame' });
    expect(v.start(c, { type: 'audio_start', client_msg_id: 'a', rate: 4000 })).toEqual({ type: 'error', code: 'invalid_frame' });
    expect(v.start(c, { type: 'audio_start', client_msg_id: 'a', format: 'opus' })).toEqual({ type: 'error', code: 'invalid_frame' });
  });

  it('a cancel drops the recording: nothing is transcribed or sent, and later audio is ignored', async () => {
    const t = fakeTranscriber('x');
    const { v, submitted } = setup(t);
    const c = client();
    v.start(c, { type: 'audio_start', client_msg_id: 'a' }); v.chunk(c, tone(800));
    v.cancel(c, { type: 'audio_cancel', client_msg_id: 'a' });
    v.chunk(c, tone(800));
    await v.end(c, { type: 'audio_end', client_msg_id: 'a' });
    expect(t.calls).toEqual([]);
    expect(submitted).toEqual([]);
    expect(c.frames).toEqual([{ type: 'transcript', client_msg_id: 'a', final: true, status: 'failed', reason: 'no_recording' }]);
  });

  it('keeps at most max_seconds of audio', async () => {
    const t = fakeTranscriber('long');
    const { v } = setup(t, { max_seconds: 1 });
    const c = client();
    v.start(c, { type: 'audio_start', client_msg_id: 'a' });
    for (let i = 0; i < 5; i++) v.chunk(c, tone(500));
    await v.end(c, { type: 'audio_end', client_msg_id: 'a' });
    expect(t.calls[0]!.bytes).toBe(44 + 32000);
  });

  it('drops a recording that goes quiet, answering failed / timeout', async () => {
    vi.useFakeTimers();
    const { v } = setup(fakeTranscriber('x'), { idle_timeout_ms: 1000 });
    const c = client();
    v.start(c, { type: 'audio_start', client_msg_id: 'a' }); v.chunk(c, tone(200));
    await vi.advanceTimersByTimeAsync(1100);
    expect(c.frames).toEqual([{ type: 'transcript', client_msg_id: 'a', final: true, status: 'failed', reason: 'timeout' }]);
  });

  it('sends interim transcripts while held, only after new audio', async () => {
    vi.useFakeTimers();
    const t = fakeTranscriber('Book the');
    const { v } = setup(t, { partial_interval_ms: 1000 });
    const c = client();
    v.start(c, { type: 'audio_start', client_msg_id: 'a' });
    v.chunk(c, tone(1000));
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);                 // no new audio: no second partial
    expect(t.calls.length).toBe(1);
    expect(c.frames).toEqual([{ type: 'transcript', client_msg_id: 'a', final: false, text: 'Book the' }]);
    v.detach(c);
  });

  it('a socket that closes mid-transcription gets nothing and sends nothing', async () => {
    let release!: (s: string) => void;
    const { v, submitted } = setup(fakeTranscriber(() => new Promise<string>((r) => { release = r; })));
    const c = client();
    v.start(c, { type: 'audio_start', client_msg_id: 'a' }); v.chunk(c, tone(800));
    const done = v.end(c, { type: 'audio_end', client_msg_id: 'a' });
    await Promise.resolve();
    v.detach(c);
    release('late words');
    await done;
    expect(c.frames).toEqual([]);
    expect(submitted).toEqual([]);
  });
});

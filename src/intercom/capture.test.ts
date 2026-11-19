import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IntercomAdapterSchema } from '../config/schema.js';
import {
  CaptureStore, captureMessage, decodeAdpcm, decodeAdpcmBlock, encodeAdpcm, formatTranscript, spokenDuration, type CaptureResult,
} from './capture.js';
import { ElevenLabsTranscriber, wordsToSegments, type Transcriber } from './voice.js';

const vector = JSON.parse(readFileSync(join(__dirname, '__fixtures__', 'adpcm-test-vector.json'), 'utf8')) as {
  pcm: number[]; block_hex: string; decoded: number[];
};

const capCfg = (over: Record<string, unknown> = {}) => IntercomAdapterSchema.parse({ capture: over }).capture;

/** `samples` of a square wave, 16 kHz. */
function tone(samples: number, amp = 6000): Int16Array {
  const a = new Int16Array(samples);
  for (let i = 0; i < samples; i++) a[i] = i % 32 < 16 ? amp : -amp;
  return a;
}

const CHUNK = 32000;
const chunkB64 = (samples = CHUNK, amp = 6000) => encodeAdpcm(tone(samples, amp)).toString('base64');

describe('IMA ADPCM', () => {
  it('decodes the firmware test vector exactly', () => {
    const blk = Buffer.from(vector.block_hex, 'hex');
    const d = decodeAdpcmBlock(blk);
    expect(d).not.toBeNull();
    expect(Array.from(d!.pcm)).toEqual(vector.decoded);
    expect(d!.next).toBe(blk.length);
  });
  it('encodes the test vector to the same block as the firmware', () => {
    expect(encodeAdpcm(Int16Array.from(vector.pcm)).toString('hex')).toBe(vector.block_hex);
  });
  it('round-trips several blocks and flags a malformed tail', () => {
    const enc = encodeAdpcm(tone(1000));
    const { pcm, bad } = decodeAdpcm(enc);
    expect(bad).toBe(false);
    expect(pcm.length).toBe(2000);
    expect(decodeAdpcm(Buffer.concat([enc, Buffer.from([0x07, 0, 0])])).bad).toBe(true);
  });
});

describe('transcript helpers', () => {
  it('groups Scribe words by speaker and pause', () => {
    const segs = wordsToSegments([
      { text: 'Hello', start: 0, end: 0.4, type: 'word', speaker_id: 'speaker_0' },
      { text: ' ', type: 'spacing', speaker_id: 'speaker_0' },
      { text: 'there.', start: 0.5, end: 0.9, type: 'word', speaker_id: 'speaker_0' },
      { text: '(laughs)', start: 1, end: 1.2, type: 'audio_event' },
      { text: 'Hi', start: 1.3, end: 1.5, type: 'word', speaker_id: 'speaker_1' },
      { text: 'Later', start: 5, end: 5.4, type: 'word', speaker_id: 'speaker_1' },
    ]);
    expect(segs).toEqual([
      { start: 0, end: 0.9, speaker: 'speaker_0', text: 'Hello there.' },
      { start: 1.3, end: 1.5, speaker: 'speaker_1', text: 'Hi' },
      { start: 5, end: 5.4, speaker: 'speaker_1', text: 'Later' },
    ]);
  });
  it('formats the transcript with speakers, times and gaps', () => {
    const txt = formatTranscript(
      { text: 'a b', segments: [{ start: 0, end: 1, speaker: 'speaker_3', text: 'a' }, { start: 3725, end: 3726, speaker: 'speaker_0', text: 'b' }] },
      { id: 'cap-1', label: 'Thu, Nov 19, 2:03 PM', durationMs: 3_726_000, gaps: [2], chunkMs: 2000 },
    );
    expect(txt).toContain('Recorded Thu, Nov 19, 2:03 PM, 1 h 2 min');
    expect(txt).toContain('Missing audio (silence): 00:00:04 (2 s each)');
    expect(txt).toContain('[00:00:00] Speaker 1: a');
    expect(txt).toContain('[01:02:05] Speaker 2: b');
    expect(spokenDuration(2_832_000)).toBe('47 min 12 s');
  });
  it('sends Scribe the long-form request with diarization', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const form = init!.body as FormData;
      expect(form.get('diarize')).toBe('true');
      expect(form.get('timestamps_granularity')).toBe('word');
      expect(form.get('file_format')).toBe('pcm_s16le_16');
      return new Response(JSON.stringify({ text: 'Hi there', language_code: 'eng', words: [
        { text: 'Hi', start: 0.1, end: 0.3, type: 'word', speaker_id: 'speaker_0' },
        { text: ' ', type: 'spacing' },
        { text: 'there', start: 0.4, end: 0.7, type: 'word', speaker_id: 'speaker_0' },
      ] }), { status: 200 });
    });
    const t = new ElevenLabsTranscriber({ apiKey: 'k', model: 'scribe_v2', baseUrl: 'https://x', fetchImpl: fetchImpl as unknown as typeof fetch });
    const wav = Buffer.alloc(44 + 3200);
    wav.write('RIFF', 0, 'ascii'); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24);
    const d = await t.transcribeDetailed(wav, { language: 'en', signal: new AbortController().signal });
    expect(d).toEqual({ text: 'Hi there', language: 'eng', segments: [{ start: 0.1, end: 0.7, speaker: 'speaker_0', text: 'Hi there' }] });
  });
});

describe('CaptureStore', () => {
  let dir: string;
  let now: number;
  let woken: CaptureResult[];
  const started = Date.UTC(2026, 10, 19, 19, 3, 0);     // 2:03 PM ET

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'capture-test-'));
    now = started + 1000;
    woken = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function store(transcriber: Transcriber | null = null, over: Record<string, unknown> = {}): CaptureStore {
    return new CaptureStore({
      config: capCfg(over), spoolDir: join(dir, 'spool'), outDir: join(dir, 'out'), transcriber, language: 'en',
      wake: async (r) => { woken.push(r); }, now: () => now, log: () => {},
    });
  }
  const startFrame = (id = 'cap-a') => ({ type: 'capture_start', id, rate: 16000, codec: 'ima_adpcm', chunk_samples: CHUNK, started_at: started });

  it('acks each chunk durably, resumes, and ignores repeats', async () => {
    const s = store();
    expect(await s.handle('compact', startFrame())).toEqual({ type: 'capture_ack', id: 'cap-a', acked: 0, have: 0 });
    expect(await s.handle('compact', { type: 'capture_chunk', id: 'cap-a', seq: 0, data: chunkB64() })).toEqual({ type: 'capture_ack', id: 'cap-a', seq: 0, acked: 1 });
    expect(await s.handle('compact', { type: 'capture_chunk', id: 'cap-a', seq: 2, data: chunkB64() })).toEqual({ type: 'capture_ack', id: 'cap-a', seq: 2, acked: 1 });
    expect(await s.handle('compact', { type: 'capture_chunk', id: 'cap-a', seq: 0, data: chunkB64() })).toMatchObject({ seq: 0, acked: 1 });
    // a fresh store (bus restart) reads the spool back
    const s2 = store();
    expect(await s2.handle('compact', startFrame())).toEqual({ type: 'capture_ack', id: 'cap-a', acked: 1, have: 2 });
    expect(await s2.handle('compact', { type: 'capture_chunk', id: 'cap-a', seq: 1, data: chunkB64() })).toMatchObject({ seq: 1, acked: 3 });
  });

  it('refuses malformed frames with drop, and chunks before a start', async () => {
    const s = store();
    expect(await s.handle('compact', { type: 'capture_start', id: '../x' })).toMatchObject({ error: 'invalid_id', drop: true });
    expect(await s.handle('compact', { type: 'capture_start', id: 'c', codec: 'opus' })).toMatchObject({ error: 'invalid_frame', drop: true });
    expect(await s.handle('compact', { type: 'capture_chunk', id: 'nope', seq: 0, data: chunkB64() })).toMatchObject({ error: 'not_started' });
    await s.handle('compact', startFrame());
    expect(await s.handle('compact', { type: 'capture_chunk', id: 'cap-a', seq: 0, data: Buffer.from([9, 9, 9]).toString('base64') })).toMatchObject({ error: 'bad_chunk', drop: true });
    expect(await s.handle('compact', { type: 'capture_chunk', id: 'cap-a', seq: 999999, data: chunkB64() })).toMatchObject({ error: 'invalid_frame', drop: true });
  });

  it('assembles the WAV on end, fills a gap with silence, transcribes, writes files and wakes once', async () => {
    const t: Transcriber = {
      name: 'fake',
      async transcribe() { return 'unused'; },
      async transcribeDetailed() { return { text: 'Hello Kate', segments: [{ start: 0, end: 1.2, speaker: 'speaker_0', text: 'Hello Kate' }] }; },
    };
    const s = store(t);
    await s.handle('compact', startFrame());
    await s.handle('compact', { type: 'capture_chunk', id: 'cap-a', seq: 0, data: chunkB64() });
    await s.handle('compact', { type: 'capture_chunk', id: 'cap-a', seq: 2, data: chunkB64(16000) });
    expect(await s.handle('compact', { type: 'capture_end', id: 'cap-a', chunks: 3, duration_ms: 5000, reason: 'stopped' }))
      .toEqual({ type: 'capture_ack', id: 'cap-a', end: true, acked: 1 });
    const r = await s.finalizeNow('compact', 'cap-a');
    await vi.waitFor(() => expect(woken.length).toBe(1));
    const res = r ?? woken[0]!;
    expect(res.gaps).toEqual([1]);
    expect(res.durationMs).toBe(5000);                    // 2 s + 2 s of silence + 1 s
    expect(res.wav).toBe(join(dir, 'out', '2026-11-19', 'cap-a.wav'));
    const wav = readFileSync(res.wav);
    expect(wav.readUInt32LE(40)).toBe(80000 * 2);
    expect(wav.subarray(44 + CHUNK * 2, 44 + CHUNK * 4).every((b) => b === 0)).toBe(true);
    expect(readFileSync(res.txt!, 'utf8')).toContain('[00:00:00] Speaker 1: Hello Kate');
    const meta = JSON.parse(readFileSync(res.json, 'utf8'));
    expect(meta).toMatchObject({ id: 'cap-a', surface: 'compact', transcript: 'ok', gaps: [1], partial: false, started_local: 'Thu, Nov 19, 2:03 PM' });
    // chunks are gone; a late resend is told the recording is already saved
    expect(readdirSync(join(dir, 'spool', 'compact', 'cap-a'))).toEqual(['meta.json']);
    expect(await s.handle('compact', startFrame())).toEqual({ type: 'capture_ack', id: 'cap-a', end: true, status: 'saved' });
    expect(await s.handle('compact', { type: 'capture_chunk', id: 'cap-a', seq: 0, data: chunkB64() })).toMatchObject({ end: true, seq: 0 });
    expect(woken.length).toBe(1);
    expect(captureMessage(res, 'Thu, Nov 19, 2:03 PM')).toBe(
      `[capture] Recording from the Compact saved: 5 s, started Thu, Nov 19, 2:03 PM. Transcript: ${res.txt} Audio: ${res.wav}. Details: ${res.json}. 1 missing chunk(s) were filled with silence.`,
    );
  });

  it('cuts long audio into pieces for engines without long-form support', async () => {
    const calls: number[] = [];
    const t: Transcriber = { name: 'piecewise', async transcribe(wav) { calls.push(wav.length); return `piece ${calls.length}`; } };
    const s = store(t, { segment_s: 60 });
    await s.handle('compact', startFrame('cap-b'));
    for (let seq = 0; seq < 35; seq++) await s.handle('compact', { type: 'capture_chunk', id: 'cap-b', seq, data: chunkB64() });
    await s.handle('compact', { type: 'capture_end', id: 'cap-b', chunks: 35, duration_ms: 70000 });
    const r = (await s.finalizeNow('compact', 'cap-b'))!;
    expect(calls.length).toBe(2);                         // 60 s + 10 s
    expect(readFileSync(r.txt!, 'utf8')).toContain('[00:01:00] piece 2');
  });

  it('keeps the WAV and still wakes when transcription fails', async () => {
    const t: Transcriber = { name: 'broken', async transcribe() { throw new Error('HTTP 500'); } };
    const s = store(t);
    await s.handle('compact', startFrame('cap-c'));
    await s.handle('compact', { type: 'capture_chunk', id: 'cap-c', seq: 0, data: chunkB64() });
    await s.handle('compact', { type: 'capture_end', id: 'cap-c', chunks: 1 });
    const r = (await s.finalizeNow('compact', 'cap-c'))!;
    expect(r.transcript).toBe('failed');
    expect(r.txt).toBeNull();
    expect(existsSync(r.wav)).toBe(true);
    expect(captureMessage(r, 'x')).toContain('No transcript (transcription failed: HTTP 500).');
  });

  it('finishes a stale recording with no end as partial, and an ended one after a restart', async () => {
    const s = store(null, { stale_after_s: 600 });
    await s.handle('compact', startFrame('cap-d'));
    await s.handle('compact', { type: 'capture_chunk', id: 'cap-d', seq: 0, data: chunkB64() });
    await s.recover();
    expect(woken.length).toBe(0);                         // still fresh
    // a restart with an ended capture on disk
    await s.handle('compact', startFrame('cap-e'));
    await s.handle('compact', { type: 'capture_chunk', id: 'cap-e', seq: 0, data: chunkB64() });
    const meta = join(dir, 'spool', 'compact', 'cap-e', 'meta.json');
    const m = JSON.parse(readFileSync(meta, 'utf8'));
    m.end = { chunks: 1, duration_ms: 2000, reason: 'battery', at: now };
    writeFileSync(meta, JSON.stringify(m));
    now += 11 * 60_000;
    const s2 = store(null, { stale_after_s: 600 });
    await s2.recover();
    await vi.waitFor(() => expect(woken.map((w) => w.id).sort()).toEqual(['cap-d', 'cap-e']));
    const d = woken.find((w) => w.id === 'cap-d')!;
    expect(d.partial).toBe(true);
    expect(d.transcript).toBe('off');
    expect(woken.find((w) => w.id === 'cap-e')!.reason).toBe('battery');
  });
});

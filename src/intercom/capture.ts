/**
 * Compact Capture — long recordings from a surface (docs/INTERCOM.md "Capture").
 *
 * The device records 16 kHz mono, encodes it as IMA ADPCM blocks (the phone-link codec: 5-byte header + 4-bit codes,
 * each block decodable on its own) and streams numbered chunks over its surface socket as JSON text frames:
 *
 *   {"type":"capture_start","id","rate":16000,"codec":"ima_adpcm","chunk_samples":32000,"started_at":<epoch ms>}
 *   {"type":"capture_chunk","id","seq":<0..>,"data":"<base64 ADPCM blocks>"}
 *   {"type":"capture_end","id","chunks":<count>,"duration_ms","reason":"stopped|max|battery|storage_full|interrupted"}
 *
 * Every frame is answered with `capture_ack` {id, acked: <chunks held from 0 without a gap>, seq?, end?}. A chunk is
 * written to a durable spool before its ack, so the device may forget it; a repeated chunk is acked again without
 * rewriting. `capture_start` is also the resume handshake (a device that lost its socket sends it again and skips what
 * is already held). The device sends `capture_end` once it has nothing left to upload; the bus then assembles the
 * WAV (missing chunks become silence and are listed), transcribes it with the push-to-talk engine, writes
 * `<out_dir>/<date>/<id>.wav|.txt|.json` and sends a `[capture]` message into the surface's followed conversation.
 * A recording that stops arriving without an end is assembled as partial after `stale_after_s`.
 */
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IntercomAdapterConfig } from '../config/schema.js';
import { pcmPeak, pcmToWav, type DetailedTranscript, type Transcriber, type TranscriptSegment } from './voice.js';

export type CaptureConfig = IntercomAdapterConfig['capture'];

// ── IMA ADPCM (matches intercom-firmware main/adpcm.c and its shared test vector) ─────────────────────────────

const STEP = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97,
  107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796,
  876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871,
  5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623,
  27086, 29794, 32767,
];
const INDEX = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];
export const ADPCM_CODEC_IMA = 0x01;
const ADPCM_HDR = 5;

/** Decode one block at `off`; returns the samples and the next offset, or null when malformed. */
export function decodeAdpcmBlock(buf: Buffer, off = 0): { pcm: Int16Array; next: number } | null {
  if (buf.length - off < ADPCM_HDR || buf[off] !== ADPCM_CODEC_IMA || buf[off + 3]! > 88) return null;
  const n = buf[off + 4] || 256;
  const len = ADPCM_HDR + Math.ceil(n / 2);
  if (buf.length - off < len) return null;
  let pred = buf.readInt16LE(off + 1);
  let idx = buf[off + 3]!;
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const byte = buf[off + ADPCM_HDR + (i >> 1)]!;
    const code = i & 1 ? byte >> 4 : byte & 0x0f;
    const s = STEP[idx]!;
    let diff = s >> 3;
    if (code & 4) diff += s;
    if (code & 2) diff += s >> 1;
    if (code & 1) diff += s >> 2;
    pred = code & 8 ? pred - diff : pred + diff;
    if (pred > 32767) pred = 32767;
    if (pred < -32768) pred = -32768;
    idx += INDEX[code]!;
    if (idx < 0) idx = 0;
    if (idx > 88) idx = 88;
    out[i] = pred;
  }
  return { pcm: out, next: off + len };
}

/** Encode PCM as a run of blocks (encoder state carried across blocks, as the firmware does). Tests and tools. */
export function encodeAdpcm(pcm: Int16Array, blockSamples = 256): Buffer {
  const out: Buffer[] = [];
  let pred = 0, idx = 0;
  for (let off = 0; off < pcm.length; off += blockSamples) {
    const n = Math.min(blockSamples, pcm.length - off);
    const blk = Buffer.alloc(ADPCM_HDR + Math.ceil(n / 2));
    blk[0] = ADPCM_CODEC_IMA;
    blk.writeInt16LE(pred, 1);
    blk[3] = idx;
    blk[4] = n & 0xff;
    for (let i = 0; i < n; i++) {
      const st = STEP[idx]!;
      let d = pcm[off + i]! - pred;
      let code = 0;
      if (d < 0) { code = 8; d = -d; }
      if (d >= st) { code |= 4; d -= st; }
      if (d >= st >> 1) { code |= 2; d -= st >> 1; }
      if (d >= st >> 2) code |= 1;
      let diff = st >> 3;
      if (code & 4) diff += st;
      if (code & 2) diff += st >> 1;
      if (code & 1) diff += st >> 2;
      pred = code & 8 ? pred - diff : pred + diff;
      if (pred > 32767) pred = 32767;
      if (pred < -32768) pred = -32768;
      idx = Math.min(88, Math.max(0, idx + INDEX[code]!));
      if (i & 1) blk[ADPCM_HDR + (i >> 1)]! |= code << 4;
      else blk[ADPCM_HDR + (i >> 1)] = code;
    }
    out.push(blk);
  }
  return Buffer.concat(out);
}

/** Decode a run of blocks to 16-bit little-endian PCM. Stops at the first malformed block (`bad` tells). */
export function decodeAdpcm(buf: Buffer): { pcm: Buffer; bad: boolean } {
  const parts: Buffer[] = [];
  let off = 0;
  while (off < buf.length) {
    const b = decodeAdpcmBlock(buf, off);
    if (!b) return { pcm: Buffer.concat(parts), bad: true };
    parts.push(Buffer.from(b.pcm.buffer, b.pcm.byteOffset, b.pcm.byteLength));
    off = b.next;
  }
  return { pcm: Buffer.concat(parts), bad: false };
}

// ── store ──────────────────────────────────────────────────────────────────────────────────────────────────

const ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_CHUNK_BYTES = 64 * 1024;
const REASONS = new Set(['stopped', 'max', 'battery', 'storage_full', 'interrupted', 'partial']);

interface CaptureMeta {
  id: string;
  surface: string;
  rate: number;
  chunk_samples: number;
  started_at: number;               // epoch ms, from the device (or first sight)
  created_at: number;
  updated_at: number;
  end?: { chunks: number; duration_ms: number; reason: string; at: number };
  finalized?: { at: number; wav: string; txt: string | null; json: string };
}

export interface CaptureResult {
  id: string;
  surfaceId: string;
  startedAt: number;
  durationMs: number;
  reason: string;
  partial: boolean;
  gaps: number[];
  wav: string;
  txt: string | null;
  json: string;
  transcript: 'ok' | 'empty' | 'failed' | 'off';
  error?: string;
}

export interface CaptureDeps {
  config: CaptureConfig;
  spoolDir: string;
  outDir: string;
  /** null: no engine (files are written, the transcript is skipped). */
  transcriber: Transcriber | null;
  language: string;
  /** The finished recording: send the `[capture]` message. Rejections are logged; the files stay either way. */
  wake?: (result: CaptureResult) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
}

type Ack = Record<string, unknown>;

export class CaptureStore {
  /** Per-capture work, one at a time (socket frames are handled concurrently). */
  private readonly chains = new Map<string, Promise<unknown>>();
  /** Chunks held per capture (seq numbers), loaded from the spool on first touch. */
  private readonly held = new Map<string, Set<number>>();
  private readonly metas = new Map<string, CaptureMeta>();
  private readonly finalizing = new Map<string, Promise<CaptureResult | null>>();
  private sweepTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private readonly deps: CaptureDeps) {}

  private now(): number { return this.deps.now?.() ?? Date.now(); }
  private log(line: string): void { (this.deps.log ?? ((l) => console.log(`[intercom] capture: ${l}`)))(line); }
  private dir(surface: string, id: string): string { return join(this.deps.spoolDir, surface, id); }

  /** Serialize work for one capture. */
  private run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.chains.set(key, tail);
    void tail.then(() => { if (this.chains.get(key) === tail) this.chains.delete(key); });
    return next;
  }

  private async loadMeta(surface: string, id: string): Promise<CaptureMeta | null> {
    const key = `${surface}/${id}`;
    const cached = this.metas.get(key);
    if (cached) return cached;
    try {
      const m = JSON.parse(await readFile(join(this.dir(surface, id), 'meta.json'), 'utf8')) as CaptureMeta;
      this.metas.set(key, m);
      return m;
    } catch { return null; }
  }

  private async saveMeta(m: CaptureMeta): Promise<void> {
    const d = this.dir(m.surface, m.id);
    await mkdir(d, { recursive: true });
    const tmp = join(d, 'meta.json.tmp');
    await writeFile(tmp, JSON.stringify(m, null, 1), { mode: 0o600 });
    await rename(tmp, join(d, 'meta.json'));
    this.metas.set(`${m.surface}/${m.id}`, m);
  }

  private async loadHeld(surface: string, id: string): Promise<Set<number>> {
    const key = `${surface}/${id}`;
    let h = this.held.get(key);
    if (h) return h;
    h = new Set<number>();
    try {
      for (const f of await readdir(this.dir(surface, id))) {
        const m = /^c(\d{6})\.adpcm$/.exec(f);
        if (m) h.add(Number(m[1]));
      }
    } catch { /* new */ }
    this.held.set(key, h);
    return h;
  }

  private static contiguous(h: Set<number>): number {
    let n = 0;
    while (h.has(n)) n++;
    return n;
  }

  private maxChunks(m: CaptureMeta): number {
    return Math.ceil((this.deps.config.max_seconds * m.rate) / m.chunk_samples) + 2;
  }

  /** One `capture_*` frame from `surfaceId`; resolves to the frame to send back. */
  handle(surfaceId: string, frame: Record<string, unknown>): Promise<Ack> {
    const id = typeof frame['id'] === 'string' ? frame['id'] : '';
    if (!ID_RE.test(id)) return Promise.resolve({ type: 'capture_ack', id: id.slice(0, 64), error: 'invalid_id', drop: true });
    return this.run(`${surfaceId}/${id}`, async () => {
      try {
        if (frame['type'] === 'capture_start') return await this.onStart(surfaceId, id, frame);
        if (frame['type'] === 'capture_chunk') return await this.onChunk(surfaceId, id, frame);
        if (frame['type'] === 'capture_end') return await this.onEnd(surfaceId, id, frame);
        return { type: 'capture_ack', id, error: 'invalid_frame' };
      } catch (err) {
        this.log(`warn: ${String(frame['type'])} ${id} failed: ${String(err)}`);
        return { type: 'capture_ack', id, error: 'internal_error' };     // not acked: the device retries
      }
    });
  }

  private doneAck(id: string): Ack { return { type: 'capture_ack', id, end: true, status: 'saved' }; }

  private async onStart(surface: string, id: string, f: Record<string, unknown>): Promise<Ack> {
    const rate = f['rate'] === undefined ? 16000 : f['rate'];
    const codec = f['codec'] === undefined ? 'ima_adpcm' : f['codec'];
    const cs = f['chunk_samples'] === undefined ? 32000 : f['chunk_samples'];
    if (typeof rate !== 'number' || !Number.isInteger(rate) || rate < 8000 || rate > 48000 || codec !== 'ima_adpcm'
        || typeof cs !== 'number' || !Number.isInteger(cs) || cs < 256 || cs > 10 * rate) {
      return { type: 'capture_ack', id, error: 'invalid_frame', drop: true };
    }
    let m = await this.loadMeta(surface, id);
    if (m?.finalized) return this.doneAck(id);
    const now = this.now();
    if (!m) {
      const at = typeof f['started_at'] === 'number' && f['started_at'] > 1.6e12 && f['started_at'] < now + 86_400_000 ? f['started_at'] : now;
      m = { id, surface, rate, chunk_samples: cs, started_at: at, created_at: now, updated_at: now };
      this.log(`start ${surface}/${id} (${rate} Hz, ${cs} samples a chunk)`);
    } else {
      m.updated_at = now;
    }
    await this.saveMeta(m);
    const h = await this.loadHeld(surface, id);
    return { type: 'capture_ack', id, acked: CaptureStore.contiguous(h), have: h.size, ...(m.end ? { ended: true } : {}) };
  }

  private async onChunk(surface: string, id: string, f: Record<string, unknown>): Promise<Ack> {
    const seq = f['seq'];
    const m = await this.loadMeta(surface, id);
    if (m?.finalized) return { ...this.doneAck(id), ...(typeof seq === 'number' ? { seq } : {}) };
    if (!m) return { type: 'capture_ack', id, error: 'not_started', ...(typeof seq === 'number' ? { seq } : {}) };
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0 || seq >= this.maxChunks(m) || typeof f['data'] !== 'string') {
      return { type: 'capture_ack', id, error: 'invalid_frame', drop: true, ...(typeof seq === 'number' ? { seq } : {}) };
    }
    const h = await this.loadHeld(surface, id);
    if (!h.has(seq)) {
      const data = Buffer.from(f['data'], 'base64');
      if (data.length === 0 || data.length > MAX_CHUNK_BYTES || decodeAdpcm(data).bad) {
        this.log(`warn: ${surface}/${id} chunk ${seq} malformed (${data.length} bytes): dropped`);
        return { type: 'capture_ack', id, seq, error: 'bad_chunk', drop: true, acked: CaptureStore.contiguous(h) };
      }
      const d = this.dir(surface, id);
      const name = `c${String(seq).padStart(6, '0')}.adpcm`;
      await writeFile(join(d, `${name}.tmp`), data, { mode: 0o600 });
      await rename(join(d, `${name}.tmp`), join(d, name));
      h.add(seq);
    }
    m.updated_at = this.now();
    if (seq % 15 === 0) await this.saveMeta(m);                        // keep the stale clock roughly current on disk
    return { type: 'capture_ack', id, seq, acked: CaptureStore.contiguous(h) };
  }

  private async onEnd(surface: string, id: string, f: Record<string, unknown>): Promise<Ack> {
    const m = await this.loadMeta(surface, id);
    if (m?.finalized) return this.doneAck(id);
    if (!m) return { type: 'capture_ack', id, error: 'not_started' };
    const h = await this.loadHeld(surface, id);
    const chunks = typeof f['chunks'] === 'number' && Number.isInteger(f['chunks']) && f['chunks'] >= 0 && f['chunks'] <= this.maxChunks(m)
      ? f['chunks'] : (h.size ? Math.max(...h) + 1 : 0);
    const dur = typeof f['duration_ms'] === 'number' && f['duration_ms'] >= 0 ? Math.round(f['duration_ms']) : Math.round((chunks * m.chunk_samples * 1000) / m.rate);
    const reason = typeof f['reason'] === 'string' && REASONS.has(f['reason']) ? f['reason'] : 'stopped';
    if (!m.end) {
      m.end = { chunks, duration_ms: dur, reason, at: this.now() };
      m.updated_at = this.now();
      await this.saveMeta(m);
      this.log(`end ${surface}/${id}: ${chunks} chunks, ${Math.round(dur / 1000)} s (${reason}); held ${h.size}`);
    }
    void this.finalizeSoon(surface, id);
    return { type: 'capture_ack', id, end: true, acked: CaptureStore.contiguous(h) };
  }

  /** Assemble, transcribe, write, wake. Runs once per capture; safe to call again after a crash. */
  private finalizeSoon(surface: string, id: string): Promise<CaptureResult | null> {
    const key = `${surface}/${id}`;
    const running = this.finalizing.get(key);
    if (running) return running;
    const p = this.finalize(surface, id)
      .catch((err) => { this.log(`warn: finalize ${key} failed: ${String(err)}`); return null; })
      .finally(() => this.finalizing.delete(key));
    this.finalizing.set(key, p);
    return p;
  }

  /** Test hook and recovery: finish one capture now (its chain first). */
  async finalizeNow(surface: string, id: string): Promise<CaptureResult | null> {
    await (this.chains.get(`${surface}/${id}`) ?? Promise.resolve());
    return this.finalizeSoon(surface, id);
  }

  private localParts(ms: number): { date: string; label: string } {
    const tz = this.deps.config.timezone;
    const d = new Date(ms);
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
    const label = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(d);
    return { date, label };
  }

  private async finalize(surface: string, id: string): Promise<CaptureResult | null> {
    const m = await this.loadMeta(surface, id);
    if (!m || m.finalized || this.stopped) return null;
    const h = await this.loadHeld(surface, id);
    const partial = !m.end || m.end.reason === 'interrupted' || m.end.reason === 'partial';
    const chunks = Math.max(m.end?.chunks ?? 0, h.size ? Math.max(...h) + 1 : 0);
    const gaps: number[] = [];
    const parts: Buffer[] = [];
    for (let seq = 0; seq < chunks; seq++) {
      if (!h.has(seq)) { gaps.push(seq); parts.push(Buffer.alloc(m.chunk_samples * 2)); continue; }
      const raw = await readFile(join(this.dir(surface, id), `c${String(seq).padStart(6, '0')}.adpcm`));
      const { pcm, bad } = decodeAdpcm(raw);
      if (bad) this.log(`warn: ${surface}/${id} chunk ${seq} decoded short`);
      parts.push(pcm);
    }
    const pcm = Buffer.concat(parts);
    const durationMs = Math.round((pcm.length / 2 / m.rate) * 1000);
    const { date, label } = this.localParts(m.started_at);
    const outDir = join(this.deps.outDir, date);
    await mkdir(outDir, { recursive: true });
    const base = join(outDir, id);
    const wav = `${base}.wav`, txt = `${base}.txt`, json = `${base}.json`;
    await writeFile(wav, pcmToWav(pcm, m.rate), { mode: 0o600 });

    let transcript: CaptureResult['transcript'] = 'off';
    let detail: DetailedTranscript | null = null;
    let error: string | undefined;
    const t = this.deps.config.transcribe ? this.deps.transcriber : null;
    if (t && pcm.length > 0 && pcmPeak(pcm) < 200) transcript = 'empty';
    else if (t && pcm.length > 0) {
      try {
        detail = await this.transcribe(t, pcm, m.rate);
        transcript = detail.text.trim() ? 'ok' : 'empty';
      } catch (err) {
        transcript = 'failed';
        error = String(err instanceof Error ? err.message : err);
        this.log(`warn: ${surface}/${id} transcription failed (${t.name}): ${error}`);
      }
    } else if (t) transcript = 'empty';

    let txtPath: string | null = null;
    if (detail && transcript === 'ok') {
      await writeFile(txt, formatTranscript(detail, { id, label, durationMs, gaps, chunkMs: (m.chunk_samples * 1000) / m.rate }), { mode: 0o600 });
      txtPath = txt;
    }
    const reason = m.end?.reason ?? 'partial';
    const record = {
      id, surface, started_at: new Date(m.started_at).toISOString(), started_local: label, duration_ms: durationMs,
      reason, partial, chunks, gaps, wav, txt: txtPath, transcript, engine: t?.name ?? null,
      ...(detail?.language ? { language: detail.language } : {}), ...(error ? { error } : {}),
      segments: detail?.segments ?? [], created_at: new Date(this.now()).toISOString(),
    };
    await writeFile(json, JSON.stringify(record, null, 1), { mode: 0o600 });
    m.finalized = { at: this.now(), wav, txt: txtPath, json };
    await this.saveMeta(m);
    // The chunks are no longer needed; meta.json stays as the "already saved" marker for late resends.
    for (const seq of h) await rm(join(this.dir(surface, id), `c${String(seq).padStart(6, '0')}.adpcm`), { force: true });
    this.held.delete(`${surface}/${id}`);
    this.log(`saved ${surface}/${id}: ${Math.round(durationMs / 1000)} s, ${gaps.length} gap(s), transcript ${transcript} -> ${wav}`);

    const result: CaptureResult = {
      id, surfaceId: surface, startedAt: m.started_at, durationMs, reason, partial, gaps, wav, txt: txtPath, json, transcript,
      ...(error ? { error } : {}),
    };
    if (this.deps.config.wake && this.deps.wake) {
      try { await this.deps.wake(result); } catch (err) { this.log(`warn: ${surface}/${id} wake failed: ${String(err)}`); }
    }
    return result;
  }

  private async transcribe(t: Transcriber, pcm: Buffer, rate: number): Promise<DetailedTranscript> {
    const cfg = this.deps.config;
    const once = async <T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> => {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(new Error('timeout')), cfg.timeout_s * 1000);
      try { return await fn(ac.signal); } finally { clearTimeout(timer); }
    };
    const language = this.deps.language;
    if (t.transcribeDetailed) return once((signal) => t.transcribeDetailed!(pcmToWav(pcm, rate), { language, signal }));
    // Pieces of `segment_s`, one request each, timed by their offset.
    const step = cfg.segment_s * rate * 2;
    const segments: TranscriptSegment[] = [];
    for (let off = 0; off < pcm.length; off += step) {
      const piece = pcm.subarray(off, Math.min(pcm.length, off + step));
      const start = off / 2 / rate, end = (off + piece.length) / 2 / rate;
      if (pcmPeak(piece) < 200) continue;
      const text = (await once((signal) => t.transcribe(pcmToWav(piece, rate), { language, signal }))).replace(/\s+/g, ' ').trim();
      if (text) segments.push({ start, end, text });
    }
    return { text: segments.map((s) => s.text).join(' '), segments };
  }

  /** Startup and every 10 min: finish ended captures left by a restart, and stale ones with no end. */
  async recover(): Promise<void> {
    const root = this.deps.spoolDir;
    if (!existsSync(root)) return;
    const now = this.now();
    for (const surface of readdirSync(root)) {
      let ids: string[] = [];
      try { ids = readdirSync(join(root, surface)); } catch { continue; }
      for (const id of ids) {
        let m: CaptureMeta;
        try { m = JSON.parse(readFileSync(join(root, surface, id, 'meta.json'), 'utf8')) as CaptureMeta; } catch { continue; }
        if (m.finalized) {
          if (now - m.finalized.at > 30 * 86_400_000) await rm(join(root, surface, id), { recursive: true, force: true });
          continue;
        }
        const key = `${surface}/${id}`;
        if (!this.metas.has(key)) this.metas.set(key, m);
        const live = this.metas.get(key)!;
        const idle = now - live.updated_at;
        if (live.end || idle > this.deps.config.stale_after_s * 1000) {
          if (!live.end) this.log(`${key}: no frames for ${Math.round(idle / 60000)} min and no end: assembling what arrived`);
          await this.finalizeSoon(surface, id);
        }
      }
    }
  }

  start(): void {
    if (this.sweepTimer) return;
    this.stopped = false;
    void this.recover().catch((err) => this.log(`warn: recover failed: ${String(err)}`));
    this.sweepTimer = setInterval(() => { void this.recover().catch((err) => this.log(`warn: recover failed: ${String(err)}`)); }, 10 * 60_000);
    this.sweepTimer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }
}

const hms = (s: number) => {
  const t = Math.max(0, Math.floor(s));
  return `${String(Math.floor(t / 3600)).padStart(2, '0')}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};

/** "47 min 12 s", "1 h 3 min", "8 s". */
export function spokenDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60} s`;
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
}

/** The `.txt`: a header, then one line per segment, `[hh:mm:ss] Speaker 1: text`. */
export function formatTranscript(d: DetailedTranscript, info: { id: string; label: string; durationMs: number; gaps: number[]; chunkMs: number }): string {
  const speakers = new Map<string, string>();
  const name = (sp?: string) => {
    if (!sp) return '';
    if (!speakers.has(sp)) speakers.set(sp, `Speaker ${speakers.size + 1}`);
    return speakers.get(sp)!;
  };
  const lines = [
    `Capture ${info.id}`,
    `Recorded ${info.label}, ${spokenDuration(info.durationMs)}`,
    ...(info.gaps.length ? [`Missing audio (silence): ${info.gaps.map((g) => hms((g * info.chunkMs) / 1000)).join(', ')} (${Math.round(info.chunkMs / 1000)} s each)`] : []),
    '',
  ];
  for (const s of d.segments) {
    const who = name(s.speaker);
    lines.push(`[${hms(s.start)}] ${who ? `${who}: ` : ''}${s.text}`);
  }
  if (!d.segments.length && d.text.trim()) lines.push(d.text.trim());
  return `${lines.join('\n')}\n`;
}

/** The `[capture]` message the agent receives (also echoed to the followed conversation). */
export function captureMessage(r: CaptureResult, startedLabel: string): string {
  const what = r.partial ? 'Partial recording' : 'Recording';
  const parts = [`[capture] ${what} from the Compact saved: ${spokenDuration(r.durationMs)}, started ${startedLabel}.`];
  if (r.txt) parts.push(`Transcript: ${r.txt}`);
  else parts.push(`No transcript (${r.transcript === 'failed' ? `transcription failed${r.error ? `: ${r.error}` : ''}` : r.transcript === 'empty' ? 'nothing intelligible was heard' : 'transcription is off'}).`);
  parts.push(`Audio: ${r.wav}. Details: ${r.json}.`);
  if (r.gaps.length) parts.push(`${r.gaps.length} missing chunk(s) were filled with silence.`);
  if (r.reason !== 'stopped') parts.push(`Stopped by: ${r.reason}.`);
  return parts.join(' ');
}

/** The per-message note the agent sees with a `[capture]` message. */
export const CAPTURE_NOTE = 'This [capture] message was generated by the bus, not typed by Chris: a Capture (long recording) from the Compact has been saved and transcribed. Follow the compact-capture skill.';

/** Local "Thu, Nov 19, 2:03 PM" for a capture's start. */
export function captureStartLabel(ms: number, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(ms));
}

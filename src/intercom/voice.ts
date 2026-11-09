/**
 * E92 (S92.1, S92.4) — push-to-talk audio from a surface.
 *
 * A surface streams raw 16-bit little-endian mono PCM over its socket while the talk button is held:
 *
 *   {"type":"audio_start","client_msg_id","rate":16000}   then binary frames of PCM, then
 *   {"type":"audio_end","client_msg_id"}                  (or {"type":"audio_cancel","client_msg_id"})
 *
 * The bus transcribes the recording and answers with `transcript` frames: interim ones (`final: false`)
 * while the button is still held, then one final frame. A non-empty final transcript goes into the
 * followed conversation exactly like a typed `send` with the same `client_msg_id`, so the usual `ack`
 * follows and the agent's answer arrives as `reply` / `conversation_append` events.
 *
 * Engines: ElevenLabs Scribe (`scribe_v2`, raw 16 kHz PCM), the OpenAI transcription API
 * (`gpt-4o-mini-transcribe`, kept as a fallback until OpenAI retires it on 2027-02-26) or any local command
 * that prints a transcript for a WAV file. Audio is held in memory only and
 * dropped once transcribed. See docs/SURFACE_API.md "Push-to-talk audio".
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IntercomAdapterConfig } from '../config/schema.js';

export type VoiceConfig = IntercomAdapterConfig['voice'];

export interface Transcriber {
  /** Short engine label for logs and message metadata. */
  readonly name: string;
  /** Transcribe a WAV file; resolves to the text (possibly empty). Rejects on failure or abort. */
  transcribe(wav: Buffer, opts: { language: string; signal: AbortSignal }): Promise<string>;
}

/** A RIFF/WAVE header plus the samples: 16-bit little-endian mono PCM at `rate`. */
export function pcmToWav(pcm: Buffer, rate: number): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);            // fmt chunk size
  h.writeUInt16LE(1, 20);             // PCM
  h.writeUInt16LE(1, 22);             // mono
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);      // byte rate
  h.writeUInt16LE(2, 32);             // block align
  h.writeUInt16LE(16, 34);            // bits per sample
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** Loudest absolute sample of 16-bit little-endian PCM. */
export function pcmPeak(pcm: Buffer): number {
  let peak = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    const v = Math.abs(pcm.readInt16LE(i));
    if (v > peak) peak = v;
  }
  return peak;
}

/** The OpenAI `audio/transcriptions` endpoint. */
export class OpenAiTranscriber implements Transcriber {
  readonly name: string;
  constructor(private readonly opts: { apiKey: string; model: string; baseUrl: string; prompt?: string; fetchImpl?: typeof fetch }) {
    this.name = `openai:${opts.model}`;
  }
  async transcribe(wav: Buffer, { language, signal }: { language: string; signal: AbortSignal }): Promise<string> {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'ptt.wav');
    form.append('model', this.opts.model);
    form.append('response_format', 'json');
    if (language) form.append('language', language);
    if (this.opts.prompt) form.append('prompt', this.opts.prompt);
    const res = await (this.opts.fetchImpl ?? fetch)(`${this.opts.baseUrl.replace(/\/+$/, '')}/audio/transcriptions`, {
      method: 'POST', headers: { Authorization: `Bearer ${this.opts.apiKey}` }, body: form, signal,
    });
    if (!res.ok) throw new Error(`transcription HTTP ${res.status}`);
    const j = await res.json() as { text?: unknown };
    return typeof j.text === 'string' ? j.text : '';
  }
}

/**
 * ElevenLabs Scribe (`POST /v1/speech-to-text`). 16 kHz recordings go as raw PCM (`file_format:
 * pcm_s16le_16`, the low-latency path); other rates as the WAV file.
 */
export class ElevenLabsTranscriber implements Transcriber {
  readonly name: string;
  constructor(private readonly opts: { apiKey: string; model: string; baseUrl: string; keyterms?: string[]; fetchImpl?: typeof fetch }) {
    this.name = `elevenlabs:${opts.model}`;
  }
  async transcribe(wav: Buffer, { language, signal }: { language: string; signal: AbortSignal }): Promise<string> {
    const form = new FormData();
    const raw = wav.length >= 44 && wav.toString('ascii', 0, 4) === 'RIFF' && wav.readUInt32LE(24) === 16000 && wav.readUInt16LE(22) === 1;
    const bytes = raw ? wav.subarray(44) : wav;
    form.append('model_id', this.opts.model);
    form.append('file', new Blob([new Uint8Array(bytes)], { type: raw ? 'application/octet-stream' : 'audio/wav' }), raw ? 'ptt.pcm' : 'ptt.wav');
    if (raw) form.append('file_format', 'pcm_s16le_16');
    if (language) form.append('language_code', language);
    form.append('tag_audio_events', 'false');
    for (const k of this.opts.keyterms ?? []) form.append('keyterms', k);
    const res = await (this.opts.fetchImpl ?? fetch)(`${this.opts.baseUrl.replace(/\/+$/, '')}/v1/speech-to-text`, {
      method: 'POST', headers: { 'xi-api-key': this.opts.apiKey }, body: form, signal,
    });
    if (!res.ok) throw new Error(`transcription HTTP ${res.status}`);
    const j = await res.json() as { text?: unknown };
    return typeof j.text === 'string' ? j.text : '';
  }
}

/** A local engine: `argv` with `{wav}` and `{lang}` substituted, run without a shell; stdout is the transcript. */
export class CommandTranscriber implements Transcriber {
  readonly name: string;
  constructor(private readonly argv: string[]) { this.name = `command:${argv[0]}`; }
  async transcribe(wav: Buffer, { language, signal }: { language: string; signal: AbortSignal }): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'agentbus-ptt-'));
    const file = join(dir, 'ptt.wav');
    try {
      await writeFile(file, wav, { mode: 0o600 });
      const args = this.argv.map((a) => a.replaceAll('{wav}', file).replaceAll('{lang}', language));
      return await new Promise<string>((resolve, reject) => {
        execFile(args[0]!, args.slice(1), { signal, maxBuffer: 1 << 20, encoding: 'utf8' }, (err, stdout) => {
          if (err) reject(err); else resolve(stdout);
        });
      });
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => { /* best effort */ });
    }
  }
}

/** Pick the engine from config and env. Null: voice is unavailable (disabled, or no key and no command). */
export function createTranscriber(cfg: VoiceConfig, env: NodeJS.ProcessEnv): Transcriber | null {
  if (!cfg.enabled) return null;
  const key = env[cfg.openai.api_key_env];
  const xi = env[cfg.elevenlabs.api_key_env];
  const eleven = () => new ElevenLabsTranscriber({ apiKey: xi!, model: cfg.elevenlabs.stt_model, baseUrl: cfg.elevenlabs.base_url, keyterms: cfg.elevenlabs.keyterms });
  const openai = () => new OpenAiTranscriber({ apiKey: key!, model: cfg.openai.model, baseUrl: cfg.openai.base_url, ...(cfg.openai.prompt ? { prompt: cfg.openai.prompt } : {}) });
  const command = () => new CommandTranscriber(cfg.command.argv!);
  if (cfg.engine === 'elevenlabs') return xi ? eleven() : null;
  if (cfg.engine === 'openai') return key ? openai() : null;
  if (cfg.engine === 'command') return cfg.command.argv ? command() : null;
  if (xi) return eleven();
  if (key) return openai();
  return cfg.command.argv ? command() : null;
}

/** The socket side of a session: who receives frames, and how the transcript is sent on. */
export interface VoiceClient {
  readonly id: string;
  send(frame: Record<string, unknown>): void;
}

interface Session {
  cmid: string;
  rate: number;
  chunks: Buffer[];
  bytes: number;
  maxBytes: number;
  startedAt: number;
  lastChunkAt: number;
  ended: boolean;
  closed: boolean;
  abort: AbortController;
  idleTimer: NodeJS.Timeout | null;
  partialTimer: NodeJS.Timeout | null;
  partialBusy: boolean;
  partialBytes: number;
}

export interface VoiceDeps<C extends VoiceClient = VoiceClient> {
  config: VoiceConfig;
  transcriber: Transcriber | null;
  /** Send the final transcript on like a typed `send`; resolves to the `ack` frame. */
  submit(client: C, clientMsgId: string, text: string, engine: string): Promise<Record<string, unknown>>;
  now?: () => number;
  log?: (line: string) => void;
}

const CMID_MAX = 100;

/** Per-socket push-to-talk recordings. One open recording per socket; a new `audio_start` replaces it. */
export class VoiceSessions<C extends VoiceClient = VoiceClient> {
  private readonly sessions = new Map<string, Session>();
  constructor(private readonly deps: VoiceDeps<C>) {}

  get available(): boolean { return !!this.deps.transcriber; }
  private now(): number { return this.deps.now?.() ?? Date.now(); }
  private log(line: string): void { (this.deps.log ?? ((l) => console.log(`[intercom] ${l}`)))(line); }

  private result(client: VoiceClient, cmid: string, status: 'ok' | 'empty' | 'failed', extra: Record<string, unknown> = {}): void {
    client.send({ type: 'transcript', client_msg_id: cmid, final: true, status, ...extra });
  }

  /** `audio_start`. Answers `invalid_frame` for a malformed frame. */
  start(client: VoiceClient, frame: Record<string, unknown>): Record<string, unknown> | null {
    const cmid = typeof frame['client_msg_id'] === 'string' ? frame['client_msg_id'] : '';
    const rate = frame['rate'] === undefined ? 16000 : frame['rate'];
    const format = frame['format'] === undefined ? 'pcm_s16le' : frame['format'];
    if (!cmid || cmid.length > CMID_MAX || typeof rate !== 'number' || !Number.isInteger(rate) || rate < 8000 || rate > 48000 || format !== 'pcm_s16le') {
      return { type: 'error', code: 'invalid_frame' };
    }
    this.drop(client.id);
    if (!this.deps.transcriber) { this.result(client, cmid, 'failed', { reason: 'unavailable' }); return null; }
    const s: Session = {
      cmid, rate, chunks: [], bytes: 0, maxBytes: this.deps.config.max_seconds * rate * 2,
      startedAt: this.now(), lastChunkAt: this.now(), ended: false, closed: false, abort: new AbortController(),
      idleTimer: null, partialTimer: null, partialBusy: false, partialBytes: 0,
    };
    this.sessions.set(client.id, s);
    this.armIdle(client, s);
    const every = this.deps.config.partial_interval_ms;
    if (every > 0) { s.partialTimer = setInterval(() => this.partial(client, s), every); s.partialTimer.unref?.(); }
    return null;
  }

  /** A binary frame: PCM for the socket's open recording. Ignored when none is open (e.g. after a cancel). */
  chunk(client: VoiceClient, data: Buffer): void {
    const s = this.sessions.get(client.id);
    if (!s || s.ended || data.length === 0) return;
    s.lastChunkAt = this.now();
    this.armIdle(client, s);
    const room = s.maxBytes - s.bytes;
    if (room <= 0) return;                                   // past max_seconds: the rest is dropped
    const piece = data.length > room ? data.subarray(0, room) : data;
    s.chunks.push(Buffer.from(piece));                       // copy: ws may reuse its buffer
    s.bytes += piece.length;
  }

  /** `audio_cancel`: drop the recording, nothing is sent. */
  cancel(client: VoiceClient, frame: Record<string, unknown>): void {
    const s = this.sessions.get(client.id);
    if (s && s.cmid === frame['client_msg_id']) this.drop(client.id);
  }

  /** `audio_end`: transcribe, answer the final `transcript`, then send the text on and answer its `ack`. */
  async end(client: C, frame: Record<string, unknown>): Promise<void> {
    const cmid = typeof frame['client_msg_id'] === 'string' ? frame['client_msg_id'] : '';
    const s = this.sessions.get(client.id);
    if (!s || s.cmid !== cmid || s.ended) { if (cmid && cmid.length <= CMID_MAX) this.result(client, cmid, 'failed', { reason: 'no_recording' }); return; }
    s.ended = true;
    this.stopTimers(s);
    const pcm = Buffer.concat(s.chunks);
    s.chunks = [];
    const ms = Math.round((pcm.length / 2 / s.rate) * 1000);
    const cfg = this.deps.config;
    if (ms < cfg.min_ms || (cfg.silence_peak > 0 && pcmPeak(pcm) < cfg.silence_peak)) {
      this.finish(client.id, s);
      this.result(client, cmid, 'empty', { duration_ms: ms });
      return;
    }
    const released = this.now();
    let text: string;
    try {
      text = await this.run(s, pcm);
    } catch (err) {
      const aborted = s.closed;
      this.finish(client.id, s);
      if (aborted) return;                                    // cancelled or the socket went away
      this.log(`warn: transcription failed (${this.deps.transcriber?.name}): ${String(err)}`);
      this.result(client, cmid, 'failed', { reason: 'stt_error', duration_ms: ms });
      return;
    }
    if (s.closed) return;
    this.finish(client.id, s);
    text = cleanTranscript(text);
    this.log(JSON.stringify({ evt: 'latency', mark: 'transcript_final', client_msg_id: cmid, ms: this.now() - released, audio_ms: ms, chars: text.length }));
    if (!text) { this.result(client, cmid, 'empty', { duration_ms: ms }); return; }
    this.result(client, cmid, 'ok', { text, duration_ms: ms });
    client.send(await this.deps.submit(client, cmid, text, this.deps.transcriber!.name));
  }

  /** The socket closed: drop its recording. */
  detach(client: VoiceClient): void { this.drop(client.id); }

  /** Drop every recording (bus shutdown). */
  stop(): void { for (const id of [...this.sessions.keys()]) this.drop(id); }

  private run(s: Session, pcm: Buffer): Promise<string> {
    const t = this.deps.transcriber!;
    const timeout = setTimeout(() => s.abort.abort(new Error('timeout')), this.deps.config.timeout_ms);
    return t.transcribe(pcmToWav(pcm, s.rate), { language: this.deps.config.language, signal: s.abort.signal })
      .finally(() => clearTimeout(timeout));
  }

  /** Interim transcript of everything so far, while the button is held. One at a time, only after new audio. */
  private partial(client: VoiceClient, s: Session): void {
    if (s.ended || s.closed || s.partialBusy || s.bytes - s.partialBytes < s.rate * 2 * 0.8) return;
    const t = this.deps.transcriber!;
    s.partialBusy = true;
    s.partialBytes = s.bytes;
    const pcm = Buffer.concat(s.chunks);
    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(), this.deps.config.timeout_ms);
    const onAbort = () => ac.abort();
    s.abort.signal.addEventListener('abort', onAbort, { once: true });
    t.transcribe(pcmToWav(pcm, s.rate), { language: this.deps.config.language, signal: ac.signal })
      .then((text) => {
        const clean = cleanTranscript(text);
        if (clean && !s.ended && !s.closed) client.send({ type: 'transcript', client_msg_id: s.cmid, final: false, text: clean });
      })
      .catch(() => { /* interim only */ })
      .finally(() => { clearTimeout(timeout); s.abort.signal.removeEventListener('abort', onAbort); s.partialBusy = false; });
  }

  private armIdle(client: VoiceClient, s: Session): void {
    if (s.idleTimer) clearTimeout(s.idleTimer);
    s.idleTimer = setTimeout(() => {
      if (s.ended || this.sessions.get(client.id) !== s) return;
      this.drop(client.id);
      this.result(client, s.cmid, 'failed', { reason: 'timeout' });
    }, this.deps.config.idle_timeout_ms);
    s.idleTimer.unref?.();
  }

  private stopTimers(s: Session): void {
    if (s.idleTimer) clearTimeout(s.idleTimer);
    if (s.partialTimer) clearInterval(s.partialTimer);
    s.idleTimer = s.partialTimer = null;
  }

  private finish(id: string, s: Session): void {
    this.stopTimers(s);
    if (this.sessions.get(id) === s) this.sessions.delete(id);
  }

  private drop(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    s.closed = true;
    this.stopTimers(s);
    s.chunks = [];
    s.abort.abort(new Error('cancelled'));
    this.sessions.delete(id);
  }
}

/**
 * Whisper-family models answer noise with stock captions ("[Music]", "Thanks for watching!", "..."). Those
 * alone count as nothing heard (a genuine "Thank you" is kept; silence is caught by `silence_peak`).
 * Otherwise the text is trimmed and its whitespace collapsed.
 */
const HALLUCINATIONS = /^(thanks for watching[.!]?|\.+|…|\[.*\]|\(.*\))$/i;
export function cleanTranscript(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return HALLUCINATIONS.test(t) ? '' : t;
}

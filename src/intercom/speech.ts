/**
 * Spoken replies for push-to-talk (E92 follow-on). When a surface message began as speech, the agent's reply
 * in that interaction is spoken on the device that sent it: ElevenLabs streaming text-to-speech returns raw
 * PCM, which goes down the same socket as
 *
 *   {"type":"speech_start","id","rate":16000,"format":"pcm_s16le","chars"}   binary PCM frames   {"type":"speech_end","id","ms","truncated?"}
 *
 * or `{"type":"speech_cancel","id","reason"}` when it stops early. The agent's `speak` text is spoken
 * (E102), paced to the device, with no policy limits; nothing is spoken to a muted or sleeping device.
 * The device may send `{"type":"speech_stop"}` to end it early. See docs/SURFACE_API.md "Spoken replies".
 */
import { randomUUID } from 'node:crypto';
import type { IntercomAdapterConfig } from '../config/schema.js';
import { stripMarkdown, truncateAtWord } from './glance.js';

type VoiceConfig = IntercomAdapterConfig['voice'];
export type SpeechConfig = VoiceConfig['speech'];

/** Bytes per binary frame: 100 ms at 16 kHz, small enough for the Compact's 4 KB socket buffer. */
export const SPEECH_FRAME_BYTES = 3200;

export interface Synthesizer {
  readonly name: string;
  /** Sample rate of the 16-bit mono PCM `stream` yields. */
  readonly rate: number;
  stream(text: string, opts: { signal: AbortSignal }): AsyncIterable<Uint8Array>;
}

/** ElevenLabs `POST /v1/text-to-speech/{voice_id}/stream` with a raw PCM `output_format`. */
export class ElevenLabsSynthesizer implements Synthesizer {
  readonly name: string;
  readonly rate: number;
  constructor(private readonly opts: {
    apiKey: string; baseUrl: string; model: string; voiceId: string; outputFormat: 'pcm_16000' | 'pcm_22050' | 'pcm_24000';
    voiceSettings?: Record<string, number>; fetchImpl?: typeof fetch;
  }) {
    this.name = `elevenlabs:${opts.model}`;
    this.rate = Number(opts.outputFormat.slice(4));
  }
  async *stream(text: string, { signal }: { signal: AbortSignal }): AsyncIterable<Uint8Array> {
    const url = `${this.opts.baseUrl.replace(/\/+$/, '')}/v1/text-to-speech/${encodeURIComponent(this.opts.voiceId)}/stream?output_format=${this.opts.outputFormat}`;
    const body: Record<string, unknown> = { text, model_id: this.opts.model };
    if (this.opts.voiceSettings && Object.keys(this.opts.voiceSettings).length) body['voice_settings'] = this.opts.voiceSettings;
    const res = await (this.opts.fetchImpl ?? fetch)(url, {
      method: 'POST', headers: { 'xi-api-key': this.opts.apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
    });
    if (!res.ok || !res.body) throw new Error(`speech HTTP ${res.status}`);
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        if (value?.length) yield value;
      }
    } finally {
      reader.releaseLock();
    }
  }
}

/** The ElevenLabs synthesizer when speech is on and its key is set; null otherwise. */
export function createSynthesizer(cfg: VoiceConfig, env: NodeJS.ProcessEnv): Synthesizer | null {
  if (!cfg.enabled || !cfg.speech.enabled) return null;
  const key = env[cfg.elevenlabs.api_key_env];
  if (!key) return null;
  const e = cfg.elevenlabs;
  const settings: Record<string, number> = {};
  if (e.stability !== undefined) settings['stability'] = e.stability;
  if (e.similarity_boost !== undefined) settings['similarity_boost'] = e.similarity_boost;
  if (e.style !== undefined) settings['style'] = e.style;
  if (e.speed !== undefined) settings['speed'] = e.speed;
  return new ElevenLabsSynthesizer({ apiKey: key, baseUrl: e.base_url, model: e.tts_model, voiceId: e.voice_id, outputFormat: e.output_format, voiceSettings: settings });
}

/**
 * What to say for a reply: the plain-text body when it is at most `maxChars`, else the glance line. Markdown,
 * links, emoji and list markers are dropped; never more than `maxChars`.
 */
export function speechText(body: string, glance: string, maxChars: number): string {
  const clean = (s: string) => stripMarkdown(s)
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '')
    .replace(/^\s*•\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  const b = clean(body);
  const text = b && Array.from(b).length <= maxChars ? b : clean(glance);
  return Array.from(text).length > maxChars ? truncateAtWord(text, maxChars) : text;
}

/** ElevenLabs audio tags: `[quickly]`, `[warmly]`, `[short pause]` (not a Markdown link, so not followed by `(`). */
const AUDIO_TAG_RE = /\[[A-Za-z][A-Za-z' -]{0,40}\](?!\()/g;

/** The text with ElevenLabs audio tags removed and spacing tidied: what is shown and recorded. */
export function stripAudioTags(text: string): string {
  return text.replace(AUDIO_TAG_RE, ' ').replace(/\s+([,.;:!?])/g, '$1').replace(/\s+/g, ' ').trim();
}

/**
 * E102 — what an agent's `speak` call says. Markdown, links and emoji are dropped as for replies, but audio
 * tags pass through to the synthesiser untouched. `visible` is the same text without the tags. There is no
 * length cap: long text is split into sequential synthesis requests ({@link splitForTts}).
 */
export function agentSpeechText(text: string): { tts: string; visible: string } | { error: 'empty' } {
  const tts = stripMarkdown(text)
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '')
    .replace(/^\s*•\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  const visible = stripAudioTags(tts);
  return visible ? { tts, visible } : { error: 'empty' };
}

/** Technical per-request ceiling for text-to-speech (ElevenLabs accepts about 5,000 characters per request on its tag-aware models). */
export const TTS_REQUEST_CHARS = 4000;

/** Split `text` into pieces of at most `max` characters at sentence ends (else word ends), so long speech is several requests, not a refusal. */
export function splitForTts(text: string, max = TTS_REQUEST_CHARS): string[] {
  if (Array.from(text).length <= max) return [text];
  const out: string[] = [];
  let cur = '';
  const push = () => { if (cur.trim()) out.push(cur.trim()); cur = ''; };
  const pieces = text.split(/(?<=[.!?…])\s+/u).flatMap((sentence) => {
    if (Array.from(sentence).length <= max) return [sentence];
    const words = sentence.split(/\s+/);
    const chunks: string[] = []; let w = '';
    for (const word of words) {
      const piece = Array.from(word).length > max ? Array.from(word).reduce<string[]>((acc, ch) => { const last = acc[acc.length - 1]; if (last !== undefined && Array.from(last).length < max) acc[acc.length - 1] = last + ch; else acc.push(ch); return acc; }, []) : [word];
      for (const x of piece) { if (w && Array.from(`${w} ${x}`).length > max) { chunks.push(w); w = x; } else w = w ? `${w} ${x}` : x; }
    }
    if (w) chunks.push(w);
    return chunks;
  });
  for (const piece of pieces) {
    if (cur && Array.from(`${cur} ${piece}`).length > max) push();
    cur = cur ? `${cur} ${piece}` : piece;
  }
  push();
  return out;
}

/** Where speech goes: one device socket. */
export interface SpeechTarget {
  readonly id: string;
  send(frame: Record<string, unknown>): void;
  /** False when the socket can no longer take frames. */
  sendBinary(data: Buffer): boolean;
}

interface Active { id: string; abort: AbortController; reason: string | null }

/** Resolves after `ms`, or at once when `signal` aborts. */
const sleep = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve) => {
  if (signal.aborted) { resolve(); return; }
  const t = setTimeout(done, Math.max(0, ms));
  function done() { clearTimeout(t); signal.removeEventListener('abort', done); resolve(); }
  signal.addEventListener('abort', done, { once: true });
});

/**
 * Streams utterances to device sockets, one at a time per socket (a new one cancels the old).
 *
 * Pacing (E102): audio goes down the socket at about real time, never more than `lead_s` ahead of playback
 * (computed from bytes sent and the time since `speech_start`), because the device's jitter buffer holds
 * about 32 s and drops what does not fit. There is no cap on total length. TTS chunks are read as fast as
 * they arrive into memory; only the sending is paced. After `speech_end` the call resolves once the audio
 * has had time to play out, so a queued utterance does not cut the tail off.
 */
export class Speaker {
  private readonly active = new Map<string, Active>();
  constructor(private readonly deps: { config: SpeechConfig; synth: Synthesizer | null; log?: (line: string) => void }) {}

  get available(): boolean { return !!this.deps.synth; }
  private log(line: string): void { (this.deps.log ?? ((l) => console.log(`[intercom] ${l}`)))(line); }

  /** Speak `text` on `target`. Resolves when the utterance ended (and played out), was cancelled or failed. Never throws. */
  async speak(target: SpeechTarget, text: string): Promise<void> {
    const synth = this.deps.synth;
    if (!synth || !text) return;
    this.cancel(target.id, 'replaced');
    const cfg = this.deps.config;
    const a: Active = { id: randomUUID().slice(0, 12), abort: new AbortController(), reason: null };
    this.active.set(target.id, a);
    const bps = synth.rate * 2;
    const leadMs = cfg.lead_s * 1000;
    const stallMs = cfg.stall_timeout_s * 1000;
    const parts = splitForTts(text);
    const started = Date.now();
    let sent = 0, opened = false, t0 = 0;

    // Producer: read synthesis into memory as fast as it arrives; the consumer below paces the sending.
    const chunks: Buffer[] = [];
    let producerDone = false, producerError: unknown = null, lastByteAt = Date.now();
    let wake: (() => void) | null = null;
    const poke = () => { const w = wake; wake = null; w?.(); };
    const producer = (async () => {
      try {
        for (const part of parts) {
          for await (const chunk of synth.stream(part, { signal: a.abort.signal })) {
            if (a.abort.signal.aborted) return;
            chunks.push(Buffer.from(chunk)); lastByteAt = Date.now(); poke();
          }
        }
      } catch (err) { producerError = err; }
      finally { producerDone = true; poke(); }
    })();

    let pending: Buffer = Buffer.alloc(0);
    const take = (): boolean => { if (!chunks.length) return false; pending = Buffer.concat([pending, ...chunks.splice(0)]); return true; };
    try {
      target.send({ type: 'speech_start', id: a.id, rate: synth.rate, format: 'pcm_s16le', chars: Array.from(text).length });
      opened = true; t0 = Date.now();
      for (;;) {
        if (a.abort.signal.aborted) break;
        take();
        const n = pending.length >= SPEECH_FRAME_BYTES ? SPEECH_FRAME_BYTES : producerDone && chunks.length === 0 ? pending.length & ~1 : 0;
        if (n > 0) {
          const aheadMs = ((sent + n) / bps) * 1000 - (Date.now() - t0);
          if (aheadMs > leadMs) { await sleep(aheadMs - leadMs, a.abort.signal); continue; }
          if (!target.sendBinary(pending.subarray(0, n))) { a.reason = 'closed'; break; }
          sent += n; pending = pending.subarray(n);
          continue;
        }
        if (producerDone && chunks.length === 0) break;
        // Starved: wait for more audio, but not for ever.
        const left = stallMs - (Date.now() - lastByteAt);
        if (left <= 0) { a.reason = 'timeout'; break; }
        const timer = setTimeout(poke, left);
        a.abort.signal.addEventListener('abort', poke, { once: true });
        await new Promise<void>((resolve) => { wake = resolve; });
        clearTimeout(timer);
        a.abort.signal.removeEventListener('abort', poke);
      }
      if (a.reason === null && producerError !== null) a.reason = 'tts_error';
      if (a.reason === null && !a.abort.signal.aborted) {
        target.send({ type: 'speech_end', id: a.id, ms: Math.round((sent / bps) * 1000) });
        await sleep((sent / bps) * 1000 - (Date.now() - t0), a.abort.signal);   // let it play out before the next utterance starts
      } else if (a.reason !== null && a.reason !== 'closed' && opened) {
        target.send({ type: 'speech_cancel', id: a.id, reason: a.reason });
      }
      if (a.reason === 'tts_error') this.log(`warn: speech failed (${synth.name}): ${String(producerError)}`);
    } catch (err) {
      if (a.reason === null) a.reason = 'tts_error';
      this.log(`warn: speech failed (${synth.name}): ${String(err)}`);
      if (opened && a.reason !== 'closed') target.send({ type: 'speech_cancel', id: a.id, reason: a.reason });
    } finally {
      a.abort.abort();                                                          /* stop any download still running */
      this.log(JSON.stringify({ evt: 'speech', id: a.id, chars: Array.from(text).length, parts: parts.length, audio_ms: Math.round((sent / bps) * 1000), ms: Date.now() - started, end: a.reason ?? 'done' }));
      if (this.active.get(target.id) === a) this.active.delete(target.id);
    }
  }

  /** Stop what `targetId` is hearing (the device sends nothing more for it). */
  cancel(targetId: string, reason: string): void {
    const a = this.active.get(targetId);
    if (!a) return;
    a.reason = reason;
    a.abort.abort();
    this.active.delete(targetId);
  }

  speaking(targetId: string): boolean { return this.active.has(targetId); }

  stop(): void { for (const id of [...this.active.keys()]) this.cancel(id, 'stopped'); }
}

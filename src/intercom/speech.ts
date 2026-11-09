/**
 * Spoken replies for push-to-talk (E92 follow-on). When a surface message began as speech, the agent's reply
 * in that interaction is spoken on the device that sent it: ElevenLabs streaming text-to-speech returns raw
 * PCM, which goes down the same socket as
 *
 *   {"type":"speech_start","id","rate":16000,"format":"pcm_s16le","chars"}   binary PCM frames   {"type":"speech_end","id","ms","truncated?"}
 *
 * or `{"type":"speech_cancel","id","reason"}` when it stops early. Only the reply's glance (or a short body)
 * is spoken, length and time are bounded, and nothing is spoken in quiet hours or to a muted device.
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
 * tags pass through to the synthesiser untouched. `visible` is the same text without the tags (the length
 * cap counts it). Null `error` text: empty or longer than `maxChars`.
 */
export function agentSpeechText(text: string, maxChars: number): { tts: string; visible: string } | { error: 'empty' | 'too_long'; chars: number } {
  const tts = stripMarkdown(text)
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '')
    .replace(/^\s*•\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  const visible = stripAudioTags(tts);
  const chars = Array.from(visible).length;
  if (!visible) return { error: 'empty', chars: 0 };
  if (chars > maxChars) return { error: 'too_long', chars };
  return { tts, visible };
}

/** Minutes since local midnight in `timeZone`. */
function localMinutes(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0), m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return h * 60 + m;
}
const hhmm = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));

/** True inside the configured quiet hours (start after end wraps midnight; start = end means none). */
export function inQuietHours(cfg: SpeechConfig, at: Date): boolean {
  if (!cfg.quiet_hours.enabled) return false;
  const m = localMinutes(at, cfg.timezone), a = hhmm(cfg.quiet_hours.start), b = hhmm(cfg.quiet_hours.end);
  if (a === b) return false;
  return a < b ? m >= a && m < b : m >= a || m < b;
}

/** Where speech goes: one device socket. */
export interface SpeechTarget {
  readonly id: string;
  send(frame: Record<string, unknown>): void;
  /** False when the socket can no longer take frames. */
  sendBinary(data: Buffer): boolean;
}

interface Active { id: string; abort: AbortController; reason: string | null }

/** Streams utterances to device sockets, one at a time per socket (a new one cancels the old). */
export class Speaker {
  private readonly active = new Map<string, Active>();
  constructor(private readonly deps: { config: SpeechConfig; synth: Synthesizer | null; log?: (line: string) => void }) {}

  get available(): boolean { return !!this.deps.synth; }
  private log(line: string): void { (this.deps.log ?? ((l) => console.log(`[intercom] ${l}`)))(line); }

  /** Speak `text` on `target`. Resolves when the utterance ended, was cancelled or failed. Never throws. */
  async speak(target: SpeechTarget, text: string): Promise<void> {
    const synth = this.deps.synth;
    if (!synth || !text) return;
    this.cancel(target.id, 'replaced');
    const cfg = this.deps.config;
    const a: Active = { id: randomUUID().slice(0, 12), abort: new AbortController(), reason: null };
    this.active.set(target.id, a);
    const timer = setTimeout(() => { a.reason = 'timeout'; a.abort.abort(); }, cfg.timeout_ms);
    const max = cfg.max_seconds * synth.rate * 2;
    const started = Date.now();
    let sent = 0, truncated = false, pending: Buffer = Buffer.alloc(0), opened = false;
    const flush = (all: boolean): boolean => {
      while (pending.length >= SPEECH_FRAME_BYTES || (all && pending.length >= 2)) {
        const n = pending.length >= SPEECH_FRAME_BYTES ? SPEECH_FRAME_BYTES : pending.length & ~1;
        if (!target.sendBinary(pending.subarray(0, n))) { a.reason = 'closed'; return false; }
        sent += n;
        pending = pending.subarray(n);
      }
      return true;
    };
    try {
      target.send({ type: 'speech_start', id: a.id, rate: synth.rate, format: 'pcm_s16le', chars: Array.from(text).length });
      opened = true;
      for await (const chunk of synth.stream(text, { signal: a.abort.signal })) {
        if (a.abort.signal.aborted) break;
        let piece = Buffer.from(chunk);
        if (sent + pending.length + piece.length > max) { piece = piece.subarray(0, Math.max(0, max - sent - pending.length)); truncated = true; }
        pending = pending.length ? Buffer.concat([pending, piece]) : piece;
        if (!flush(false) || truncated) break;
      }
      if (a.reason === null) {
        if (flush(true)) target.send({ type: 'speech_end', id: a.id, ms: Math.round((sent / 2 / synth.rate) * 1000), ...(truncated ? { truncated: true } : {}) });
        if (truncated) a.abort.abort();                       /* stop the download */
      } else if (a.reason !== 'closed') {
        target.send({ type: 'speech_cancel', id: a.id, reason: a.reason });
      }
    } catch (err) {
      if (a.reason === null) a.reason = 'tts_error';
      if (a.reason === 'tts_error') this.log(`warn: speech failed (${synth.name}): ${String(err)}`);
      if (opened && a.reason !== 'closed') target.send({ type: 'speech_cancel', id: a.id, reason: a.reason });
    } finally {
      clearTimeout(timer);
      if (this.active.get(target.id) === a) this.active.delete(target.id);
      this.log(JSON.stringify({ evt: 'speech', id: a.id, chars: Array.from(text).length, audio_ms: Math.round((sent / 2 / synth.rate) * 1000), ms: Date.now() - started, end: a.reason ?? (truncated ? 'truncated' : 'done') }));
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

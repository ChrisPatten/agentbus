/**
 * E90/E91 — the Intercom service: surfaces, the follow engine and the event fan-out.
 *
 * A surface (the iPhone web app, later the Compact) follows ONE existing
 * conversation, normally Chris's Telegram DM with Peggy. The engine
 *
 *  - turns a surface `send` into an inbound message that looks exactly like a
 *    Telegram message from the followed contact in the followed chat (same
 *    contact, channel, topic, conversation, session and pane), plus a silent
 *    Telegram echo that is never routed back as inbound or as an agent reply;
 *  - mirrors the conversation's activity (queued, running, idle, E79 status
 *    text) to the surface whoever started the turn;
 *  - opens an interaction window on a surface send and, while it is open,
 *    turns the agent's outbound messages in that conversation into durable
 *    `reply` events. The window closes `interaction_grace_s` after the agent's
 *    turn ends. Nothing else in the conversation reaches the surface.
 *
 * It is not a registry adapter: it owns no delivery channel. DeliveryWorker
 * calls {@link IntercomService.onDelivered}; the typing, tool-status and
 * turn-ended routes call the `on*` activity hooks.
 */
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { AppConfig, IntercomAdapterConfig, IntercomFollowConfig, NotificationsConfig } from '../config/schema.js';
import { shareContextToConversation } from '../app/context-share.js';
import type { MessageEnvelope } from '../types/envelope.js';
import type { AdapterRegistry } from '../core/registry.js';
import type { InboundAbort, InboundMessage, InboundResult, InboundSystemOptions } from '../http/api.js';
import { computeConversationId } from '../pipeline/conversation-id.js';
import { renderSystemBlock } from '../core/system-block.js';
import { VERSION } from '../version.js';
import { CalendarFeed, type CalendarPayload } from './calendar.js';
import { buildDeparture, buildDeskPayload, createPlanSource, deskSignature, liveState, liveTargets, loadCommute, localDay, officeDay, type LiveView, type CommuteConfig, type CommutePlan, type DeskPayload, type DeskSession } from './desk.js';
import { OnMyWayStore } from './on-my-way.js';
import type { LiveSource, LivePrediction } from './mbta.js';
import { resolveGlance, surfaceBody } from './glance.js';
import { createTranscriber, VoiceSessions, type Transcriber, type VoiceClient } from './voice.js';
import { agentSpeechText, createSynthesizer, inQuietHours, Speaker, speechText, type Synthesizer } from './speech.js';
import {
  acknowledgeNotification, attentionFor, expireDue, getNotification, isTerminal, openForSurface, publicNotification,
  sweepNotifications, targetsSurface, updateNotification, upsertNotification, listNotifications,
  type Notification, type NotifyInputT, type StateFilter, type UpdateInputT, type UpdateResult, type WriteResult,
} from './notifications-store.js';
import { appendEvent, cursorNeedsReset, eventBounds, getSend, putSend, readEvents, sweepEvents, sweepPairCodes, type StoredEvent } from './store.js';
import {
  SURFACE_PROTOCOL_VERSION, type ActionHandler, type ActionResult, type ConversationMessage, type DeltaFrame, type Device, type DeviceStore,
  type ResourceHub, type ResourceName, type ResourceOp,
} from '../surface/types.js';
import { diffOps } from '../surface/resources.js';
import { conversationIdForEnvelope, messageForLiveAppend } from '../surface/conversations.js';

export const PROTOCOL_VERSION = 1;
export const MAX_SEND_CHARS = 4000;

export interface SocketLike { send(data: string): void; close(code?: number, reason?: string): void; readyState: number; ping?(): void }

export interface Surface {
  id: string;
  profile: string;
  follow: { contact: string; channel: string; topic: string | undefined };
  /** Conversation id of the followed (contact, channel, topic), as the pipeline computes it. */
  conversationId: string;
  /** sha256 of the v1 shared token; empty when the surface has none (E96: devices carry their own credentials). */
  tokenHash: string;
  /** E96 — bare agent ids allowed to publish to this surface. */
  publishers: string[];
  /** Spoken replies allowed on this surface (`surfaces[].speech`); absent means allowed. */
  speech?: boolean;
}

export interface Client {
  socket: SocketLike; surface: Surface; ready: boolean; cursor: number; lastPong: number; clientName?: string;
  /** E96 — the paired device behind this socket (absent for v1 surface-token auth without a device store). */
  device?: Device;
  /** 1 (default) or 2. Only v2 clients receive `delta` and `conversation_append` frames. */
  protocol?: number;
  /** E96 — what the device reports it is showing (`view` frame), e.g. `conversation:<id>`. */
  view?: string | null;
  /** E96 — the rev per resource this socket has been brought to; older frames are not sent again. */
  revs?: Partial<Record<ResourceName, number>>;
}

/** E96 — Surface API v2 collaborators. Absent: the service behaves exactly as protocol v1 (shared surface tokens). */
export interface SurfaceApiDeps {
  devices: DeviceStore;
  hub: ResourceHub;
  actions?: ActionHandler;
  /** SHA-256 fingerprint of the surface listener's certificate, for the pairing payload. */
  certFingerprint?: string | null;
  /** Conversations a surface may read (`GET /conversations/:id`, `view`, live appends). Default: only the one it follows. */
  canReadConversation?: (surface: Surface, conversationId: string) => boolean;
}

/** Default faces seeded into an empty `faces` resource. */
const DEFAULT_FACES = ['day', 'status', 'desk'];

export type ActivityState = 'running' | 'queued' | 'idle';
interface Activity { state: ActivityState; status_text: string | null; interaction_id: string | null }

interface Interaction {
  id: string;
  acceptedAt: number;
  firstStatusLogged: boolean;
  firstReplyLogged: boolean;
  closeTimer: NodeJS.Timeout | null;
  /** Spoken replies: the socket that sent this interaction's latest push-to-talk message. Null after a typed send. */
  speak?: {
    to: VoiceSocket; at: number; left: number;
    /** E102: the visible text of the latest `speak` call for this voice message; null until the agent calls it. */
    spoken: string | null;
    /** E102: the pending fallback (auto-speech of the first reply), cancelled by a `speak` call. */
    fallbackTimer: NodeJS.Timeout | null;
    /** E102: the fallback already ran; later replies follow the pre-E102 rule (spoken up to `left`). */
    fallbackRan: boolean;
  } | null;
}

/** E102 — outcome of the agent's `speak` call, as the bus route returns it. */
export type SpeakResult =
  | { ok: true; status: 'spoken' | 'queued'; text: string; interaction_id: string; surface_id: string; echo: string }
  | { ok: true; status: 'skipped'; reason: string }
  | { ok: false; error: string };

interface SurfaceState {
  interaction: Interaction | null;
  activity: Activity;
  staleTimer: NodeJS.Timeout | null;
  quiet: boolean;
  battery: number | null;
}

export interface IntercomDeps {
  config: IntercomAdapterConfig;
  db: Database.Database;
  registry?: Pick<AdapterRegistry, 'lookupPrimaryByChannel'>;
  submitInbound: (message: InboundMessage, system?: InboundSystemOptions) => Promise<InboundResult | InboundAbort>;
  calendar?: CalendarFeed;
  /** E94 — current desk-mode sessions (cc-pool panes). Absent: the desk feed reports none. */
  deskSessions?: () => DeskSession[];
  /** E94 — leave-by timetable; loaded from `adapters.intercom.desk.commute_file` when absent. */
  commute?: CommuteConfig | null;
  /** E94 — office-day plan source; built from `adapters.intercom.desk.plan_file` when absent. */
  plan?: { get(): CommutePlan | null };
  /** Live MBTA predictions for the on-my-way ETA. Absent or null: the scheduled behaviour only. */
  mbta?: LiveSource | null;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  log?: (line: string) => void;
  /** E89 — the `notifications` config block (absent or disabled: no notification features). */
  notifications?: NotificationsConfig;
  /** E89 — the full config, for routing the context carry-over into the followed conversation. */
  appConfig?: AppConfig;
  /** E96 — devices, resources and actions. */
  surfaceApi?: SurfaceApiDeps;
  /** E92 — the speech-to-text engine for push-to-talk. Absent: built from `config.voice` and the env; null: voice unavailable. */
  transcriber?: Transcriber | null;
  /** Spoken replies — the text-to-speech engine. Absent: built from `config.voice` and the env; null: no speech. */
  synthesizer?: Synthesizer | null;
}

/** E92 — a socket as push-to-talk and spoken replies see it. */
export interface VoiceSocket extends VoiceClient {
  surface: Surface;
  /** Raw PCM down the socket; false once it is closed. */
  sendBinary(data: Buffer): boolean;
  /** From the device's `state` frame: `volume: 0` or `speech: false`. */
  muted?: boolean;
  /** From the device's `state` frame: `quiet: true` (the Compact sends it while asleep). */
  asleep?: boolean;
  closed?: boolean;
}

export const normalizeTopic = (topic: string | undefined | null): string => (!topic || topic === 'general' ? 'general' : topic);
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const bareContact = (id: string) => id.replace(/^contact:/, '');

/** The one-line note the agent sees with every surface message. */
export function agentNote(surfaceId: string, withNotify = false): string {
  const base = `Sent from Intercom (${surfaceId}), a small round glance display. Reply as usual with reply(); keep it to 1-3 sentences, lead with the answer, and pass glance: a plain line of at most 100 characters.`;
  return withNotify ? `${base} ${NOTIFY_GUIDANCE}` : base;
}

/** The per-message line for a push-to-talk message (the long style guide is a separate once-per-session block, E102). */
export const VOICE_NOTE = 'Spoken by push-to-talk: the text is a speech transcript and may contain recognition errors. It is answered aloud: call speak(message_id, text) first with the short spoken answer, then reply() for anything longer.';

/** N9 — when to raise a dial notification instead of sending a message. */
export const NOTIFY_GUIDANCE =
  'notify() puts a short-lived "needs you soon" item on the dial (leaving time, a bill due today, a draft awaiting approval, a job finished): give it a key so you can resolve it later. ' +
  'Use reply()/send_message for content. When background work started from an Intercom turn finishes, notify with level "info" (or "attention" if a decision is needed) and a key, and reply the result.';

const WRITE_WINDOW_MS = 60_000;
/** Commute alert buttons that mean "I'm catching this train" (labels on E89 notifications and Events; action ids on Events). */
const ON_MY_WAY_LABEL_RE = /^(on my way|taking it)$/i;
const ON_MY_WAY_ACTION_IDS = new Set(['omw', 'taking']);
const DESK_CHECK_MS = 5_000;

export class IntercomService {
  readonly surfaces = new Map<string, Surface>();
  private readonly byTokenHash = new Map<string, Surface>();
  private readonly clients = new Set<Client>();
  private readonly state = new Map<string, SurfaceState>();
  private readonly sendLocks = new Map<string, Promise<void>>();
  /** E102 — push-to-talk message id -> its surface and interaction, so `speak(message_id)` finds the device. */
  private readonly voiceMessages = new Map<string, { surfaceId: string; interactionId: string }>();
  /** E102 — utterances wait their turn per device socket. */
  private readonly speechChains = new WeakMap<object, Promise<void>>();
  private readonly pairHits = new Map<string, number[]>();
  readonly calendar: CalendarFeed;
  private sweepTimer: NodeJS.Timeout | null = null;
  private calendarTimer: NodeJS.Timeout | null = null;
  private deskTimer: NodeJS.Timeout | null = null;
  private lastDeskSig = '';
  private readonly commute: CommuteConfig | null;
  private readonly plan: { get(): CommutePlan | null };
  private readonly onMyWay: OnMyWayStore;
  private lastCalendarDate = '';
  private readonly writeHits = new Map<string, number[]>();
  /** E92 — push-to-talk recordings per socket. */
  readonly voice: VoiceSessions<VoiceSocket>;
  /** Spoken replies to push-to-talk messages. */
  readonly speaker: Speaker;

  constructor(private readonly deps: IntercomDeps) {
    const env = deps.env ?? process.env;
    this.voice = new VoiceSessions<VoiceSocket>({
      config: deps.config.voice,
      transcriber: deps.transcriber !== undefined ? deps.transcriber : createTranscriber(deps.config.voice, env),
      submit: (c, clientMsgId, text, engine) => this.handleSend(c.surface, { client_msg_id: clientMsgId, body: text }, {
        noteLine: VOICE_NOTE,
        metadata: { input: 'voice', transcript_engine: engine },
        echoIcon: '🎙️',
        speakTo: c,
      }),
      ...(deps.now ? { now: deps.now } : {}),
      log: (l) => this.log(l),
    });
    this.speaker = new Speaker({
      config: deps.config.voice.speech,
      synth: deps.synthesizer !== undefined ? deps.synthesizer : createSynthesizer(deps.config.voice, env),
      log: (l) => this.log(l),
    });
    this.calendar = deps.calendar ?? new CalendarFeed(deps.config.calendar);
    this.commute = deps.commute !== undefined ? deps.commute : loadCommute(deps.config.desk.commute_file, (l) => this.log(l));
    this.plan = deps.plan ?? createPlanSource(deps.config.desk.plan_file, (l) => this.log(l));
    this.onMyWay = new OnMyWayStore(deps.db);
    for (const s of deps.config.surfaces) {
      const token = s.token_env ? env[s.token_env] : undefined;
      const tokenOk = !!token && token.length >= 32;
      // E96: with a device store every configured surface is live (devices carry their own credentials);
      // without one a surface needs its v1 shared token, as before.
      if (!tokenOk && !deps.surfaceApi) {
        this.log(`warn: surface "${s.id}" skipped: env ${s.token_env ?? '(token_env)'} is ${token ? 'shorter than 32 characters' : 'not set'}`);
        continue;
      }
      const follow = { contact: bareContact(s.follow.contact), channel: s.follow.channel, topic: s.follow.topic };
      const surface: Surface = {
        id: s.id, profile: s.profile, follow,
        conversationId: computeConversationId(follow.contact, follow.channel, normalizeTopic(follow.topic)),
        tokenHash: tokenOk ? sha256(token) : '',
        publishers: s.publishers,
        speech: s.speech,
      };
      this.surfaces.set(s.id, surface);
      if (surface.tokenHash) this.byTokenHash.set(surface.tokenHash, surface);
      this.state.set(s.id, { interaction: null, activity: { state: 'idle', status_text: null, interaction_id: null }, staleTimer: null, quiet: false, battery: null });
    }
    if (deps.surfaceApi) {
      deps.surfaceApi.devices.syncFromConfig(deps.config.surfaces.map((s) => ({
        id: s.id, profile: s.profile, max_devices: s.max_devices, ...(s.token_env ? { token_env: s.token_env } : {}),
        follow: { contact: bareContact(s.follow.contact), channel: s.follow.channel, ...(s.follow.topic ? { topic: s.follow.topic } : {}) },
      })), env);
      for (const s of this.surfaces.values()) { this.seedFaces(s.id); this.syncNotices(s); this.resetDeviceLinks(s.id); }
    }
  }

  get surfaceApi(): SurfaceApiDeps | undefined { return this.deps.surfaceApi; }

  /** At startup no socket is open: a `device` item left `connected` by a crash or a late close is cleared. */
  private resetDeviceLinks(surfaceId: string): void {
    const hub = this.deps.surfaceApi!.hub;
    try {
      const ops = Object.entries(hub.snapshot(surfaceId, 'device').items)
        .filter(([, d]) => d['connected'] === true)
        .map(([id]) => ({ op: 'patch' as const, id, value: { connected: false } }));
      if (ops.length) hub.apply(surfaceId, 'device', ops);
    } catch (err) { this.log(`warn: device link reset failed for ${surfaceId}: ${String(err)}`); }
  }

  private seedFaces(surfaceId: string): void {
    const hub = this.deps.surfaceApi!.hub;
    try {
      if (Object.keys(hub.snapshot(surfaceId, 'faces').items).length > 0) return;
      hub.apply(surfaceId, 'faces', DEFAULT_FACES.map((id, order) => ({ op: 'set' as const, id, value: { id, order, enabled: true } })));
    } catch (err) { this.log(`warn: faces seed failed for ${surfaceId}: ${String(err)}`); }
  }

  private now(): number { return this.deps.now?.() ?? Date.now(); }
  private log(line: string): void { (this.deps.log ?? ((l) => console.log(`[intercom] ${l}`)))(line); }
  private mark(surface: Surface, interaction: Interaction, mark: string): void {
    this.log(JSON.stringify({ evt: 'latency', mark, surface_id: surface.id, interaction_id: interaction.id, ms: this.now() - interaction.acceptedAt }));
  }

  private started = false;

  start(): void {
    // Idempotent: the main port and the surface listener (E96) both mount the routes that start it.
    if (this.started) return;
    this.started = true;
    const sweep = () => {
      try {
        sweepEvents(this.deps.db, this.deps.config.event_retention_days);
        sweepPairCodes(this.deps.db);
      } catch (err) { this.log(`warn: sweep failed: ${String(err)}`); }
    };
    sweep();
    this.notificationTick();
    this.sweepTimer = setInterval(sweep, 60 * 60 * 1000);
    this.sweepTimer.unref();
    // Push the calendar every 5 minutes and at a date change.
    this.calendarTimer = setInterval(() => { void this.pushCalendar(); this.notificationTick(); }, 60_000);
    this.calendarTimer.unref();
    // E94 — desk summary: checked every 5 s, pushed only when it changed, so never more than one per 5 s.
    this.deskTimer = setInterval(() => { void this.pushDesk(); this.surfaceTick(); }, DESK_CHECK_MS);
    this.deskTimer.unref();
  }

  /** E96 — collaborators that keep computed resources (sessions, approvals, notices) in sync; run on the 5 s tick. */
  private readonly tickHooks: (() => void)[] = [];
  onSurfaceTick(fn: () => void): void { this.tickHooks.push(fn); }

  /** Runs the revocation check and the tick hooks now (also called every 5 s once started). */
  surfaceTick(): void {
    const api = this.deps.surfaceApi;
    if (!api) return;
    // A device revoked from the CLI (another process) loses its sockets within one tick.
    for (const c of [...this.clients]) {
      if (!c.device) continue;
      const d = api.devices.get(c.device.id);
      if (!d || d.revoked_at) this.closeClient(c, 4403, 'revoked');
    }
    for (const fn of this.tickHooks) { try { fn(); } catch (err) { this.log(`warn: surface tick failed: ${String(err)}`); } }
  }

  stop(): void {
    this.started = false;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.calendarTimer) clearInterval(this.calendarTimer);
    if (this.deskTimer) clearInterval(this.deskTimer);
    for (const st of this.state.values()) {
      if (st.staleTimer) clearTimeout(st.staleTimer);
      if (st.interaction?.closeTimer) clearTimeout(st.interaction.closeTimer);
      if (st.interaction?.speak?.fallbackTimer) clearTimeout(st.interaction.speak.fallbackTimer);
    }
    this.sweepTimer = this.calendarTimer = this.deskTimer = null;
    this.voice.stop();
    this.speaker.stop();
  }

  // ── Auth ─────────────────────────────────────────────────────────────────

  /** E96 — resolve a credential: a paired device (when the device store is on), else a v1 surface token. */
  authenticate(token: string | undefined): { surface: Surface; device?: Device } | null {
    if (!token) return null;
    const api = this.deps.surfaceApi;
    if (api) {
      const device = api.devices.authenticate(token);
      const surface = device ? this.surfaces.get(device.surface_id) : undefined;
      return device && surface ? { surface, device } : null;
    }
    const surface = this.surfaceForToken(token);
    return surface ? { surface } : null;
  }

  surfaceForToken(token: string | undefined): Surface | null {
    if (!token) return null;
    if (this.deps.surfaceApi) return this.authenticate(token)?.surface ?? null;
    const hash = sha256(token);
    const found = this.byTokenHash.get(hash);
    if (!found) return null;
    return timingSafeEqual(Buffer.from(found.tokenHash), Buffer.from(hash)) ? found : null;
  }

  /** Sliding-window limit on pairing attempts per remote address. */
  pairAllowed(remote: string): boolean {
    const now = this.now();
    const hits = (this.pairHits.get(remote) ?? []).filter((t) => now - t < 60_000);
    if (hits.length >= this.deps.config.pair_rate_limit_per_min) { this.pairHits.set(remote, hits); return false; }
    hits.push(now);
    this.pairHits.set(remote, hits);
    if (this.pairHits.size > 1000) for (const [k, v] of this.pairHits) if (v.every((t) => now - t >= 60_000)) this.pairHits.delete(k);
    return true;
  }

  tokenFor(surfaceId: string): string | null {
    const s = this.deps.config.surfaces.find((x) => x.id === surfaceId);
    return s?.token_env ? (this.deps.env ?? process.env)[s.token_env] ?? null : null;
  }

  connectedClients(surfaceId: string): number {
    let n = 0;
    for (const c of this.clients) if (c.surface.id === surfaceId && c.ready) n++;
    return n;
  }

  health(surface: Surface, device?: Device) {
    return {
      ok: true, surface_id: surface.id,
      follow: this.followJson(surface), version: VERSION,
      connected_clients: this.connectedClients(surface.id),
      ...(device ? { device_id: device.id, scope: device.scope, protocol: SURFACE_PROTOCOL_VERSION } : {}),
    };
  }

  followJson(surface: Surface): { contact: string; channel: string; topic?: string; conversation_id: string } {
    return { contact: surface.follow.contact, channel: surface.follow.channel, ...(surface.follow.topic ? { topic: surface.follow.topic } : {}), conversation_id: surface.conversationId };
  }

  // ── Sockets ──────────────────────────────────────────────────────────────

  private raw(socket: SocketLike, frame: Record<string, unknown>): void {
    try { if (socket.readyState === 1) socket.send(JSON.stringify(frame)); } catch { /* the client catches up from its cursor */ }
  }
  sendFrame(client: Client, frame: Record<string, unknown>): void { this.raw(client.socket, frame); }

  /** Complete the handshake: welcome, replay, then the activity snapshot and calendar. */
  async attach(client: Client, cursor: number, clientName?: string, revs?: Partial<Record<ResourceName, number>>): Promise<void> {
    const surface = client.surface;
    const { latest } = eventBounds(this.deps.db, surface.id);
    const reset = cursorNeedsReset(this.deps.db, surface.id, cursor);
    client.cursor = reset ? latest : cursor;
    if (clientName) client.clientName = clientName;
    const api = this.deps.surfaceApi;
    const v2 = client.protocol === SURFACE_PROTOCOL_VERSION && !!api;
    // Attach-time writes happen first, then pending coalesced deltas go to the other sockets, so no
    // frame is in flight across this resume and this socket sees nothing before its resume frames.
    if (client.device) this.markDevice(client, { connected: true });
    if (v2) api.hub.flush();
    this.clients.add(client);
    this.raw(client.socket, {
      type: 'welcome', version: v2 ? SURFACE_PROTOCOL_VERSION : PROTOCOL_VERSION, surface_id: surface.id, follow: this.followJson(surface),
      latest_seq: latest, reset, server_time: new Date(this.now()).toISOString(),
      ...(v2 ? { device_id: client.device?.id ?? null, scope: client.device?.scope ?? 'interactive', revs: api.hub.revs(surface.id) } : {}),
    });
    if (!reset) this.replay(client);
    // v2: bring each resource up to date (nothing, one coalesced delta, or a reset) before live deltas flow.
    if (v2) {
      client.revs = { ...(revs ?? {}) };
      for (const frame of api.hub.resume(surface.id, revs ?? {})) this.sendDelta(client, frame);
      client.revs = api.hub.revs(surface.id);
    }
    client.ready = true;
    const st = this.state.get(surface.id)!;
    this.raw(client.socket, { type: 'event', event: 'activity', data: st.activity });
    if (st.interaction) this.raw(client.socket, { type: 'event', event: 'interaction', data: { interaction_id: st.interaction.id, state: 'open' } });
    if (this.notificationsOn) {
      // A fresh client gets the full open set without replaying days of history, then the attention summary.
      try {
        for (const n of openForSurface(this.deps.db, surface.id)) this.raw(client.socket, { type: 'event', event: 'notification', data: publicNotification(n) });
        this.raw(client.socket, { type: 'event', event: 'attention', data: attentionFor(this.deps.db, surface.id) });
      } catch (err) { this.log(`warn: notification snapshot failed: ${String(err)}`); }
    }
    try {
      const cal = await this.calendar.today();
      this.lastCalendarDate = cal.date;
      this.lastCalendarPush = this.now();
      this.raw(client.socket, { type: 'event', event: 'calendar', data: cal });
    } catch (err) {
      this.log(`warn: calendar unavailable: ${String(err)}`);
    }
    try { this.raw(client.socket, { type: 'event', event: 'desk', data: await this.desk() }); }
    catch (err) { this.log(`warn: desk snapshot failed: ${String(err)}`); }
  }

  /** E94 — the desk summary (agent sessions, counts, next departure). Read-only; no message text. */
  async desk(now: Date = new Date(this.now())): Promise<DeskPayload> {
    const plan = this.plan.get();
    const tz = this.deps.config.calendar.timezone;
    const date = localDay(now, tz).date;
    const cfg = this.deps.config.desk.mbta;
    const flagged = this.onMyWay.active(date, now.getTime(), cfg.on_my_way_timeout_min);
    const live = await this.liveView(now, plan, flagged);
    for (const t of liveTargets({ now, commute: this.commute, plan, onMyWay: flagged })) {
      if (flagged.has(t.number) && liveState(t.schedMs, live?.get(t.number), now.getTime()) === 'departed') { this.onMyWay.clear(date, t.number); flagged.delete(t.number); }
    }
    return buildDeskPayload({
      now, sessions: this.deps.deskSessions?.() ?? [],
      departure: buildDeparture({ now, commute: this.commute, plan, live, onMyWay: flagged }),
    });
  }

  /** Live predictions for the trains near their departure (or flagged). Null when disabled; an unreachable stop leaves its trains out (unknown). */
  private async liveView(now: Date, plan: CommutePlan | null, flagged: ReadonlySet<string>): Promise<LiveView | null> {
    const src = this.deps.mbta;
    if (!src) return null;
    const targets = liveTargets({ now, commute: this.commute, plan, onMyWay: flagged });
    if (!targets.length) return null;
    const cfg = this.deps.config.desk.mbta;
    const out = new Map<string, LivePrediction | null>();
    for (const side of ['am', 'pm'] as const) {
      const mine = targets.filter((t) => t.side === side);
      if (!mine.length) continue;
      const got = await src.get({ stop: side === 'am' ? cfg.am_stop : cfg.pm_stop, direction: side === 'am' ? 1 : 0 });
      if (got) for (const t of mine) out.set(t.number, got.get(t.number) ?? null);
    }
    return out;
  }

  /** The Commute notification's "On my way" / "Taking it" tap (E89 path): flag that train so the face shows its live ETA. */
  private noteOnMyWay(n: { key: string | null; source: string }, label: string): void {
    if (!ON_MY_WAY_LABEL_RE.test(label.trim()) || n.source.toLowerCase() !== 'commute') return;
    const m = /^commute-(?:am|pm-(\d+))$/.exec(n.key ?? '');
    if (!m) return;
    this.noteOnMyWayTrain(m[1] ?? null);
  }

  /**
   * The commute watcher's urgent Event (Surface v2) fired a button: `commute-am-<date>` with `omw`, or
   * `commute-pm-<date>-<train>` with `taking` (or the "On my way" / "Taking it" label). Flags the train like
   * the notification tap. A tap on another day's Event (local date in the calendar timezone) is ignored.
   */
  noteEventFired(info: { eventId: string; actionId: string; label: string }): void {
    if (!ON_MY_WAY_ACTION_IDS.has(info.actionId) && !ON_MY_WAY_LABEL_RE.test(info.label.trim())) return;
    const m = /^commute-(?:am-(\d{4}-\d{2}-\d{2})|pm-(\d{4}-\d{2}-\d{2})-(\d+))$/.exec(info.eventId);
    if (!m) return;
    const date = m[1] ?? m[2];
    const today = localDay(new Date(this.now()), this.deps.config.calendar.timezone).date;
    if (date !== today) { this.log(`intercom: on my way ignored for event ${info.eventId} (not today, ${today})`); return; }
    this.noteOnMyWayTrain(m[3] ?? null);
  }

  /** Flag `train` (null = today's office-day AM train) as on my way for today, then push the desk. */
  private noteOnMyWayTrain(train: string | null): void {
    const now = new Date(this.now());
    const tz = this.deps.config.calendar.timezone;
    const number = train ?? (this.commute ? officeDay(this.commute, this.plan.get(), now)?.am : null);
    if (!number) return;
    this.onMyWay.set(localDay(now, tz).date, number, now.getTime());
    this.log(`intercom: on my way flagged for train ${number}`);
    void this.pushDesk();
  }

  private async pushDesk(): Promise<void> {
    let ready = false;
    for (const c of this.clients) if (c.ready) { ready = true; break; }
    if (!ready) return;
    try {
      const payload = await this.desk();
      const sig = deskSignature(payload);
      if (sig === this.lastDeskSig) return;
      this.lastDeskSig = sig;
      for (const c of this.clients) if (c.ready) this.raw(c.socket, { type: 'event', event: 'desk', data: payload });
    } catch (err) { this.log(`warn: desk push failed: ${String(err)}`); }
  }

  detach(client: Client): void {
    if (!this.clients.delete(client)) return;
    if (client.device && ![...this.clients].some((c) => c.device?.id === client.device!.id)) this.markDevice(client, { connected: false });
  }

  // ── Surface API v2 (E96) ─────────────────────────────────────────────────

  /** Resource hub sink: push a delta to the surface's ready v2 sockets. */
  pushDelta(surfaceId: string, frame: DeltaFrame): void {
    for (const c of this.clients) {
      if (c.surface.id === surfaceId && c.ready && c.protocol === SURFACE_PROTOCOL_VERSION) this.sendDelta(c, frame);
    }
  }

  /** Send unless the socket already has this rev (a frame coalesced before its resume). */
  private sendDelta(client: Client, frame: DeltaFrame): void {
    const known = client.revs?.[frame.resource];
    if (known !== undefined && frame.rev <= known) return;
    if (known !== undefined && !('reset' in frame) && frame.base_rev !== known && this.deps.surfaceApi) {
      // Coalesced across this socket's rev: send what it actually lacks instead.
      for (const f of this.deps.surfaceApi.hub.resume(client.surface.id, { [frame.resource]: known })) this.raw(client.socket, f as unknown as Record<string, unknown>);
    } else {
      this.raw(client.socket, frame as unknown as Record<string, unknown>);
    }
    (client.revs ??= {})[frame.resource] = frame.rev;
  }

  /** Apply ops to a resource; errors are logged, never thrown (computed resources sync on the next tick). */
  applyResource(surfaceId: string, resource: ResourceName, ops: ResourceOp[]): void {
    if (!this.deps.surfaceApi || ops.length === 0) return;
    try { this.deps.surfaceApi.hub.apply(surfaceId, resource, ops); }
    catch (err) { this.log(`warn: ${resource} update failed for ${surfaceId}: ${String(err)}`); }
  }

  private closeClient(client: Client, code: number, reason: string): void {
    this.detach(client);
    try { client.socket.close(code, reason); } catch { /* already closing */ }
  }

  /** Close every socket of a device (revocation). Returns how many were closed. */
  closeDevice(deviceId: string): number {
    let n = 0;
    for (const c of [...this.clients]) if (c.device?.id === deviceId) { this.closeClient(c, 4403, 'revoked'); n++; }
    return n;
  }

  /** Update the device's item in the `device` resource (link state, battery, quiet, view). */
  private markDevice(client: Client, patch: Record<string, unknown>): void {
    const api = this.deps.surfaceApi;
    const d = client.device;
    if (!api || !d) return;
    const nowIso = new Date(this.now()).toISOString();
    // Best effort: also runs from socket close handlers, possibly during shutdown.
    try {
      api.devices.touch(d.id);
      const existing = api.hub.get(client.surface.id, 'device', d.id);
      const value = existing
        ? { ...patch, last_seen_at: nowIso }
        : { id: d.id, name: d.name, profile: d.profile, scope: d.scope, connected: false, last_seen_at: nowIso, battery: null, quiet: false, view: null, ...patch };
      this.applyResource(client.surface.id, 'device', [{ op: existing ? 'patch' : 'set', id: d.id, value }]);
    } catch (err) { this.log(`warn: device state update failed: ${String(err)}`); }
  }

  /** E96 S96.7 — may this surface read that conversation (transcript page, live appends)? */
  canReadConversation(surface: Surface, conversationId: string): boolean {
    const check = this.deps.surfaceApi?.canReadConversation;
    return check ? check(surface, conversationId) : conversationId === surface.conversationId;
  }

  /**
   * `{"type":"view","view":"conversation:<id>"|null}`. A conversation the surface may not read is
   * refused (the view is cleared), so live appends never reach a device that could not page it.
   */
  setView(client: Client, view: unknown): boolean {
    let next = typeof view === 'string' && view.length <= 200 ? view : null;
    let ok = true;
    if (next?.startsWith('conversation:') && !this.canReadConversation(client.surface, next.slice('conversation:'.length))) { next = null; ok = false; }
    client.view = next;
    this.markDevice(client, { view: client.view });
    return ok;
  }

  /** `{"type":"action",...}` frame and `POST /api/v1/surface/actions`. */
  async handleAction(surface: Surface, device: Device | undefined, request: unknown): Promise<ActionResult> {
    const key = typeof (request as { idempotency_key?: unknown })?.idempotency_key === 'string' ? (request as { idempotency_key: string }).idempotency_key : '';
    const actions = this.deps.surfaceApi?.actions;
    if (!actions || !device || device.surface_id !== surface.id) return { type: 'action_result', idempotency_key: key, status: 'failed', reason: 'invalid' };
    return actions.handle(device, request);
  }

  /** E96 S96.7 — push a transcript line to v2 devices viewing that conversation. */
  appendConversation(conversationId: string, message: ConversationMessage): void {
    const view = `conversation:${conversationId}`;
    for (const c of this.clients) {
      if (c.ready && c.protocol === SURFACE_PROTOCOL_VERSION && c.view === view && this.canReadConversation(c.surface, conversationId)) {
        this.raw(c.socket, { type: 'event', event: 'conversation_append', data: { conversation_id: conversationId, message } });
      }
    }
  }

  /** E96 S96.7 — a delivered or accepted message, appended live for devices viewing its conversation. Never throws. */
  liveAppend(envelope: MessageEnvelope, conversationId?: string | null): void {
    if (!this.deps.surfaceApi || this.clients.size === 0) return;
    try {
      const id = conversationId ?? conversationIdForEnvelope(envelope);
      if (!id || !this.isViewed(id)) return;
      const message = messageForLiveAppend(envelope, this.deps.db, new Date(this.now()));
      if (message) this.appendConversation(id, message);
    } catch (err) { this.log(`warn: live append failed: ${String(err)}`); }
  }

  /** True when some v2 device is viewing this conversation (cheap check before building a message). */
  isViewed(conversationId: string): boolean {
    const view = `conversation:${conversationId}`;
    for (const c of this.clients) if (c.ready && c.view === view) return true;
    return false;
  }

  private replay(client: Client): void {
    for (;;) {
      const batch = readEvents(this.deps.db, client.surface.id, client.cursor, 500);
      for (const e of batch) this.pushStored(client, e);
      if (batch.length < 500) return;
    }
  }

  private pushStored(client: Client, e: StoredEvent): void {
    if (e.seq <= client.cursor) return;
    client.cursor = e.seq;
    this.raw(client.socket, { type: 'event', event: e.event, seq: e.seq, data: e.data });
  }

  /** Append a durable event and push it to the surface's ready sockets. */
  private emitDurable(surface: Surface, event: string, data: Record<string, unknown>): number {
    const seq = appendEvent(this.deps.db, surface.id, event, data);
    for (const c of this.clients) {
      if (c.surface.id !== surface.id || !c.ready) continue;
      c.cursor = Math.max(c.cursor, seq);
      this.raw(c.socket, { type: 'event', event, seq, data });
    }
    return seq;
  }

  private emitEphemeral(surface: Surface, event: string, data: unknown): void {
    for (const c of this.clients) if (c.surface.id === surface.id && c.ready) this.raw(c.socket, { type: 'event', event, data });
  }

  private async pushCalendar(): Promise<void> {
    if (this.clients.size === 0) return;
    try {
      const cal = await this.calendar.today();
      const fresh = cal.date !== this.lastCalendarDate || this.calendarDue();
      if (!fresh) return;
      this.lastCalendarDate = cal.date;
      this.lastCalendarPush = this.now();
      for (const c of this.clients) if (c.ready) this.raw(c.socket, { type: 'event', event: 'calendar', data: cal as CalendarPayload });
    } catch (err) { this.log(`warn: calendar push failed: ${String(err)}`); }
  }
  private lastCalendarPush = 0;
  private calendarDue(): boolean { return this.now() - this.lastCalendarPush >= 5 * 60_000; }

  setSurfaceState(surface: Surface, frame: { quiet?: unknown; battery?: unknown }, client?: Client): void {
    const st = this.state.get(surface.id)!;
    st.quiet = frame.quiet === true;
    st.battery = typeof frame.battery === 'number' ? frame.battery : null;
    this.log(JSON.stringify({ evt: 'surface_state', surface_id: surface.id, ...(client?.device ? { device_id: client.device.id } : {}), quiet: st.quiet, battery: st.battery }));
    if (client) this.markDevice(client, { quiet: st.quiet, battery: st.battery });
  }

  // ── Follow matching ──────────────────────────────────────────────────────

  private matches(surface: Surface, channel: string | undefined, topic: string | undefined | null, contactId?: string | null): boolean {
    if (channel !== surface.follow.channel) return false;
    if (normalizeTopic(topic) !== normalizeTopic(surface.follow.topic)) return false;
    if (contactId && bareContact(contactId) !== surface.follow.contact) return false;
    return true;
  }

  // ── Interaction window and activity ──────────────────────────────────────

  private setActivity(surface: Surface, next: Partial<Activity>): void {
    const st = this.state.get(surface.id)!;
    const merged: Activity = { ...st.activity, ...next };
    if (merged.state === 'idle') merged.status_text = null;
    const same = merged.state === st.activity.state && merged.status_text === st.activity.status_text && merged.interaction_id === st.activity.interaction_id;
    st.activity = merged;
    if (!same) this.emitEphemeral(surface, 'activity', merged);
    if (st.staleTimer) clearTimeout(st.staleTimer);
    st.staleTimer = null;
    if (merged.state !== 'idle') {
      st.staleTimer = setTimeout(() => this.noteTurnEnded(surface, 'stale'), this.deps.config.activity_stale_s * 1000);
      st.staleTimer.unref();
    }
  }

  private openInteraction(surface: Surface): Interaction {
    const st = this.state.get(surface.id)!;
    if (st.interaction) {
      if (st.interaction.closeTimer) clearTimeout(st.interaction.closeTimer);
      st.interaction.closeTimer = null;
      return st.interaction;
    }
    const interaction: Interaction = { id: randomUUID(), acceptedAt: this.now(), firstStatusLogged: false, firstReplyLogged: false, closeTimer: null };
    st.interaction = interaction;
    this.emitEphemeral(surface, 'interaction', { interaction_id: interaction.id, state: 'open' });
    return interaction;
  }

  private closeInteraction(surface: Surface, id?: string): void {
    const st = this.state.get(surface.id)!;
    const i = st.interaction;
    if (!i || (id && i.id !== id)) return;
    if (i.closeTimer) clearTimeout(i.closeTimer);
    if (i.speak?.fallbackTimer) clearTimeout(i.speak.fallbackTimer);
    st.interaction = null;
    this.emitEphemeral(surface, 'interaction', { interaction_id: i.id, state: 'closed' });
    if (st.activity.interaction_id === i.id) this.setActivity(surface, { interaction_id: null });
  }

  /** The followed conversation shows signs of a running turn. `text` is the E79 status line, when there is one. */
  private noteRunning(surface: Surface, text: string | null): void {
    const st = this.state.get(surface.id)!;
    const i = st.interaction;
    if (i) {
      if (i.closeTimer) { clearTimeout(i.closeTimer); i.closeTimer = null; }
      if (!i.firstStatusLogged && text) { i.firstStatusLogged = true; this.mark(surface, i, 'first_status'); }
    }
    this.setActivity(surface, {
      state: 'running',
      status_text: text ?? (st.activity.state === 'running' ? st.activity.status_text : null),
      interaction_id: i?.id ?? null,
    });
  }

  /** The turn ended: idle now; the window closes after the grace period. */
  noteTurnEnded(surface: Surface, why = 'turn-ended'): void {
    const st = this.state.get(surface.id)!;
    this.setActivity(surface, { state: 'idle', status_text: null });
    const i = st.interaction;
    if (!i) return;
    if (i.closeTimer) clearTimeout(i.closeTimer);
    const grace = this.deps.config.interaction_grace_s * 1000;
    if (grace === 0) { this.closeInteraction(surface, i.id); return; }
    i.closeTimer = setTimeout(() => this.closeInteraction(surface, i.id), grace);
    i.closeTimer.unref();
    this.log(JSON.stringify({ evt: 'window_closing', surface_id: surface.id, interaction_id: i.id, why, grace_s: grace / 1000 }));
  }

  // ── Activity hooks (called from the HTTP layer) ──────────────────────────

  /** `/api/v1/adapters/:id/typing` */
  onTyping(input: { channel: string; contactId?: string | null; topic?: string | null; conversationId?: string | null }): void {
    try { for (const s of this.followersOf(input)) this.noteRunning(s, null); } catch (err) { console.error(`[intercom] onTyping failed: ${String(err)}`); }
  }

  /** `/api/v1/adapters/:id/tool-status` */
  onToolStatus(input: { channel: string; contactId?: string | null; topic?: string | null; conversationId?: string | null; text: string }): void {
    try { for (const s of this.followersOf(input)) this.noteRunning(s, input.text.trim().slice(0, 80) || null); } catch (err) { console.error(`[intercom] onToolStatus failed: ${String(err)}`); }
  }

  /** A turn ended in this conversation (Stop hook). */
  onTurnEnded(conversationId: string | null | undefined): void {
    if (!conversationId) return;
    try { for (const s of this.surfaces.values()) if (s.conversationId === conversationId) this.noteTurnEnded(s); } catch (err) { console.error(`[intercom] onTurnEnded failed: ${String(err)}`); }
  }

  private followersOf(input: { channel: string; contactId?: string | null; topic?: string | null; conversationId?: string | null }): Surface[] {
    const out: Surface[] = [];
    for (const s of this.surfaces.values()) {
      if (input.conversationId ? input.conversationId === s.conversationId : this.matches(s, input.channel, input.topic, input.contactId)) out.push(s);
    }
    return out;
  }

  // ── Agent outbound → reply events ────────────────────────────────────────

  /** DeliveryWorker hook: an outbound message was delivered. Never throws. */
  onDelivered(envelope: MessageEnvelope): void {
    this.liveAppend(envelope);
    try {
      if (this.surfaces.size === 0) return;
      const meta = envelope.metadata ?? {};
      if (!envelope.sender.startsWith('agent:')) return;                       // bus notices, command replies, echoes
      if (meta['intercom_echo'] === true || meta['system_only'] === true || meta['context_only'] === true || meta['bus_notice'] === true) return;
      if (envelope.payload.type !== 'text') return;
      if (meta['intercom_spoken'] === true) return;                              // E102: the record of a `speak` call; the device was already shown it
      for (const s of this.surfaces.values()) {
        if (!this.matches(s, envelope.channel, envelope.topic, envelope.recipient)) continue;
        const st = this.state.get(s.id)!;
        const i = st.interaction;
        if (!i) continue;                                                       // out of window: not delivered to the surface
        const body = envelope.payload.body;
        const { text, cut } = surfaceBody(body);
        const tsend = meta['telegram_send'] as { kind?: unknown } | undefined;
        const hasAttachments = !!tsend && (tsend.kind === 'document' || tsend.kind === 'photo');
        const hasChoices = meta['choices'] !== undefined && meta['choices'] !== null;
        const moreOnTelegram = hasAttachments || !!tsend || hasChoices || cut;
        if (!i.firstReplyLogged) { i.firstReplyLogged = true; this.mark(s, i, 'first_reply'); }
        const glance = resolveGlance(meta['glance'], body);
        // E102: once the agent has `speak`-ed in this interaction, that is the device's answer; a later reply
        // goes to the Thread and Telegram, and its `reply` event keeps the spoken text so Understood is not overwritten.
        const spokenAnswer = i.speak?.spoken ?? null;
        this.emitDurable(s, 'reply', {
          message_id: envelope.id, interaction_id: i.id,
          glance: spokenAnswer ? resolveGlance(null, spokenAnswer) : glance,
          body: spokenAnswer ?? text,
          has_attachments: hasAttachments, more_on_telegram: spokenAnswer ? true : moreOnTelegram,
          ...(spokenAnswer ? { spoken: true } : {}),
          created_at: new Date(this.now()).toISOString(),
        });
        this.replySpeech(s, i, body, glance);
      }
    } catch (err) {
      this.log(`warn: onDelivered failed: ${String(err)}`);
    }
  }

  /** Why a reply in this interaction would not be spoken, or null when it will be. */
  speechBlocked(surface: Surface, i: Interaction): string | null {
    const cfg = this.deps.config.voice.speech;
    const sp = i.speak;
    if (!sp) return 'not_voice';
    if (!cfg.enabled || !this.speaker.available) return 'off';
    if (surface.speech === false) return 'surface_off';
    if (sp.left <= 0) return 'enough';
    if (this.now() - sp.at > cfg.reply_window_s * 1000) return 'late';
    if (sp.to.closed) return 'gone';
    if (sp.to.muted) return 'muted';
    if (sp.to.asleep) return 'asleep';
    if (inQuietHours(cfg, new Date(this.now()))) return 'quiet_hours';
    return null;
  }

  /** One utterance at a time per device: a new one waits for the one playing. Returns true when it had to wait. */
  private enqueueSpeech(target: VoiceSocket, text: string): boolean {
    const prev = this.speechChains.get(target);
    const busy = !!prev || this.speaker.speaking(target.id);
    const run = (prev ?? Promise.resolve()).then(() => (target.closed ? undefined : this.speaker.speak(target, text)));
    const tail = run.catch(() => undefined).then(() => { if (this.speechChains.get(target) === tail) this.speechChains.delete(target); });
    this.speechChains.set(target, tail);
    return busy;
  }

  private maybeSpeak(surface: Surface, i: Interaction, body: string, glance: string): void {
    const why = this.speechBlocked(surface, i);
    if (why) { if (why !== 'not_voice') this.log(JSON.stringify({ evt: 'speech_skipped', surface_id: surface.id, interaction_id: i.id, why })); return; }
    const text = speechText(body, glance, this.deps.config.voice.speech.max_chars);
    if (!text) return;
    i.speak!.left--;
    this.enqueueSpeech(i.speak!.to, text);
  }

  /**
   * E102 — fallback auto-speech for a reply. The agent's own `speak` call is the primary path: once one has been
   * made for this voice message, replies are never auto-spoken. Without one, the first reply's glance (or short
   * body) is spoken after `voice.speech.fallback_grace_s`, unless `speak` arrives first; `fallback: false` turns it off.
   */
  private replySpeech(surface: Surface, i: Interaction, body: string, glance: string): void {
    const sp = i.speak;
    if (!sp) return;
    const cfg = this.deps.config.voice.speech;
    if (sp.spoken !== null) return;
    if (!cfg.fallback) { this.log(JSON.stringify({ evt: 'speech_skipped', surface_id: surface.id, interaction_id: i.id, why: 'fallback_off' })); return; }
    if (sp.fallbackRan) { this.maybeSpeak(surface, i, body, glance); return; }
    if (sp.fallbackTimer) return;                                               // the first reply's fallback is already pending
    const run = (): void => {
      sp.fallbackTimer = null;
      if (this.state.get(surface.id)?.interaction !== i || i.speak !== sp || sp.spoken !== null) return;
      sp.fallbackRan = true;
      this.log(JSON.stringify({ evt: 'speech_fallback', surface_id: surface.id, interaction_id: i.id }));
      this.maybeSpeak(surface, i, body, glance);
    };
    if (cfg.fallback_grace_s <= 0) run();
    else { sp.fallbackTimer = setTimeout(run, cfg.fallback_grace_s * 1000); sp.fallbackTimer.unref?.(); }
  }

  /**
   * E102 — the agent's `speak(message_id, text)`: say `text` on the device that sent that push-to-talk message.
   * Returns at once; synthesis and streaming run behind it. Anything not allowed is an error or a skip with a
   * reason, never a partial effect. On success the device's Understood screen shows the text as the answer.
   */
  speakFor(messageId: string, rawText: string): SpeakResult {
    const cfg = this.deps.config.voice.speech;
    const ref = this.voiceMessages.get(messageId);
    if (!ref) return { ok: false, error: 'speak is only for a message that arrived by push-to-talk from an Intercom device (this id is not one, or its window is gone). Use reply().' };
    const surface = this.surfaces.get(ref.surfaceId);
    const i = surface ? this.state.get(surface.id)?.interaction : null;
    if (!surface || !i || i.id !== ref.interactionId) return { ok: false, error: 'the voice interaction for this message has closed. Use reply().' };
    const sp = i.speak;
    if (!sp) return { ok: false, error: 'a typed message followed this voice message, so nothing is spoken any more. Use reply().' };
    if (this.now() - sp.at > cfg.reply_window_s * 1000) return { ok: false, error: `the voice message is older than ${cfg.reply_window_s} s, too late to speak. Use reply().` };
    const prepared = agentSpeechText(rawText, cfg.speak_max_chars);
    if ('error' in prepared) {
      return { ok: false, error: prepared.error === 'empty' ? 'text is empty after removing Markdown and links.' : `text is ${prepared.chars} characters; speak at most ${cfg.speak_max_chars} (audio tags do not count). Shorten it and put the rest in reply().` };
    }
    const why = this.speechBlocked(surface, i);
    if (why) {
      this.log(JSON.stringify({ evt: 'speech_skipped', surface_id: surface.id, interaction_id: i.id, why, via: 'speak' }));
      return { ok: true, status: 'skipped', reason: why };
    }
    sp.left--;
    sp.spoken = prepared.visible;
    if (sp.fallbackTimer) { clearTimeout(sp.fallbackTimer); sp.fallbackTimer = null; }
    this.emitDurable(surface, 'reply', {
      message_id: messageId, interaction_id: i.id,
      glance: resolveGlance(null, prepared.visible), body: prepared.visible,
      has_attachments: false, more_on_telegram: false, spoken: true,
      created_at: new Date(this.now()).toISOString(),
    });
    const waited = this.enqueueSpeech(sp.to, prepared.tts);
    return { ok: true, status: waited ? 'queued' : 'spoken', text: prepared.visible, interaction_id: i.id, surface_id: surface.id, echo: `🔊 ${prepared.visible}` };
  }

  // ── Surface send ─────────────────────────────────────────────────────────

  async handleSend(surface: Surface, frame: { client_msg_id?: unknown; body?: unknown }, extra: { noteLine?: string; metadata?: Record<string, unknown>; echoIcon?: string; speakTo?: VoiceSocket } = {}): Promise<Record<string, unknown>> {
    const clientMsgId = typeof frame.client_msg_id === 'string' ? frame.client_msg_id : '';
    if (!clientMsgId || clientMsgId.length > 100) return { type: 'error', code: 'invalid_frame' };
    const reject = (reason: string, messageId = ''): Record<string, unknown> => ({ type: 'ack', client_msg_id: clientMsgId, status: 'rejected', reason, ...(messageId ? { message_id: messageId } : {}) });
    const body = typeof frame.body === 'string' ? frame.body : '';
    if (body.trim().length < 1 || Array.from(body).length > MAX_SEND_CHARS) return reject('invalid_body');

    const lockKey = `${surface.id}:${clientMsgId}`;
    while (this.sendLocks.has(lockKey)) await this.sendLocks.get(lockKey);
    let release!: () => void;
    this.sendLocks.set(lockKey, new Promise<void>((r) => { release = r; }));
    try {
      const existing = getSend(this.deps.db, surface.id, clientMsgId);
      if (existing) return existing;                                           // idempotent on client_msg_id

      const messageId = randomUUID();
      const interaction = this.openInteraction(surface);
      interaction.acceptedAt = this.now();
      interaction.firstStatusLogged = false;
      interaction.firstReplyLogged = false;

      const inbound: InboundMessage = {
        id: messageId,
        channel: surface.follow.channel,
        ...(surface.follow.topic ? { topic: surface.follow.topic } : {}),
        sender: `contact:${surface.follow.contact}`,
        payload: { type: 'text', body },
        metadata: { origin: 'intercom', surface_id: surface.id, interaction_id: interaction.id, client_msg_id: clientMsgId, ...extra.metadata },
      };
      let result: InboundResult | InboundAbort;
      try {
        result = await this.deps.submitInbound(inbound, { blocks: [renderSystemBlock('intercom', extra.noteLine ? `${agentNote(surface.id, this.notificationsOn)}\n${extra.noteLine}` : agentNote(surface.id, this.notificationsOn), { surface: surface.id })] });
      } catch (err) {
        this.log(`warn: submitInbound failed: ${String(err)}`);
        this.abortIfUnused(surface, interaction.id);
        return reject('internal_error');                                       // not stored: the client may retry the same id
      }
      const queued = result.queued && result.enqueued_count > 0;
      const command = !result.queued && result.reason === 'command_handled';
      if (!queued) {
        this.abortIfUnused(surface, interaction.id);
        const ack = command
          ? { type: 'ack', client_msg_id: clientMsgId, status: 'command', message_id: messageId }
          : reject(result.queued ? 'no_route' : (result.reason ?? 'rejected'), messageId);
        putSend(this.deps.db, surface.id, clientMsgId, messageId, ack);
        return ack;
      }
      this.mark(surface, interaction, 'inbound_accepted');
      if (this.state.get(surface.id)!.activity.state === 'idle') {
        this.setActivity(surface, { state: 'queued', interaction_id: interaction.id });
      } else {
        this.setActivity(surface, { interaction_id: interaction.id });
      }
      // Spoken replies follow a push-to-talk message only; a typed send in the same window turns them off.
      if (interaction.speak?.fallbackTimer) clearTimeout(interaction.speak.fallbackTimer);
      interaction.speak = extra.speakTo ? { to: extra.speakTo, at: this.now(), left: this.deps.config.voice.speech.max_replies, spoken: null, fallbackTimer: null, fallbackRan: false } : null;
      if (extra.speakTo) {
        this.voiceMessages.set(messageId, { surfaceId: surface.id, interactionId: interaction.id });
        if (this.voiceMessages.size > 200) this.voiceMessages.delete(this.voiceMessages.keys().next().value as string);
      }
      const ack = { type: 'ack', client_msg_id: clientMsgId, status: 'queued', message_id: messageId, interaction_id: interaction.id };
      putSend(this.deps.db, surface.id, clientMsgId, messageId, ack);
      void this.echo(surface, body, extra.echoIcon);
      return ack;
    } finally {
      this.sendLocks.delete(lockKey);
      release();
    }
  }

  /** An interaction opened for a send that never reached the agent is dropped again. */
  private abortIfUnused(surface: Surface, interactionId: string): void {
    const st = this.state.get(surface.id)!;
    if (st.interaction?.id !== interactionId) return;
    if (st.activity.state === 'idle') this.closeInteraction(surface, interactionId);
  }

  /** The silent `⌨️ text` echo into the followed Telegram chat. Bookkeeping only: it bypasses the queue and DeliveryWorker. */
  private async echo(surface: Surface, body: string, icon = '⌨️'): Promise<void> {
    if (!this.deps.config.echo_to_followed) return;
    try {
      const adapter = this.deps.registry?.lookupPrimaryByChannel(surface.follow.channel);
      if (!adapter) { this.log(`warn: no adapter for ${surface.follow.channel}; echo skipped`); return; }
      const echo: MessageEnvelope = {
        id: randomUUID(), timestamp: new Date(this.now()).toISOString(),
        channel: surface.follow.channel, topic: normalizeTopic(surface.follow.topic),
        sender: 'system:bus', recipient: `contact:${surface.follow.contact}`, reply_to: null, priority: 'normal',
        payload: { type: 'text', body: `${icon} ${body}\n— via Intercom` },
        metadata: { adapter_id: adapter.id, silent: true, no_preview: true, intercom_echo: true, bus_notice: true },
      };
      const res = await adapter.send(echo);
      if (!res.success) this.log(`warn: echo failed: ${res.error ?? 'unknown'}`);
    } catch (err) {
      this.log(`warn: echo failed: ${String(err)}`);
    }
  }

  // ── Notifications (E89) ──────────────────────────────────────────────────

  get notificationsOn(): boolean { return this.deps.notifications?.enabled === true; }

  /** Sliding-window write limit per source label. */
  writeAllowed(source: string): boolean {
    const now = this.now();
    const hits = (this.writeHits.get(source) ?? []).filter((t) => now - t < WRITE_WINDOW_MS);
    if (hits.length >= (this.deps.notifications?.rate_limit_per_min ?? 30)) { this.writeHits.set(source, hits); return false; }
    hits.push(now);
    this.writeHits.set(source, hits);
    if (this.writeHits.size > 1000) for (const [k, v] of this.writeHits) if (v.every((t) => now - t >= WRITE_WINDOW_MS)) this.writeHits.delete(k);
    return true;
  }

  raise(input: NotifyInputT): WriteResult {
    const res = upsertNotification(this.deps.db, input, this.now());
    this.publish(res.notification, res.contentChanged);
    return res;
  }

  patch(patch: UpdateInputT): UpdateResult {
    const res = updateNotification(this.deps.db, patch, this.now());
    if (!('error' in res)) this.publish(res.notification, res.contentChanged && res.notification.state === 'active');
    return res;
  }

  list(state: StateFilter, limit: number): Notification[] { return listNotifications(this.deps.db, state, limit); }

  private targetedSurfaces(n: Notification): Surface[] {
    return [...this.surfaces.values()].filter((s) => targetsSurface(n, s.id));
  }

  /** Durable `notification` event plus a fresh `attention` to every targeted surface; optionally the context carry-over. */
  private publish(n: Notification, carryContext: boolean): void {
    try {
      for (const s of this.targetedSurfaces(n)) {
        this.emitDurable(s, 'notification', publicNotification(n));
        this.emitAttention(s);
        this.syncNotices(s);
      }
      if (carryContext && n.state === 'active') this.carryContext(n);
    } catch (err) { this.log(`warn: notification publish failed: ${String(err)}`); }
  }

  private emitAttention(surface: Surface): void {
    this.emitEphemeral(surface, 'attention', attentionFor(this.deps.db, surface.id));
  }

  private clock(iso: string): string {
    const tz = this.deps.config.calendar.timezone;
    try { return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz }).format(new Date(iso)); }
    catch { return iso.slice(11, 16); }
  }

  /** Hand what the dial shows to each targeted surface's followed conversation as hidden pending context. */
  private carryContext(n: Notification): void {
    const cfg = this.deps.appConfig;
    if (!cfg || this.deps.notifications?.context_to_followed === false) return;
    const seen = new Set<string>();
    for (const s of this.targetedSurfaces(n)) {
      if (seen.has(s.conversationId)) continue;
      seen.add(s.conversationId);
      const actions = n.actions.length > 0 ? ` Actions: ${n.actions.map((a) => a.label).join(' / ')}.` : '';
      const text = `[Shown on Intercom at ${this.clock(n.updated_at)}] (${n.level}) ${n.title}${n.body ? `: ${/[.!?]$/.test(n.body) ? n.body : `${n.body}.`}` : '.'}${actions}`;
      const res = shareContextToConversation(this.deps.db, cfg, {
        contactId: s.follow.contact, channel: s.follow.channel, topic: normalizeTopic(s.follow.topic), body: text, source: `Intercom: ${n.source}`,
      });
      if (!res.ok) this.log(`warn: notification context not written for ${s.id}: ${res.error}`);
    }
  }

  /** 60 s tick: expire items past `expires_at` (telling the surfaces) and delete old terminal rows. */
  notificationTick(): void {
    if (!this.notificationsOn) return;
    try {
      for (const n of expireDue(this.deps.db, this.now())) this.publish(n, false);
      sweepNotifications(this.deps.db, this.deps.notifications?.retention_days ?? 14, this.now());
    } catch (err) { this.log(`warn: notification tick failed: ${String(err)}`); }
  }

  /** `{"type":"notification_ack"}` from a surface. Returns an error frame, or null on success. */
  handleNotificationAck(surface: Surface, frame: { id?: unknown }): Record<string, unknown> | null {
    const id = typeof frame.id === 'string' ? frame.id : '';
    const n = id ? getNotification(this.deps.db, id) : null;
    if (!this.notificationsOn || !n || isTerminal(n) || !targetsSurface(n, surface.id)) return { type: 'error', code: 'notification_not_found' };
    const res = acknowledgeNotification(this.deps.db, id, surface.id, this.now());
    if (res?.changed) this.publish(res.notification, false);
    return null;
  }

  /** `{"type":"notification_action"}`: acknowledge, then send `[tapped] <label>` into the followed conversation like a surface `send`. */
  async handleNotificationAction(surface: Surface, frame: { client_msg_id?: unknown; id?: unknown; index?: unknown }): Promise<Record<string, unknown>> {
    const clientMsgId = typeof frame.client_msg_id === 'string' ? frame.client_msg_id : '';
    if (!clientMsgId || clientMsgId.length > 100 || typeof frame.id !== 'string' || !Number.isInteger(frame.index)) return { type: 'error', code: 'invalid_frame' };
    const existing = getSend(this.deps.db, surface.id, clientMsgId);
    if (existing) return existing;                                             // idempotent on client_msg_id, even if the item has since been resolved
    const n = getNotification(this.deps.db, frame.id);
    if (!this.notificationsOn || !n || isTerminal(n) || !targetsSurface(n, surface.id)) return { type: 'error', code: 'notification_not_found' };
    const action = n.actions[frame.index as number];
    if (!action) return { type: 'error', code: 'invalid_frame' };
    const acked = acknowledgeNotification(this.deps.db, n.id, surface.id, this.now());
    if (acked?.changed) this.publish(acked.notification, false);
    this.noteOnMyWay(n, action.label);
    return this.handleSend(surface, { client_msg_id: clientMsgId, body: `[tapped] ${action.label}` }, {
      noteLine: `On the Intercom notification "${n.title}" (${n.source}, raised ${this.clock(n.created_at)})`.replace(/\s+/g, ' '),
      metadata: { notification_id: n.id },
    });
  }

  /** E96 — mirror the surface's open notifications into its `notices` resource. */
  syncNotices(surface: Surface): void {
    const api = this.deps.surfaceApi;
    if (!api) return;
    const next: Record<string, Record<string, unknown>> = {};
    if (this.notificationsOn) {
      for (const n of openForSurface(this.deps.db, surface.id)) next[n.id] = publicNotification(n) as unknown as Record<string, unknown>;
    }
    this.applyResource(surface.id, 'notices', diffOps(api.hub.snapshot(surface.id, 'notices').items, next));
  }

  /**
   * E96 — `notices:<id>` actions from the shared action handler: the E89 notification action
   * path (`[tapped] <label>` into the followed conversation), with the idempotency key as `client_msg_id`.
   */
  async noticeAction(device: Device, noticeId: string, actionId: string, idempotencyKey: string): Promise<ActionResult> {
    const base = { type: 'action_result' as const, idempotency_key: idempotencyKey };
    const surface = this.surfaces.get(device.surface_id);
    const index = /^\d{1,3}$/.test(actionId) ? Number(actionId) : NaN;
    if (!surface || !Number.isInteger(index)) return { ...base, status: 'failed', reason: 'invalid' };
    const ack = await this.handleNotificationAction(surface, { client_msg_id: idempotencyKey, id: noticeId, index });
    if (ack['type'] === 'error') return { ...base, status: 'failed', reason: ack['code'] === 'notification_not_found' ? 'not_found' : 'invalid' };
    const messageId = typeof ack['message_id'] === 'string' ? { message_id: ack['message_id'] } : {};
    if (ack['status'] === 'queued' || ack['status'] === 'command') return { ...base, status: 'done', ...messageId };
    return { ...base, status: 'failed', reason: String(ack['reason'] ?? 'rejected'), ...messageId };
  }

  // ── Test/inspection helpers ──────────────────────────────────────────────

  inspect(surfaceId: string): { activity: Activity; interaction_id: string | null } {
    const st = this.state.get(surfaceId)!;
    return { activity: st.activity, interaction_id: st.interaction?.id ?? null };
  }
}

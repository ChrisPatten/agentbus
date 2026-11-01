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
import type { IntercomAdapterConfig, IntercomFollowConfig } from '../config/schema.js';
import type { MessageEnvelope } from '../types/envelope.js';
import type { AdapterRegistry } from '../core/registry.js';
import type { InboundAbort, InboundMessage, InboundResult, InboundSystemOptions } from '../http/api.js';
import { computeConversationId } from '../pipeline/conversation-id.js';
import { renderSystemBlock } from '../core/system-block.js';
import { VERSION } from '../version.js';
import { CalendarFeed, type CalendarPayload } from './calendar.js';
import { resolveGlance, surfaceBody } from './glance.js';
import { appendEvent, cursorNeedsReset, eventBounds, getSend, putSend, readEvents, sweepEvents, sweepPairCodes, type StoredEvent } from './store.js';

export const PROTOCOL_VERSION = 1;
export const MAX_SEND_CHARS = 4000;

export interface SocketLike { send(data: string): void; close(code?: number, reason?: string): void; readyState: number; ping?(): void }

export interface Surface {
  id: string;
  profile: string;
  follow: { contact: string; channel: string; topic: string | undefined };
  /** Conversation id of the followed (contact, channel, topic), as the pipeline computes it. */
  conversationId: string;
  tokenHash: string;
}

export interface Client { socket: SocketLike; surface: Surface; ready: boolean; cursor: number; lastPong: number; clientName?: string }

export type ActivityState = 'running' | 'queued' | 'idle';
interface Activity { state: ActivityState; status_text: string | null; interaction_id: string | null }

interface Interaction {
  id: string;
  acceptedAt: number;
  firstStatusLogged: boolean;
  firstReplyLogged: boolean;
  closeTimer: NodeJS.Timeout | null;
}

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
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  log?: (line: string) => void;
}

export const normalizeTopic = (topic: string | undefined | null): string => (!topic || topic === 'general' ? 'general' : topic);
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const bareContact = (id: string) => id.replace(/^contact:/, '');

/** The one-line note the agent sees with every surface message. */
export function agentNote(surfaceId: string): string {
  return `Sent from Intercom (${surfaceId}), a small round glance display. Reply as usual with reply(); keep it to 1-3 sentences, lead with the answer, and pass glance: a plain line of at most 100 characters.`;
}

export class IntercomService {
  readonly surfaces = new Map<string, Surface>();
  private readonly byTokenHash = new Map<string, Surface>();
  private readonly clients = new Set<Client>();
  private readonly state = new Map<string, SurfaceState>();
  private readonly sendLocks = new Map<string, Promise<void>>();
  private readonly pairHits = new Map<string, number[]>();
  readonly calendar: CalendarFeed;
  private sweepTimer: NodeJS.Timeout | null = null;
  private calendarTimer: NodeJS.Timeout | null = null;
  private lastCalendarDate = '';

  constructor(private readonly deps: IntercomDeps) {
    const env = deps.env ?? process.env;
    this.calendar = deps.calendar ?? new CalendarFeed(deps.config.calendar);
    for (const s of deps.config.surfaces) {
      const token = env[s.token_env];
      if (!token || token.length < 32) {
        this.log(`warn: surface "${s.id}" skipped: env ${s.token_env} is ${token ? 'shorter than 32 characters' : 'not set'}`);
        continue;
      }
      const follow = { contact: bareContact(s.follow.contact), channel: s.follow.channel, topic: s.follow.topic };
      const surface: Surface = {
        id: s.id, profile: s.profile, follow,
        conversationId: computeConversationId(follow.contact, follow.channel, normalizeTopic(follow.topic)),
        tokenHash: sha256(token),
      };
      this.surfaces.set(s.id, surface);
      this.byTokenHash.set(surface.tokenHash, surface);
      this.state.set(s.id, { interaction: null, activity: { state: 'idle', status_text: null, interaction_id: null }, staleTimer: null, quiet: false, battery: null });
    }
  }

  private now(): number { return this.deps.now?.() ?? Date.now(); }
  private log(line: string): void { (this.deps.log ?? ((l) => console.log(`[intercom] ${l}`)))(line); }
  private mark(surface: Surface, interaction: Interaction, mark: string): void {
    this.log(JSON.stringify({ evt: 'latency', mark, surface_id: surface.id, interaction_id: interaction.id, ms: this.now() - interaction.acceptedAt }));
  }

  start(): void {
    const sweep = () => {
      try {
        sweepEvents(this.deps.db, this.deps.config.event_retention_days);
        sweepPairCodes(this.deps.db);
      } catch (err) { this.log(`warn: sweep failed: ${String(err)}`); }
    };
    sweep();
    this.sweepTimer = setInterval(sweep, 60 * 60 * 1000);
    this.sweepTimer.unref();
    // Push the calendar every 5 minutes and at a date change.
    this.calendarTimer = setInterval(() => { void this.pushCalendar(); }, 60_000);
    this.calendarTimer.unref();
  }

  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.calendarTimer) clearInterval(this.calendarTimer);
    for (const st of this.state.values()) {
      if (st.staleTimer) clearTimeout(st.staleTimer);
      if (st.interaction?.closeTimer) clearTimeout(st.interaction.closeTimer);
    }
    this.sweepTimer = this.calendarTimer = null;
  }

  // ── Auth ─────────────────────────────────────────────────────────────────

  surfaceForToken(token: string | undefined): Surface | null {
    if (!token) return null;
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
    return s ? (this.deps.env ?? process.env)[s.token_env] ?? null : null;
  }

  connectedClients(surfaceId: string): number {
    let n = 0;
    for (const c of this.clients) if (c.surface.id === surfaceId && c.ready) n++;
    return n;
  }

  health(surface: Surface) {
    return {
      ok: true, surface_id: surface.id,
      follow: this.followJson(surface), version: VERSION,
      connected_clients: this.connectedClients(surface.id),
    };
  }

  followJson(surface: Surface): { contact: string; channel: string; topic?: string } {
    return { contact: surface.follow.contact, channel: surface.follow.channel, ...(surface.follow.topic ? { topic: surface.follow.topic } : {}) };
  }

  // ── Sockets ──────────────────────────────────────────────────────────────

  private raw(socket: SocketLike, frame: Record<string, unknown>): void {
    try { if (socket.readyState === 1) socket.send(JSON.stringify(frame)); } catch { /* the client catches up from its cursor */ }
  }
  sendFrame(client: Client, frame: Record<string, unknown>): void { this.raw(client.socket, frame); }

  /** Complete the handshake: welcome, replay, then the activity snapshot and calendar. */
  async attach(client: Client, cursor: number, clientName?: string): Promise<void> {
    const surface = client.surface;
    const { latest } = eventBounds(this.deps.db, surface.id);
    const reset = cursorNeedsReset(this.deps.db, surface.id, cursor);
    client.cursor = reset ? latest : cursor;
    if (clientName) client.clientName = clientName;
    this.clients.add(client);
    this.raw(client.socket, {
      type: 'welcome', version: PROTOCOL_VERSION, surface_id: surface.id, follow: this.followJson(surface),
      latest_seq: latest, reset, server_time: new Date(this.now()).toISOString(),
    });
    if (!reset) this.replay(client);
    client.ready = true;
    const st = this.state.get(surface.id)!;
    this.raw(client.socket, { type: 'event', event: 'activity', data: st.activity });
    if (st.interaction) this.raw(client.socket, { type: 'event', event: 'interaction', data: { interaction_id: st.interaction.id, state: 'open' } });
    try {
      const cal = await this.calendar.today();
      this.lastCalendarDate = cal.date;
      this.lastCalendarPush = this.now();
      this.raw(client.socket, { type: 'event', event: 'calendar', data: cal });
    } catch (err) {
      this.log(`warn: calendar unavailable: ${String(err)}`);
    }
  }

  detach(client: Client): void { this.clients.delete(client); }

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

  setSurfaceState(surface: Surface, frame: { quiet?: unknown; battery?: unknown }): void {
    const st = this.state.get(surface.id)!;
    st.quiet = frame.quiet === true;
    st.battery = typeof frame.battery === 'number' ? frame.battery : null;
    this.log(JSON.stringify({ evt: 'surface_state', surface_id: surface.id, quiet: st.quiet, battery: st.battery }));
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
    try {
      if (this.surfaces.size === 0) return;
      const meta = envelope.metadata ?? {};
      if (!envelope.sender.startsWith('agent:')) return;                       // bus notices, command replies, echoes
      if (meta['intercom_echo'] === true || meta['system_only'] === true || meta['context_only'] === true || meta['bus_notice'] === true) return;
      if (envelope.payload.type !== 'text') return;
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
        this.emitDurable(s, 'reply', {
          message_id: envelope.id, interaction_id: i.id,
          glance: resolveGlance(meta['glance'], body), body: text,
          has_attachments: hasAttachments, more_on_telegram: moreOnTelegram,
          created_at: new Date(this.now()).toISOString(),
        });
      }
    } catch (err) {
      this.log(`warn: onDelivered failed: ${String(err)}`);
    }
  }

  // ── Surface send ─────────────────────────────────────────────────────────

  async handleSend(surface: Surface, frame: { client_msg_id?: unknown; body?: unknown }): Promise<Record<string, unknown>> {
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
        metadata: { origin: 'intercom', surface_id: surface.id, interaction_id: interaction.id, client_msg_id: clientMsgId },
      };
      let result: InboundResult | InboundAbort;
      try {
        result = await this.deps.submitInbound(inbound, { blocks: [renderSystemBlock('intercom', agentNote(surface.id), { surface: surface.id })] });
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
      const ack = { type: 'ack', client_msg_id: clientMsgId, status: 'queued', message_id: messageId, interaction_id: interaction.id };
      putSend(this.deps.db, surface.id, clientMsgId, messageId, ack);
      void this.echo(surface, body);
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
  private async echo(surface: Surface, body: string): Promise<void> {
    if (!this.deps.config.echo_to_followed) return;
    try {
      const adapter = this.deps.registry?.lookupPrimaryByChannel(surface.follow.channel);
      if (!adapter) { this.log(`warn: no adapter for ${surface.follow.channel}; echo skipped`); return; }
      const echo: MessageEnvelope = {
        id: randomUUID(), timestamp: new Date(this.now()).toISOString(),
        channel: surface.follow.channel, topic: normalizeTopic(surface.follow.topic),
        sender: 'system:bus', recipient: `contact:${surface.follow.contact}`, reply_to: null, priority: 'normal',
        payload: { type: 'text', body: `⌨️ ${body}\n— via Intercom` },
        metadata: { adapter_id: adapter.id, silent: true, no_preview: true, intercom_echo: true, bus_notice: true },
      };
      const res = await adapter.send(echo);
      if (!res.success) this.log(`warn: echo failed: ${res.error ?? 'unknown'}`);
    } catch (err) {
      this.log(`warn: echo failed: ${String(err)}`);
    }
  }

  // ── Test/inspection helpers ──────────────────────────────────────────────

  inspect(surfaceId: string): { activity: Activity; interaction_id: string | null } {
    const st = this.state.get(surfaceId)!;
    return { activity: st.activity, interaction_id: st.interaction?.id ?? null };
  }
}

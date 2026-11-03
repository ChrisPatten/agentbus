// WebSocket client. Prefers /api/v1/surface/ws with protocol v2 (resource deltas); falls back to the legacy
// /api/v1/intercom/ws with protocol v1 when the bus refuses the credential there or does not answer on the v2 path.
import { backoffDelay, Outbox, frameOf } from './logic.js';

export const CLIENT = 'intercom-web/0.2';
export const WS_PATH = 'api/v1/intercom/ws';
export const WS_PATH_V2 = 'api/v1/surface/ws';

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
export { store };

/** Absolute same-origin API URL; the app lives at /intercom/ so go up one level. */
export function apiUrl(path, loc = location) {
  return new URL(`/${path}`, loc.origin).href;
}

export function wsUrl(loc = location, path = WS_PATH) {
  const u = new URL(`/${path}`, loc.origin);
  u.protocol = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  return u.href;
}

export class IntercomSocket {
  /**
   * handlers: onState(state), onEvent(name, data, seq), onAck(frame), onUnauthorized(), onReset(), onWelcome(frame),
   *   onDelta(frame), onActionResult(frame), onMode('v1'|'v2')
   * state: 'connecting' | 'online' | 'offline'
   * v2: try protocol v2 first. getRevs() gives the per-resource revs sent in the hello for resume.
   * urls: { v1, v2 } override the socket addresses (tests).
   */
  constructor({ token, handlers, WS = globalThis.WebSocket, urls = null, url = null, v2 = true, getRevs = () => ({}), timers = globalThis }) {
    this.token = token;
    this.h = handlers;
    this.WS = WS;
    this.urls = urls || (url ? { v1: url, v2: url } : { v1: wsUrl(location, WS_PATH), v2: wsUrl(location, WS_PATH_V2) });
    this.enabled = { v1: true, v2: !!v2 };
    this.mode = v2 ? 'v2' : 'v1';
    this.denied = { v1: false, v2: false };
    this.fails = 0;
    this.welcomed = false;
    this.getRevs = getRevs;
    this.timers = timers;
    this.attempt = 0;
    this.ws = null;
    this.stopped = false;
    this.state = 'offline';
    this.cursor = Number(store.get('intercom.cursor') || 0) || 0;
    this.outbox = new Outbox(this.loadOutbox());
    this.lastFrameAt = 0;
  }

  loadOutbox() {
    try { return JSON.parse(store.get('intercom.outbox') || '[]'); } catch { return []; }
  }
  saveOutbox() { store.set('intercom.outbox', JSON.stringify(this.outbox.pending())); }

  setState(s) {
    if (this.state !== s) { this.state = s; this.h.onState?.(s); }
  }

  start() {
    this.stopped = false;
    this.connect();
    this.watchdog = this.timers.setInterval(() => this.tick(), 15000);
  }

  stop() {
    this.stopped = true;
    this.timers.clearInterval(this.watchdog);
    this.timers.clearTimeout(this.retryTimer);
    try { this.ws?.close(); } catch { /* ignore */ }
  }

  tick() {
    if (this.state === 'online') {
      this.sendRaw({ type: 'ping' });
      if (Date.now() - this.lastFrameAt > 75000) try { this.ws.close(); } catch { /* ignore */ }
    }
  }

  /** Called when the page becomes visible again or the network returns. */
  nudge() {
    if (this.stopped) return;
    if (this.state === 'offline') { this.timers.clearTimeout(this.retryTimer); this.attempt = 0; this.connect(); }
    else if (this.state === 'online' && Date.now() - this.lastFrameAt > 45000) { try { this.ws.close(); } catch { /* ignore */ } }
  }

  connect() {
    if (this.stopped) return;
    this.setState('connecting');
    let ws;
    this.welcomed = false;
    try { ws = new this.WS(this.urls[this.mode]); } catch { this.scheduleRetry(); return; }
    this.ws = ws;
    ws.onopen = () => {
      this.lastFrameAt = Date.now();
      const hello = { type: 'hello', token: this.token, cursor: this.cursor, client: CLIENT };
      if (this.mode === 'v2') { hello.protocol = 2; hello.revs = this.getRevs(); }
      this.sendRaw(hello);
    };
    ws.onmessage = (m) => {
      this.lastFrameAt = Date.now();
      let f;
      try { f = JSON.parse(m.data); } catch { return; }
      this.onFrame(f);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (ev.code === 4401) {
        // Refused on this path. Try the other protocol once before treating the credential as bad.
        this.denied[this.mode] = true;
        const other = this.mode === 'v2' ? 'v1' : 'v2';
        if (this.enabled[other] && !this.denied[other]) { this.switchMode(other); this.connect(); return; }
        this.stopped = true; this.timers.clearInterval(this.watchdog); this.setState('offline'); this.h.onUnauthorized?.(); return;
      }
      this.setState('offline');
      // Two attempts in a row that never reached a welcome: probe the other path (a bus without v2 answers nothing there).
      if (!this.welcomed && this.enabled.v2 && ++this.fails >= 2) { this.switchMode(this.mode === 'v2' ? 'v1' : 'v2'); }
      this.scheduleRetry();
    };
    ws.onerror = () => { /* close follows */ };
  }

  switchMode(mode) {
    this.mode = mode; this.fails = 0;
    this.h.onMode?.(mode);
  }

  /** Tell the bus which view is open (v2 only): `conversation:<id>`, or null. */
  sendView(view) { return this.mode === 'v2' && this.state === 'online' ? this.sendRaw({ type: 'view', view }) : false; }

  scheduleRetry() {
    if (this.stopped) return;
    const d = backoffDelay(this.attempt++, Math.random);
    this.retryTimer = this.timers.setTimeout(() => this.connect(), d);
  }

  onFrame(f) {
    switch (f.type) {
      case 'welcome':
        this.attempt = 0;
        this.fails = 0;
        this.welcomed = true;
        this.denied = { v1: false, v2: false };
        if (this.mode === 'v2' && f.version !== 2) this.switchMode('v1'); // an older bus answered a v2 hello with a v1 welcome
        if (f.reset) {
          this.cursor = f.latest_seq || 0;
          store.set('intercom.cursor', String(this.cursor));
          this.h.onReset?.();
        }
        this.setState('online');
        this.h.onWelcome?.(f);
        this.outbox.dropActions(600000); // a tap from long ago should not fire on a fresh connection
        this.saveOutbox();
        for (const item of this.outbox.pending()) this.sendRaw(frameOf(item));
        break;
      case 'event':
        if (typeof f.seq === 'number' && f.seq > this.cursor) {
          this.cursor = f.seq;
          store.set('intercom.cursor', String(f.seq));
        }
        this.h.onEvent?.(f.event, f.data || {}, f.seq);
        break;
      case 'ack':
        if (f.status === 'queued' || f.status === 'rejected') { this.outbox.ack(f.client_msg_id); this.saveOutbox(); }
        this.h.onAck?.(f);
        break;
      case 'delta': this.h.onDelta?.(f); break;
      case 'action_result': this.h.onActionResult?.(f); break;
      case 'ping': this.sendRaw({ type: 'pong' }); break;
      case 'error':
        if (f.code === 'notification_not_found') { this.outbox.dropActions(); this.saveOutbox(); }
        this.h.onError?.(f);
        break;
      default: break;
    }
  }

  sendRaw(obj) {
    if (this.ws && this.ws.readyState === 1) { this.ws.send(JSON.stringify(obj)); return true; }
    return false;
  }

  /** Queue a typed message; sent now if online, otherwise on reconnect. */
  send(body) {
    const item = this.outbox.add(body);
    this.saveOutbox();
    if (this.state === 'online') this.sendRaw(frameOf(item));
    return item;
  }

  /** Tap on a notification action: queued like a send (same retry and ack), answered by an `ack` with an interaction. */
  sendAction(id, index) {
    const item = this.outbox.addAction(id, index);
    this.saveOutbox();
    if (this.state === 'online') this.sendRaw(frameOf(item));
    return item;
  }

  /** "Got it". Idempotent on the server, so fire and forget; the app re-sends pending ones after each welcome. */
  ackNotification(id) { return this.sendRaw({ type: 'notification_ack', id }); }
}

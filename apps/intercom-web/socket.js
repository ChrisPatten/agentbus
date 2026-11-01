// WebSocket client for /api/v1/intercom/ws (protocol v1).
import { backoffDelay, Outbox } from './logic.js';

export const CLIENT = 'intercom-web/0.1';
export const WS_PATH = 'api/v1/intercom/ws';

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

export function wsUrl(loc = location) {
  const u = new URL(`/${WS_PATH}`, loc.origin);
  u.protocol = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  return u.href;
}

export class IntercomSocket {
  /**
   * handlers: onState(state), onEvent(name, data, seq), onAck(frame), onUnauthorized(), onReset()
   * state: 'connecting' | 'online' | 'offline'
   */
  constructor({ token, handlers, WS = globalThis.WebSocket, url = wsUrl(), timers = globalThis }) {
    this.token = token;
    this.h = handlers;
    this.WS = WS;
    this.url = url;
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
    try { ws = new this.WS(this.url); } catch { this.scheduleRetry(); return; }
    this.ws = ws;
    ws.onopen = () => {
      this.lastFrameAt = Date.now();
      this.sendRaw({ type: 'hello', token: this.token, cursor: this.cursor, client: CLIENT });
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
      if (ev.code === 4401) { this.stopped = true; this.timers.clearInterval(this.watchdog); this.setState('offline'); this.h.onUnauthorized?.(); return; }
      this.setState('offline');
      this.scheduleRetry();
    };
    ws.onerror = () => { /* close follows */ };
  }

  scheduleRetry() {
    if (this.stopped) return;
    const d = backoffDelay(this.attempt++, Math.random);
    this.retryTimer = this.timers.setTimeout(() => this.connect(), d);
  }

  onFrame(f) {
    switch (f.type) {
      case 'welcome':
        this.attempt = 0;
        if (f.reset) {
          this.cursor = f.latest_seq || 0;
          store.set('intercom.cursor', String(this.cursor));
          this.h.onReset?.();
        }
        this.setState('online');
        this.h.onWelcome?.(f);
        for (const item of this.outbox.pending()) this.sendRaw({ type: 'send', client_msg_id: item.client_msg_id, body: item.body });
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
      case 'ping': this.sendRaw({ type: 'pong' }); break;
      case 'error': this.h.onError?.(f); break;
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
    if (this.state === 'online') this.sendRaw({ type: 'send', client_msg_id: item.client_msg_id, body });
    return item;
  }
}

/**
 * E96 — Surface API v2 end to end: devices, `/api/v1/surface/*`, protocol v2 deltas,
 * actions and the v1 alias, wired as bus-core wires them (minus the TLS listener).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { runMigrations } from '../db/schema.js';
import { IntercomAdapterSchema } from '../config/schema.js';
import { IntercomService } from '../intercom/service.js';
import type { CalendarFeed } from '../intercom/calendar.js';
import { createDeviceStore, legacyDeviceId, type SurfaceDeviceStore } from '../surface/devices.js';
import { createResourceHub, applyOps, type ResourceHubImpl } from '../surface/resources.js';
import { createActionHandler, createJobStore } from '../surface/actions.js';
import type { InboundMessage } from './api.js';
import type { JobStore, PairResult, ResourceOp } from '../surface/types.js';
import { registerIntercomRoutes } from './intercom-routes.js';
import { isSurfaceUrl, registerSurfaceRoutes } from './surface-routes.js';

const LEGACY = 'L'.repeat(48);
const cfg = IntercomAdapterSchema.parse({
  hello_timeout_ms: 500, pair_rate_limit_per_min: 50,
  surfaces: [{ id: 'desk', token_env: 'DESK_TOKEN', publishers: ['peggy'], follow: { contact: 'chris', channel: 'telegram:peggy' } }],
});
const calendar = { today: async () => ({ date: '2026-11-03', tz: 'America/New_York', generated_at: 'now', events: [] }) } as unknown as CalendarFeed;

describe('Surface API v2', () => {
  let db: Database.Database; let server: FastifyInstance; let service: IntercomService;
  let devices: SurfaceDeviceStore; let hub: ResourceHubImpl; let jobs: JobStore;
  let base: string; let wsBase: string; let clock: number;
  const injected: InboundMessage[] = [];
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    db = new Database(':memory:'); runMigrations(db);
    clock = Date.parse('2026-11-03T15:00:00Z');
    injected.length = 0;
    devices = createDeviceStore({ db, log: () => {} });
    let svc: IntercomService | null = null;
    hub = createResourceHub({ db, sink: (s, f) => svc?.pushDelta(s, f), coalesceMs: 0 });
    jobs = createJobStore(db, () => clock);
    const actions = createActionHandler({
      db, hub, jobs, rateLimitPerMin: 100, keyTtlHours: 48, now: () => clock,
      submitInbound: async (m) => { injected.push(m); return { ok: true, id: 'm1', queued: true, enqueued_count: 1 }; },
      noticeAction: (d, id, a, k) => svc!.noticeAction(d, id, a, k),
    });
    service = svc = new IntercomService({
      config: cfg, db, calendar, env: { DESK_TOKEN: LEGACY }, log: () => {},
      submitInbound: async () => ({ ok: true, id: 'x', queued: true, enqueued_count: 1 }),
      surfaceApi: { devices, hub, actions, certFingerprint: 'AA:BB' },
    });
    server = Fastify();
    await registerIntercomRoutes(server, { config: cfg, db, service, webRoot: '/nonexistent' });
    await registerSurfaceRoutes(server, { config: cfg, service });
    await server.listen({ host: '127.0.0.1', port: 0 });
    const { port } = server.server.address() as { port: number };
    base = `http://127.0.0.1:${port}`; wsBase = `ws://127.0.0.1:${port}`;
  });
  afterEach(async () => {
    for (const s of sockets.splice(0)) s.terminate();
    hub.stop(); await server.close(); db.close();
  });

  const post = (path: string, body: unknown, token?: string) => fetch(`${base}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  });
  const get = (path: string, token: string) => fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
  const until = async (fn: () => boolean) => { for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 10)); expect(fn()).toBe(true); };

  async function pair(name: string, scope: 'interactive' | 'read_only' = 'interactive'): Promise<PairResult> {
    const { code } = devices.createPairCode({ surfaceId: 'desk', name, scope, ttlMs: 60_000 });
    const res = await post('/api/v1/surface/pair', { code });
    expect(res.status).toBe(200);
    return await res.json() as PairResult;
  }

  function connect(token: string, hello: Record<string, unknown> = { protocol: 2 }, path = '/api/v1/surface/ws') {
    return new Promise<{ ws: WebSocket; frames: any[]; closed: Promise<number> }>((resolve, reject) => {
      const ws = new WebSocket(`${wsBase}${path}`);
      sockets.push(ws);
      const frames: any[] = [];
      ws.on('message', (d) => frames.push(JSON.parse(d.toString())));
      const closed = new Promise<number>((r) => ws.on('close', (c) => r(c)));
      ws.on('open', () => { ws.send(JSON.stringify({ type: 'hello', token, ...hello })); resolve({ ws, frames, closed }); });
      ws.on('error', reject);
    });
  }
  const welcomed = (frames: any[]) => frames.some((f) => f.type === 'welcome');
  const deltas = (frames: any[], resource: string) => frames.filter((f) => f.type === 'delta' && f.resource === resource);

  it('keeps surface routes off the bus token hook', () => {
    expect(isSurfaceUrl('/api/v1/surface/state?x=1')).toBe(true);
    expect(isSurfaceUrl('/api/v1/surfaces')).toBe(false);
  });

  it('pairs devices with their own credential and the cert fingerprint', async () => {
    const a = await pair('Kitchen');
    expect(a.credential).toBe(a.token);
    expect(a.cert_fingerprint).toBe('AA:BB');
    expect(a.surface_id).toBe('desk');
    const health = await (await get('/api/v1/surface/health', a.credential)).json() as Record<string, unknown>;
    expect(health).toMatchObject({ surface_id: 'desk', device_id: a.device_id, protocol: 2 });
  });

  it('two devices get the same delta; revoking one closes its socket and leaves the other', async () => {
    const a = await pair('Kitchen'); const b = await pair('Desk');
    const ca = await connect(a.credential); const cb = await connect(b.credential);
    await until(() => welcomed(ca.frames) && welcomed(cb.frames));
    const before = ca.frames.length;
    hub.apply('desk', 'events', [{ op: 'set', id: 'arrive', value: { id: 'arrive', kind: 'event', title: "I'm here", level: 'info', actions: [] } }]);
    await until(() => deltas(ca.frames.slice(before), 'events').length === 1 && deltas(cb.frames, 'events').some((f) => f.ops?.[0]?.id === 'arrive'));
    const da = deltas(ca.frames.slice(before), 'events')[0];
    const db_ = deltas(cb.frames, 'events').find((f) => f.ops?.[0]?.id === 'arrive');
    expect(db_).toEqual(da);

    // Revoke from another process (the CLI): the 5 s tick closes the socket.
    devices.revoke(a.device_id);
    service.surfaceTick();
    expect(await ca.closed).toBe(4403);
    expect((await get('/api/v1/surface/health', a.credential)).status).toBe(401);
    expect((await get('/api/v1/surface/health', b.credential)).status).toBe(200);
    expect(cb.ws.readyState).toBe(WebSocket.OPEN);
    const n = cb.frames.length;
    hub.apply('desk', 'events', [{ op: 'remove', id: 'arrive' }]);
    await until(() => deltas(cb.frames.slice(n), 'events').length === 1);
  });

  it('resumes a stale client with the missed changes, and the result equals /state', async () => {
    const a = await pair('Kitchen');
    const c1 = await connect(a.credential);
    await until(() => welcomed(c1.frames));
    const state0 = await (await get('/api/v1/surface/state', a.credential)).json() as any;
    c1.ws.close();
    await c1.closed;
    for (let i = 0; i < 5; i++) hub.apply('desk', 'widgets', [{ op: 'set', id: `w${i % 2}`, value: { id: `w${i % 2}`, type: 'counter', data: { n: i } } }]);
    const c2 = await connect(a.credential, { protocol: 2, revs: state0.revs });
    await until(() => welcomed(c2.frames) && deltas(c2.frames, 'widgets').length > 0);
    const local = structuredClone(state0.resources.widgets);
    for (const f of deltas(c2.frames, 'widgets')) {
      if (f.reset) Object.assign(local, f.items);
      else { expect(f.base_rev).toBe(state0.revs.widgets); applyOps(local, f.ops as ResourceOp[]); }
    }
    const fresh = await (await get('/api/v1/surface/state', a.credential)).json() as any;
    expect(local).toEqual(fresh.resources.widgets);
    expect(fresh.revs.widgets).toBe(state0.revs.widgets + 5);
  });

  it('fires an Event action once per key, then already_done, then expired after the Event', async () => {
    const a = await pair('Kitchen');
    const expires = new Date(clock + 3_600_000).toISOString();
    hub.apply('desk', 'events', [{ op: 'set', id: 'arrive', value: { id: 'arrive', kind: 'event', title: 'Pickup', level: 'info', expires_at: expires, actions: [{ id: 'here', label: "I'm here" }] } }]);
    jobs.replaceForEvent('desk', 'arrive', [{ action_id: 'here', channel: 'telegram:peggy', sender: 'contact:chris', payload_body: 'Chris tapped I am here', sends_on_behalf: false, confirm_draft: null, once: true, expires_at: expires }], 'agent:peggy');
    const tap = { object: 'events:arrive', action_id: 'here', idempotency_key: 'k1' };
    expect(await (await post('/api/v1/surface/actions', tap, a.credential)).json()).toMatchObject({ status: 'done' });
    expect(await (await post('/api/v1/surface/actions', tap, a.credential)).json()).toMatchObject({ status: 'already_done' });
    expect(injected).toHaveLength(1);
    expect(injected[0]!.payload).toEqual({ type: 'text', body: 'Chris tapped I am here' });
    clock += 2 * 3_600_000;
    expect(await (await post('/api/v1/surface/actions', { ...tap, idempotency_key: 'k2' }, a.credential)).json()).toMatchObject({ status: 'expired' });
    expect(injected).toHaveLength(1);
  });

  it('rejects a send-on-behalf action without its confirm draft, over the WS action frame too', async () => {
    const a = await pair('Kitchen');
    const draft = 'Running 10 minutes late, sorry!';
    hub.apply('desk', 'events', [{ op: 'set', id: 'late', value: { id: 'late', kind: 'event', title: 'Tell Sam', level: 'attention', actions: [{ id: 'send', label: 'Send', confirm: { draft } }] } }]);
    jobs.replaceForEvent('desk', 'late', [{ action_id: 'send', channel: 'telegram:peggy', sender: 'contact:chris', payload_body: 'Send the late note to Sam', sends_on_behalf: true, confirm_draft: draft, once: true, expires_at: null }], 'agent:peggy');
    const c = await connect(a.credential);
    await until(() => welcomed(c.frames));
    c.ws.send(JSON.stringify({ type: 'action', object: 'events:late', action_id: 'send', idempotency_key: 'w1' }));
    await until(() => c.frames.some((f) => f.type === 'action_result' && f.idempotency_key === 'w1'));
    expect(c.frames.find((f) => f.idempotency_key === 'w1')).toMatchObject({ status: 'failed', reason: 'confirm_required' });
    c.ws.send(JSON.stringify({ type: 'action', object: 'events:late', action_id: 'send', idempotency_key: 'w2', draft }));
    await until(() => c.frames.some((f) => f.type === 'action_result' && f.idempotency_key === 'w2'));
    expect(c.frames.find((f) => f.idempotency_key === 'w2')).toMatchObject({ status: 'done' });
    expect(injected).toHaveLength(1);
  });

  it('read-only devices cannot send or fire actions', async () => {
    const r = await pair('Hall', 'read_only');
    const c = await connect(r.credential);
    await until(() => welcomed(c.frames));
    c.ws.send(JSON.stringify({ type: 'send', client_msg_id: 'x1', body: 'hi' }));
    await until(() => c.frames.some((f) => f.type === 'error' && f.code === 'read_only'));
    const res = await post('/api/v1/surface/actions', { object: 'events:none', action_id: 'a', idempotency_key: 'r1' }, r.credential);
    expect(res.status).toBe(403);
  });

  it('keeps v1 working through /api/v1/intercom with the legacy token: no v2 frames', async () => {
    expect(devices.get(legacyDeviceId('desk'))).toMatchObject({ legacy: true });
    const c = await connect(LEGACY, { cursor: 0, client: 'intercom-web/0.1' }, '/api/v1/intercom/ws');
    await until(() => welcomed(c.frames) && c.frames.some((f) => f.event === 'calendar'));
    expect(c.frames.find((f) => f.type === 'welcome')).toMatchObject({ version: 1, surface_id: 'desk' });
    hub.apply('desk', 'events', [{ op: 'set', id: 'x', value: { id: 'x', kind: 'event', title: 'X', level: 'info', actions: [] } }]);
    await new Promise((r) => setTimeout(r, 50));
    expect(c.frames.some((f) => f.type === 'delta')).toBe(false);
    expect((await fetch(`${base}/api/v1/intercom/today`, { headers: { authorization: `Bearer ${LEGACY}` } })).status).toBe(200);
    // A v1 pairing code now creates a device; the prototype stores whatever token it gets.
    const { createPairCode } = await import('../intercom/store.js');
    const { code } = createPairCode(db, 'desk', 60_000);
    const paired = await (await post('/api/v1/intercom/pair', { code })).json() as PairResult;
    expect(paired.surface_id).toBe('desk');
    expect((await fetch(`${base}/api/v1/intercom/health`, { headers: { authorization: `Bearer ${paired.token}` } })).status).toBe(200);
  });

  it('marks the device connected in the device resource and records its view', async () => {
    const a = await pair('Kitchen');
    const c = await connect(a.credential);
    await until(() => welcomed(c.frames));
    c.ws.send(JSON.stringify({ type: 'view', view: `conversation:${service.surfaces.get('desk')!.conversationId}` }));
    await until(() => hub.get('desk', 'device', a.device_id)?.['view'] != null);
    expect(hub.get('desk', 'device', a.device_id)).toMatchObject({ connected: true, name: 'Kitchen' });
    service.appendConversation(service.surfaces.get('desk')!.conversationId, { id: 'm', role: 'agent', text: 'hello', created_at: 'now' });
    await until(() => c.frames.some((f) => f.event === 'conversation_append'));
    c.ws.close();
    await until(() => hub.get('desk', 'device', a.device_id)?.['connected'] === false);
  });
});

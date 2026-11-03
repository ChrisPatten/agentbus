// The phone is paired with the legacy device credential (the pre-E96 shared token). This runs the bus's own surface
// routes in-process and checks that credential authenticates on the v2 paths the new client uses first.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import WebSocket from 'ws';
import { runMigrations } from '../../../src/db/schema.ts';
import { IntercomAdapterSchema } from '../../../src/config/schema.ts';
import { IntercomService } from '../../../src/intercom/service.ts';
import { createDeviceStore } from '../../../src/surface/devices.ts';
import { createResourceHub } from '../../../src/surface/resources.ts';
import { createActionHandler, createJobStore } from '../../../src/surface/actions.ts';
import { registerIntercomRoutes } from '../../../src/http/intercom-routes.ts';
import { registerSurfaceRoutes } from '../../../src/http/surface-routes.ts';

const LEGACY = 'L'.repeat(48);
const cfg = IntercomAdapterSchema.parse({ hello_timeout_ms: 500, surfaces: [{ id: 'desk', token_env: 'DESK_TOKEN', publishers: ['peggy'], follow: { contact: 'chris', channel: 'telegram:peggy' } }] });
const calendar = { today: async () => ({ date: '2026-11-03', tz: 'America/New_York', generated_at: 'now', events: [] }) };

describe('legacy device credential on the surface v2 paths', () => {
  let db, server, hub, base, wsBase;
  const sockets = [];
  beforeEach(async () => {
    db = new Database(':memory:'); runMigrations(db);
    const devices = createDeviceStore({ db, log: () => {} });
    let svc = null;
    hub = createResourceHub({ db, sink: (s, f) => svc?.pushDelta(s, f), coalesceMs: 0 });
    const jobs = createJobStore(db, () => Date.now());
    const actions = createActionHandler({ db, hub, jobs, rateLimitPerMin: 100, keyTtlHours: 48, now: () => Date.now(), submitInbound: async () => ({ ok: true, id: 'm1', queued: true, enqueued_count: 1 }), noticeAction: (d, id, a, k) => svc.noticeAction(d, id, a, k) });
    svc = new IntercomService({ config: cfg, db, calendar, env: { DESK_TOKEN: LEGACY }, log: () => {}, submitInbound: async () => ({ ok: true, id: 'x', queued: true, enqueued_count: 1 }), surfaceApi: { devices, hub, actions, certFingerprint: 'AA:BB' } });
    server = Fastify();
    await registerIntercomRoutes(server, { config: cfg, db, service: svc, webRoot: '/nonexistent' });
    await registerSurfaceRoutes(server, { config: cfg, service: svc });
    await server.listen({ host: '127.0.0.1', port: 0 });
    const { port } = server.server.address();
    base = `http://127.0.0.1:${port}`; wsBase = `ws://127.0.0.1:${port}`;
  });
  afterEach(async () => { for (const s of sockets.splice(0)) s.terminate(); hub.stop(); await server.close(); db.close(); });
  const get = (p, t) => fetch(`${base}${p}`, { headers: { authorization: `Bearer ${t}` } });

  it('authenticates /state, /health and /actions over HTTP', async () => {
    expect((await get('/api/v1/surface/health', LEGACY)).status).toBe(200);
    const st = await get('/api/v1/surface/state', LEGACY);
    expect(st.status).toBe(200);
    expect(Object.keys((await st.json()).resources)).toEqual(expect.arrayContaining(['events', 'slots', 'sessions', 'faces']));
    expect((await get('/api/v1/surface/state', 'wrong')).status).toBe(401);
    const act = await fetch(`${base}/api/v1/surface/actions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${LEGACY}` }, body: JSON.stringify({ object: 'events:none', action_id: 'a', idempotency_key: 'k1' }) });
    expect(act.status).not.toBe(401);
  });

  it('answers a protocol 2 hello on /api/v1/surface/ws with a v2 welcome, then deltas', async () => {
    const frames = [];
    const ws = new WebSocket(`${wsBase}/api/v1/surface/ws`); sockets.push(ws);
    await new Promise((r) => { ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', token: LEGACY, cursor: 0, client: 'intercom-web/0.2', protocol: 2, revs: {} }))); ws.on('message', (m) => { frames.push(JSON.parse(m.toString())); if (frames.some((f) => f.type === 'welcome')) setTimeout(r, 80); }); });
    expect(frames.find((f) => f.type === 'welcome')).toMatchObject({ version: 2, surface_id: 'desk', device_id: 'desk-legacy', scope: 'interactive' });
    hub.apply('desk', 'events', [{ op: 'set', id: 'x', value: { id: 'x', kind: 'event', title: 'X', level: 'info', actions: [] } }]);
    await new Promise((r) => setTimeout(r, 100));
    expect(frames.find((f) => f.type === 'delta' && f.resource === 'events')).toMatchObject({ base_rev: expect.any(Number), rev: expect.any(Number) });
  });
});

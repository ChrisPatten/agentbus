import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { runMigrations } from '../db/schema.js';
import { MessageQueue } from '../core/queue.js';
import { AdapterRegistry } from '../core/registry.js';
import { PipelineEngine } from '../pipeline/engine.js';
import { IntercomAdapterSchema, NotificationsConfigSchema, type AppConfig } from '../config/schema.js';
import { IntercomService } from '../intercom/service.js';
import type { CalendarFeed } from '../intercom/calendar.js';
import { createHttpServer } from './api.js';
import { registerIntercomRoutes } from './intercom-routes.js';
import { registerNotificationRoutes, isNotificationsApiUrl } from './notifications-routes.js';

const SURFACE_TOKEN = 's'.repeat(48);
const API_TOKEN = 'automation-token-123456';
const icfg = IntercomAdapterSchema.parse({ hello_timeout_ms: 300, surfaces: [
  { id: 'iphone-proto', token_env: 'T', follow: { contact: 'chris', channel: 'telegram:peggy' } },
] });
const ncfg = NotificationsConfigSchema.parse({ enabled: true, api_tokens_env: ['NOTIFY_TOKEN_AUTOMATIONS'] });
const calendar = { today: async () => ({ date: '2026-11-01', tz: 'America/New_York', generated_at: 'now', events: [] }) } as unknown as CalendarFeed;
const env = { T: SURFACE_TOKEN, NOTIFY_TOKEN_AUTOMATIONS: API_TOKEN };

describe('notifications HTTP API and WebSocket (E89)', () => {
  let db: Database.Database; let server: FastifyInstance; let service: IntercomService; let base: string; let wsBase: string;
  const sockets: WebSocket[] = [];
  const submitted: any[] = [];

  beforeEach(async () => {
    db = new Database(':memory:'); runMigrations(db);
    service = new IntercomService({ config: icfg, db, calendar, env, log: () => {}, notifications: ncfg,
      submitInbound: async (m) => { submitted.push(m); return { ok: true, id: m.id, queued: true, enqueued_count: 1 } as never; } });
    server = Fastify();
    await registerIntercomRoutes(server, { config: icfg, db, service, webRoot: '/nonexistent' });
    registerNotificationRoutes(server, { config: ncfg, service, env });
    await server.listen({ host: '127.0.0.1', port: 0 });
    const port = (server.server.address() as { port: number }).port;
    base = `http://127.0.0.1:${port}`; wsBase = `ws://127.0.0.1:${port}`;
    submitted.length = 0;
  });
  afterEach(async () => { for (const s of sockets.splice(0)) s.terminate(); await server.close(); db.close(); });

  const call = (method: string, path: string, body?: unknown, token: string | null = API_TOKEN) => fetch(`${base}${path}`, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
  const until = async (fn: () => boolean) => { for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 10)); expect(fn()).toBe(true); };
  function open(): Promise<{ ws: WebSocket; frames: any[] }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${wsBase}/api/v1/intercom/ws`); sockets.push(ws);
      const frames: any[] = [];
      ws.on('message', (d) => frames.push(JSON.parse(d.toString())));
      ws.on('open', () => { ws.send(JSON.stringify({ type: 'hello', token: SURFACE_TOKEN })); resolve({ ws, frames }); });
      ws.on('error', reject);
    });
  }

  describe('auth, validation and limits', () => {
    it('requires a Bearer token from notifications.api_tokens_env', async () => {
      const body = { title: 'Hi', source: 'cron' };
      expect((await call('POST', '/api/v1/notifications', body, null)).status).toBe(401);
      expect((await call('POST', '/api/v1/notifications', body, 'wrong-token-wrong-token')).status).toBe(401);
      expect((await call('POST', '/api/v1/notifications', body, SURFACE_TOKEN)).status).toBe(401); // a surface token is not an API token
      expect((await call('GET', '/api/v1/notifications', undefined, null)).status).toBe(401);
      expect((await call('PATCH', '/api/v1/notifications/x', { state: 'resolved' }, null)).status).toBe(401);
      expect((await call('POST', '/api/v1/notifications', body)).status).toBe(201);
    });

    it('answers 400 on validation errors', async () => {
      for (const bad of [{ source: 's' }, { title: 't' }, { title: 't', source: 's', level: 'loud' }, { title: 't', source: 's', extra: 1 },
        { title: 't', source: 's', actions: [{ label: 'a' }, { label: 'b' }, { label: 'c' }, { label: 'd' }] }, { title: 't', source: 's', actions: [{ label: 'x'.repeat(25) }] }]) {
        const res = await call('POST', '/api/v1/notifications', bad);
        expect(res.status, JSON.stringify(bad)).toBe(400);
        expect((await res.json() as any).error).toBe('invalid_body');
      }
      expect((await call('PATCH', '/api/v1/notifications', { state: 'resolved' })).status).toBe(400);   // neither id nor key
      expect((await call('GET', '/api/v1/notifications?state=bogus')).status).toBe(400);
    });

    it('limits the body to 8 KB', async () => {
      const res = await call('POST', '/api/v1/notifications', { title: 't', source: 's', body: 'x'.repeat(9000) });
      expect(res.status).toBe(413);
    });

    it('answers 429 after 30 writes per minute for one source, other sources unaffected', async () => {
      for (let i = 0; i < 30; i++) expect((await call('POST', '/api/v1/notifications', { title: `n${i}`, source: 'noisy' })).status).toBe(201);
      const res = await call('POST', '/api/v1/notifications', { title: 'one more', source: 'noisy' });
      expect(res.status).toBe(429);
      expect(res.headers.get('retry-after')).toBe('60');
      expect((await call('POST', '/api/v1/notifications', { title: 'fine', source: 'quiet' })).status).toBe(201);
    });
  });

  describe('create, update, list', () => {
    it('creates, upserts by key, patches by id and by key, and lists by state', async () => {
      const a = await (await call('POST', '/api/v1/notifications', { title: 'Bill due today', key: 'bill', source: 'cron', level: 'urgent' })).json() as any;
      expect(a).toMatchObject({ ok: true, key: 'bill', state: 'active', created: true });
      const again = await call('POST', '/api/v1/notifications', { title: 'Bill due today!', key: 'bill', source: 'cron' });
      expect(again.status).toBe(200);
      expect((await again.json() as any).id).toBe(a.id);
      const p = await (await call('PATCH', '/api/v1/notifications?key=bill', { level: 'info' })).json() as any;
      expect(p).toMatchObject({ ok: true, id: a.id });
      expect((await call('PATCH', '/api/v1/notifications/nope', { title: 'x' })).status).toBe(404);
      const open = await (await call('GET', '/api/v1/notifications')).json() as any;
      expect(open.notifications).toHaveLength(1);
      expect(open.notifications[0]).toMatchObject({ id: a.id, title: 'Bill due today!', level: 'info', source: 'cron' });
      expect((await call('PATCH', `/api/v1/notifications/${a.id}`, { state: 'resolved' })).status).toBe(200);
      expect((await call('PATCH', `/api/v1/notifications/${a.id}`, { title: 'late' })).status).toBe(409);
      expect((await (await call('GET', '/api/v1/notifications?state=open')).json() as any).notifications).toHaveLength(0);
      expect((await (await call('GET', '/api/v1/notifications?state=all')).json() as any).notifications).toHaveLength(1);
    });

    it('the internal route used by the MCP tools needs no Bearer token (shared bus auth applies instead)', async () => {
      const res = await call('POST', '/api/v1/internal/notifications', { title: 'From a tool', source: 'Agent: peggy' }, null);
      expect(res.status).toBe(201);
      expect((await call('GET', '/api/v1/internal/notifications', undefined, null)).status).toBe(200);
    });
  });

  describe('WebSocket', () => {
    it('curl-style POST reaches a connected surface as notification + attention; ack clears attention', async () => {
      const { ws, frames } = await open();
      await until(() => frames.some((f) => f.type === 'event' && f.event === 'attention')); // snapshot attention after welcome
      expect(frames.find((f) => f.type === 'event' && f.event === 'attention').data).toEqual({ level: 'none', count: 0 });
      frames.length = 0;
      const created = await (await call('POST', '/api/v1/notifications', { title: 'Draft awaiting OK', source: 'Peggy', actions: [{ label: 'Send it' }] })).json() as any;
      await until(() => frames.some((f) => f.event === 'notification') && frames.some((f) => f.event === 'attention'));
      expect(frames.find((f) => f.event === 'notification')).toMatchObject({ seq: expect.any(Number), data: { id: created.id, state: 'active' } });
      expect(frames.find((f) => f.event === 'attention').data).toEqual({ level: 'attention', count: 1 });
      frames.length = 0;
      ws.send(JSON.stringify({ type: 'notification_ack', id: created.id }));
      await until(() => frames.some((f) => f.event === 'attention'));
      expect(frames.find((f) => f.event === 'notification').data.state).toBe('acknowledged');
      expect(frames.find((f) => f.event === 'attention').data).toEqual({ level: 'none', count: 0 });
      ws.send(JSON.stringify({ type: 'notification_ack', id: 'missing' }));
      await until(() => frames.some((f) => f.type === 'error'));
      expect(frames.find((f) => f.type === 'error')).toEqual({ type: 'error', code: 'notification_not_found' });
    });

    it('notification_action produces the ack frame and an inbound with the note; a repeat is idempotent', async () => {
      const { ws, frames } = await open();
      await until(() => frames.some((f) => f.event === 'attention'));
      const created = await (await call('POST', '/api/v1/notifications', { title: 'Draft to Kate', source: 'Peggy', actions: [{ label: 'Send it', style: 'success' }] })).json() as any;
      await until(() => frames.some((f) => f.event === 'notification'));
      frames.length = 0;
      const frame = { type: 'notification_action', client_msg_id: 'tap-1', id: created.id, index: 0 };
      ws.send(JSON.stringify(frame));
      await until(() => frames.some((f) => f.type === 'ack'));
      const ack = frames.find((f) => f.type === 'ack');
      expect(ack).toMatchObject({ client_msg_id: 'tap-1', status: 'queued', interaction_id: expect.any(String) });
      expect(submitted).toHaveLength(1);
      expect(submitted[0].payload.body).toBe('[tapped] Send it');
      ws.send(JSON.stringify(frame));
      await until(() => frames.filter((f) => f.type === 'ack').length === 2);
      expect(frames.filter((f) => f.type === 'ack')[1]).toEqual(ack);
      expect(submitted).toHaveLength(1);
    });
  });

  it('skips X-Bus-Token for the public notification routes only when enabled', async () => {
    expect(isNotificationsApiUrl('/api/v1/notifications?key=a')).toBe(true);
    expect(isNotificationsApiUrl('/api/v1/internal/notifications')).toBe(false);
    vi.stubEnv('NOTIFY_TOKEN_AUTOMATIONS', API_TOKEN);
    const db2 = new Database(':memory:'); runMigrations(db2);
    const config = { bus: { auth_token: 'bus-secret', http_port: 0 }, adapters: { intercom: icfg }, notifications: ncfg, contacts: {}, agents: {}, pipeline: { routes: [] } } as unknown as AppConfig;
    const svc = new IntercomService({ config: icfg, db: db2, env, log: () => {}, calendar, notifications: ncfg, submitInbound: async () => ({ ok: true, queued: false, reason: 'x' }) });
    const s = await createHttpServer({ config, db: db2, registry: new AdapterRegistry(), queue: new MessageQueue(db2), pipeline: new PipelineEngine(), intercom: svc });
    const post = (url: string, headers: Record<string, string>) => s.inject({ method: 'POST', url, headers: { 'content-type': 'application/json', ...headers }, payload: { title: 't', source: 's' } });
    expect((await post('/api/v1/notifications', {})).statusCode).toBe(401);                                          // Bearer auth, not bus auth
    expect((await post('/api/v1/notifications', { authorization: `Bearer ${API_TOKEN}` })).statusCode).toBe(201);   // no X-Bus-Token needed
    expect((await post('/api/v1/internal/notifications', {})).statusCode).toBe(401);                                 // bus auth applies
    expect((await post('/api/v1/internal/notifications', { 'x-bus-token': 'bus-secret' })).statusCode).toBe(201);
    await s.close(); db2.close(); vi.unstubAllEnvs();
  });
});

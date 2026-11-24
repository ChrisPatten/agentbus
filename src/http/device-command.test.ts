import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { runMigrations } from '../db/schema.js';
import { IntercomAdapterSchema } from '../config/schema.js';
import { IntercomService } from '../intercom/service.js';
import type { CalendarFeed } from '../intercom/calendar.js';
import { registerIntercomRoutes } from './intercom-routes.js';
import { registerSurfacePublishRoutes } from './surface-publish-routes.js';
import type { JobStore, ResourceHub } from '../surface/types.js';

const TOKEN = 't'.repeat(48);
const cfg = IntercomAdapterSchema.parse({
  hello_timeout_ms: 300,
  surfaces: [
    { id: 'compact', token_env: 'T', publishers: ['peggy'], follow: { contact: 'chris', channel: 'telegram:peggy' } },
    { id: 'other', token_env: 'T2', publishers: ['peggy'], follow: { contact: 'chris', channel: 'telegram:peggy' } },
  ],
});
const calendar = { today: async () => ({ date: '2026-11-01', tz: 'America/New_York', generated_at: 'now', events: [] }) } as unknown as CalendarFeed;
const OPS = [{ op: 'pomodoro', usage: 'start [focus] | stop | status' }, { op: 'chime', usage: 'chime' }];

describe('device commands (bus side)', () => {
  let db: Database.Database; let server: FastifyInstance; let service: IntercomService; let wsBase: string; let logs: string[];
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    db = new Database(':memory:'); runMigrations(db); logs = [];
    service = new IntercomService({ config: cfg, db, calendar, env: { T: TOKEN, T2: 'u'.repeat(40) }, log: (l) => logs.push(l),
      submitInbound: async () => ({ ok: true, id: 'x', queued: true, enqueued_count: 1 }) });
    server = Fastify();
    await registerIntercomRoutes(server, { config: cfg, db, service });
    registerSurfacePublishRoutes(server, {
      db, hub: {} as ResourceHub, jobs: {} as JobStore,
      surfaces: () => [...service.surfaces.values()].map((s) => ({ id: s.id, follow: service.followJson(s), publishers: s.publishers })),
      sendCommand: (surfaceId, input) => service.sendCommand(surfaceId, { ...input, waitMs: 250 }),
    });
    await server.listen({ host: '127.0.0.1', port: 0 });
    wsBase = `ws://127.0.0.1:${(server.server.address() as { port: number }).port}`;
  });
  afterEach(async () => { for (const s of sockets.splice(0)) s.terminate(); await server.close(); db.close(); });

  async function device(hello: Record<string, unknown> = { ops: OPS }, path = '/api/v1/intercom/ws', token = TOKEN) {
    const frames: any[] = [];
    const ws = new WebSocket(`${wsBase}${path}`);
    sockets.push(ws);
    ws.on('message', (d, bin) => { if (!bin) frames.push(JSON.parse(d.toString())); });
    await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
    ws.send(JSON.stringify({ type: 'hello', token, cursor: 0, client: 'compact-fw', ...hello }));
    await until(() => frames.some((f) => f.type === 'welcome'));
    return { ws, frames, commands: () => frames.filter((f) => f.type === 'command') };
  }
  const until = async (fn: () => boolean) => { for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 10)); expect(fn()).toBe(true); };
  const run = async (body: Record<string, unknown>, surface = 'compact') => {
    const res = await server.inject({ method: 'POST', url: `/api/v1/surface-publish/${surface}/command`, payload: { agent_id: 'peggy-pool-1', ...body } });
    return { status: res.statusCode, body: res.json() as Record<string, any> };
  };

  it('forwards a command frame and returns the device result', async () => {
    const d = await device();
    const pending = run({ op: 'pomodoro', args: 'start 25 5 15', ttl_s: 60 });
    await until(() => d.commands().length === 1);
    const cmd = d.commands()[0];
    expect(cmd).toMatchObject({ type: 'command', op: 'pomodoro', args: 'start 25 5 15', ttl_s: 60 });
    expect(typeof cmd.id).toBe('string');
    d.ws.send(JSON.stringify({ type: 'command_result', id: cmd.id, ok: true, data: { phase: 'focus' } }));
    expect((await pending).body).toEqual({ ok: true, data: { phase: 'focus' }, surface: 'compact' });
  });

  it('passes object args and device failure reasons through', async () => {
    const d = await device();
    const pending = run({ op: 'face', args: { name: 'nope' } });
    await until(() => d.commands().length === 1);
    expect(d.commands()[0].args).toEqual({ name: 'nope' });
    expect(d.commands()[0].ttl_s).toBe(120);
    d.ws.send(JSON.stringify({ type: 'command_result', id: d.commands()[0].id, ok: false, reason: 'bad_args', data: 'face thread|now|agents|day|settings' }));
    expect((await pending).body).toMatchObject({ ok: false, reason: 'bad_args', data: 'face thread|now|agents|day|settings' });
  });

  it('answers offline at once and never queues', async () => {
    expect((await run({ op: 'chime' })).body).toMatchObject({ ok: false, reason: 'offline' });
    const d = await device();
    // A device that connects later sees nothing from the earlier command.
    await new Promise((r) => setTimeout(r, 50));
    expect(d.commands()).toHaveLength(0);
  });

  it('is offline when only another surface has a client', async () => {
    const d = await device({ ops: OPS }, '/api/v1/intercom/ws', 'u'.repeat(40));
    expect((await run({ op: 'chime' })).body).toMatchObject({ ok: false, reason: 'offline' });
    d.ws.close();
  });

  it('times out when the device stays silent, and ignores a late result', async () => {
    const d = await device();
    const r = await run({ op: 'chime' });
    expect(r.body).toMatchObject({ ok: false, reason: 'timeout' });
    d.ws.send(JSON.stringify({ type: 'command_result', id: d.commands()[0].id, ok: true }));
    await until(() => logs.some((l) => l.includes('"device_command_result"') && l.includes('"awaited":false')));
  });

  it('wait:false returns once sent', async () => {
    const d = await device();
    const r = await run({ op: 'chime', wait: false });
    expect(r.body).toMatchObject({ ok: true, data: { sent: true } });
    await until(() => d.commands().length === 1);
    expect(r.body['data'].id).toBe(d.commands()[0].id);
  });

  it('ignores a result with an unknown id or from another surface', async () => {
    const a = await device();
    const b = await device({ ops: OPS }, '/api/v1/intercom/ws', 'u'.repeat(40));
    const pending = run({ op: 'chime' });
    await until(() => a.commands().length === 1);
    b.ws.send(JSON.stringify({ type: 'command_result', id: a.commands()[0].id, ok: true, data: 'forged' }));
    a.ws.send(JSON.stringify({ type: 'command_result', id: 'nope', ok: true }));
    a.ws.send(JSON.stringify({ type: 'command_result', id: a.commands()[0].id, ok: true, data: 'real' }));
    expect((await pending).body).toMatchObject({ ok: true, data: 'real' });
  });

  it('answers help from the cached hello ops without a device round trip', async () => {
    const d = await device();
    const help = (await run({ op: 'help' })).body;
    expect(help['data'].slice(0, 2)).toEqual(OPS);
    expect(help['data'].map((o: { op: string }) => o.op)).toEqual(expect.arrayContaining(['event.publish', 'event.remove', 'widget.write', 'widget.remove']));
    expect((await run({ op: 'help', args: 'pomodoro' })).body).toMatchObject({ ok: true, data: OPS[0] });
    expect((await run({ op: 'help', args: 'nope' })).body).toMatchObject({ ok: false, reason: 'unknown_op' });
    expect(d.commands()).toHaveLength(0);
    // Still answers after the device disconnects.
    d.ws.close();
    await until(() => service.connectedClients('compact') === 0);
    expect((await run({ op: 'help' })).body.data.slice(0, 2)).toEqual(OPS);
    expect((await run({ op: 'chime' })).body.reason).toBe('offline');
  });

  it('a later hello or capabilities frame refreshes the cache', async () => {
    const d = await device();
    d.ws.send(JSON.stringify({ type: 'capabilities', ops: [{ op: 'power', usage: 'sleep|wake' }, { bad: 1 }] }));
    await until(() => service.surfaceOps('compact').length === 1);
    expect((await run({ op: 'help' })).body.data[0]).toEqual({ op: 'power', usage: 'sleep|wake' });
  });

  it('prefers a client that declared ops over a plain web client', async () => {
    const dev = await device();
    const web = await device({});
    const pending = run({ op: 'chime' });
    await until(() => dev.commands().length === 1);
    expect(web.commands()).toHaveLength(0);
    dev.ws.send(JSON.stringify({ type: 'command_result', id: dev.commands()[0].id, ok: true }));
    expect((await pending).body.ok).toBe(true);
  });

  it('logs each command and its result', async () => {
    const d = await device();
    const pending = run({ op: 'chime', args: 'x' });
    await until(() => d.commands().length === 1);
    d.ws.send(JSON.stringify({ type: 'command_result', id: d.commands()[0].id, ok: true }));
    await pending;
    for (const evt of ['device_command"', 'device_command_result', 'device_command_done']) expect(logs.some((l) => l.includes(`"evt":"${evt}`) || l.includes(evt))).toBe(true);
  });

  it('refuses agents that are not publishers, unknown surfaces and a missing op', async () => {
    const res = await server.inject({ method: 'POST', url: '/api/v1/surface-publish/compact/command', payload: { agent_id: 'mallory', op: 'chime' } });
    expect(res.statusCode).toBe(403);
    expect((await server.inject({ method: 'POST', url: '/api/v1/surface-publish/nope/command', payload: { agent_id: 'peggy', op: 'chime' } })).statusCode).toBe(404);
    expect((await server.inject({ method: 'POST', url: '/api/v1/surface-publish/compact/command', payload: { agent_id: 'peggy' } })).statusCode).toBe(400);
    expect((await server.inject({ method: 'POST', url: '/api/v1/surface-publish/compact/command', payload: { op: 'chime' } })).statusCode).toBe(400);
  });
});

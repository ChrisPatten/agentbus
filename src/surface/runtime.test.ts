/**
 * E96 — the surface runtime as bus-core wires it: agent publishing reaches every paired
 * device and its button fires the job; answer-needed shows as needs_you and clears on a reply.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { runMigrations } from '../db/schema.js';
import { AppConfigSchema, type AppConfig } from '../config/schema.js';
import { IntercomService } from '../intercom/service.js';
import type { CalendarFeed } from '../intercom/calendar.js';
import type { InboundMessage } from '../http/api.js';
import { registerSurfaceServer } from '../http/surface-routes.js';
import { registerSurfacePublishRoutes } from '../http/surface-publish-routes.js';
import { createSurfaceRuntime, type SurfaceRuntime } from './runtime.js';
import { setAnswerNeeded } from './flags.js';
import { ChoiceStore } from '../choices/store.js';
import { notifyInboundAccepted } from './inbound-hook.js';
import type { PairResult } from './types.js';
import type { MessageEnvelope } from '../types/envelope.js';

const calendar = { today: async () => ({ date: '2026-11-03', tz: 'America/New_York', generated_at: 'now', events: [] }) } as unknown as CalendarFeed;

describe('surface runtime', () => {
  let db: Database.Database; let server: FastifyInstance; let service: IntercomService; let runtime: SurfaceRuntime;
  let config: AppConfig; let base: string; let wsBase: string;
  const injected: InboundMessage[] = [];
  const sockets: WebSocket[] = [];
  const finalized: string[] = [];

  beforeEach(async () => {
    db = new Database(':memory:'); runMigrations(db);
    injected.length = 0;
    config = AppConfigSchema.parse({
      bus: { db_path: ':memory:' },
      adapters: { intercom: { hello_timeout_ms: 500, surfaces: [{ id: 'desk', publishers: ['peggy'], follow: { contact: 'chris', channel: 'telegram:peggy' } }] } },
      surface_api: { delta_coalesce_ms: 0 },
      memory: {}, pipeline: { routes: [] },
    });
    finalized.length = 0;
    runtime = createSurfaceRuntime({
      config, db, log: () => {},
      registry: { lookupPrimaryByChannel: () => ({ finalizeChoicePrompt: async (p: { id: string }) => { finalized.push(p.id); } }) as never },
      submitInbound: async (m) => { injected.push(m); return { ok: true, id: 'q', queued: true, enqueued_count: 1 }; },
    });
    service = new IntercomService({
      config: config.adapters.intercom!, db, calendar, env: {}, log: () => {},
      submitInbound: async () => ({ ok: true, id: 'x', queued: true, enqueued_count: 1 }),
      surfaceApi: runtime.surfaceApi,
    });
    runtime.bind(service);
    server = Fastify();
    await registerSurfaceServer(server, { config, db, intercom: service });
    registerSurfacePublishRoutes(server, {
      db, hub: runtime.hub, jobs: runtime.jobs,
      surfaces: () => [...service.surfaces.values()].map((s) => ({ id: s.id, follow: service.followJson(s), publishers: s.publishers })),
    });
    await server.listen({ host: '127.0.0.1', port: 0 });
    const { port } = server.server.address() as { port: number };
    base = `http://127.0.0.1:${port}`; wsBase = `ws://127.0.0.1:${port}`;
  });
  afterEach(async () => {
    for (const s of sockets.splice(0)) s.terminate();
    runtime.stop(); await server.close(); db.close();
  });

  const send = (method: string, path: string, body?: unknown, token?: string) => fetch(`${base}${path}`, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const until = async (fn: () => boolean) => { for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 10)); expect(fn()).toBe(true); };
  async function pairAndConnect(name: string) {
    const { code } = runtime.devices.createPairCode({ surfaceId: 'desk', name, ttlMs: 60_000 });
    const paired = await (await send('POST', '/api/v1/surface/pair', { code })).json() as PairResult;
    const frames: any[] = [];
    const ws = new WebSocket(`${wsBase}/api/v1/surface/ws`);
    sockets.push(ws);
    ws.on('message', (d) => frames.push(JSON.parse(d.toString())));
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ type: 'hello', token: paired.credential, protocol: 2 }));
    await until(() => frames.some((f) => f.type === 'welcome'));
    return { paired, frames };
  }

  it('an agent-published Event with a button reaches both devices, and the button fires once', async () => {
    const a = await pairAndConnect('Kitchen'); const b = await pairAndConnect('Desk');
    const res = await send('PUT', '/api/v1/surface-publish/desk/events/pickup', {
      agent_id: 'peggy', title: 'Pick up Sam at 3:30', level: 'attention',
      actions: [{ id: 'here', label: "I'm here", run: { body: 'Chris is at the school gate' } }],
    });
    expect(res.status).toBe(201);
    const got = (frames: any[]) => frames.some((f) => f.type === 'delta' && f.resource === 'events' && f.ops?.some((o: any) => o.id === 'pickup'));
    await until(() => got(a.frames) && got(b.frames));
    const tap = { object: 'events:pickup', action_id: 'here', idempotency_key: 't1' };
    expect(await (await send('POST', '/api/v1/surface/actions', tap, a.paired.credential)).json()).toMatchObject({ status: 'done' });
    expect(await (await send('POST', '/api/v1/surface/actions', tap, b.paired.credential)).json()).toMatchObject({ status: 'already_done' });
    expect(injected.map((m) => m.payload)).toEqual([{ type: 'text', body: 'Chris is at the school gate' }]);
  });

  it('rejects an over-limit or unauthorised publish with a readable error', async () => {
    const long = await send('PUT', '/api/v1/surface-publish/desk/events/x', { agent_id: 'peggy', title: 'x'.repeat(120) });
    expect(long.status).toBe(400);
    expect(JSON.stringify(await long.json())).toMatch(/80/);
    const other = await send('PUT', '/api/v1/surface-publish/desk/events/x', { agent_id: 'stranger', title: 'Hi' });
    expect(other.status).toBe(403);
    expect(JSON.stringify(await other.json())).toMatch(/publishers/);
    expect(runtime.hub.get('desk', 'events', 'x')).toBeNull();
  });

  it('answer_needed shows as needs_you until the contact replies; a message without it never sets it', async () => {
    const conversationId = service.surfaces.get('desk')!.conversationId;
    runtime.refreshSessions();
    expect(Object.values(runtime.hub.snapshot('desk', 'sessions').items).some((s) => s['needs_you'] === true)).toBe(false);
    setAnswerNeeded(db, { conversationId, messageId: 'm1', agentId: 'peggy' });
    runtime.refreshSessions();
    const flagged = Object.values(runtime.hub.snapshot('desk', 'sessions').items).find((s) => s['conversation_id'] === conversationId);
    expect(flagged).toMatchObject({ needs_you: true, needs_you_message_id: 'm1' });
    const reply: MessageEnvelope = {
      id: 'in1', timestamp: 'now', channel: 'telegram:peggy', topic: 'general', sender: 'contact:chris', recipient: '',
      reply_to: null, priority: 'normal', payload: { type: 'text', body: 'Yes, go ahead' }, metadata: {},
    };
    notifyInboundAccepted(reply, conversationId, false);
    const after = Object.values(runtime.hub.snapshot('desk', 'sessions').items).find((s) => s['conversation_id'] === conversationId);
    expect(after?.['needs_you'] ?? false).toBe(false);
  });
  it('a conversation button tapped on a device answers the prompt, injects the pick, clears needs_you and the keyboard', async () => {
    const a = await pairAndConnect('Kitchen');
    const conversationId = service.surfaces.get('desk')!.conversationId;
    db.prepare(`INSERT INTO conversation_registry(id,contact_id,channel,topic,first_seen,last_seen) VALUES (?,?,?,?,?,?)`).run(conversationId, 'chris', 'telegram:peggy', 'general', 'x', 'x');
    db.prepare(`INSERT INTO sessions(id,conversation_id,channel,contact_id,started_at,last_activity,message_count) VALUES ('s1',?,?,?,?,?,0)`).run(conversationId, 'telegram:peggy', 'chris', 'x', 'x');
    db.prepare(`INSERT INTO transcripts(id,message_id,conversation_id,session_id,created_at,channel,contact_id,direction,body,metadata)
      VALUES ('t1','q1',?,'s1',?,'telegram:peggy','chris','outbound','Book the 3pm?','{}')`).run(conversationId, new Date().toISOString());
    new ChoiceStore(db).create({ id: 'p1', channel: 'telegram:peggy', topic: 'general', contactId: 'chris', labels: ['Book it', 'Skip'], platformMessageId: '5:6', busMessageId: 'q1' }, 3600_000);
    setAnswerNeeded(db, { conversationId, messageId: 'q1', agentId: 'peggy' });
    runtime.refreshSessions();
    expect(Object.values(runtime.hub.snapshot('desk', 'sessions').items).some((x) => x['needs_you'] === true)).toBe(true);

    const res = await (await send('POST', '/api/v1/surface/actions', { object: `conversations:${conversationId}`, action_id: '0', idempotency_key: 'c1' }, a.paired.credential)).json();
    expect(res).toMatchObject({ status: 'done' });
    expect(injected.at(-1)).toMatchObject({ sender: 'contact:chris', reply_to: 'q1', payload: { type: 'text', body: '[tapped] Book it' } });
    expect(finalized).toEqual(['p1']);
    expect(Object.values(runtime.hub.snapshot('desk', 'sessions').items).some((x) => x['needs_you'] === true)).toBe(false);
    expect(await (await send('POST', '/api/v1/surface/actions', { object: `conversations:${conversationId}`, action_id: '1', idempotency_key: 'c2' }, a.paired.credential)).json()).toMatchObject({ status: 'already_done' });
  });
});

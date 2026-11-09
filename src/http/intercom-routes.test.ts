import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../db/schema.js';
import { MessageQueue } from '../core/queue.js';
import { AdapterRegistry } from '../core/registry.js';
import { PipelineEngine } from '../pipeline/engine.js';
import { IntercomAdapterSchema, type AppConfig } from '../config/schema.js';
import { IntercomService } from '../intercom/service.js';
import type { CalendarFeed } from '../intercom/calendar.js';
import { appendEvent, createPairCode } from '../intercom/store.js';
import { createHttpServer } from './api.js';
import { isIntercomUrl, registerIntercomRoutes, resolveStaticPath } from './intercom-routes.js';
import { VERSION } from '../version.js';

const TOKEN = 't'.repeat(48);
const cfg = IntercomAdapterSchema.parse({
  hello_timeout_ms: 300, pair_rate_limit_per_min: 4,
  voice: { speech: { quiet_hours: { enabled: false } } },
  surfaces: [
    { id: 'iphone-proto', token_env: 'T', follow: { contact: 'chris', channel: 'telegram:peggy' } },
    { id: 'other', token_env: 'T2', follow: { contact: 'chris', channel: 'telegram:peggy' } },
  ],
});
const calendar = { today: async () => ({ date: '2026-11-01', tz: 'America/New_York', generated_at: 'now', events: [{ id: 'e', title: 'Dentist' }] }) } as unknown as CalendarFeed;

describe('Intercom routes', () => {
  let db: Database.Database; let server: FastifyInstance; let service: IntercomService; let webRoot: string; let base: string; let wsBase: string;
  let inbound: { body: string; metadata: Record<string, unknown> | undefined }[] = [];
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    db = new Database(':memory:'); runMigrations(db);
    webRoot = mkdtempSync(join(tmpdir(), 'intercom-web-'));
    mkdirSync(join(webRoot, 'sub'));
    writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>Intercom</title>');
    writeFileSync(join(webRoot, 'app.js'), 'export const a = 1;');
    writeFileSync(join(webRoot, 'manifest.webmanifest'), '{}');
    writeFileSync(join(webRoot, 'sub', 'index.html'), 'sub index');
    writeFileSync(join(webRoot, '..', 'intercom-secret.txt'), 'TOPSECRETCONTENT');
    inbound = [];
    service = new IntercomService({ config: cfg, db, calendar, env: { T: TOKEN, T2: 'u'.repeat(40) }, log: () => {},
      transcriber: { name: 'fake', transcribe: async (wav) => (wav.length > 44 ? 'Turn on the porch light' : '') },
      synthesizer: { name: 'fake-tts', rate: 16000, async *stream() { yield new Uint8Array(4000); yield new Uint8Array(2400); } },
      submitInbound: async (m) => { inbound.push({ body: m.payload.type === 'text' ? m.payload.body : '', metadata: m.metadata }); return { ok: true, id: 'x', queued: true, enqueued_count: 1 }; } });
    server = Fastify();
    await registerIntercomRoutes(server, { config: cfg, db, service, webRoot });
    await server.listen({ host: '127.0.0.1', port: 0 });
    const addr = server.server.address() as { port: number };
    base = `http://127.0.0.1:${addr.port}`; wsBase = `ws://127.0.0.1:${addr.port}`;
  });
  afterEach(async () => {
    for (const s of sockets.splice(0)) s.terminate();
    await server.close(); db.close();
    rmSync(webRoot, { recursive: true, force: true }); rmSync(join(webRoot, '..', 'intercom-secret.txt'), { force: true });
  });

  function open(): Promise<{ ws: WebSocket; frames: any[]; closed: Promise<number> }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${wsBase}/api/v1/intercom/ws`);
      sockets.push(ws);
      const frames: any[] = [];
      ws.on('message', (d, isBinary) => { if (!isBinary) frames.push(JSON.parse(d.toString())); });
      const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
      ws.on('open', () => resolve({ ws, frames, closed }));
      ws.on('error', reject);
    });
  }
  const until = async (fn: () => boolean) => { for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 10)); expect(fn()).toBe(true); };
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  describe('pairing', () => {
    it('exchanges a one-time code for the surface token, once', async () => {
      const { code } = createPairCode(db, 'iphone-proto', 60_000);
      const res = await post('/api/v1/intercom/pair', { code });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ surface_id: 'iphone-proto', token: TOKEN });
      expect((await post('/api/v1/intercom/pair', { code })).status).toBe(410);
    });
    it('answers 404 for an unknown code, 410 for an expired one and 400 for a bad body', async () => {
      expect((await post('/api/v1/intercom/pair', { code: 'ZZZZZ-ZZZZZ' })).status).toBe(404);
      const { code } = createPairCode(db, 'iphone-proto', -1000);
      expect((await post('/api/v1/intercom/pair', { code })).status).toBe(410);
      expect((await post('/api/v1/intercom/pair', {})).status).toBe(400);
      expect((await post('/api/v1/intercom/pair', { code: 5 })).status).toBe(400);
    });
    it('rate limits per remote address', async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) statuses.push((await post('/api/v1/intercom/pair', { code: 'AAAAA-BBBBB' })).status);
      expect(statuses).toEqual([404, 404, 404, 404, 429, 429]);
    });
    it('does not hand out the token of a surface that is not active', async () => {
      const { code } = createPairCode(db, 'ghost', 60_000);
      expect((await post('/api/v1/intercom/pair', { code })).status).toBe(503);
    });
  });

  describe('health and today', () => {
    it('requires the surface token', async () => {
      expect((await fetch(`${base}/api/v1/intercom/health`)).status).toBe(401);
      expect((await fetch(`${base}/api/v1/intercom/health`, { headers: { authorization: 'Bearer nope' } })).status).toBe(401);
      expect((await fetch(`${base}/api/v1/intercom/today`)).status).toBe(401);
    });
    it('reports surface, follow target, version and connected clients', async () => {
      const { ws, frames } = await open();
      ws.send(JSON.stringify({ type: 'hello', token: TOKEN, cursor: 0 }));
      await until(() => frames.some((f) => f.event === 'calendar'));
      const res = await fetch(`${base}/api/v1/intercom/health`, { headers: { authorization: `Bearer ${TOKEN}` } });
      expect(await res.json()).toMatchObject({ surface_id: 'iphone-proto', follow: { contact: 'chris', channel: 'telegram:peggy' }, version: VERSION, connected_clients: 1 });
    });
    it('serves the calendar payload', async () => {
      const res = await fetch(`${base}/api/v1/intercom/today`, { headers: { authorization: `Bearer ${TOKEN}` } });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ date: '2026-11-01', tz: 'America/New_York', events: [{ title: 'Dentist' }] });
    });
    it('serves the desk summary behind the surface token', async () => {
      expect((await fetch(`${base}/api/v1/intercom/desk`)).status).toBe(401);
      const res = await fetch(`${base}/api/v1/intercom/desk`, { headers: { authorization: `Bearer ${TOKEN}` } });
      expect(res.status).toBe(200);
      const body = await res.json() as { sessions: unknown[]; counts: unknown; departure: unknown };
      expect(body.sessions).toEqual([]);
      expect(body.counts).toEqual({ working: 0, needs_you: 0 });
      expect(body).toHaveProperty('departure');
    });
    it('answers 503 when the calendar cannot be read', async () => {
      const failing = new IntercomService({ config: cfg, db, env: { T: TOKEN }, log: () => {}, calendar: { today: async () => { throw new Error('x'); } } as unknown as CalendarFeed,
        submitInbound: async () => ({ ok: true, queued: false, reason: 'x' }) });
      const s2 = Fastify(); await registerIntercomRoutes(s2, { config: cfg, db, service: failing, webRoot });
      const res = await s2.inject({ url: '/api/v1/intercom/today', headers: { authorization: `Bearer ${TOKEN}` } });
      expect(res.statusCode).toBe(503);
      await s2.close();
    });
  });

  describe('WebSocket handshake', () => {
    it('welcomes a valid hello, then sends activity and calendar', async () => {
      const { ws, frames } = await open();
      ws.send(JSON.stringify({ type: 'hello', token: TOKEN, cursor: 0, client: 'intercom-web/0.1' }));
      await until(() => frames.some((f) => f.event === 'calendar'));
      expect(frames[0]).toMatchObject({ type: 'welcome', version: 1, surface_id: 'iphone-proto', follow: { contact: 'chris', channel: 'telegram:peggy', conversation_id: expect.stringMatching(/^[0-9a-f]{64}$/) }, latest_seq: 0, reset: false });
      expect(frames[1]).toMatchObject({ type: 'event', event: 'activity', data: { state: 'idle', status_text: null, interaction_id: null } });
      expect(frames[2]).toMatchObject({ type: 'event', event: 'calendar', data: { date: '2026-11-01' } });
    });
    it('closes a bad token with 4401', async () => {
      const { ws, closed } = await open();
      ws.send(JSON.stringify({ type: 'hello', token: 'wrong-token' }));
      expect(await closed).toBe(4401);
    });
    it('closes a first frame that is not a hello with 4401', async () => {
      const { ws, closed } = await open();
      ws.send(JSON.stringify({ type: 'send', client_msg_id: 'x', body: 'hi' }));
      expect(await closed).toBe(4401);
    });
    it('closes with 4401 when no hello arrives in time', async () => {
      const { closed } = await open();
      expect(await closed).toBe(4401);
    });
    it('answers ping with pong and rejects bad send frames', async () => {
      const { ws, frames } = await open();
      ws.send(JSON.stringify({ type: 'hello', token: TOKEN }));
      await until(() => frames.some((f) => f.event === 'calendar'));
      ws.send(JSON.stringify({ type: 'ping' }));
      ws.send(JSON.stringify({ type: 'send', client_msg_id: 'x' }));
      ws.send(JSON.stringify({ type: 'state', quiet: true, battery: 80 }));
      ws.send('not json');
      await until(() => frames.filter((f) => f.type === 'error').length === 2);
      expect(frames.some((f) => f.type === 'pong')).toBe(true);
      expect(frames.filter((f) => f.type === 'error').map((f) => f.code)).toEqual(['invalid_frame', 'invalid_frame']);
    });
  });

  describe('replay', () => {
    beforeEach(() => { for (let i = 1; i <= 3; i++) appendEvent(db, 'iphone-proto', 'reply', { message_id: `m${i}` }); });
    it('replays durable events after the cursor, oldest first', async () => {
      const { ws, frames } = await open();
      ws.send(JSON.stringify({ type: 'hello', token: TOKEN, cursor: 1 }));
      await until(() => frames.some((f) => f.event === 'calendar'));
      expect(frames[0]).toMatchObject({ type: 'welcome', latest_seq: 3, reset: false });
      const replies = frames.filter((f) => f.event === 'reply');
      expect(replies.map((f) => [f.seq, f.data.message_id])).toEqual([[2, 'm2'], [3, 'm3']]);
      // replay comes before the activity snapshot
      expect(frames.findIndex((f) => f.event === 'reply')).toBeLessThan(frames.findIndex((f) => f.event === 'activity'));
    });
    it('keeps surfaces apart', async () => {
      const { ws, frames } = await open();
      ws.send(JSON.stringify({ type: 'hello', token: 'u'.repeat(40), cursor: 0 }));
      await until(() => frames.some((f) => f.event === 'calendar'));
      expect(frames[0]).toMatchObject({ surface_id: 'other', latest_seq: 0 });
      expect(frames.some((f) => f.event === 'reply')).toBe(false);
    });
    it('answers reset:true for a cursor outside retention and replays nothing', async () => {
      const { ws, frames } = await open();
      ws.send(JSON.stringify({ type: 'hello', token: TOKEN, cursor: 99 }));
      await until(() => frames.some((f) => f.event === 'calendar'));
      expect(frames[0]).toMatchObject({ type: 'welcome', latest_seq: 3, reset: true });
      expect(frames.some((f) => f.event === 'reply')).toBe(false);
    });
    it('takes a send over the socket, acks it, and pushes the agent reply live with the next seq', async () => {
      const { ws, frames } = await open();
      ws.send(JSON.stringify({ type: 'hello', token: TOKEN, cursor: 3 }));
      await until(() => frames.some((f) => f.event === 'calendar'));
      ws.send(JSON.stringify({ type: 'send', client_msg_id: 'c-1', body: 'hello' }));
      await until(() => frames.some((f) => f.type === 'ack'));
      expect(frames.find((f) => f.type === 'ack')).toMatchObject({ client_msg_id: 'c-1', status: 'queued', interaction_id: expect.any(String) });
      service.onDelivered({ id: 'x', timestamp: '', channel: 'telegram:peggy', topic: 'general', sender: 'agent:p', recipient: 'contact:chris', reply_to: null, priority: 'normal', payload: { type: 'text', body: 'Hi back. Anything else?' }, metadata: {} });
      await until(() => frames.some((f) => f.event === 'reply'));
      expect(frames.find((f) => f.event === 'reply')).toMatchObject({ seq: 4, data: { glance: 'Hi back.', body: 'Hi back. Anything else?' } });
    });
  });

  describe('push-to-talk', () => {
    const pcm = (ms: number) => { const b = Buffer.alloc(32 * ms); for (let i = 0; i < b.length / 2; i++) b.writeInt16LE(i % 16 < 8 ? 3000 : -3000, i * 2); return b; };
    it('streams PCM, answers the transcript, and sends it into the followed conversation like a typed send', async () => {
      const { ws, frames } = await open();
      ws.send(JSON.stringify({ type: 'hello', token: TOKEN }));
      await until(() => frames.some((f) => f.event === 'calendar'));
      ws.send(JSON.stringify({ type: 'audio_start', client_msg_id: 'v-1', rate: 16000, format: 'pcm_s16le' }));
      for (let i = 0; i < 6; i++) ws.send(pcm(100), { binary: true });
      ws.send(JSON.stringify({ type: 'audio_end', client_msg_id: 'v-1' }));
      await until(() => frames.some((f) => f.type === 'ack'));
      expect(frames.find((f) => f.type === 'transcript')).toEqual({ type: 'transcript', client_msg_id: 'v-1', final: true, status: 'ok', text: 'Turn on the porch light', duration_ms: 600 });
      expect(frames.find((f) => f.type === 'ack')).toMatchObject({ client_msg_id: 'v-1', status: 'queued', interaction_id: expect.any(String) });
      expect(inbound).toEqual([{ body: 'Turn on the porch light', metadata: expect.objectContaining({ origin: 'intercom', input: 'voice', transcript_engine: 'fake', client_msg_id: 'v-1' }) }]);
    });
    it('ignores binary frames outside a recording and drops a cancelled one', async () => {
      const { ws, frames } = await open();
      ws.send(JSON.stringify({ type: 'hello', token: TOKEN }));
      await until(() => frames.some((f) => f.event === 'calendar'));
      ws.send(pcm(100), { binary: true });
      ws.send(JSON.stringify({ type: 'audio_start', client_msg_id: 'v-2' }));
      ws.send(pcm(500), { binary: true });
      ws.send(JSON.stringify({ type: 'audio_cancel', client_msg_id: 'v-2' }));
      ws.send(JSON.stringify({ type: 'audio_end', client_msg_id: 'v-2' }));
      await until(() => frames.some((f) => f.type === 'transcript'));
      expect(frames.find((f) => f.type === 'transcript')).toMatchObject({ client_msg_id: 'v-2', status: 'failed', reason: 'no_recording' });
      expect(inbound).toEqual([]);
    });
    it('speaks the reply to a push-to-talk message on the device that sent it, and not to a typed one', async () => {
      const { ws, frames } = await open();
      const bins: number[] = [];
      ws.on('message', (d, isBinary) => { if (isBinary) bins.push((d as Buffer).length); });
      ws.send(JSON.stringify({ type: 'hello', token: TOKEN }));
      await until(() => frames.some((f) => f.event === 'calendar'));
      ws.send(JSON.stringify({ type: 'audio_start', client_msg_id: 'v-9' }));
      ws.send(pcm(500), { binary: true });
      ws.send(JSON.stringify({ type: 'audio_end', client_msg_id: 'v-9' }));
      await until(() => frames.some((f) => f.type === 'ack'));
      const agent = (body: string) => service.onDelivered({ id: `a-${body.length}`, timestamp: '', channel: 'telegram:peggy', topic: 'general', sender: 'agent:p', recipient: 'contact:chris', reply_to: null, priority: 'normal', payload: { type: 'text', body }, metadata: {} });
      agent('**Done.** Porch light is on.');
      await until(() => frames.some((f) => f.type === 'speech_end'));
      expect(frames.find((f) => f.type === 'speech_start')).toMatchObject({ rate: 16000, format: 'pcm_s16le', chars: 24 });
      expect(bins).toEqual([3200, 3200]);
      // a typed send in the same window: its replies are not spoken
      ws.send(JSON.stringify({ type: 'send', client_msg_id: 't-1', body: 'thanks' }));
      await until(() => frames.filter((f) => f.type === 'ack').length === 2);
      agent('You are welcome.');
      await until(() => frames.filter((f) => f.event === 'reply').length === 2);
      await new Promise((r) => setTimeout(r, 30));
      expect(frames.filter((f) => f.type === 'speech_start').length).toBe(1);
    });
    it('does not speak to a device that reports volume 0', async () => {
      const { ws, frames } = await open();
      ws.send(JSON.stringify({ type: 'hello', token: TOKEN }));
      await until(() => frames.some((f) => f.event === 'calendar'));
      ws.send(JSON.stringify({ type: 'state', quiet: false, battery: 80, volume: 0 }));
      ws.send(JSON.stringify({ type: 'audio_start', client_msg_id: 'v-10' }));
      ws.send(pcm(500), { binary: true });
      ws.send(JSON.stringify({ type: 'audio_end', client_msg_id: 'v-10' }));
      await until(() => frames.some((f) => f.type === 'ack'));
      service.onDelivered({ id: 'a-1', timestamp: '', channel: 'telegram:peggy', topic: 'general', sender: 'agent:p', recipient: 'contact:chris', reply_to: null, priority: 'normal', payload: { type: 'text', body: 'Done.' }, metadata: {} });
      await until(() => frames.some((f) => f.event === 'reply'));
      await new Promise((r) => setTimeout(r, 30));
      expect(frames.some((f) => f.type === 'speech_start')).toBe(false);
    });
    it('closes a socket whose first frame is binary', async () => {
      const { ws, closed } = await open();
      ws.send(pcm(10), { binary: true });
      expect(await closed).toBe(4401);
    });
  });

  describe('static web app', () => {
    it('redirects /intercom to /intercom/ and serves index.html', async () => {
      const redirect = await fetch(`${base}/intercom`, { redirect: 'manual' });
      expect(redirect.status).toBe(301);
      expect(redirect.headers.get('location')).toBe('/intercom/');
      const res = await fetch(`${base}/intercom/`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      expect(res.headers.get('cache-control')).toBe('no-cache');
      expect(await res.text()).toContain('<title>Intercom</title>');
    });
    it('serves modules and manifest with the right MIME types, and sub-directory indexes', async () => {
      expect((await fetch(`${base}/intercom/app.js`)).headers.get('content-type')).toContain('text/javascript');
      expect((await fetch(`${base}/intercom/manifest.webmanifest`)).headers.get('content-type')).toContain('application/manifest+json');
      expect(await (await fetch(`${base}/intercom/sub/`)).text()).toBe('sub index');
    });
    it('answers 404 for a missing file and never leaves the web root', async () => {
      expect((await fetch(`${base}/intercom/nope.js`)).status).toBe(404);
      for (const path of ['/intercom/../intercom-secret.txt', '/intercom/%2e%2e/intercom-secret.txt', '/intercom/..%2fintercom-secret.txt',
        '/intercom/%2e%2e%2fintercom-secret.txt', '/intercom/sub/../../intercom-secret.txt', '/intercom/%00', '/intercom/..%5cintercom-secret.txt']) {
        const res = await server.inject({ url: path });
        expect([400, 404, 301]).toContain(res.statusCode);
        expect(res.body).not.toContain('TOPSECRETCONTENT');
      }
    });
    it('does not 500 when the web root does not exist', async () => {
      const s2 = Fastify();
      await registerIntercomRoutes(s2, { config: cfg, db, service, webRoot: join(webRoot, 'missing') });
      expect((await s2.inject({ url: '/intercom/' })).statusCode).toBe(404);
      expect((await s2.inject({ url: '/intercom/app.js' })).statusCode).toBe(404);
      await s2.close();
    });
    it('resolveStaticPath refuses symlinks that point outside the root', () => {
      symlinkSync(join(webRoot, '..', 'intercom-secret.txt'), join(webRoot, 'link.txt'));
      expect(resolveStaticPath(webRoot, 'link.txt')).toBeNull();
      expect(resolveStaticPath(webRoot, 'app.js')).toBe(join(realpathSync(webRoot), 'app.js'));
      expect(resolveStaticPath(webRoot, '../x')).toBeNull();
      expect(resolveStaticPath(webRoot, 'a\\b')).toBeNull();
    });
  });
});

describe('Intercom and the shared bus token', () => {
  it('isIntercomUrl matches only the Intercom prefixes', () => {
    expect(isIntercomUrl('/intercom')).toBe(true);
    expect(isIntercomUrl('/intercom/app.js?x=1')).toBe(true);
    expect(isIntercomUrl('/api/v1/intercom/ws')).toBe(true);
    expect(isIntercomUrl('/intercomx')).toBe(false);
    expect(isIntercomUrl('/api/v1/messages')).toBe(false);
  });

  it('skips X-Bus-Token for Intercom routes but not for the rest of the API', async () => {
    const db = new Database(':memory:'); runMigrations(db);
    const config = { bus: { auth_token: 'bus-secret', http_port: 0 }, adapters: { intercom: cfg }, contacts: {}, agents: {}, pipeline: { routes: [] } } as unknown as AppConfig;
    const service = new IntercomService({ config: cfg, db, env: { T: TOKEN }, log: () => {}, calendar, submitInbound: async () => ({ ok: true, queued: false, reason: 'x' }) });
    const server = await createHttpServer({ config, db, registry: new AdapterRegistry(), queue: new MessageQueue(db), pipeline: new PipelineEngine(), intercom: service });
    expect((await server.inject({ url: '/api/v1/intercom/health' })).statusCode).toBe(401);                 // surface auth, not bus auth
    expect((await server.inject({ url: '/api/v1/intercom/health', headers: { authorization: `Bearer ${TOKEN}` } })).statusCode).toBe(200);
    expect((await server.inject({ url: '/intercom/no-such-file.txt' })).statusCode).toBe(404);              // not blocked by bus auth; missing file is 404
    expect((await server.inject({ url: '/api/v1/adapters' })).statusCode).toBe(401);
    await server.close(); db.close();
  });
});

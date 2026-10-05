import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../adapters/cc-headless.js', () => ({ getHeadlessSnapshots: () => [] }));
vi.mock('../adapters/claude-transcript.js', () => ({ claudeTranscriptExists: () => true }));
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';
import { MessageQueue } from '../core/queue.js';
import { AdapterRegistry } from '../core/registry.js';
import { PipelineEngine } from '../pipeline/engine.js';
import { AppAdapter } from '../adapters/app.js';
import { createHttpServer } from './api.js';
import type { AppConfig } from '../config/schema.js';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { normalize } from '../pipeline/stages/normalize.js';
import { createRouteResolve } from '../pipeline/stages/route-resolve.js';
import { createTranscriptLog } from '../pipeline/stages/transcript-log.js';
import { eventBounds } from '../app/store.js';
import { ensureOutboundAppSession } from '../app/outbound.js';
import { slashCommandDetect } from '../pipeline/stages/slash-command.js';
import { CommandRegistry } from '../commands/registry.js';
import { createBuiltinCommands } from '../commands/handlers.js';

const TOKEN = 'app-contact-token-0123456789';
const config = {
  bus: { http_port: 0, db_path: ':memory:', log_level: 'info' },
  adapters: { app: { enabled: true, event_retention_days: 30, max_upload_bytes: 100, ping_interval_ms: 30000 } },
  contacts: { alice: { id: 'alice', displayName: 'Alice', platforms: { app: { token: TOKEN } } } },
  agents: {}, topics: ['general'],
  memory: { summarizer_interval_ms: 60000, session_idle_threshold_ms: 1800000, context_window_hours: 48, claude_api_model: 'claude-opus-4-6' },
  pipeline: { dedup_window_ms: 30000, drop_unrouted: false, topic_rules: [], priority_weights: { base_score: 0, topic_bonus: 40, vip_sender_bonus: 20, urgency_keyword_bonus: 15 }, urgency_keywords: [], vip_contacts: [],
    routes: [{ match: { channel: 'app' }, target: { adapterId: 'cc-headless', recipientId: 'agent:work' } }] },
} as unknown as AppConfig;

const live: { server: FastifyInstance; db: Database.Database }[] = [];
afterEach(async () => { for (const x of live.splice(0)) { await x.server.close(); x.db.close(); } });

async function fixture(withPipeline = false, localConfig = config, reusedDb?: Database.Database, withCommands = false) {
  const db = reusedDb ?? new Database(':memory:'); db.pragma('foreign_keys = ON'); runMigrations(db);
  const registry = new AdapterRegistry(); const app = new AppAdapter(db, () => 'agent:work'); registry.register(app);
  const queue = new MessageQueue(db);
  const commandRegistry = withCommands ? new CommandRegistry() : undefined;
  if (commandRegistry) {
    const clear = createBuiltinCommands({ adapterRegistry: registry, queue, pauseSet: new Set(), db }).find(c => c.name === 'clear')!;
    commandRegistry.register(clear);
  }
  const pipeline = new PipelineEngine();
  if (withPipeline) {
    pipeline.use({ slot: 10, name: 'normalize', stage: normalize });
    if (withCommands) pipeline.use({ slot: 40, name: 'slash', stage: slashCommandDetect });
    pipeline.use({ slot: 70, name: 'route', stage: createRouteResolve(config, db) });
    pipeline.use({ slot: 80, name: 'transcript', stage: createTranscriptLog(db, config) });
  }
  const server = await createHttpServer({ config: localConfig, db, registry, app, queue, pipeline, commandRegistry });
  live.push({ server, db }); return { server, db };
}

describe('app routes', () => {
  it('binds an app send to an active Telegram session and routes its reply back to that session', async () => {
    const { server, db } = await fixture(true);
    const now = new Date().toISOString();
    const sessionId = '741320d9-27ef-4e63-a1f2-94744813ab21';
    db.prepare(`INSERT INTO conversation_registry(id,contact_id,channel,topic,first_seen,last_seen) VALUES (?,?,?,?,?,?)`)
      .run('telegram-conversation', 'alice', 'telegram', 'general', now, now);
    db.prepare(`INSERT INTO sessions(id,conversation_id,channel,contact_id,started_at,last_activity,agent_id)
      VALUES (?,?,?,?,?,?,?)`).run(sessionId, 'telegram-conversation', 'telegram', 'alice', now, now, 'agent:work');
    db.prepare(`INSERT INTO transcripts(id,message_id,conversation_id,session_id,created_at,channel,contact_id,direction,body,metadata)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run('seed-row', 'seed-msg', 'telegram-conversation', sessionId, now, 'telegram', 'alice', 'inbound', 'Earlier hello', '{}');
    await server.listen({ host: '127.0.0.1', port: 0 });
    const address = server.server.address(); if (!address || typeof address === 'string') throw new Error('No address');
    const client = await connect(`ws://127.0.0.1:${address.port}/api/v1/app/ws`);
    client.socket.send(JSON.stringify({ type: 'hello', cursor: 0 }));
    await until(() => client.frames.some(f => f['type'] === 'welcome'));
    client.socket.send(JSON.stringify({ type: 'send', client_msg_id: 'c269dbf0-286f-4b8b-9446-3fab00d69c56',
      target: { kind: 'session', session_id: sessionId }, body: 'Continue here' }));
    await until(() => client.frames.some(f => f['type'] === 'ack'));
    const ack = client.frames.find(f => f['type'] === 'ack')!;
    expect(ack).toMatchObject({ status: 'queued', session_id: sessionId });
    const inbound = db.prepare('SELECT * FROM transcripts WHERE message_id = ?').get(ack['message_id']) as {session_id:string;conversation_id:string;channel:string};
    expect(inbound).toMatchObject({ session_id: sessionId, conversation_id: 'telegram-conversation', channel: 'app' });
    const queued = new MessageQueue(db).getById(String(ack['message_id']));
    expect(queued!.envelope.metadata).toMatchObject({ conversation_id: 'telegram-conversation', session_channel: 'telegram', bound_session_id: sessionId });
    const response = await server.inject({ method: 'POST', url: '/api/v1/messages', payload: {
      channel: 'app', topic: 'general', sender: 'agent:work', recipient: 'contact:alice', reply_to: ack['message_id'],
      payload: { type: 'text', body: 'App only reply' }, metadata: {},
    } });
    expect(response.statusCode).toBe(201);
    const app = new AppAdapter(db, () => 'agent:work');
    const outId = response.json().id as string;
    const outbound = new MessageQueue(db).getById(outId)!;
    expect((await app.send(outbound.envelope)).success).toBe(true);
    expect(db.prepare('SELECT session_id,conversation_id FROM transcripts WHERE message_id = ?').get(outId))
      .toMatchObject({ session_id: sessionId, conversation_id: 'telegram-conversation' });
    client.socket.close();
  });

  it('forks a resumable Earlier session without replacing the current Telegram session', async () => {
    const localConfig = { ...config, adapters: { ...config.adapters,
      'cc-headless': { agent_id: 'work', working_dir: '/tmp/project', system_prompt: 'test' } } } as AppConfig;
    const { server, db } = await fixture(true, localConfig);
    const now = new Date().toISOString();
    const oldId = '741320d9-27ef-4e63-a1f2-94744813ab22';
    const currentId = '741320d9-27ef-4e63-a1f2-94744813ab23';
    db.prepare(`INSERT INTO conversation_registry(id,contact_id,channel,topic,first_seen,last_seen) VALUES (?,?,?,?,?,?)`)
      .run('telegram-earlier', 'alice', 'telegram', 'general', now, now);
    db.prepare(`INSERT INTO sessions(id,conversation_id,channel,contact_id,started_at,last_activity,ended_at,agent_id,claude_session_id)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(oldId, 'telegram-earlier', 'telegram', 'alice', now, now, now, 'agent:work', 'claude-old');
    db.prepare(`INSERT INTO sessions(id,conversation_id,channel,contact_id,started_at,last_activity,agent_id,claude_session_id)
      VALUES (?,?,?,?,?,?,?,?)`).run(currentId, 'telegram-earlier', 'telegram', 'alice', now, now, 'agent:work', 'claude-current');
    db.prepare(`INSERT INTO transcripts(id,message_id,conversation_id,session_id,created_at,channel,contact_id,direction,body,metadata)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run('old-row', 'old-msg', 'telegram-earlier', oldId, now, 'telegram', 'alice', 'inbound', 'Original title', '{}');
    await server.listen({ host: '127.0.0.1', port: 0 });
    const address = server.server.address(); if (!address || typeof address === 'string') throw new Error('No address');
    const client = await connect(`ws://127.0.0.1:${address.port}/api/v1/app/ws`);
    client.socket.send(JSON.stringify({ type: 'hello', cursor: 0 }));
    await until(() => client.frames.some(f => f['type'] === 'welcome'));
    client.socket.send(JSON.stringify({ type: 'send', client_msg_id: 'c269dbf0-286f-4b8b-9446-3fab00d69c57',
      target: { kind: 'session', session_id: oldId }, body: 'Resume this' }));
    await until(() => client.frames.some(f => f['type'] === 'ack'));
    const ack = client.frames.find(f => f['type'] === 'ack')!;
    expect(ack['status']).toBe('queued');
    expect(ack['session_id']).not.toBe(oldId);
    const fork = db.prepare(`SELECT s.id,s.channel,s.claude_session_id,cr.topic FROM sessions s
      JOIN conversation_registry cr ON cr.id=s.conversation_id WHERE s.id=?`).get(ack['session_id']) as {id:string;channel:string;claude_session_id:string;topic:string};
    expect(fork).toMatchObject({ channel: 'app', claude_session_id: 'claude-old' });
    expect(fork.topic).toMatch(/^thread:/);
    expect(new MessageQueue(db).getById(String(ack['message_id']))?.envelope.metadata)
      .toMatchObject({ session_channel: 'telegram', resumed_from_channel: 'telegram' });
    expect(db.prepare('SELECT ended_at FROM sessions WHERE id = ?').get(oldId)).toMatchObject({ ended_at: now });
    expect(db.prepare('SELECT claude_session_id,ended_at FROM sessions WHERE id = ?').get(currentId))
      .toMatchObject({ claude_session_id: 'claude-current', ended_at: null });
    client.socket.close();
  });

  it('rejects hidden and unresumable session targets before creating an intent', async () => {
    const { server, db } = await fixture(true);
    const now = new Date().toISOString();
    for (const [id, contact, agent, ended] of [
      ['741320d9-27ef-4e63-a1f2-94744813ab24', 'bob', 'agent:work', false],
      ['741320d9-27ef-4e63-a1f2-94744813ab25', 'alice', 'agent:other', false],
      ['741320d9-27ef-4e63-a1f2-94744813ab26', 'alice', 'agent:work', true],
    ] as const) {
      db.prepare(`INSERT INTO conversation_registry(id,contact_id,channel,topic,first_seen,last_seen) VALUES (?,?,?,?,?,?)`)
        .run(`conv-${id}`, contact, 'telegram', 'general', now, now);
      db.prepare(`INSERT INTO sessions(id,conversation_id,channel,contact_id,started_at,last_activity,ended_at,agent_id)
        VALUES (?,?,?,?,?,?,?,?)`).run(id, `conv-${id}`, 'telegram', contact, now, now, ended ? now : null, agent);
      db.prepare(`INSERT INTO transcripts(id,message_id,conversation_id,session_id,created_at,channel,contact_id,direction,body,metadata)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(`row-${id}`, `msg-${id}`, `conv-${id}`, id, now, 'telegram', contact, 'inbound', 'hello', '{}');
    }
    await server.listen({ host: '127.0.0.1', port: 0 });
    const address = server.server.address(); if (!address || typeof address === 'string') throw new Error('No address');
    const client = await connect(`ws://127.0.0.1:${address.port}/api/v1/app/ws`);
    client.socket.send(JSON.stringify({ type: 'hello', cursor: 0 }));
    await until(() => client.frames.some(f => f['type'] === 'welcome'));
    for (const [i, id] of ['741320d9-27ef-4e63-a1f2-94744813ab24', '741320d9-27ef-4e63-a1f2-94744813ab25', '741320d9-27ef-4e63-a1f2-94744813ab26'].entries()) {
      const clientId = `c269dbf0-286f-4b8b-9446-${String(i).padStart(12, '0')}`;
      client.socket.send(JSON.stringify({ type: 'send', client_msg_id: clientId, target: { kind: 'session', session_id: id }, body: 'Guess' }));
      await until(() => client.frames.some(f => f['type'] === 'ack' && f['client_msg_id'] === clientId));
      const ack = client.frames.find(f => f['type'] === 'ack' && f['client_msg_id'] === clientId)!;
      expect(ack['status']).toBe('rejected');
      expect(ack['reason']).toBe(i === 2 ? 'not_resumable' : 'session_not_found');
    }
    expect((db.prepare('SELECT COUNT(*) AS n FROM app_sends').get() as {n:number}).n).toBe(0);
    client.socket.close();
  });

  it('sends a bound /clear confirmation into the foreign session after closing it', async () => {
    const { server, db } = await fixture(true, config, undefined, true);
    const now = new Date().toISOString();
    const sessionId = '741320d9-27ef-4e63-a1f2-94744813ab27';
    db.prepare(`INSERT INTO conversation_registry(id,contact_id,channel,topic,first_seen,last_seen) VALUES (?,?,?,?,?,?)`)
      .run('telegram-clear', 'alice', 'telegram', 'general', now, now);
    db.prepare(`INSERT INTO sessions(id,conversation_id,channel,contact_id,started_at,last_activity,agent_id,claude_session_id)
      VALUES (?,?,?,?,?,?,?,?)`).run(sessionId, 'telegram-clear', 'telegram', 'alice', now, now, 'agent:work', 'claude-clear');
    db.prepare(`INSERT INTO transcripts(id,message_id,conversation_id,session_id,created_at,channel,contact_id,direction,body,metadata)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run('clear-seed', 'clear-seed-msg', 'telegram-clear', sessionId, now, 'telegram', 'alice', 'inbound', 'Original', '{}');
    await server.listen({ host: '127.0.0.1', port: 0 });
    const address = server.server.address(); if (!address || typeof address === 'string') throw new Error('No address');
    const client = await connect(`ws://127.0.0.1:${address.port}/api/v1/app/ws`);
    client.socket.send(JSON.stringify({ type: 'hello', cursor: 0 }));
    await until(() => client.frames.some(f => f['type'] === 'welcome'));
    client.socket.send(JSON.stringify({ type: 'send', client_msg_id: 'c269dbf0-286f-4b8b-9446-3fab00d69c58',
      target: { kind: 'session', session_id: sessionId }, body: '/clear' }));
    await until(() => client.frames.some(f => f['type'] === 'ack'));
    expect(client.frames.find(f => f['type'] === 'ack')).toMatchObject({ status: 'command', session_id: sessionId });
    expect(db.prepare('SELECT ended_at FROM sessions WHERE id = ?').get(sessionId)).toMatchObject({ ended_at: expect.any(String) });
    const response = db.prepare(`SELECT session_id,channel,body FROM transcripts WHERE session_id = ? AND direction = 'outbound'
      AND json_extract(metadata,'$.command') = 'clear'`).get(sessionId) as {session_id:string;channel:string;body:string}|undefined;
    expect(response).toMatchObject({ session_id: sessionId, channel: 'app', body: expect.stringContaining('Context cleared') });
    expect((db.prepare('SELECT COUNT(*) AS n FROM app_events WHERE session_id = ? AND kind = ?').get(sessionId, 'message') as {n:number}).n).toBeGreaterThanOrEqual(3);
    client.socket.close();
  });
  it('gates every route by contact bearer token and reports routed health', async () => {
    const { server } = await fixture();
    expect((await server.inject('/api/v1/app/health')).statusCode).toBe(401);
    expect((await server.inject({ url: '/api/v1/app/sessions', headers: { authorization: 'Bearer wrong' } })).statusCode).toBe(401);
    const health = await server.inject({ url: '/api/v1/app/health', headers: { authorization: `Bearer ${TOKEN}` } });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ ok: true, contact: 'contact:alice', agent: 'agent:work', routed: true });
  });

  it('rejects an unknown proactive app topic before enqueue', async () => {
    const { server, db } = await fixture();
    const res = await server.inject({ method: 'POST', url: '/api/v1/messages', payload: {
      channel: 'app', topic: 'thread:1234567890abcdef', sender: 'agent:work', recipient: 'contact:alice',
      payload: { type: 'text', body: 'hello' }, metadata: {},
    } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('Unknown or inactive app topic');
    expect((db.prepare('SELECT COUNT(*) AS n FROM message_queue').get() as {n:number}).n).toBe(0);
  });

  it('returns 404 for hidden history and an actionable 422 when media is absent', async () => {
    const { server } = await fixture();
    const headers = { authorization: `Bearer ${TOKEN}` };
    expect((await server.inject({ url: '/api/v1/app/sessions/00000000-0000-4000-8000-000000000000/messages', headers })).statusCode).toBe(404);
    const upload = await server.inject({ method: 'POST', url: '/api/v1/app/attachments', headers });
    expect(upload.statusCode).toBe(422);
    expect(upload.json().error).toContain('media.download_path');
  });

  it('replays a send once and returns the original ack on duplicate client id', async () => {
    const { server, db } = await fixture(true);
    await server.listen({ host: '127.0.0.1', port: 0 });
    const address = server.server.address();
    if (!address || typeof address === 'string') throw new Error('No socket address');
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/v1/app/ws`, { headers: { authorization: `Bearer ${TOKEN}` } });
    const frames: Record<string, unknown>[] = [];
    socket.on('message', raw => frames.push(JSON.parse(raw.toString()) as Record<string, unknown>));
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    socket.send(JSON.stringify({ type: 'hello', cursor: 0 }));
    await until(() => frames.some(f => f['type'] === 'welcome'));
    const id = 'd566559c-c3f5-4011-8271-f8385f987654';
    const sendFrame = { type: 'send', client_msg_id: id, target: { kind: 'main' }, body: 'Hello' };
    socket.send(JSON.stringify(sendFrame));
    await until(() => frames.some(f => f['type'] === 'ack'));
    const first = frames.find(f => f['type'] === 'ack')!;
    expect(first['status']).toBe('queued');
    socket.send(JSON.stringify(sendFrame));
    await until(() => frames.filter(f => f['type'] === 'ack').length === 2);
    expect(frames.filter(f => f['type'] === 'ack')[1]).toEqual(first);
    expect((db.prepare("SELECT COUNT(*) AS n FROM transcripts WHERE channel='app' AND direction='inbound'").get() as {n:number}).n).toBe(1);
    socket.close();
  });

  it('accepts one app multipart file despite the Pebble zero-file default', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentbus-app-test-'));
    try {
      const localConfig = { ...config, agents: { 'agent:work': { media: { download_path: dir, ttl_seconds: 3600 } } } } as AppConfig;
      const { server } = await fixture(false, localConfig);
      const boundary = 'test-boundary';
      const body = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="note.txt"\r\nContent-Type: text/plain\r\n\r\nhey\r\n--${boundary}--\r\n`;
      const response = await server.inject({ method: 'POST', url: '/api/v1/app/attachments',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: body });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ original_filename: 'note.txt', size: 3, type: 'file' });
      const tooLarge = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="big.txt"\r\nContent-Type: text/plain\r\n\r\n${'x'.repeat(101)}\r\n--${boundary}--\r\n`;
      const rejected = await server.inject({ method: 'POST', url: '/api/v1/app/attachments',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: tooLarge });
      expect(rejected.statusCode).toBe(413);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('rejects a bad-token WebSocket upgrade', async () => {
    const { server } = await fixture();
    await server.listen({ host: '127.0.0.1', port: 0 });
    const address = server.server.address(); if (!address || typeof address === 'string') throw new Error('No address');
    const status = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/v1/app/ws`, { headers: { authorization: 'Bearer wrong' } });
      socket.once('unexpected-response', (_req, res) => { resolve(res.statusCode ?? 0); socket.terminate(); });
      socket.once('error', reject);
    });
    expect(status).toBe(401);
  });

  it('replays offline app and foreign transcripts to multiple sockets, then resets a stale cursor', async () => {
    const { server, db } = await fixture();
    const app = new AppAdapter(db, () => 'agent:work');
    const offline = await app.send({ id: 'outbound-offline', timestamp: new Date().toISOString(), channel: 'app', topic: 'general',
      sender: 'agent:work', recipient: 'contact:alice', reply_to: null, priority: 'normal',
      payload: { type: 'text', body: 'Offline note' }, metadata: {} });
    expect(offline.success).toBe(true);
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO conversation_registry(id,contact_id,channel,topic,first_seen,last_seen) VALUES (?,?,?,?,?,?)`)
      .run('foreign', 'alice', 'telegram', 'general', now, now);
    db.prepare(`INSERT INTO sessions(id,conversation_id,channel,contact_id,started_at,last_activity,agent_id)
      VALUES (?,?,?,?,?,?,?)`).run('foreign-session', 'foreign', 'telegram', 'alice', now, now, 'agent:work');
    db.prepare(`INSERT INTO transcripts(id,message_id,conversation_id,session_id,created_at,channel,contact_id,direction,body,metadata)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run('foreign-row', 'foreign-in', 'foreign', 'foreign-session', now, 'telegram', 'alice', 'inbound', 'Telegram hello', '{}');
    await server.listen({ host: '127.0.0.1', port: 0 });
    const address = server.server.address(); if (!address || typeof address === 'string') throw new Error('No address');
    const url = `ws://127.0.0.1:${address.port}/api/v1/app/ws`;
    const a = await connect(url); const b = await connect(url);
    a.socket.send(JSON.stringify({ type: 'hello', cursor: 0 }));
    b.socket.send(JSON.stringify({ type: 'hello', cursor: 0 }));
    await until(() => a.frames.filter(f => f['event'] === 'message').length >= 2 && b.frames.filter(f => f['event'] === 'message').length >= 2);
    for (const client of [a, b]) {
      expect(client.frames.filter(f => f['event'] === 'message').map(f => (f['data'] as Record<string, unknown>)['body']))
        .toContain('Offline note');
      expect(client.frames.filter(f => f['event'] === 'message').map(f => (f['data'] as Record<string, unknown>)['body']))
        .toContain('Telegram hello');
    }
    a.socket.close(); b.socket.close();
    await server.close();
    live.splice(live.findIndex(x => x.server === server), 1);
    const restarted = await fixture(false, config, db);
    await restarted.server.listen({ host: '127.0.0.1', port: 0 });
    const restartedAddress = restarted.server.server.address();
    if (!restartedAddress || typeof restartedAddress === 'string') throw new Error('No restarted address');
    const restartedUrl = `ws://127.0.0.1:${restartedAddress.port}/api/v1/app/ws`;
    const replay = await connect(restartedUrl);
    replay.socket.send(JSON.stringify({ type: 'hello', cursor: 0 }));
    await until(() => replay.frames.filter(f => f['event'] === 'message').length >= 2);
    expect(replay.frames.filter(f => f['event'] === 'message')).toHaveLength(2);
    replay.socket.close();
    const latest = eventBounds(db, 'alice').latest;
    db.prepare('DELETE FROM app_events WHERE contact_id = ? AND seq < ?').run('alice', latest);
    const stale = await connect(restartedUrl);
    stale.socket.send(JSON.stringify({ type: 'hello', cursor: 1 }));
    await until(() => stale.frames.some(f => f['type'] === 'welcome'));
    expect(stale.frames.find(f => f['type'] === 'welcome')).toMatchObject({ reset: true, latest_seq: latest });
    stale.socket.close();
  });

  it('recovers a claimed send after transcript commit but before queue enqueue', async () => {
    const { server, db } = await fixture(true);
    const { conversationId, sessionId } = ensureOutboundAppSession(db, 'alice', 'agent:work', 'general');
    const clientId = 'd566559c-c3f5-4011-8271-f8385f987611';
    const messageId = 'd566559c-c3f5-4011-8271-f8385f987612';
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO transcripts(id,message_id,conversation_id,session_id,created_at,channel,contact_id,direction,body,metadata)
      VALUES (?,?,?,?,?,'app','alice','inbound','Recover me','{}')`)
      .run('crash-transcript', messageId, conversationId, sessionId, now);
    const intent = { message_id: messageId, topic: 'general', session_id: sessionId, body: 'Recover me',
      attachments: [], agent_id: 'agent:work', adapter_id: 'cc-headless' };
    db.prepare(`INSERT INTO app_sends(contact_id,client_msg_id,ack_json,intent_json,created_at) VALUES (?,?,?,?,?)`)
      .run('alice', clientId, JSON.stringify({ type: 'ack', status: 'pending', client_msg_id: clientId, message_id: messageId }), JSON.stringify(intent), now);
    await server.listen({ host: '127.0.0.1', port: 0 });
    const address = server.server.address(); if (!address || typeof address === 'string') throw new Error('No address');
    const client = await connect(`ws://127.0.0.1:${address.port}/api/v1/app/ws`);
    client.socket.send(JSON.stringify({ type: 'hello', cursor: 0 }));
    await until(() => client.frames.some(f => f['type'] === 'welcome'));
    client.socket.send(JSON.stringify({ type: 'send', client_msg_id: clientId, target: { kind: 'main' }, body: 'Recover me' }));
    await until(() => client.frames.some(f => f['type'] === 'ack'));
    expect(client.frames.find(f => f['type'] === 'ack')).toMatchObject({ status: 'queued', message_id: messageId });
    expect((db.prepare('SELECT COUNT(*) AS n FROM message_queue WHERE id = ?').get(messageId) as {n:number}).n).toBe(1);
    // Simulate a second crash after queue enqueue but before ack persistence.
    db.prepare('UPDATE app_sends SET ack_json = ? WHERE contact_id = ? AND client_msg_id = ?')
      .run(JSON.stringify({ type: 'ack', status: 'pending', client_msg_id: clientId, message_id: messageId }), 'alice', clientId);
    client.socket.send(JSON.stringify({ type: 'send', client_msg_id: clientId, target: { kind: 'main' }, body: 'Recover me' }));
    await until(() => client.frames.filter(f => f['type'] === 'ack').length === 2);
    expect(client.frames.filter(f => f['type'] === 'ack')[1]).toMatchObject({ status: 'queued', message_id: messageId });
    expect((db.prepare('SELECT COUNT(*) AS n FROM message_queue WHERE id = ?').get(messageId) as {n:number}).n).toBe(1);
    client.socket.close();
  });

  it('measures local send-ack and outbound-event latency', async () => {
    const { server, db } = await fixture(true);
    await server.listen({ host: '127.0.0.1', port: 0 });
    const address = server.server.address(); if (!address || typeof address === 'string') throw new Error('No address');
    const client = await connect(`ws://127.0.0.1:${address.port}/api/v1/app/ws`);
    client.socket.send(JSON.stringify({ type: 'hello', cursor: 0 }));
    await until(() => client.frames.some(f => f['type'] === 'welcome'));
    const ackSamples: number[] = [];
    for (let i = 0; i < 20; i++) {
      const id = `d566559c-c3f5-4011-8271-${String(i).padStart(12, '0')}`;
      const start = performance.now();
      client.socket.send(JSON.stringify({ type: 'send', client_msg_id: id, target: { kind: 'main' }, body: `ping ${i}` }));
      await until(() => client.frames.some(f => f['type'] === 'ack' && f['client_msg_id'] === id));
      ackSamples.push(performance.now() - start);
    }
    const app = new AppAdapter(db, () => 'agent:work');
    const eventSamples: number[] = [];
    for (let i = 0; i < 10; i++) {
      const id = `latency-reply-${i}`;
      const start = performance.now();
      await app.send({ id, timestamp: new Date().toISOString(), channel: 'app', topic: 'general',
        sender: 'agent:work', recipient: 'contact:alice', reply_to: null, priority: 'normal',
        payload: { type: 'text', body: `reply ${i}` }, metadata: {} });
      await until(() => client.frames.some(f => f['event'] === 'message' && (f['data'] as Record<string, unknown>)['message_id'] === id));
      eventSamples.push(performance.now() - start);
    }
    const p95 = (xs: number[]) => [...xs].sort((a,b) => a-b)[Math.ceil(xs.length * .95) - 1]!;
    console.log(`[app latency] local send ack p95=${p95(ackSamples).toFixed(1)}ms (n=20); outbound event p95=${p95(eventSamples).toFixed(1)}ms (n=10)`);
    client.socket.close();
  });
});

async function connect(url: string): Promise<{ socket: WebSocket; frames: Record<string, unknown>[] }> {
  const socket = new WebSocket(url, { headers: { authorization: `Bearer ${TOKEN}` } });
  const frames: Record<string, unknown>[] = [];
  socket.on('message', raw => frames.push(JSON.parse(raw.toString()) as Record<string, unknown>));
  await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  return { socket, frames };
}

async function until(check: () => boolean): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 3000) throw new Error('Timed out waiting for app frame');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

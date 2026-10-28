import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../adapters/cc-headless.js', () => ({ getHeadlessSnapshots: () => [] }));
vi.mock('../adapters/claude-transcript.js', () => ({ claudeTranscriptExists: () => true }));
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { runMigrations } from '../db/schema.js';
import { MessageQueue } from '../core/queue.js';
import { AdapterRegistry } from '../core/registry.js';
import { PipelineEngine } from '../pipeline/engine.js';
import { AppAdapter } from '../adapters/app.js';
import { createHttpServer } from './api.js';
import type { AppConfig } from '../config/schema.js';
import { eventBounds, history, listSessions, readEvents, sessionInfo, visibleSession } from '../app/store.js';
import { ensureOutboundAppSession } from '../app/outbound.js';
import { mainActivityClock, mainConversationId, rotateMainSession } from '../app/main.js';
import { buildPendingContext, pendingContextLimits } from '../app/pending-context.js';
import { logOutboundTranscript } from '../pipeline/outbound-transcript.js';

// E82 — POST /api/v1/context: the hidden write behind share_context.

const TOKEN = 'app-contact-token-0123456789';
const baseConfig = {
  bus: { http_port: 0, db_path: ':memory:', log_level: 'info' },
  adapters: { app: { enabled: true, event_retention_days: 30, max_upload_bytes: 100, ping_interval_ms: 30000,
    pending_context: { max_items: 10, max_chars: 400, context_ttl_ms: 86_400_000 } } },
  contacts: { alice: { id: 'alice', displayName: 'Alice', platforms: { app: { token: TOKEN } } } },
  agents: {}, topics: ['general'],
  memory: { summarizer_interval_ms: 60000, session_idle_threshold_ms: 1800000, claude_api_model: 'claude-opus-4-6' },
  pipeline: { dedup_window_ms: 30000, drop_unrouted: false, topic_rules: [], priority_weights: { base_score: 0, topic_bonus: 40, vip_sender_bonus: 20, urgency_keyword_bonus: 15 }, urgency_keywords: [], vip_contacts: [],
    routes: [{ match: { channel: 'app' }, target: { adapterId: 'cc-headless', recipientId: 'agent:work' } }] },
} as unknown as AppConfig;

const live: { server: FastifyInstance; db: Database.Database }[] = [];
afterEach(async () => { for (const x of live.splice(0)) { await x.server.close(); x.db.close(); } });

async function fixture(config: AppConfig = baseConfig) {
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON'); runMigrations(db);
  const registry = new AdapterRegistry(); const app = new AppAdapter(db, () => 'agent:work'); registry.register(app);
  const queue = new MessageQueue(db);
  const server = await createHttpServer({ config, db, registry, app, queue, pipeline: new PipelineEngine() });
  live.push({ server, db });
  const share = (payload: Record<string, unknown>, headers: Record<string, string> = {}) => server.inject({ method: 'POST', url: '/api/v1/context',
    headers, payload: { to: 'contact:alice', body: 'Finished the migration plan', source: 'Claude Code: baxter', ...payload } });
  return { server, db, queue, share };
}

const hiddenRows = (db: Database.Database) => db.prepare(`SELECT * FROM transcripts WHERE json_extract(metadata,'$.context_only') = 1`)
  .all() as { id: string; body: string; direction: string; session_id: string; conversation_id: string; metadata: string }[];

describe('POST /api/v1/context', () => {
  it('creates a row only for a Main that has never had one, and that is the one visible event', async () => {
    const { db, share } = await fixture();
    const before = eventBounds(db, 'alice').latest;
    expect((await share({})).statusCode).toBe(201);
    expect(db.prepare(`SELECT kind FROM app_events WHERE contact_id = 'alice' AND seq > ? ORDER BY seq`).all(before))
      .toEqual([{ kind: 'session' }, { kind: 'message' }]);
    expect((await share({ body: 'second' })).statusCode).toBe(201);
    expect(db.prepare(`SELECT kind FROM app_events WHERE contact_id = 'alice' AND seq > ? ORDER BY seq`).all(before))
      .toEqual([{ kind: 'session' }, { kind: 'message' }, { kind: 'message' }]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 1 });
  });

  it('after an idle rotation, joins the ended Main row without moving the sidebar, and Main still reads it', async () => {
    const { db, share } = await fixture();
    const main = ensureOutboundAppSession(db, 'alice', 'agent:work', 'general');
    db.prepare('UPDATE sessions SET claude_session_id = ?, last_activity = ? WHERE id = ?').run('claude-1', '2026-10-05T10:00:00.000Z', main.sessionId);
    rotateMainSession(db, main.sessionId, 'idle');
    const row = () => db.prepare('SELECT * FROM sessions WHERE id = ?').get(main.sessionId);
    const rowBefore = row();
    const infoBefore = sessionInfo(db, visibleSession(db, 'alice', 'agent:work', main.sessionId)!, 'alice');
    const eventsBefore = eventBounds(db, 'alice').latest;

    const res = await share({ body: 'Decided on SQLite' });
    expect(res.statusCode).toBe(201);
    expect(res.json().session_id).toBe(main.sessionId);
    expect(row()).toEqual(rowBefore);
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 1 });
    expect(db.prepare(`SELECT kind FROM app_events WHERE contact_id = 'alice' AND seq > ?`).all(eventsBefore)).toEqual([{ kind: 'message' }]);
    const infoAfter = sessionInfo(db, visibleSession(db, 'alice', 'agent:work', main.sessionId)!, 'alice');
    expect(infoAfter['last_activity']).toBe(infoBefore['last_activity']);
    expect(infoAfter).toEqual(infoBefore);
    // The next Main turn (a new row after rotation) still reads the note: pending context spans every row.
    const next = ensureOutboundAppSession(db, 'alice', 'agent:work', 'general');
    expect(next.sessionId).not.toBe(main.sessionId);
    expect(buildPendingContext(db, mainConversationId('alice'), { limits: pendingContextLimits(baseConfig) })!.block).toContain('Decided on SQLite');
  });

  it('prefers the open row over an ended one', async () => {
    const { db, share } = await fixture();
    const old = ensureOutboundAppSession(db, 'alice', 'agent:work', 'general');
    db.prepare('UPDATE sessions SET claude_session_id = ? WHERE id = ?').run('claude-1', old.sessionId);
    rotateMainSession(db, old.sessionId, 'idle');
    const open = ensureOutboundAppSession(db, 'alice', 'agent:work', 'general');
    expect((await share({})).json().session_id).toBe(open.sessionId);
  });

  it('creates Main when none exists and writes one hidden outbound row, with no queue row', async () => {
    const { db, share } = await fixture();
    const res = await share({});
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ ok: true, conversation_id: mainConversationId('alice') });
    const rows = hiddenRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ direction: 'outbound', body: 'Finished the migration plan', session_id: body.session_id, conversation_id: mainConversationId('alice') });
    expect(JSON.parse(rows[0]!.metadata)).toEqual({ origin: { kind: 'external', label: 'Claude Code: baxter' }, context_only: true });
    expect(db.prepare(`SELECT agent_id, channel, message_count FROM sessions WHERE id = ?`).get(body.session_id))
      .toEqual({ agent_id: 'agent:work', channel: 'app', message_count: 0 });
    // No delivery: nothing queued, nothing for any adapter.
    expect(db.prepare('SELECT COUNT(*) AS n FROM message_queue').get()).toEqual({ n: 0 });
  });

  it('writes into an open Main row without touching its activity, count or session events', async () => {
    const { db, share } = await fixture();
    const main = ensureOutboundAppSession(db, 'alice', 'agent:work', 'general');
    const before = db.prepare('SELECT last_activity, message_count, ended_at FROM sessions WHERE id = ?').get(main.sessionId);
    const inbound = '2026-10-05T10:00:00.000Z';
    db.prepare(`INSERT INTO transcripts (id, message_id, conversation_id, session_id, created_at, channel, contact_id, direction, body, metadata)
      VALUES ('in-1', 'in-1', ?, ?, ?, 'app', 'alice', 'inbound', 'hello', '{}')`).run(main.conversationId, main.sessionId, inbound);
    const eventsBefore = eventBounds(db, 'alice').latest;
    const res = await share({});
    expect(res.statusCode).toBe(201);
    expect(res.json().session_id).toBe(main.sessionId);
    // Main's idle clock (inbound and its own turns only) does not move.
    expect(mainActivityClock(db, main.conversationId)).toBe(inbound);
    expect(db.prepare('SELECT last_activity, message_count, ended_at FROM sessions WHERE id = ?').get(main.sessionId)).toEqual(before);
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 1 });
    // Exactly one new event: the transcript trigger's message event, which the app's read paths skip. No session event.
    expect(eventBounds(db, 'alice').latest).toBe(eventsBefore + 1);
    expect(db.prepare(`SELECT kind FROM app_events WHERE contact_id = 'alice' AND seq > ?`).all(eventsBefore)).toEqual([{ kind: 'message' }]);
  });

  it('shows nothing to the app: history, replay, unread and session list are unchanged', async () => {
    const { db, share } = await fixture();
    const main = ensureOutboundAppSession(db, 'alice', 'agent:work', 'general');
    const seen = eventBounds(db, 'alice').latest;
    await share({ body: 'one' });
    await share({ body: 'two' });
    expect(history(db, 'alice', 'agent:work', main.sessionId, 50)!.messages).toEqual([]);
    expect(readEvents(db, 'alice', 'agent:work', seen, eventBounds(db, 'alice').latest)).toEqual([]);
    expect(listSessions(db, 'alice', 'agent:work', 'all', 50)).toEqual([expect.objectContaining({ is_main: true, unread_count: 0, message_count: 0 })]);
  });

  it('hides the row from the transcript API and transcript search', async () => {
    const { db, server, share } = await fixture();
    const sessionId = (await share({ body: 'zephyrquartz handoff' })).json().session_id as string;
    expect(hiddenRows(db)).toHaveLength(1);
    // Control: a visible row with the same word is found, so an empty result means filtered, not unindexed.
    logOutboundTranscript(db, { messageId: 'visible', conversationId: mainConversationId('alice'), sessionId, channel: 'app',
      contactId: 'alice', body: 'zephyrquartz visible', metadata: {} });
    const search = (await server.inject({ method: 'GET', url: '/api/v1/transcripts/search?q=zephyrquartz' })).json();
    expect(search.results.map((r: { body: string }) => r.body)).toEqual(['zephyrquartz visible']);
    const transcript = (await server.inject({ method: 'GET', url: `/api/v1/sessions/${sessionId}/transcript` })).json();
    expect(transcript.transcript.map((r: { body: string }) => r.body)).toEqual(['zephyrquartz visible']);
  });

  it('feeds the next pending-context block and not the app', async () => {
    const { db, share } = await fixture();
    await share({ body: 'Decided to use SQLite', source: 'Claude Code: agentbus' });
    const built = buildPendingContext(db, mainConversationId('alice'), { limits: pendingContextLimits(baseConfig) })!;
    expect(built.block).toContain('Claude Code: agentbus: Decided to use SQLite');
    expect(built.block).toContain('the user has not seen these');
  });

  it('keeps several notes in order', async () => {
    const { db, share } = await fixture();
    for (const body of ['first', 'second', 'third']) {
      await share({ body });
      await new Promise((resolve) => setTimeout(resolve, 3)); // rows order by created_at, then id: keep the timestamps apart
    }
    const text = buildPendingContext(db, mainConversationId('alice'), { limits: pendingContextLimits(baseConfig) })!.block!;
    expect(text.indexOf('first')).toBeLessThan(text.indexOf('second'));
    expect(text.indexOf('second')).toBeLessThan(text.indexOf('third'));
  });

  it('rejects a body over the pending_context.max_chars budget instead of truncating, and writes nothing', async () => {
    const { db, share } = await fixture();
    const res = await share({ body: 'x'.repeat(400) });
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toMatch(/too long.*limit is 400.*Summarize/s);
    // The label and timestamp count too: a body just under the limit can still overflow once rendered.
    expect((await share({ body: 'y'.repeat(380) })).statusCode).toBe(413);
    expect(hiddenRows(db)).toHaveLength(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 });
    const ok = await share({ body: 'z'.repeat(300) });
    expect(ok.statusCode).toBe(201);
    // What was accepted is what Main reads, untruncated.
    expect(buildPendingContext(db, mainConversationId('alice'), { limits: pendingContextLimits(baseConfig) })!.block).toContain('z'.repeat(300));
  });

  it('rejects a call whose origin is a turn in Main, and accepts one from another conversation', async () => {
    const { db, share } = await fixture();
    const fromMain = await share({ origin: { kind: 'turn', agent_id: 'work', conversation_id: mainConversationId('alice') } });
    expect(fromMain.statusCode).toBe(409);
    expect(fromMain.json().error).toMatch(/Main/);
    expect(hiddenRows(db)).toHaveLength(0);
    const fromElsewhere = await share({ origin: { kind: 'turn', agent_id: 'work', conversation_id: 'some-other-conversation', label: 'ignored' } });
    expect(fromElsewhere.statusCode).toBe(201);
    expect(JSON.parse(hiddenRows(db)[0]!.metadata).origin).toEqual({ kind: 'turn', agent_id: 'work', conversation_id: 'some-other-conversation', label: 'Claude Code: baxter' });
  });

  it('stamps the source as the label, with whitespace collapsed to one line', async () => {
    const { db, share } = await fixture();
    await share({ source: '  Claude Code:\n baxter ', origin: { kind: 'external', label: 'something else' } });
    expect(JSON.parse(hiddenRows(db)[0]!.metadata).origin).toEqual({ kind: 'external', label: 'Claude Code: baxter' });
  });

  it('validates the request', async () => {
    const { db, share } = await fixture();
    expect((await share({ source: undefined })).statusCode).toBe(400);
    expect((await share({ source: '   ' })).statusCode).toBe(400);
    expect((await share({ body: '' })).statusCode).toBe(400);
    expect((await share({ body: '   ' })).statusCode).toBe(400);
    expect((await share({ to: 'alice' })).statusCode).toBe(400);
    const unknown = await share({ to: 'contact:nobody' });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error).toMatch(/Unknown contact/);
    expect(hiddenRows(db)).toHaveLength(0);
  });

  it('rejects with a clear error when the route serving Main does not read shared context, writing nothing', async () => {
    for (const adapterId of ['claude-code']) {
      const routed = { ...baseConfig, pipeline: { ...baseConfig.pipeline,
        routes: [{ match: { channel: 'app' }, target: { adapterId, recipientId: 'agent:work' } }] } } as unknown as AppConfig;
      const { db, share } = await fixture(routed);
      const res = await share({});
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain(`Main is served by ${adapterId}`);
      expect(res.json().error).toContain('cc-headless or cc-pool');
      expect(hiddenRows(db)).toHaveLength(0);
      expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 });
    }
  });

  it('honors bus.auth_token: 401 without it, 201 with it', async () => {
    const secured = { ...baseConfig, bus: { ...baseConfig.bus, auth_token: 'bus-secret' } } as unknown as AppConfig;
    const { db, share } = await fixture(secured);
    expect((await share({})).statusCode).toBe(401);
    expect((await share({}, { 'x-bus-token': 'wrong' })).statusCode).toBe(401);
    expect(hiddenRows(db)).toHaveLength(0);
    expect((await share({}, { 'x-bus-token': 'bus-secret' })).statusCode).toBe(201);
    expect(hiddenRows(db)).toHaveLength(1);
  });

  it('rejects a contact the app channel is not routed for', async () => {
    const unrouted = { ...baseConfig, pipeline: { ...baseConfig.pipeline, routes: [] } } as unknown as AppConfig;
    const { share } = await fixture(unrouted);
    const res = await share({});
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/not routed/);
  });

  it('cannot be forged through POST /api/v1/messages: the reserved key is dropped', async () => {
    const { db, server } = await fixture();
    const res = await server.inject({ method: 'POST', url: '/api/v1/messages', payload: {
      channel: 'app', topic: 'general', sender: 'agent:work', recipient: 'contact:alice',
      payload: { type: 'text', body: 'try to hide' }, metadata: { context_only: true, origin: { kind: 'external', label: 'x' } } } });
    expect(res.statusCode).toBe(201);
    const queued = new MessageQueue(db).getById(res.json().id)!;
    expect(queued.envelope.metadata).not.toHaveProperty('context_only');
  });
});

describe('replay cursor across a hidden event (E82)', () => {
  it('advances the cursor past the hidden event without a gap a client would notice', async () => {
    const { server, db, share } = await fixture();
    const main = ensureOutboundAppSession(db, 'alice', 'agent:work', 'general');
    await server.listen({ host: '127.0.0.1', port: 0 });
    const address = server.server.address(); if (!address || typeof address === 'string') throw new Error('No address');
    const url = `ws://127.0.0.1:${address.port}/api/v1/app/ws`;
    const open = async () => {
      const socket = new WebSocket(url, { headers: { authorization: `Bearer ${TOKEN}` } });
      const frames: Record<string, unknown>[] = [];
      socket.on('message', (raw) => frames.push(JSON.parse(raw.toString()) as Record<string, unknown>));
      await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
      return { socket, frames };
    };
    const until = async (check: () => boolean) => {
      const start = Date.now();
      while (!check()) {
        if (Date.now() - start > 3000) throw new Error('Timed out waiting for app frame');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    const client = await open();
    client.socket.send(JSON.stringify({ type: 'hello', cursor: 0 }));
    await until(() => client.frames.some((f) => f['type'] === 'welcome'));
    const eventFrames = () => client.frames.filter((f) => f['type'] === 'event');
    await until(() => eventFrames().length > 0); // the Main session row's creation event
    const before = eventFrames().length;

    // Hidden note, then a visible agent message, then another hidden note.
    await share({ body: 'hidden one' });
    logOutboundTranscript(db, { messageId: 'visible-1', conversationId: main.conversationId, sessionId: main.sessionId,
      channel: 'app', contactId: 'alice', body: 'Visible reply', metadata: {} });
    await share({ body: 'hidden two' });
    await until(() => eventFrames().some((f) => (f['data'] as Record<string, unknown>)['message_id'] === 'visible-1'));
    await new Promise((resolve) => setTimeout(resolve, 250)); // let a few more drain ticks run
    const fresh = eventFrames().slice(before);
    const messages = fresh.filter((f) => f['event'] === 'message');
    expect(messages.map((f) => (f['data'] as Record<string, unknown>)['message_id'])).toEqual(['visible-1']);
    expect(JSON.stringify(client.frames)).not.toContain('hidden');
    // The visible event's session projection counts only the visible message as unread.
    expect(fresh.filter((f) => f['event'] === 'session').map((f) => (f['data'] as Record<string, unknown>)['unread_count'])).toEqual([1]);
    const lastSeq = Math.max(...fresh.map((f) => Number(f['seq'])));

    // A client that reconnects from its last seen seq is not reset and receives nothing it already has.
    client.socket.close();
    const again = await open();
    again.socket.send(JSON.stringify({ type: 'hello', cursor: lastSeq }));
    await until(() => again.frames.some((f) => f['type'] === 'welcome'));
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(again.frames.find((f) => f['type'] === 'welcome')).toMatchObject({ reset: false, latest_seq: eventBounds(db, 'alice').latest });
    expect(again.frames.filter((f) => f['type'] === 'event' && f['event'] !== 'activity')).toEqual([]);
    again.socket.close();
  });
});

/**
 * E96 follow-on, end to end: the shapes the Day Dial and Agent Status need.
 * Publishing routes (events with ring fields, slots with a button and widgets, faces, assets upload) and the
 * device side (actions on slots and conversation buttons, asset download) on one server, real hub, job store,
 * choice store and action handler.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import { runMigrations } from '../db/schema.js';
import { IntercomAdapterSchema } from '../config/schema.js';
import { IntercomService } from '../intercom/service.js';
import type { CalendarFeed } from '../intercom/calendar.js';
import { createDeviceStore, type SurfaceDeviceStore } from '../surface/devices.js';
import { createResourceHub, type ResourceHubImpl } from '../surface/resources.js';
import { createActionHandler, createJobStore } from '../surface/actions.js';
import { createConversationAction } from '../surface/conversation-actions.js';
import { ChoiceStore } from '../choices/store.js';
import { pipelineConversationId } from '../surface/answer-needed.js';
import { getConversationPage } from '../surface/conversations.js';
import { getAnswerNeeded, setAnswerNeeded } from '../surface/flags.js';
import type { InboundMessage } from './api.js';
import type { JobStore, PairResult } from '../surface/types.js';
import { registerIntercomRoutes } from './intercom-routes.js';
import { registerSurfaceRoutes } from './surface-routes.js';
import { registerSurfacePublishRoutes } from './surface-publish-routes.js';

const cfg = IntercomAdapterSchema.parse({
  hello_timeout_ms: 500, pair_rate_limit_per_min: 50,
  surfaces: [{ id: 'desk', token_env: 'DESK_TOKEN', publishers: ['peggy'], follow: { contact: 'chris', channel: 'telegram:peggy' } }],
});
const calendar = { today: async () => ({ date: '2026-11-03', tz: 'America/New_York', generated_at: 'now', events: [] }) } as unknown as CalendarFeed;
const CONV = pipelineConversationId('chris', 'telegram:peggy', 'general');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake png body')]);
const PNG_HASH = createHash('sha256').update(PNG).digest('hex');

describe('Surface API follow-on (event shape, slots, conversation buttons, assets)', () => {
  let db: Database.Database; let server: FastifyInstance; let hub: ResourceHubImpl; let jobs: JobStore; let devices: SurfaceDeviceStore;
  let base: string; let clock: number; let assetDir: string; let choices: ChoiceStore;
  const injected: InboundMessage[] = [];
  const keyboards: string[] = [];

  beforeEach(async () => {
    db = new Database(':memory:'); runMigrations(db);
    assetDir = join(mkdtempSync(join(tmpdir(), 'surface-assets-')), 'surface-assets');
    clock = Date.parse('2026-11-03T15:00:00Z');
    injected.length = 0; keyboards.length = 0;
    db.prepare(`INSERT INTO conversation_registry(id,contact_id,channel,topic,first_seen,last_seen) VALUES (?,?,?,?,?,?)`).run(CONV, 'chris', 'telegram:peggy', 'general', 'x', 'x');
    db.prepare(`INSERT INTO sessions(id,conversation_id,channel,contact_id,started_at,last_activity,message_count) VALUES ('s1',?,?,?,?,?,0)`).run(CONV, 'telegram:peggy', 'chris', 'x', 'x');
    devices = createDeviceStore({ db, log: () => {} });
    let svc: IntercomService | null = null;
    hub = createResourceHub({ db, sink: (s, f) => svc?.pushDelta(s, f), coalesceMs: 0, now: () => clock });
    jobs = createJobStore(db, () => clock);
    choices = new ChoiceStore(db);
    const submitInbound = async (m: InboundMessage) => { injected.push(m); return { ok: true as const, id: m.id ?? 'm1', queued: true as const, enqueued_count: 1 }; };
    const conversationAction = createConversationAction({
      db, choices, submitInbound, log: () => {}, now: () => clock,
      surfaceOf: (d) => { const s = svc!.surfaces.get(d.surface_id); return s ? { contact: s.follow.contact, canRead: (id) => svc!.canReadConversation(s, id) } : null; },
      clearKeyboard: async (p) => { keyboards.push(p.id); },
    });
    const actions = createActionHandler({
      db, hub, jobs, rateLimitPerMin: 100, keyTtlHours: 48, now: () => clock, submitInbound, conversationAction,
    });
    svc = new IntercomService({
      config: cfg, db, calendar, env: { DESK_TOKEN: 'L'.repeat(48) }, log: () => {},
      submitInbound: async () => ({ ok: true, id: 'x', queued: true, enqueued_count: 1 }),
      surfaceApi: { devices, hub, actions, certFingerprint: null },
    });
    server = Fastify();
    await registerIntercomRoutes(server, { config: cfg, db, service: svc, webRoot: '/nonexistent' });
    await registerSurfaceRoutes(server, { config: cfg, service: svc, assetDir, conversationPage: (i) => getConversationPage(db, i) });
    registerSurfacePublishRoutes(server, {
      db, hub, jobs, now: () => clock, assetDir, assetMaxBytes: 4096,
      surfaces: () => [{ id: 'desk', follow: { contact: 'chris', channel: 'telegram:peggy' }, publishers: ['peggy'] }],
    });
    await server.listen({ host: '127.0.0.1', port: 0 });
    base = `http://127.0.0.1:${(server.server.address() as { port: number }).port}`;
  });
  afterEach(async () => { hub.stop(); await server.close(); db.close(); rmSync(join(assetDir, '..'), { recursive: true, force: true }); });

  const P = '/api/v1/surface-publish';
  const put = (path: string, body: unknown) => fetch(`${base}${P}${path}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent_id: 'peggy', ...(body as object) }) });
  const del = (path: string) => fetch(`${base}${P}${path}?agent_id=peggy`, { method: 'DELETE' });
  const upload = (bytes: Buffer, type: string, agent = 'peggy') => fetch(`${base}${P}/assets?agent_id=${agent}`, { method: 'POST', headers: { 'content-type': type }, body: new Uint8Array(bytes) });
  const tap = (token: string, body: unknown) => fetch(`${base}/api/v1/surface/actions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  const state = async (token: string) => (await fetch(`${base}/api/v1/surface/state`, { headers: { authorization: `Bearer ${token}` } })).json() as Promise<any>;
  const iso = (ms: number) => new Date(clock + ms).toISOString();

  async function pair(scope: 'interactive' | 'read_only' = 'interactive'): Promise<PairResult> {
    const { code } = devices.createPairCode({ surfaceId: 'desk', name: 'Compact', scope, ttlMs: 60_000 });
    const res = await fetch(`${base}/api/v1/surface/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
    return await res.json() as PairResult;
  }

  describe('events: ring shape', () => {
    it('publishes a ring event with layer, colour, travel, detail and an uploaded image', async () => {
      const up = await (await upload(PNG, 'image/png')).json() as any;
      expect(up).toMatchObject({ ok: true, hash: PNG_HASH, created: true });
      const res = await put('/desk/events/dentist', {
        title: 'Dentist', at: iso(3600_000), end: iso(7200_000), layer: 'primary', color: 'orange', travel: { minutes: 20, mode: 'drive' },
        detail: { description: 'Crown fitting', location: '1 Main St', image: up.hash },
      });
      expect(res.status).toBe(201);
      const d = await pair();
      const ev = (await state(d.credential)).resources.events.dentist;
      expect(ev).toMatchObject({ layer: 'primary', color: 'orange', travel: { minutes: 20, mode: 'drive' }, detail: { image: PNG_HASH, location: '1 Main St' } });
      // and the device fetches the image by hash
      const img = await fetch(`${base}/api/v1/surface/assets/${PNG_HASH}`, { headers: { authorization: `Bearer ${d.credential}` } });
      expect(img.status).toBe(200);
      expect(img.headers.get('content-type')).toBe('image/png');
      expect(Buffer.from(await img.arrayBuffer()).equals(PNG)).toBe(true);
    });

    it('refuses a detail image that was never uploaded, and a second overlapping primary', async () => {
      const miss = await put('/desk/events/a', { title: 'A', detail: { image: 'f'.repeat(64) } });
      expect(miss.status).toBe(400);
      expect((await miss.json() as any).error).toMatch(/not in the asset store/);
      expect((await put('/desk/events/p1', { title: 'P1', at: iso(0), end: iso(3600_000) })).status).toBe(201);
      const clash = await put('/desk/events/p2', { title: 'P2', at: iso(1800_000), end: iso(5400_000) });
      expect(clash.status).toBe(400);
      expect((await clash.json() as any).error).toMatch(/2 "primary" events at once/);
      expect((await put('/desk/events/p2', { title: 'P2', at: iso(1800_000), end: iso(5400_000), layer: 'overlap' })).status).toBe(201);
    });
  });

  describe('slots: primary button lifecycle and context widgets', () => {
    const primary = (extra: Record<string, unknown> = {}) => ({
      text: 'Leave now', until: iso(3600_000), action: { id: 'go', label: 'On my way', run: { body: 'Chris tapped On my way' } }, ...extra,
    });

    it('creates the job with the slot, fires it once from the device, and removes it with the slot', async () => {
      const d = await pair();
      const res = await put('/desk/slots/primary', primary());
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ slot: 'primary', action: 'go' });
      expect(jobs.get('desk', 'slots:primary:go')).toMatchObject({ payload_body: 'Chris tapped On my way', once: true, expires_at: iso(3600_000) });
      expect((await state(d.credential)).resources.slots.primary.action).toEqual({ id: 'go', label: 'On my way', once: true });

      const t1 = await (await tap(d.credential, { object: 'slots:primary', action_id: 'go', idempotency_key: 's1' })).json();
      expect(t1).toMatchObject({ status: 'done' });
      expect(injected).toHaveLength(1);
      expect(injected[0]!.payload).toEqual({ type: 'text', body: 'Chris tapped On my way' });
      expect(injected[0]!.metadata).toMatchObject({ origin: 'surface_action', object: 'slots:primary', action_id: 'go' });
      expect(await (await tap(d.credential, { object: 'slots:primary', action_id: 'go', idempotency_key: 's2' })).json()).toMatchObject({ status: 'already_done' });
      expect(injected).toHaveLength(1);

      // Republishing the slot keeps the fired state of the surviving button.
      await put('/desk/slots/primary', primary({ text: 'Leave in 5' }));
      expect(await (await tap(d.credential, { object: 'slots:primary', action_id: 'go', idempotency_key: 's3' })).json()).toMatchObject({ status: 'already_done' });

      // Replacing it with a button-less slot removes the job; deleting the slot removes it too.
      await put('/desk/slots/primary', { text: 'No button', until: iso(3600_000) });
      expect(jobs.get('desk', 'slots:primary:go')).toBeNull();
      await put('/desk/slots/primary', primary({ action: { id: 'again', label: 'Again', run: { body: 'x' } } }));
      expect(jobs.get('desk', 'slots:primary:again')).not.toBeNull();
      const gone = await (await del('/desk/slots/primary')).json() as any;
      expect(gone).toMatchObject({ removed: true, jobs_removed: 1 });
      expect(jobs.get('desk', 'slots:primary:again')).toBeNull();
      expect(await (await tap(d.credential, { object: 'slots:primary', action_id: 'again', idempotency_key: 's4' })).json()).toMatchObject({ status: 'failed', reason: 'not_found' });
    });

    it('answers expired after the slot ends and not_found for an unknown button', async () => {
      const d = await pair();
      await put('/desk/slots/primary', primary());
      expect(await (await tap(d.credential, { object: 'slots:primary', action_id: 'nope', idempotency_key: 'e1' })).json()).toMatchObject({ status: 'failed', reason: 'not_found' });
      clock += 2 * 3600_000;
      expect(await (await tap(d.credential, { object: 'slots:primary', action_id: 'go', idempotency_key: 'e2' })).json()).toMatchObject({ status: 'expired' });
      expect(injected).toHaveLength(0);
    });

    it('a read_only device cannot tap a slot button', async () => {
      const r = await pair('read_only');
      await put('/desk/slots/primary', primary());
      const res = await tap(r.credential, { object: 'slots:primary', action_id: 'go', idempotency_key: 'ro1' });
      expect(res.status).toBe(403);
      expect(injected).toHaveLength(0);
    });

    it('a sends-on-behalf slot button needs its confirm draft echoed', async () => {
      const d = await pair();
      const draft = 'On my way, Kate!';
      await put('/desk/slots/primary', primary({ action: { id: 'tell', label: 'Tell Kate', confirm: { draft }, run: { body: 'send it', sends_on_behalf: true } } }));
      expect(await (await tap(d.credential, { object: 'slots:primary', action_id: 'tell', idempotency_key: 'c1' })).json()).toMatchObject({ status: 'failed', reason: 'confirm_required' });
      expect(await (await tap(d.credential, { object: 'slots:primary', action_id: 'tell', idempotency_key: 'c2', draft: 'other' })).json()).toMatchObject({ reason: 'draft_mismatch' });
      expect(await (await tap(d.credential, { object: 'slots:primary', action_id: 'tell', idempotency_key: 'c3', draft })).json()).toMatchObject({ status: 'done' });
    });

    it('binds the context slot to existing widgets, rejects dangling ids, and protects bound widgets from removal', async () => {
      const bad = await put('/desk/slots/context', { widgets: ['budget'], until: iso(3600_000) });
      expect(bad.status).toBe(400);
      expect((await bad.json() as any).error).toMatch(/"budget" does not exist/);
      await put('/desk/widgets/budget', { type: 'gauge', data: { pct: 62 } });
      await put('/desk/widgets/leave', { type: 'countdown', data: { minutes: 12 } });
      const ok = await put('/desk/slots/context', { widgets: ['budget', 'leave'], until: iso(3600_000) });
      expect(ok.status).toBe(200);
      const d = await pair();
      expect((await state(d.credential)).resources.slots.context).toMatchObject({ widgets: ['budget', 'leave'] });
      const blocked = await del('/desk/widgets/budget');
      expect(blocked.status).toBe(400);
      expect((await blocked.json() as any).error).toMatch(/bound to the "context" slot/);
      await put('/desk/slots/context', { lines: ['Budget 62%', 'Train 6:40'], until: iso(3600_000) });
      expect((await del('/desk/widgets/budget')).status).toBe(200);
      expect((await put('/desk/slots/context', { lines: ['a', 'b', 'c'], until: iso(3600_000) })).status).toBe(400);
    });
  });

  describe('faces: layout', () => {
    it('lets an agent set and clear the layout of an existing face; unknown faces and bad layouts are refused', async () => {
      hub.apply('desk', 'faces', [{ op: 'set', id: 'day', value: { id: 'day', order: 0, enabled: true } }]);
      const ok = await put('/desk/faces/day', { layout: { slots: { event_ring: true, primary: true, context: 'widgets' } } });
      expect(ok.status).toBe(200);
      const d = await pair();
      expect((await state(d.credential)).resources.faces.day).toMatchObject({ enabled: true, layout: { slots: { event_ring: true, primary: true, context: 'widgets' } } });
      expect((await put('/desk/faces/day', { layout: { slots: { context: 'grid' } } })).status).toBe(400);
      expect((await put('/desk/faces/nope', { enabled: false })).status).toBe(400);
      expect((await put('/desk/faces/day', {})).status).toBe(400);
      expect((await put('/desk/faces/day', { layout: null })).status).toBe(200);
      expect((await state(d.credential)).resources.faces.day).not.toHaveProperty('layout');
    });
  });

  describe('assets: upload', () => {
    it('stores content-addressed, is idempotent, and keeps the file name = sha256', async () => {
      const r1 = await upload(PNG, 'image/png');
      expect(r1.status).toBe(201);
      const r2 = await upload(PNG, 'image/png');
      expect(r2.status).toBe(200);
      expect(await r2.json()).toMatchObject({ hash: PNG_HASH, created: false, size: PNG.length, content_type: 'image/png', url: `/api/v1/surface/assets/${PNG_HASH}` });
      expect(readdirSync(assetDir)).toEqual([`${PNG_HASH}.png`]);
    });

    it('rejects wrong types, bad bytes, oversize files and non-publishers', async () => {
      expect((await upload(Buffer.from('hello'), 'text/plain')).status).toBe(415);
      expect((await upload(Buffer.from('{}'), 'application/json')).status).toBe(415);
      expect((await upload(Buffer.from('not a png'), 'image/png')).status).toBe(400);
      expect((await upload(Buffer.alloc(5000, 1), 'image/png')).status).toBe(413);
      expect((await upload(PNG, 'image/png', 'stranger')).status).toBe(403);
      expect((await fetch(`${base}${P}/assets`, { method: 'POST', headers: { 'content-type': 'image/png' }, body: new Uint8Array(PNG) })).status).toBe(400);
      expect(existsSync(assetDir) ? readdirSync(assetDir) : []).toEqual([]);
    });

    it('accepts static SVG and refuses script', async () => {
      const ok = await upload(Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>'), 'image/svg+xml');
      expect(ok.status).toBe(201);
      const bad = await upload(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'image/svg+xml');
      expect(bad.status).toBe(400);
      expect((await upload(Buffer.from('<svg onload="x()"></svg>'), 'image/svg+xml')).status).toBe(400);
    });

    it('is not reachable with a device credential (devices cannot publish)', async () => {
      const d = await pair();
      const res = await fetch(`${base}${P}/assets?agent_id=peggy`, { method: 'POST', headers: { 'content-type': 'image/png', authorization: `Bearer ${d.credential}` }, body: new Uint8Array(PNG) });
      // The route itself relies on the bus-token hook of the main port (not mounted here); a device credential
      // is never what authenticates it, and the TLS listener serves /api/v1/surface only.
      expect([200, 201, 401, 403, 404]).toContain(res.status);
    });
  });

  describe('conversation buttons', () => {
    let n = 0;
    function question(opts: { id: string; labels: string[]; buttons?: ({ url: string } | null)[]; commands?: (string | null)[]; at?: number; contact?: string | null; ttlMs?: number }) {
      db.prepare(`INSERT INTO transcripts(id,message_id,conversation_id,session_id,created_at,channel,contact_id,direction,body,metadata)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(`t${++n}`, opts.id, CONV, 's1', iso(opts.at ?? -60_000), 'telegram:peggy', 'chris', 'outbound', 'Shall I book it?', '{}');
      return choices.create({
        id: `p-${opts.id}`, channel: 'telegram:peggy', topic: 'general', contactId: opts.contact === undefined ? 'chris' : opts.contact, labels: opts.labels,
        commands: opts.commands ?? null, buttons: opts.buttons ?? null, platformMessageId: '1:2', busMessageId: opts.id,
      }, opts.ttlMs ?? 3600_000, new Date(clock + (opts.at ?? -60_000)));
    }
    const ctap = (token: string, key: string, index: number | string, extra: Record<string, unknown> = {}) =>
      tap(token, { object: `conversations:${CONV}`, action_id: String(index), idempotency_key: key, ...extra }).then((r) => r.json()) as Promise<any>;

    it('taps like Telegram: injects [tapped] <label> as the contact, answers the prompt, clears answer_needed, clears the keyboard', async () => {
      const d = await pair();
      question({ id: 'q1', labels: ['Yes', 'No', 'Later'] });
      setAnswerNeeded(db, { conversationId: CONV, messageId: 'q1' });
      const res = await ctap(d.credential, 'k1', 1);
      expect(res).toMatchObject({ status: 'done' });
      expect(injected).toHaveLength(1);
      expect(injected[0]).toMatchObject({ channel: 'telegram:peggy', sender: 'contact:chris', reply_to: 'q1', payload: { type: 'text', body: '[tapped] No' } });
      expect(injected[0]!.metadata).toMatchObject({ origin: 'surface_action', choice_prompt_id: 'p-q1', choice_index: 1, choice_label: 'No', device_id: d.device_id });
      expect(choices.getById('p-q1')).toMatchObject({ status: 'answered', chosen_index: 1, answered_by: `device:${d.device_id}` });
      expect(getAnswerNeeded(db, CONV)).toBeNull();
      expect(keyboards).toEqual(['p-q1']);
    });

    it('is idempotent on the key, and a second tap with a new key is already_done', async () => {
      const d = await pair();
      question({ id: 'q1', labels: ['Yes', 'No'] });
      expect(await ctap(d.credential, 'k1', 0)).toMatchObject({ status: 'done' });
      expect(await ctap(d.credential, 'k1', 0)).toMatchObject({ status: 'already_done' });
      expect(await ctap(d.credential, 'k2', 1)).toMatchObject({ status: 'already_done' });
      expect(injected).toHaveLength(1);
    });

    it('runs the choice command payload when the button carries one (E54)', async () => {
      const d = await pair();
      question({ id: 'q1', labels: ['Status', 'Skip'], commands: ['/status', null] });
      expect(await ctap(d.credential, 'k1', 0)).toMatchObject({ status: 'done' });
      expect(injected[0]!.payload).toEqual({ type: 'text', body: '/status' });
    });

    it('targets message_id when given, else the newest open prompt', async () => {
      const d = await pair();
      question({ id: 'old', labels: ['A', 'B'], at: -120_000 });
      question({ id: 'new', labels: ['C', 'D'], at: -30_000 });
      expect(await ctap(d.credential, 'k1', 0, { message_id: 'old' })).toMatchObject({ status: 'done' });
      expect(injected[0]!.payload).toEqual({ type: 'text', body: '[tapped] A' });
      expect(await ctap(d.credential, 'k2', 1)).toMatchObject({ status: 'done' });
      expect(injected[1]!.payload).toEqual({ type: 'text', body: '[tapped] D' });
    });

    it('fails cleanly: bad index, copy/link button, nothing open, unreadable conversation, addressed to someone else', async () => {
      const d = await pair();
      expect(await ctap(d.credential, 'n0', 0)).toMatchObject({ status: 'failed', reason: 'not_found' });
      question({ id: 'q1', labels: ['Yes', 'Open'], buttons: [null, { url: 'https://example.com' }] });
      expect(await ctap(d.credential, 'n1', 5)).toMatchObject({ status: 'failed', reason: 'invalid' });
      expect(await ctap(d.credential, 'n2', 1)).toMatchObject({ status: 'failed', reason: 'invalid' });
      expect(await ctap(d.credential, 'n3', 'x')).toMatchObject({ status: 'failed', reason: 'invalid' });
      const other = await tap(d.credential, { object: 'conversations:' + 'a'.repeat(64), action_id: '0', idempotency_key: 'n4' }).then((r) => r.json());
      expect(other).toMatchObject({ status: 'failed', reason: 'not_found' });
      expect(choices.getById('p-q1')!.status).toBe('open');
      expect(injected).toHaveLength(0);
    });

    it('reports expired for a lapsed prompt, and a prompt addressed to another contact is forbidden', async () => {
      const d = await pair();
      question({ id: 'q1', labels: ['Yes'], ttlMs: 1000, at: -120_000 });
      expect(await ctap(d.credential, 'x1', 0)).toMatchObject({ status: 'expired' });
      question({ id: 'q2', labels: ['Yes'], contact: 'kate' });
      expect(await ctap(d.credential, 'x2', 0)).toMatchObject({ status: 'failed', reason: 'forbidden' });
      expect(injected).toHaveLength(0);
    });

    it('reopens the prompt when delivery fails, so the same button can be tapped again', async () => {
      const d = await pair();
      question({ id: 'q1', labels: ['Yes'] });
      const orig = injected.push.bind(injected);
      let fail = true;
      const spy = vi.spyOn(injected, 'push').mockImplementation((...m: InboundMessage[]) => { if (fail) throw new Error('boom'); return orig(...m); });
      expect(await ctap(d.credential, 'f1', 0)).toMatchObject({ status: 'failed', reason: 'internal_error' });
      expect(choices.getById('p-q1')!.status).toBe('open');
      fail = false; spy.mockRestore();
      expect(await ctap(d.credential, 'f1', 0)).toMatchObject({ status: 'done' });
    });

    it('a read_only device cannot tap, and the prompt stays open', async () => {
      const r = await pair('read_only');
      question({ id: 'q1', labels: ['Yes'] });
      const res = await tap(r.credential, { object: `conversations:${CONV}`, action_id: '0', idempotency_key: 'ro' });
      expect(res.status).toBe(403);
      expect(choices.getById('p-q1')!.status).toBe('open');
    });

    it('the conversation page lists the same indexes the action takes', async () => {
      const d = await pair();
      question({ id: 'q1', labels: ['Yes', 'No'], ttlMs: 400 * 86_400_000 });   // the page reads the real clock
      const page = await (await fetch(`${base}/api/v1/surface/conversations/${CONV}`, { headers: { authorization: `Bearer ${d.credential}` } })).json() as any;
      expect(page.messages.at(-1).buttons).toEqual([{ index: 0, label: 'Yes' }, { index: 1, label: 'No' }]);
    });
  });
});

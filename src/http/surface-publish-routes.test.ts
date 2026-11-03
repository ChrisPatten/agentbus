import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';
import { BoundsError, RESOURCE_NAMES, type JobStore, type NewJob, type ResourceHub, type ResourceName, type ResourceOp } from '../surface/types.js';
import { getAnswerNeeded, setAnswerNeeded } from '../surface/flags.js';
import { computeConversationId } from '../pipeline/conversation-id.js';
import { isPublisher, publishableSurfaces, registerSurfacePublishRoutes, type PublishableSurface } from './surface-publish-routes.js';

const NOW = Date.parse('2026-11-03T12:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();

/** Minimal in-memory ResourceHub: one rev per (surface, resource). */
function fakeHub() {
  const data = new Map<string, Record<string, Record<string, unknown>>>();
  const revs = new Map<string, number>();
  const key = (s: string, r: ResourceName) => `${s}/${r}`;
  const applied: { surface: string; resource: ResourceName; ops: ResourceOp[] }[] = [];
  const hub: ResourceHub = {
    apply(surface, resource, ops) {
      const items = data.get(key(surface, resource)) ?? {};
      for (const op of ops) {
        if (op.op === 'remove') delete items[op.id];
        else if (op.op === 'set') items[op.id] = op.value;
        else throw new BoundsError('patch not supported in fake');
      }
      data.set(key(surface, resource), items);
      const rev = (revs.get(key(surface, resource)) ?? 0) + 1;
      revs.set(key(surface, resource), rev);
      applied.push({ surface, resource, ops });
      return rev;
    },
    get: (surface, resource, id) => data.get(key(surface, resource))?.[id] ?? null,
    snapshot: (surface, resource) => ({ rev: revs.get(key(surface, resource)) ?? 0, items: { ...(data.get(key(surface, resource)) ?? {}) } }),
    revs: (surface) => Object.fromEntries(RESOURCE_NAMES.map((r) => [r, revs.get(key(surface, r)) ?? 0])) as Record<ResourceName, number>,
    resume: () => [],
    flush: () => {},
    stop: () => {},
    sweepExpired: () => [],
  };
  return { hub, applied };
}

/** Job store fake kept in a db table, so the route's transaction applies to it like the real one. */
function fakeJobs(db: Database.Database) {
  db.exec('CREATE TABLE fake_jobs (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
  const read = (k: string) => (db.prepare('SELECT v FROM fake_jobs WHERE k = ?').get(k) as { v: string } | undefined)?.v;
  const jobs = {
    get: (k: string): NewJob[] | undefined => { const v = read(k); return v === undefined ? undefined : (JSON.parse(v) as NewJob[]); },
    has: (k: string) => read(k) !== undefined,
    get size() { return (db.prepare('SELECT COUNT(*) AS n FROM fake_jobs').get() as { n: number }).n; },
  };
  const store: JobStore = {
    replaceForEvent(surface, eventId, list) { db.prepare('INSERT OR REPLACE INTO fake_jobs (k, v) VALUES (?, ?)').run(`${surface}/${eventId}`, JSON.stringify(list)); return []; },
    removeForEvent(surface, eventId) { const n = jobs.get(`${surface}/${eventId}`)?.length ?? 0; db.prepare('DELETE FROM fake_jobs WHERE k = ?').run(`${surface}/${eventId}`); return n; },
    get: () => null,
  };
  return { store, jobs };
}

const surfaces: PublishableSurface[] = [
  { id: 'compact', follow: { contact: 'chris', channel: 'telegram:peggy' }, publishers: ['peggy'] },
  { id: 'open', follow: { contact: 'chris', channel: 'telegram:peggy', topic: 'thread:x' }, publishers: ['*'] },
  { id: 'closed', follow: { contact: 'chris', channel: 'telegram:peggy' }, publishers: [] },
];

let server: FastifyInstance | null = null;
afterEach(async () => { await server?.close(); server = null; });

async function setup() {
  const db = new Database(':memory:'); runMigrations(db);
  const { hub, applied } = fakeHub();
  const { store, jobs } = fakeJobs(db);
  const cleared: string[] = [];
  server = Fastify();
  registerSurfacePublishRoutes(server, { surfaces: () => surfaces, hub, jobs: store, db, now: () => NOW, onAnswerNeededCleared: (c) => cleared.push(c) });
  await server.ready();
  return { db, hub, applied, jobs, cleared, s: server };
}

const event = (extra: Record<string, unknown> = {}) => ({
  agent_id: 'peggy-pool-2', title: 'Train in 10 min', actions: [{ id: 'here', label: "I'm here", run: { body: 'tapped here' } }], ...extra,
});

describe('publisher matching', () => {
  it('matches exact ids, *, prefixed ids and pool panes', () => {
    expect(isPublisher(['peggy'], 'peggy')).toBe(true);
    expect(isPublisher(['peggy'], 'agent:peggy')).toBe(true);
    expect(isPublisher(['peggy'], 'peggy-pool-3')).toBe(true);
    expect(isPublisher(['peggy'], 'peggy2')).toBe(false);
    expect(isPublisher(['*'], 'anyone')).toBe(true);
    expect(isPublisher([], 'peggy')).toBe(false);
    expect(publishableSurfaces(surfaces, 'claude').map((s) => s.id)).toEqual(['open']);
  });
});

describe('surface publish routes', () => {
  it('lists the surfaces an agent may publish to', async () => {
    const { s } = await setup();
    const res = await s.inject({ method: 'GET', url: '/api/v1/surface-publish/surfaces?agent_id=peggy-pool-1' });
    expect(res.json()).toEqual({ ok: true, surfaces: [
      { id: 'compact', follow: { contact: 'chris', channel: 'telegram:peggy' } },
      { id: 'open', follow: { contact: 'chris', channel: 'telegram:peggy', topic: 'thread:x' } },
    ] });
  });

  it('creates an event with its jobs, then replaces it keeping created_at', async () => {
    const { s, hub, jobs } = await setup();
    const res = await s.inject({ method: 'PUT', url: '/api/v1/surface-publish/compact/events/train', payload: event() });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ ok: true, id: 'train', created: true, rev: 1, actions: ['here'] });
    const stored = hub.get('compact', 'events', 'train')!;
    expect(stored).toMatchObject({ title: 'Train in 10 min', source: 'agent:peggy-pool-2', created_at: iso(NOW) });
    expect(jobs.get('compact/train')).toEqual([expect.objectContaining({ action_id: 'here', channel: 'telegram:peggy', sender: 'contact:chris', payload_body: 'tapped here' })]);

    // Replace later: created_at kept, updated_at moves.
    hub.apply('compact', 'events', [{ op: 'set', id: 'train', value: { ...stored, created_at: '2026-11-01T00:00:00.000Z' } }]);
    const res2 = await s.inject({ method: 'PUT', url: '/api/v1/surface-publish/compact/events/train', payload: event({ title: 'Train in 5 min', actions: [] }) });
    expect(res2.statusCode).toBe(200);
    expect(res2.json()).toMatchObject({ created: false });
    expect(hub.get('compact', 'events', 'train')).toMatchObject({ title: 'Train in 5 min', created_at: '2026-11-01T00:00:00.000Z', updated_at: iso(NOW) });
    expect(jobs.get('compact/train')).toEqual([]);
  });

  it('removes an event and its jobs', async () => {
    const { s, hub, jobs } = await setup();
    await s.inject({ method: 'PUT', url: '/api/v1/surface-publish/compact/events/train', payload: event() });
    const res = await s.inject({ method: 'DELETE', url: '/api/v1/surface-publish/compact/events/train?agent_id=peggy' });
    expect(res.json()).toMatchObject({ ok: true, removed: true, jobs_removed: 1 });
    expect(hub.get('compact', 'events', 'train')).toBeNull();
    expect(jobs.has('compact/train')).toBe(false);
    const again = await s.inject({ method: 'DELETE', url: '/api/v1/surface-publish/compact/events/train?agent_id=peggy' });
    expect(again.json()).toMatchObject({ ok: true, removed: false });
  });

  it('403 for an agent that is not a publisher, naming the config key; 404 for an unknown surface', async () => {
    const { s, applied } = await setup();
    const res = await s.inject({ method: 'PUT', url: '/api/v1/surface-publish/compact/events/train', payload: event({ agent_id: 'claude' }) });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toContain('adapters.intercom.surfaces[id=compact].publishers');
    expect((await s.inject({ method: 'PUT', url: '/api/v1/surface-publish/closed/slots/status', payload: { agent_id: 'peggy', text: 'x', until: iso(NOW + 1000) } })).statusCode).toBe(403);
    const missing = await s.inject({ method: 'PUT', url: '/api/v1/surface-publish/nope/events/train', payload: event() });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toContain('you can publish to: compact, open');
    expect((await s.inject({ method: 'PUT', url: '/api/v1/surface-publish/compact/events/train', payload: event({ agent_id: undefined }) })).statusCode).toBe(400);
    expect(applied).toEqual([]);
  });

  it('400 with the validator message for out-of-bounds input; nothing is written', async () => {
    const { s, applied, jobs } = await setup();
    const res = await s.inject({ method: 'PUT', url: '/api/v1/surface-publish/compact/events/train', payload: event({ title: 'x'.repeat(112) }) });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ ok: false, error: 'title is 112 characters; the limit is 80' });
    const behalf = await s.inject({ method: 'PUT', url: '/api/v1/surface-publish/compact/events/x', payload: event({ actions: [{ id: 'a', label: 'Send', run: { body: 'b', sends_on_behalf: true } }] }) });
    expect(behalf.statusCode).toBe(400);
    expect(behalf.json().error).toMatch(/confirm\.draft is required/);
    expect(applied).toEqual([]);
    expect(jobs.size).toBe(0);
  });

  it('rolls the jobs back when the hub rejects the write', async () => {
    const { s, hub, jobs } = await setup();
    hub.apply = () => { throw new BoundsError('events is full'); };
    const res = await s.inject({ method: 'PUT', url: '/api/v1/surface-publish/compact/events/train', payload: event() });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('events is full');
    expect(jobs.has('compact/train')).toBe(false);
  });

  it('refuses to change a bus approval', async () => {
    const { s, hub } = await setup();
    hub.apply('compact', 'events', [{ op: 'set', id: 'appr', value: { id: 'appr', kind: 'approval', source: 'bus' } }]);
    expect((await s.inject({ method: 'PUT', url: '/api/v1/surface-publish/compact/events/appr', payload: event() })).statusCode).toBe(400);
    expect((await s.inject({ method: 'DELETE', url: '/api/v1/surface-publish/compact/events/appr?agent_id=peggy' })).statusCode).toBe(400);
  });

  it('enforces the per-surface widget limit for new ids only', async () => {
    const { s, hub } = await setup();
    for (let i = 0; i < 24; i++) hub.apply('open', 'widgets', [{ op: 'set', id: `w${i}`, value: { id: `w${i}` } }]);
    const full = await s.inject({ method: 'PUT', url: '/api/v1/surface-publish/open/widgets/extra', payload: { agent_id: 'x', type: 'weather', data: {} } });
    expect(full.statusCode).toBe(400);
    expect(full.json().error).toMatch(/already has 24 widgets; the limit is 24/);
    const replace = await s.inject({ method: 'PUT', url: '/api/v1/surface-publish/open/widgets/w3', payload: { agent_id: 'x', type: 'weather', data: { t: 1 } } });
    expect(replace.statusCode).toBe(200);
    expect(hub.get('open', 'widgets', 'w3')).toMatchObject({ type: 'weather', data: { t: 1 }, source: 'agent:x' });
  });

  it('sets and clears slots, writes and removes widgets', async () => {
    const { s, hub } = await setup();
    const set = await s.inject({ method: 'PUT', url: '/api/v1/surface-publish/compact/slots/status', payload: { agent_id: 'peggy', text: 'At the dentist', until: iso(NOW + 3600_000) } });
    expect(set.json()).toMatchObject({ ok: true, slot: 'status', until: iso(NOW + 3600_000) });
    expect(hub.get('compact', 'slots', 'status')).toMatchObject({ text: 'At the dentist' });
    const bad = await s.inject({ method: 'PUT', url: '/api/v1/surface-publish/compact/slots/status', payload: { agent_id: 'peggy', text: 'x', until: iso(NOW + 30 * 3600_000) } });
    expect(bad.statusCode).toBe(400);
    expect((await s.inject({ method: 'DELETE', url: '/api/v1/surface-publish/compact/slots/status?agent_id=peggy' })).json()).toMatchObject({ removed: true });
    expect(hub.get('compact', 'slots', 'status')).toBeNull();

    expect((await s.inject({ method: 'PUT', url: '/api/v1/surface-publish/compact/widgets/wx', payload: { agent_id: 'peggy', type: 'weather', data: { temp: 9 } } })).statusCode).toBe(200);
    expect(hub.get('compact', 'widgets', 'wx')).toMatchObject({ type: 'weather', data: { temp: 9 } });
    expect((await s.inject({ method: 'DELETE', url: '/api/v1/surface-publish/compact/widgets/wx?agent_id=peggy' })).json()).toMatchObject({ removed: true });
  });

  it('clears answer-needed by conversation id or by channel and contact', async () => {
    const { s, db, cleared } = await setup();
    setAnswerNeeded(db, { conversationId: 'conv-1', messageId: 'm1' });
    const a = await s.inject({ method: 'POST', url: '/api/v1/surface-publish/answer-needed/clear', payload: { conversation_id: 'conv-1' } });
    expect(a.json()).toEqual({ ok: true, conversation_id: 'conv-1', cleared: true });
    expect(getAnswerNeeded(db, 'conv-1')).toBeNull();

    const conv = computeConversationId('chris', 'telegram:peggy', 'general');
    setAnswerNeeded(db, { conversationId: conv, messageId: 'm2' });
    const b = await s.inject({ method: 'POST', url: '/api/v1/surface-publish/answer-needed/clear', payload: { channel: 'telegram:peggy', contact: 'contact:chris' } });
    expect(b.json()).toEqual({ ok: true, conversation_id: conv, cleared: true });
    expect(cleared).toEqual(['conv-1', conv]);
    expect((await s.inject({ method: 'POST', url: '/api/v1/surface-publish/answer-needed/clear', payload: {} })).statusCode).toBe(400);
  });
});

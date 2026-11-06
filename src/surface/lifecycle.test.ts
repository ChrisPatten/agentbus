/**
 * E100 — the Moment lifecycle end to end on the real store: publish route → resource hub → job store →
 * action handler → sweep, with the deltas a connected device receives replayed through the web client's
 * own `applyDelta`, and checked against `snapshot` (what `GET /state` returns) and `resume`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import { runMigrations } from '../db/schema.js';
import { createResourceHub, type ResourceHubImpl } from './resources.js';
import { createActionHandler, createJobStore } from './actions.js';
import { registerSurfacePublishRoutes } from '../http/surface-publish-routes.js';
import { isDecisionOrUrgent, isLiveEvent, stateOf, tombstoneDue } from './lifecycle.js';
import type { DeltaFrame, Device } from './types.js';
import type { InboundMessage, InboundResult } from '../http/api.js';
// The web client's store (plain JS, shared by both clients).
// @ts-expect-error untyped JS module
import { applyDelta, createStore } from '../../apps/intercom-web/surface.js';

const T0 = Date.parse('2026-11-03T12:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();

let server: FastifyInstance | null = null;
let hub: ResourceHubImpl | null = null;
afterEach(async () => { await server?.close(); server = null; hub?.stop(); hub = null; });

async function rig() {
  const db = new Database(':memory:'); runMigrations(db);
  const clock = { t: T0 };
  const frames: DeltaFrame[] = [];
  hub = createResourceHub({ db, sink: (_s, f) => frames.push(f), coalesceMs: 0, now: () => clock.t });
  const jobs = createJobStore(db, () => clock.t);
  const actions = createActionHandler({
    db, hub, jobs, rateLimitPerMin: 100, keyTtlHours: 48, now: () => clock.t, log: () => {},
    submitInbound: async (m: InboundMessage): Promise<InboundResult> => ({ ok: true, queued: true, id: m.id!, enqueued_count: 1 }),
  });
  server = Fastify();
  registerSurfacePublishRoutes(server, {
    surfaces: () => [{ id: 'desk', follow: { contact: 'chris', channel: 'telegram:peggy' }, publishers: ['peggy'] }],
    hub, jobs, db, now: () => clock.t,
  });
  await server.ready();
  const device: Device = { id: 'desk-1', surface_id: 'desk', name: 'Compact', profile: 'round466', scope: 'interactive', legacy: false, created_at: iso(T0), last_seen_at: null, revoked_at: null };
  const put = (id: string, body: Record<string, unknown>) => server!.inject({ method: 'PUT', url: `/api/v1/surface-publish/desk/events/${id}`, payload: { agent_id: 'peggy', title: id, ...body } });
  const del = (id: string, reason?: string) => server!.inject({ method: 'DELETE', url: `/api/v1/surface-publish/desk/events/${id}?agent_id=peggy${reason ? `&reason=${reason}` : ''}` });
  const tap = (id: string, actionId: string, key: string) => actions.handle(device, { object: `events:${id}`, action_id: actionId, idempotency_key: key });
  /** A device that saw every frame: its store must equal GET /state. */
  const deviceView = () => { const st = createStore(); for (const f of frames) expect(applyDelta(st, f)).not.toBe('gap'); return st.items.events; };
  return { clock, frames, hub: hub!, put, del, tap, deviceView };
}

const btn = { id: 'ok', label: 'OK', run: { body: 'ok tapped' } };

describe('Moment lifecycle (E100)', () => {
  it('publish → open; tap on a decision → answered; the device sees each state change, GET /state agrees', async () => {
    const r = await rig();
    expect((await r.put('ask', { weight: 'decision', actions: [btn] })).statusCode).toBe(201);
    expect(r.hub.get('desk', 'events', 'ask')).toMatchObject({ state: 'open', weight: 'decision', level: 'attention' });
    expect(await r.tap('ask', 'ok', 'k1')).toMatchObject({ status: 'done' });
    expect(r.hub.get('desk', 'events', 'ask')).toMatchObject({ state: 'answered', ended_at: iso(T0) });
    expect(await r.tap('ask', 'ok', 'k2')).toMatchObject({ status: 'expired', reason: 'answered' });
    expect(r.deviceView()).toEqual(r.hub.snapshot('desk', 'events').items);
    // The answered transition is a set carrying the state, not a removal.
    expect(r.frames.at(-1)).toMatchObject({ ops: [{ op: 'set', id: 'ask', value: { state: 'answered' } }] });
  });

  it('an ambient event stays open when tapped', async () => {
    const r = await rig();
    await r.put('fyi', { weight: 'ambient', actions: [{ ...btn, once: false }] });
    expect((await r.tap('fyi', 'ok', 'k1')).status).toBe('done');
    expect((await r.tap('fyi', 'ok', 'k2')).status).toBe('done');
    expect(stateOf(r.hub.get('desk', 'events', 'fyi'))).toBe('open');
  });

  it('remove (each reason), sweep → expired, re-publish revives, retention purges; resume from any rev reproduces /state', async () => {
    const r = await rig();
    await r.put('a', { actions: [btn] });
    await r.put('b', {});
    await r.put('c', {});
    await r.put('d', { expires_at: iso(T0 + 60_000) });
    const rev0 = r.hub.revs('desk').events;
    await r.del('a');
    await r.del('b', 'answered');
    await r.del('c', 'cleared');
    expect(await r.tap('a', 'ok', 'k1')).toMatchObject({ status: 'expired', reason: 'withdrawn' });
    r.clock.t = T0 + 120_000;
    r.hub.sweepExpired();
    const states = Object.fromEntries(Object.entries(r.hub.snapshot('desk', 'events').items).map(([id, e]) => [id, e['state']]));
    expect(states).toEqual({ a: 'withdrawn', b: 'answered', c: 'cleared', d: 'expired' });
    expect(r.hub.get('desk', 'events', 'd')).toMatchObject({ ended_at: iso(T0 + 60_000) });

    // Re-publish revives: open again, ended_at gone, its button works again.
    expect((await r.put('a', { actions: [btn] })).json()).toMatchObject({ created: true, revived: true });
    expect(r.hub.get('desk', 'events', 'a')).not.toHaveProperty('ended_at');
    expect(await r.tap('a', 'ok', 'k2')).toMatchObject({ status: 'done' });

    expect(r.deviceView()).toEqual(r.hub.snapshot('desk', 'events').items);
    for (const from of [0, rev0, rev0 + 2]) {
      const st = createStore();
      for (const f of r.frames) { if (f.type === 'delta' && 'base_rev' in f && f.rev <= from) applyDelta(st, f); }
      for (const f of r.hub.resume('desk', from ? { events: from } : {})) applyDelta(st, f);
      expect(st.items.events).toEqual(r.hub.snapshot('desk', 'events').items);
    }

    // 24 h after they ended the tombstones are purged; the revived one stays.
    r.clock.t = T0 + 25 * 3_600_000;
    r.hub.sweepExpired();
    expect(Object.keys(r.hub.snapshot('desk', 'events').items).sort()).toEqual(['a']);
    expect(r.deviceView()).toEqual(r.hub.snapshot('desk', 'events').items);
  });
});

describe('lifecycle helpers', () => {
  it('reads a missing state as open; decision/urgent by weight, else by level', () => {
    expect(stateOf({})).toBe('open');
    expect(stateOf({ state: 'nonsense' })).toBe('open');
    expect(isLiveEvent({ state: 'cleared' }, T0)).toBe(false);
    expect(isLiveEvent({ expires_at: iso(T0) }, T0)).toBe(false);
    expect(isLiveEvent({ expires_at: iso(T0 + 1) }, T0)).toBe(true);
    expect(isDecisionOrUrgent({ weight: 'notice', level: 'urgent' })).toBe(false);
    expect(isDecisionOrUrgent({ level: 'attention' })).toBe(true);
    expect(isDecisionOrUrgent({ level: 'info' })).toBe(false);
    expect(tombstoneDue({ state: 'open', ended_at: iso(0) }, T0, 1)).toBe(false);
    expect(tombstoneDue({ state: 'expired' }, T0, 1)).toBe(true);
  });
});

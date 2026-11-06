import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';
import { createActionHandler, createJobStore, sweepJobs, type ActionHandlerDeps } from './actions.js';
import { BoundsError, type ActionResult, type Device, type JobStore, type NewJob, type ResourceHub, type ResourceOp } from './types.js';
import type { InboundAbort, InboundMessage, InboundResult } from '../http/api.js';

const T0 = Date.parse('2026-11-03T12:00:00.000Z');
const S = 'watch';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function device(over: Partial<Device> = {}): Device {
  return {
    id: 'dev-1', surface_id: S, name: 'Compact', profile: 'round466', scope: 'interactive', legacy: false,
    created_at: new Date(T0).toISOString(), last_seen_at: null, revoked_at: null, ...over,
  };
}

/** Minimal fake of ResourceHub.get (and apply, for the E100 auto-answer) over a map. */
function fakeHub() {
  const items = new Map<string, Record<string, unknown>>();
  const applied: { resource: string; ops: ResourceOp[] }[] = [];
  const hub: Pick<ResourceHub, 'get' | 'apply'> = {
    get: (surfaceId, resource, id) => items.get(`${surfaceId}/${resource}/${id}`) ?? null,
    apply: (surfaceId, resource, ops) => {
      applied.push({ resource, ops });
      for (const op of ops) {
        if (op.op === 'remove') items.delete(`${surfaceId}/${resource}/${op.id}`);
        else items.set(`${surfaceId}/${resource}/${op.id}`, op.value);
      }
      return applied.length;
    },
  };
  return {
    hub, applied,
    setEvent(ev: Record<string, unknown>, surfaceId = S) { items.set(`${surfaceId}/events/${String(ev['id'])}`, ev); },
    removeEvent(id: string, surfaceId = S) { items.delete(`${surfaceId}/events/${id}`); },
  };
}

function event(id: string, actions: Record<string, unknown>[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, kind: 'event', title: 'Pick-up', level: 'info', actions, source: 'agent:peggy',
    created_at: new Date(T0).toISOString(), updated_at: new Date(T0).toISOString(), ...extra,
  };
}

function job(over: Partial<NewJob> = {}): NewJob {
  return {
    action_id: 'here', channel: 'telegram', sender: 'contact:chris', topic: 'general', payload_body: "I'm here",
    sends_on_behalf: false, confirm_draft: null, once: true, expires_at: null, ...over,
  };
}

interface Setup {
  db: Database.Database;
  jobs: JobStore;
  hub: ReturnType<typeof fakeHub>;
  sent: InboundMessage[];
  clock: { t: number };
  handler: ReturnType<typeof createActionHandler>;
  submit: ReturnType<typeof vi.fn>;
}

function setup(over: Partial<ActionHandlerDeps> = {}, submitImpl?: (m: InboundMessage) => Promise<InboundResult | InboundAbort>): Setup {
  const db = makeDb();
  const clock = { t: T0 };
  const now = () => clock.t;
  const jobs = createJobStore(db, now);
  const hub = fakeHub();
  const sent: InboundMessage[] = [];
  const submit = vi.fn(submitImpl ?? (async (m: InboundMessage): Promise<InboundResult> => {
    sent.push(m);
    return { ok: true, queued: true, id: m.id!, enqueued_count: 1 };
  }));
  const handler = createActionHandler({
    db, hub: hub.hub, jobs, submitInbound: submit, rateLimitPerMin: 30, keyTtlHours: 48, now, log: () => {}, ...over,
  });
  return { db, jobs, hub, sent, clock, handler, submit };
}

const req = (key: string, extra: Record<string, unknown> = {}) => ({ object: 'events:pickup', action_id: 'here', idempotency_key: key, ...extra });

describe('JobStore', () => {
  it('stores jobs under events:<event>:<action> and replaces them per event', () => {
    const db = makeDb();
    const store = createJobStore(db, () => T0);
    const [j] = store.replaceForEvent(S, 'pickup', [job()], 'agent:peggy');
    expect(j.object_ref).toBe('events:pickup:here');
    expect(j.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(store.get(S, 'events:pickup:here')).toMatchObject({ payload_body: "I'm here", once: true, sends_on_behalf: false, trigger: 'action' });

    store.replaceForEvent(S, 'pickup', [job({ action_id: 'late', payload_body: 'Running late' })], 'agent:peggy');
    expect(store.get(S, 'events:pickup:here')).toBeNull();
    expect(store.get(S, 'events:pickup:late')?.payload_body).toBe('Running late');
    expect(store.removeForEvent(S, 'pickup')).toBe(1);
  });

  it('does not touch another event whose id shares a prefix', () => {
    const store = createJobStore(makeDb(), () => T0);
    store.replaceForEvent(S, 'pick', [job()], 'a');
    store.replaceForEvent(S, 'pick_up', [job()], 'a');
    store.replaceForEvent(S, 'pick', [], 'a');
    expect(store.get(S, 'events:pick_up:here')).not.toBeNull();
  });

  it('keeps fire_count when an event is updated with the same action id', () => {
    const db = makeDb();
    const store = createJobStore(db, () => T0);
    const [j] = store.replaceForEvent(S, 'pickup', [job()], 'a');
    db.prepare(`UPDATE surface_jobs SET fire_count = 1 WHERE id = ?`).run(j.id);
    const [k] = store.replaceForEvent(S, 'pickup', [job({ payload_body: 'edited' })], 'a');
    expect(k).toMatchObject({ id: j.id, fire_count: 1, payload_body: 'edited' });
  });

  it('rejects a send-on-behalf job without a draft, and out-of-bounds input', () => {
    const store = createJobStore(makeDb(), () => T0);
    expect(() => store.replaceForEvent(S, 'pickup', [job({ sends_on_behalf: true })], 'a')).toThrow(BoundsError);
    expect(() => store.replaceForEvent(S, 'pickup', [job({ action_id: 'Bad Id' })], 'a')).toThrow(BoundsError);
    expect(() => store.replaceForEvent(S, 'pickup', [job(), job()], 'a')).toThrow(/duplicate/);
    expect(() => store.replaceForEvent(S, 'pickup', [job({ payload_body: 'x'.repeat(4001) })], 'a')).toThrow(BoundsError);
  });

  it('sweepJobs deletes jobs expired over a day ago and keys older than the TTL', () => {
    const db = makeDb();
    const store = createJobStore(db, () => T0);
    store.replaceForEvent(S, 'old', [job({ expires_at: new Date(T0 - 2 * 86_400_000).toISOString() })], 'a');
    store.replaceForEvent(S, 'recent', [job({ expires_at: new Date(T0 - 3_600_000).toISOString() })], 'a');
    store.replaceForEvent(S, 'open', [job()], 'a');
    const ins = db.prepare(`INSERT INTO surface_action_keys VALUES (?, ?, 'd', '{}', ?)`);
    ins.run(S, 'k-old', new Date(T0 - 49 * 3_600_000).toISOString());
    ins.run(S, 'k-new', new Date(T0 - 3_600_000).toISOString());
    expect(sweepJobs(db, T0, 48)).toEqual({ jobs: 1, keys: 1 });
    expect(store.get(S, 'events:old:here')).toBeNull();
    expect(store.get(S, 'events:recent:here')).not.toBeNull();
    expect(store.get(S, 'events:open:here')).not.toBeNull();
  });
});

describe('ActionHandler: Event jobs', () => {
  let s: Setup;
  beforeEach(() => {
    s = setup();
    s.hub.setEvent(event('pickup', [{ id: 'here', label: "I'm here" }]));
    s.jobs.replaceForEvent(S, 'pickup', [job()], 'agent:peggy');
  });

  it('"I\'m here" sends the stored payload once, like a scheduler fire', async () => {
    const res = await s.handler.handle(device(), req('k1'));
    expect(res).toMatchObject({ type: 'action_result', idempotency_key: 'k1', status: 'done' });
    expect(res.message_id).toBe(s.sent[0].id);
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]).toMatchObject({
      channel: 'telegram', sender: 'contact:chris', topic: 'general', payload: { type: 'text', body: "I'm here" },
      metadata: { origin: 'surface_action', surface_id: S, device_id: 'dev-1', object: 'events:pickup', action_id: 'here', idempotency_key: 'k1' },
    });
    expect(s.jobs.get(S, 'events:pickup:here')).toMatchObject({ fire_count: 1, last_fired_at: new Date(T0).toISOString() });
  });

  it('a second tap with the same key returns already_done and does not fire', async () => {
    const first = await s.handler.handle(device(), req('k1'));
    const second = await s.handler.handle(device({ id: 'dev-2' }), req('k1'));
    expect(second).toMatchObject({ status: 'already_done', message_id: first.message_id });
    expect(s.submit).toHaveBeenCalledTimes(1);
  });

  it('a different key on a once job returns already_done', async () => {
    await s.handler.handle(device(), req('k1'));
    expect((await s.handler.handle(device(), req('k2'))).status).toBe('already_done');
    expect(s.submit).toHaveBeenCalledTimes(1);
  });

  it('a non-once job fires per key', async () => {
    s.jobs.replaceForEvent(S, 'pickup', [job({ once: false })], 'a');
    await s.handler.handle(device(), req('k1'));
    expect((await s.handler.handle(device(), req('k2'))).status).toBe('done');
    expect(s.submit).toHaveBeenCalledTimes(2);
  });

  it('concurrent duplicate requests fire once', async () => {
    const results = await Promise.all([1, 2, 3, 4].map(() => s.handler.handle(device(), req('k1'))));
    expect(s.submit).toHaveBeenCalledTimes(1);
    expect(results.map((r) => r.status).sort()).toEqual(['already_done', 'already_done', 'already_done', 'done']);
  });

  it('concurrent taps with different keys on a once job fire once', async () => {
    const results = await Promise.all(['a', 'b', 'c'].map((k) => s.handler.handle(device(), req(k))));
    expect(s.submit).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r.status === 'done')).toHaveLength(1);
  });

  it('a tap after the event expires returns expired', async () => {
    s.hub.setEvent(event('pickup', [{ id: 'here', label: "I'm here" }], { expires_at: new Date(T0 + 60_000).toISOString() }));
    s.clock.t = T0 + 61_000;
    expect((await s.handler.handle(device(), req('k1'))).status).toBe('expired');
    expect(s.submit).not.toHaveBeenCalled();
  });

  it('a tap after the job expires returns expired, also once the event is gone', async () => {
    s.jobs.replaceForEvent(S, 'pickup', [job({ expires_at: new Date(T0 + 60_000).toISOString() })], 'a');
    s.clock.t = T0 + 61_000;
    expect((await s.handler.handle(device(), req('k1'))).status).toBe('expired');
    s.hub.removeEvent('pickup');
    expect((await s.handler.handle(device(), req('k2'))).status).toBe('expired');
    expect(s.submit).not.toHaveBeenCalled();
  });

  it('unknown event or action answers not_found', async () => {
    expect(await s.handler.handle(device(), { ...req('k1'), object: 'events:nope' })).toMatchObject({ status: 'failed', reason: 'not_found' });
    expect(await s.handler.handle(device(), { ...req('k2'), action_id: 'other' })).toMatchObject({ status: 'failed', reason: 'not_found' });
    s.hub.setEvent(event('bare', [{ id: 'here', label: 'x' }]));
    expect(await s.handler.handle(device(), { ...req('k3'), object: 'events:bare' })).toMatchObject({ status: 'failed', reason: 'not_found' });
    expect(s.submit).not.toHaveBeenCalled();
  });

  it('a pipeline abort is failed with its reason; a command counts as done', async () => {
    s = setup({}, async () => ({ ok: true, queued: false, reason: 'adapter_paused' }));
    s.hub.setEvent(event('pickup', [{ id: 'here', label: 'x' }]));
    s.jobs.replaceForEvent(S, 'pickup', [job({ once: false })], 'a');
    expect(await s.handler.handle(device(), req('k1'))).toMatchObject({ status: 'failed', reason: 'adapter_paused' });
    expect(await s.handler.handle(device(), req('k1'))).toMatchObject({ status: 'failed', reason: 'adapter_paused' });
    expect(s.submit).toHaveBeenCalledTimes(1);

    s.submit.mockImplementation(async () => ({ ok: true, queued: false, reason: 'command_handled' }));
    expect((await s.handler.handle(device(), req('k2'))).status).toBe('done');
  });

  it('a thrown pipeline error is internal_error and the same key may retry', async () => {
    s.submit.mockImplementationOnce(async () => { throw new Error('boom'); });
    expect(await s.handler.handle(device(), req('k1'))).toMatchObject({ status: 'failed', reason: 'internal_error' });
    expect(s.jobs.get(S, 'events:pickup:here')?.fire_count).toBe(0);
    expect((await s.handler.handle(device(), req('k1'))).status).toBe('done');
    expect(s.sent).toHaveLength(1);
  });

  it('an idempotency key older than the TTL is forgotten', async () => {
    s.jobs.replaceForEvent(S, 'pickup', [job({ once: false })], 'a');
    await s.handler.handle(device(), req('k1'));
    s.clock.t = T0 + 49 * 3_600_000;
    expect((await s.handler.handle(device(), req('k1'))).status).toBe('done');
    expect(s.submit).toHaveBeenCalledTimes(2);
  });
});

describe('ActionHandler: confirm.draft', () => {
  const DRAFT = 'On my way, see you at 6.';
  let s: Setup;
  beforeEach(() => {
    s = setup();
    s.hub.setEvent(event('reply', [{ id: 'send', label: 'Send', confirm: { draft: DRAFT } }]));
    s.jobs.replaceForEvent(S, 'reply', [job({ action_id: 'send', sends_on_behalf: true, confirm_draft: DRAFT, payload_body: `send this: ${DRAFT}` })], 'a');
  });
  const r = (key: string, draft?: string) => ({ object: 'events:reply', action_id: 'send', idempotency_key: key, ...(draft !== undefined ? { draft } : {}) });

  it('rejects a request without the draft', async () => {
    expect(await s.handler.handle(device(), r('k1'))).toMatchObject({ status: 'failed', reason: 'confirm_required' });
    expect(s.submit).not.toHaveBeenCalled();
  });

  it('rejects a mismatching draft', async () => {
    expect(await s.handler.handle(device(), r('k1', 'On my way'))).toMatchObject({ status: 'failed', reason: 'draft_mismatch' });
    expect(s.submit).not.toHaveBeenCalled();
  });

  it('fires on an exact draft', async () => {
    expect((await s.handler.handle(device(), r('k1', DRAFT))).status).toBe('done');
    expect(s.sent[0].payload).toEqual({ type: 'text', body: `send this: ${DRAFT}` });
  });

  it('never fires a send-on-behalf job behind an action without confirm.draft', async () => {
    s.hub.setEvent(event('reply', [{ id: 'send', label: 'Send' }]));
    expect(await s.handler.handle(device(), r('k1', DRAFT))).toMatchObject({ status: 'failed', reason: 'confirm_required' });
    expect(s.submit).not.toHaveBeenCalled();
  });

  it('never fires when the shown draft differs from the stored one', async () => {
    s.hub.setEvent(event('reply', [{ id: 'send', label: 'Send', confirm: { draft: 'Something else' } }]));
    expect(await s.handler.handle(device(), r('k1', 'Something else'))).toMatchObject({ status: 'failed', reason: 'confirm_required' });
    expect(s.submit).not.toHaveBeenCalled();
  });

  it('never fires a send-on-behalf row that somehow has no stored draft', async () => {
    s.db.prepare(`UPDATE surface_jobs SET confirm_draft = NULL`).run();
    expect(await s.handler.handle(device(), r('k1', DRAFT))).toMatchObject({ status: 'failed', reason: 'confirm_required' });
    expect(s.submit).not.toHaveBeenCalled();
  });
});

describe('ActionHandler: gates', () => {
  it('rejects malformed requests as invalid without storing', async () => {
    const s = setup();
    expect(await s.handler.handle(device(), { object: 'faces:x', action_id: 'a', idempotency_key: 'k' })).toMatchObject({ status: 'failed', reason: 'invalid', idempotency_key: 'k' });
    expect(await s.handler.handle(device(), 'nonsense')).toMatchObject({ status: 'failed', reason: 'invalid', idempotency_key: '' });
    expect(await s.handler.handle(device(), { ...req('x'.repeat(101)) })).toMatchObject({ reason: 'invalid', idempotency_key: '' });
    expect(s.db.prepare(`SELECT COUNT(*) AS n FROM surface_action_keys`).get()).toEqual({ n: 0 });
  });

  it('refuses a read-only device', async () => {
    const s = setup();
    s.hub.setEvent(event('pickup', [{ id: 'here', label: 'x' }]));
    s.jobs.replaceForEvent(S, 'pickup', [job()], 'a');
    expect(await s.handler.handle(device({ scope: 'read_only' }), req('k1'))).toMatchObject({ status: 'failed', reason: 'read_only' });
    expect(s.submit).not.toHaveBeenCalled();
    expect((await s.handler.handle(device(), req('k1'))).status).toBe('done');   // not stored under the key
  });

  it('rate-limits per device in a sliding window', async () => {
    const s = setup({ rateLimitPerMin: 2 });
    const statuses: (string | undefined)[] = [];
    for (const k of ['a', 'b', 'c']) statuses.push((await s.handler.handle(device(), req(k))).reason);
    expect(statuses).toEqual(['not_found', 'not_found', 'rate_limited']);
    expect((await s.handler.handle(device({ id: 'dev-2' }), req('d'))).reason).toBe('not_found');
    s.clock.t = T0 + 60_001;
    expect((await s.handler.handle(device(), req('e'))).reason).toBe('not_found');
  });
});

describe('ActionHandler: delegation', () => {
  it('routes notices:<id> to noticeAction and stores the result under the key', async () => {
    const noticeAction = vi.fn(async (_d: Device, _n: string, _a: string, key: string): Promise<ActionResult> =>
      ({ type: 'action_result', idempotency_key: key, status: 'done', message_id: 'm-1' }));
    const s = setup({ noticeAction });
    const res = await s.handler.handle(device(), { object: 'notices:n-42', action_id: '1', idempotency_key: 'k1' });
    expect(res).toMatchObject({ status: 'done', message_id: 'm-1', idempotency_key: 'k1' });
    expect(noticeAction).toHaveBeenCalledWith(expect.objectContaining({ id: 'dev-1' }), 'n-42', '1', 'k1');
    expect((await s.handler.handle(device(), { object: 'notices:n-42', action_id: '1', idempotency_key: 'k1' })).status).toBe('already_done');
    expect(noticeAction).toHaveBeenCalledTimes(1);
    expect((await s.handler.handle(device(), { object: 'notices:n-42', action_id: 'yes', idempotency_key: 'k2' })).reason).toBe('invalid');
    expect(s.submit).not.toHaveBeenCalled();
  });

  it('routes Approve/Deny on an approval event to approvalAction', async () => {
    const approvalAction = vi.fn(async (_d: Device, _id: string, _dec: 'approve' | 'deny', key: string): Promise<ActionResult> =>
      ({ type: 'action_result', idempotency_key: key, status: 'done' }));
    const s = setup({ approvalAction });
    s.hub.setEvent(event('approval-ab12', [{ id: 'approve', label: 'Approve' }, { id: 'deny', label: 'Deny' }], { kind: 'approval', approval: { detail: 'rm -rf build' } }));
    expect((await s.handler.handle(device(), { object: 'events:approval-ab12', action_id: 'deny', idempotency_key: 'k1' })).status).toBe('done');
    expect(approvalAction).toHaveBeenCalledWith(expect.anything(), 'ab12', 'deny', 'k1');
    expect(s.submit).not.toHaveBeenCalled();
  });

  it('a thrown delegate is internal_error and not stored', async () => {
    const noticeAction = vi.fn(async (): Promise<ActionResult> => { throw new Error('boom'); });
    const s = setup({ noticeAction });
    const r = { object: 'notices:n-1', action_id: '0', idempotency_key: 'k1' };
    expect((await s.handler.handle(device(), r)).reason).toBe('internal_error');
    noticeAction.mockImplementationOnce(async () => ({ type: 'action_result', idempotency_key: 'k1', status: 'done' }));
    expect((await s.handler.handle(device(), r)).status).toBe('done');
  });
});

describe('JobStore: slot buttons', () => {
  it('stores jobs under slots:<slot>:<action>, separate from events of the same name', () => {
    const db = makeDb();
    const store = createJobStore(db, () => T0);
    const [j] = store.replaceForSlot(S, 'primary', [job({ action_id: 'go' })], 'agent:peggy');
    store.replaceForEvent(S, 'primary', [job({ action_id: 'go', payload_body: 'event' })], 'agent:peggy');
    expect(j!.object_ref).toBe('slots:primary:go');
    expect(store.get(S, 'slots:primary:go')!.payload_body).toBe("I'm here");
    expect(store.get(S, 'events:primary:go')!.payload_body).toBe('event');
    expect(store.removeForSlot(S, 'primary')).toBe(1);
    expect(store.get(S, 'slots:primary:go')).toBeNull();
    expect(store.get(S, 'events:primary:go')).not.toBeNull();
  });

  it('keeps fire_count when a slot is replaced and validates like events', () => {
    const db = makeDb();
    const store = createJobStore(db, () => T0);
    const [a] = store.replaceForSlot(S, 'primary', [job({ action_id: 'go' })], 'a');
    db.prepare('UPDATE surface_jobs SET fire_count = 1 WHERE id = ?').run(a!.id);
    const [b] = store.replaceForSlot(S, 'primary', [job({ action_id: 'go', payload_body: 'edited' })], 'a');
    expect(b).toMatchObject({ id: a!.id, fire_count: 1, payload_body: 'edited' });
    expect(() => store.replaceForSlot(S, 'Bad Slot', [job()], 'a')).toThrow(/invalid slot id/);
    expect(() => store.replaceForSlot(S, 'primary', [job({ sends_on_behalf: true })], 'a')).toThrow(BoundsError);
  });
});

describe('ActionHandler: E100 lifecycle', () => {
  const tapOn = async (extra: Record<string, unknown>, over: Partial<NewJob> = {}) => {
    const s = setup();
    s.hub.setEvent(event('pickup', [{ id: 'here', label: "I'm here" }], extra));
    s.jobs.replaceForEvent(S, 'pickup', [job(over)], 'agent:peggy');
    const res = await s.handler.handle(device(), req('k1'));
    return { s, res, after: s.hub.hub.get(S, 'events', 'pickup')! };
  };

  it('a done fire on a decision or urgent event ends it as answered (by weight or by level)', async () => {
    for (const extra of [{ weight: 'decision', level: 'attention' }, { weight: 'urgent', level: 'urgent' }, { level: 'attention' }, { level: 'urgent' }]) {
      const { res, after, s } = await tapOn({ ...extra, state: 'open' });
      expect(res.status).toBe('done');
      expect(after).toMatchObject({ state: 'answered', ended_at: new Date(T0).toISOString() });
      expect(s.hub.applied).toEqual([{ resource: 'events', ops: [{ op: 'set', id: 'pickup', value: expect.objectContaining({ state: 'answered' }) }] }]);
    }
  });

  it('ambient and notice events stay open when a button is tapped', async () => {
    for (const extra of [{ weight: 'ambient', level: 'info' }, { weight: 'notice', level: 'info' }, { level: 'info' }]) {
      const { res, after, s } = await tapOn({ ...extra, state: 'open' });
      expect(res.status).toBe('done');
      expect(after['state']).toBe('open');
      expect(s.hub.applied).toEqual([]);
    }
  });

  it('a failed fire does not answer the event', async () => {
    const s = setup({}, async () => ({ ok: true, queued: true, id: 'x', enqueued_count: 0 }));
    s.hub.setEvent(event('pickup', [{ id: 'here', label: "I'm here" }], { weight: 'decision', level: 'attention', state: 'open' }));
    s.jobs.replaceForEvent(S, 'pickup', [job()], 'agent:peggy');
    expect(await s.handler.handle(device(), req('k1'))).toMatchObject({ status: 'failed', reason: 'no_route' });
    expect(s.hub.hub.get(S, 'events', 'pickup')!['state']).toBe('open');
  });

  it('taps on a tombstone answer expired with the state as reason, and fire nothing', async () => {
    for (const state of ['expired', 'withdrawn', 'answered', 'cleared']) {
      const { res, s } = await tapOn({ state, ended_at: new Date(T0).toISOString() });
      expect(res).toMatchObject({ status: 'expired', reason: state });
      expect(s.submit).not.toHaveBeenCalled();
    }
  });

  it('after the auto-answer a second key answers expired/answered; the same key replays already_done', async () => {
    const { s } = await tapOn({ weight: 'urgent', level: 'urgent', state: 'open' }, { once: false });
    expect(await s.handler.handle(device(), req('k2'))).toMatchObject({ status: 'expired', reason: 'answered' });
    expect((await s.handler.handle(device(), req('k1'))).status).toBe('already_done');
    expect(s.submit).toHaveBeenCalledTimes(1);
  });

  it('does not answer a version re-published while the tap was in flight', async () => {
    let s!: Setup;
    s = setup({}, async (m) => {
      s.hub.setEvent(event('pickup', [{ id: 'here', label: "I'm here" }], { weight: 'decision', level: 'attention', state: 'open', updated_at: new Date(T0 + 5).toISOString() }));
      return { ok: true, queued: true, id: m.id!, enqueued_count: 1 };
    });
    s.hub.setEvent(event('pickup', [{ id: 'here', label: "I'm here" }], { weight: 'decision', level: 'attention', state: 'open' }));
    s.jobs.replaceForEvent(S, 'pickup', [job()], 'agent:peggy');
    expect((await s.handler.handle(device(), req('k1'))).status).toBe('done');
    expect(s.hub.hub.get(S, 'events', 'pickup')!['state']).toBe('open');
  });

  it('an approval tombstone answers expired with its state', async () => {
    const approvalAction = vi.fn();
    const s = setup({ approvalAction });
    s.hub.setEvent(event('approval-ab12', [{ id: 'approve', label: 'Approve' }], { kind: 'approval', state: 'answered', approval: { detail: 'x' } }));
    expect(await s.handler.handle(device(), { object: 'events:approval-ab12', action_id: 'approve', idempotency_key: 'k1' })).toMatchObject({ status: 'expired', reason: 'answered' });
    expect(approvalAction).not.toHaveBeenCalled();
  });
});

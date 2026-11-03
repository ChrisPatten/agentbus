import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';
import { applyOps, createResourceHub, diffOps, type ResourceHubImpl } from './resources.js';
import { BOUNDS, BoundsError, type DeltaFrame, type ResourceOp } from './types.js';

let db: Database.Database;
let hub: ResourceHubImpl | undefined;
let frames: { surface: string; frame: DeltaFrame }[];

function setup(opts: { coalesceMs?: number; logRetentionRevs?: number; now?: () => number } = {}) {
  db = new Database(':memory:');
  runMigrations(db);
  frames = [];
  hub = createResourceHub({ db, sink: (surface, frame) => frames.push({ surface, frame }), coalesceMs: opts.coalesceMs ?? 0, logRetentionRevs: opts.logRetentionRevs, now: opts.now });
  return hub;
}

afterEach(() => { hub?.stop(); hub = undefined; db?.close(); vi.useRealTimers(); });

const ev = (title: string, extra: Record<string, unknown> = {}) => ({ id: title, kind: 'event', title, level: 'info', actions: [], ...extra });

/** Five mixed changes to `events` on surface `s`. */
function fiveChanges(h: ResourceHubImpl) {
  h.apply('s', 'events', [{ op: 'set', id: 'c', value: ev('c') }]);
  h.apply('s', 'events', [{ op: 'patch', id: 'a', value: { title: 'A2', body: 'hi' } }]);
  h.apply('s', 'events', [{ op: 'remove', id: 'b' }]);
  h.apply('s', 'events', [{ op: 'set', id: 'd', value: ev('d') }, { op: 'patch', id: 'd', value: { level: 'urgent' } }]);
  h.apply('s', 'events', [{ op: 'patch', id: 'a', value: { body: null } }]);
}

describe('apply, get, snapshot, revs', () => {
  it('bumps the rev per apply, writes items, and reports 0 for untouched resources', () => {
    const h = setup();
    expect(h.apply('s', 'events', [{ op: 'set', id: 'a', value: ev('a') }])).toBe(1);
    expect(h.apply('s', 'events', [{ op: 'set', id: 'b', value: ev('b') }])).toBe(2);
    expect(h.get('s', 'events', 'a')).toEqual(ev('a'));
    expect(h.get('s', 'events', 'zz')).toBeNull();
    expect(h.snapshot('s', 'events')).toEqual({ rev: 2, items: { a: ev('a'), b: ev('b') } });
    expect(h.revs('s')).toEqual({ faces: 0, events: 2, slots: 0, widgets: 0, sessions: 0, notices: 0, device: 0 });
    expect(h.revs('other').events).toBe(0);
  });

  it('treats an empty ops list as a no-op returning the current rev', () => {
    const h = setup();
    h.apply('s', 'faces', [{ op: 'set', id: 'day', value: { id: 'day', order: 0, enabled: true } }]);
    expect(h.apply('s', 'faces', [])).toBe(1);
    expect(frames).toHaveLength(1);
  });

  it('patch shallow-merges and a null value deletes the key', () => {
    const h = setup();
    h.apply('s', 'widgets', [{ op: 'set', id: 'w', value: { id: 'w', type: 'weather', data: { t: 1 }, note: 'x' } }]);
    h.apply('s', 'widgets', [{ op: 'patch', id: 'w', value: { note: null, data: { t: 2 } } }]);
    expect(h.get('s', 'widgets', 'w')).toEqual({ id: 'w', type: 'weather', data: { t: 2 } });
  });
});

describe('bounds', () => {
  function expectNothingWritten(h: ResourceHubImpl, fn: () => void, msg: RegExp) {
    const before = JSON.stringify([h.revs('s'), h.snapshot('s', 'events'), h.snapshot('s', 'slots'), h.snapshot('s', 'widgets')]);
    const logCount = (db.prepare('SELECT COUNT(*) AS n FROM surface_resource_log').get() as { n: number }).n;
    expect(fn).toThrow(BoundsError);
    expect(fn).toThrow(msg);
    expect(JSON.stringify([h.revs('s'), h.snapshot('s', 'events'), h.snapshot('s', 'slots'), h.snapshot('s', 'widgets')])).toBe(before);
    expect((db.prepare('SELECT COUNT(*) AS n FROM surface_resource_log').get() as { n: number }).n).toBe(logCount);
  }

  it('rejects malformed input and writes nothing', () => {
    const h = setup();
    h.apply('s', 'events', [{ op: 'set', id: 'a', value: ev('a') }]);
    expectNothingWritten(h, () => h.apply('s', 'bogus' as 'events', []), /unknown resource "bogus"/);
    expectNothingWritten(h, () => h.apply('s', 'events', [{ op: 'nuke', id: 'a' } as unknown as ResourceOp]), /op must be "set", "patch" or "remove"/);
    expectNothingWritten(h, () => h.apply('s', 'events', [{ op: 'remove', id: '' }]), /id must be a string of 1-128/);
    expectNothingWritten(h, () => h.apply('s', 'events', [{ op: 'remove', id: 'x'.repeat(129) }]), /1-128/);
    expectNothingWritten(h, () => h.apply('s', 'events', [{ op: 'set', id: 'b', value: [1] as unknown as Record<string, unknown> }]), /value to be a JSON object/);
    // A valid op before a bad one is not written either.
    expectNothingWritten(h, () => h.apply('s', 'events', [{ op: 'set', id: 'b', value: ev('b') }, { op: 'patch', id: 'missing', value: { title: 'x' } }]), /cannot patch "missing": no such item/);
    expect(frames).toHaveLength(1);
  });

  it('caps live events, slots and widgets per surface', () => {
    const now = Date.parse('2026-11-03T12:00:00Z');
    const h = setup({ now: () => now });
    const events: ResourceOp[] = Array.from({ length: BOUNDS.eventsPerSurface }, (_, i) => ({ op: 'set', id: `e${i}`, value: ev(`e${i}`) }));
    h.apply('s', 'events', events);
    expectNothingWritten(h, () => h.apply('s', 'events', [{ op: 'set', id: 'one-more', value: ev('x') }]), /51 live events on surface "s" \(limit 50\)/);
    // Expired events do not count; other surfaces have their own cap.
    h.apply('s', 'events', [{ op: 'patch', id: 'e0', value: { expires_at: '2026-11-03T11:00:00Z' } }]);
    expect(() => h.apply('s', 'events', [{ op: 'set', id: 'one-more', value: ev('x') }])).not.toThrow();
    expect(() => h.apply('t', 'events', [{ op: 'set', id: 'a', value: ev('a') }])).not.toThrow();

    const slots: ResourceOp[] = Array.from({ length: BOUNDS.slotsPerSurface + 1 }, (_, i) => ({ op: 'set', id: `s${i}`, value: { text: 'x' } }));
    expectNothingWritten(h, () => h.apply('s', 'slots', slots), /13 slot overrides .*limit 12/);
    const widgets: ResourceOp[] = Array.from({ length: BOUNDS.widgetsPerSurface + 1 }, (_, i) => ({ op: 'set', id: `w${i}`, value: { type: 't', data: {} } }));
    expectNothingWritten(h, () => h.apply('s', 'widgets', widgets), /25 widgets .*limit 24/);
  });

  it('caps serialized widget data, including after a patch', () => {
    const h = setup();
    const big = { blob: 'x'.repeat(BOUNDS.widgetDataBytes) };
    expectNothingWritten(h, () => h.apply('s', 'widgets', [{ op: 'set', id: 'w', value: { type: 't', data: big } }]), /widgets\["w"\]: data is \d+ bytes as JSON \(limit 4096\)/);
    h.apply('s', 'widgets', [{ op: 'set', id: 'w', value: { type: 't', data: { a: 1 } } }]);
    expectNothingWritten(h, () => h.apply('s', 'widgets', [{ op: 'patch', id: 'w', value: { data: big } }]), /limit 4096/);
  });
});

describe('resume', () => {
  it('replays 5 changes made while disconnected as one delta that reproduces the snapshot', () => {
    const h = setup();
    h.apply('s', 'events', [{ op: 'set', id: 'a', value: ev('a') }, { op: 'set', id: 'b', value: ev('b') }]);
    const old = h.snapshot('s', 'events');
    const oldRevs = h.revs('s');
    fiveChanges(h);

    const out = h.resume('s', oldRevs);
    expect(out).toHaveLength(1);
    const f = out[0]!;
    if ('reset' in f) throw new Error('expected a delta');
    expect(f).toMatchObject({ resource: 'events', base_rev: 1, rev: 6 });
    expect(f.ops).toHaveLength(6);
    expect(applyOps(structuredClone(old.items), f.ops)).toEqual(h.snapshot('s', 'events').items);
    // Already current: nothing.
    expect(h.resume('s', h.revs('s'))).toEqual([]);
  });

  it('sends a reset when the log no longer holds the gap', () => {
    const h = setup({ logRetentionRevs: 3 });
    h.apply('s', 'events', [{ op: 'set', id: 'a', value: ev('a') }, { op: 'set', id: 'b', value: ev('b') }]);
    const oldRevs = h.revs('s');
    fiveChanges(h);
    expect((db.prepare('SELECT COUNT(*) AS n FROM surface_resource_log').get() as { n: number }).n).toBe(3);

    const out = h.resume('s', oldRevs);
    expect(out).toEqual([{ type: 'delta', resource: 'events', rev: 6, reset: true, items: h.snapshot('s', 'events').items }]);
    // Within retention a delta still works.
    const recent = h.resume('s', { ...oldRevs, events: 4 });
    expect(recent[0]).toMatchObject({ base_rev: 4, rev: 6 });
  });

  it('resets a resource the client is ahead on or did not list, and skips empty ones', () => {
    const h = setup();
    h.apply('s', 'faces', [{ op: 'set', id: 'day', value: { order: 0 } }]);
    h.apply('s', 'slots', [{ op: 'set', id: 'top', value: { text: 'hi' } }]);
    const out = h.resume('s', { faces: 9, events: 0, widgets: 3 });
    expect(out.map((f) => [f.resource, 'reset' in f])).toEqual([['faces', true], ['slots', true], ['widgets', true]]);
    expect(out.find((f) => f.resource === 'widgets')).toEqual({ type: 'delta', resource: 'widgets', rev: 0, reset: true, items: {} });
  });
});

describe('delta push and coalescing', () => {
  beforeEach(() => { vi.useFakeTimers(); });

  it('sends the first change at once and 4 rapid changes as one trailing frame', () => {
    const h = setup({ coalesceMs: 250 });
    h.apply('s', 'events', [{ op: 'set', id: 'a', value: ev('a') }]);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({ surface: 's', frame: { type: 'delta', resource: 'events', base_rev: 0, rev: 1, ops: [{ op: 'set', id: 'a', value: ev('a') }] } });

    for (const id of ['b', 'c', 'd']) h.apply('s', 'events', [{ op: 'set', id, value: ev(id) }]);
    h.apply('s', 'events', [{ op: 'remove', id: 'b' }]);
    h.apply('s', 'slots', [{ op: 'set', id: 'top', value: { text: 'x' } }]); // other resource: own window, sent at once
    expect(frames).toHaveLength(2);
    expect(frames[1]!.frame.resource).toBe('slots');

    vi.advanceTimersByTime(250);
    expect(frames).toHaveLength(3);
    const trailing = frames[2]!.frame;
    expect(trailing).toMatchObject({ resource: 'events', base_rev: 1, rev: 5 });
    if ('reset' in trailing) throw new Error('expected ops');
    expect(trailing.ops.map((o) => `${o.op}:${o.id}`)).toEqual(['set:b', 'set:c', 'set:d', 'remove:b']);

    // Quiet window passes, next change is a leading frame again.
    vi.advanceTimersByTime(250);
    h.apply('s', 'events', [{ op: 'remove', id: 'c' }]);
    expect(frames).toHaveLength(4);
    expect(frames[3]!.frame).toMatchObject({ base_rev: 5, rev: 6 });
  });

  it('flush sends pending frames now; stop drops timers', () => {
    const h = setup({ coalesceMs: 250 });
    h.apply('s', 'events', [{ op: 'set', id: 'a', value: ev('a') }]);
    h.apply('s', 'events', [{ op: 'set', id: 'b', value: ev('b') }]);
    h.flush();
    expect(frames.map((f) => f.frame)).toMatchObject([{ rev: 1 }, { base_rev: 1, rev: 2 }]);
    h.apply('s', 'events', [{ op: 'set', id: 'c', value: ev('c') }]);
    h.stop();
    vi.advanceTimersByTime(1000);
    expect(frames).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('with coalesceMs 0 every apply is sent immediately', () => {
    const h = setup({ coalesceMs: 0 });
    for (const id of ['a', 'b', 'c']) h.apply('s', 'events', [{ op: 'set', id, value: ev(id) }]);
    expect(frames.map((f) => f.frame)).toMatchObject([{ base_rev: 0, rev: 1 }, { base_rev: 1, rev: 2 }, { base_rev: 2, rev: 3 }]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('sweepExpired', () => {
  it('removes past events and slots through apply and reports them', () => {
    const now = Date.parse('2026-11-03T12:00:00Z');
    const h = setup({ now: () => now });
    h.apply('s', 'events', [
      { op: 'set', id: 'old', value: ev('old', { expires_at: '2026-11-03T11:59:59Z' }) },
      { op: 'set', id: 'live', value: ev('live', { expires_at: '2026-11-03T13:00:00Z' }) },
      { op: 'set', id: 'forever', value: ev('forever') },
    ]);
    h.apply('s', 'slots', [{ op: 'set', id: 'top', value: { text: 'x', until: '2026-11-03T10:00:00Z' } }]);
    h.apply('t', 'slots', [{ op: 'set', id: 'top', value: { text: 'x', until: '2026-11-04T10:00:00Z' } }]);
    frames.length = 0;

    expect(h.sweepExpired()).toEqual([
      { surface: 's', resource: 'events', id: 'old' },
      { surface: 's', resource: 'slots', id: 'top' },
    ]);
    expect(Object.keys(h.snapshot('s', 'events').items).sort()).toEqual(['forever', 'live']);
    expect(h.snapshot('s', 'slots').items).toEqual({});
    expect(frames.map((f) => [f.frame.resource, 'ops' in f.frame ? f.frame.ops : null])).toEqual([
      ['events', [{ op: 'remove', id: 'old' }]],
      ['slots', [{ op: 'remove', id: 'top' }]],
    ]);
    expect(h.sweepExpired()).toEqual([]);
    expect(h.sweepExpired(Date.parse('2026-11-05T00:00:00Z')).map((r) => `${r.surface}/${r.resource}/${r.id}`)).toEqual(['s/events/live', 't/slots/top']);
  });
});

describe('diffOps', () => {
  it('sets new and changed items (key order ignored) and removes gone ones', () => {
    const prev = { a: { x: 1, y: { p: 1, q: 2 } }, b: { x: 1 }, c: { x: 1 } };
    const next = { a: { y: { q: 2, p: 1 }, x: 1 }, b: { x: 2 }, d: { x: 1 } };
    expect(diffOps(prev, next)).toEqual([
      { op: 'set', id: 'b', value: { x: 2 } },
      { op: 'set', id: 'd', value: { x: 1 } },
      { op: 'remove', id: 'c' },
    ]);
    expect(diffOps(next, next)).toEqual([]);
    expect(applyOps(structuredClone(prev), diffOps(prev, next))).toEqual(next);
  });
});

describe('removeSurface', () => {
  it('deletes items, revs and log for one surface only', () => {
    const h = setup();
    h.apply('s', 'events', [{ op: 'set', id: 'a', value: ev('a') }]);
    h.apply('t', 'events', [{ op: 'set', id: 'a', value: ev('a') }]);
    h.removeSurface('s');
    expect(h.snapshot('s', 'events')).toEqual({ rev: 0, items: {} });
    expect(h.snapshot('t', 'events').rev).toBe(1);
    expect(h.resume('s', { events: 1 })).toEqual([{ type: 'delta', resource: 'events', rev: 0, reset: true, items: {} }]);
  });
});

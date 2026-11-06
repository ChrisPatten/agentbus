/**
 * E96 S96.3 — per-surface resource store with revisions, a replay log and
 * coalesced delta push.
 *
 * Every resource is a keyed collection of JSON objects. {@link ResourceHub.apply}
 * validates a list of ops against counts and sizes (content shapes are checked by
 * `validate.ts` before this), then in one transaction writes the items, bumps the
 * rev, logs the ops under the new rev and trims the log. Frames go to the sink
 * after commit, coalesced to at most one per (surface, resource) per window.
 */
import type Database from 'better-sqlite3';
import {
  BOUNDS, BoundsError, RESOURCE_NAMES,
  type DeltaFrame, type ResourceHub, type ResourceName, type ResourceOp, type ResourceSnapshot,
} from './types.js';
import { DEFAULT_TOMBSTONE_HOURS, isLiveEvent, isTerminal, tombstone, tombstoneDue } from './lifecycle.js';

type Item = Record<string, unknown>;
type Items = Record<string, Item>;

export interface ResourceHubOptions {
  db: Database.Database;
  /** Receives every delta frame for a surface (the WS layer fans it out to that surface's devices). */
  sink: (surfaceId: string, frame: DeltaFrame) => void;
  /** At most one delta per (surface, resource) per this window. 0 sends every apply at once. */
  coalesceMs?: number;
  /** Revisions of ops kept per (surface, resource) for resume. Older revs get a `reset`. */
  logRetentionRevs?: number;
  /** E100: hours a terminal event (tombstone) stays in `events` after its `ended_at` (default 24). */
  tombstoneHours?: number;
  now?: () => number;
  log?: (line: string) => void;
}

export interface SweptItem { surface: string; resource: ResourceName; id: string; change: 'expired' | 'removed' }

export interface ResourceHubImpl extends ResourceHub {
  /** Delete every resource row (items, revs, log) of a surface and drop its pending frames. */
  removeSurface(surfaceId: string): void;
}

const MAX_ID_LENGTH = 128;
const RESOURCE_SET: ReadonlySet<string> = new Set(RESOURCE_NAMES);

// ── Helpers ─────────────────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Item {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** JSON with object keys sorted at every level, for order-independent comparison. */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => stableJson(x === undefined ? null : x)).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/** Apply ops to a collection in place (patch: shallow merge, `null` deletes the key). Unknown patch targets are skipped. */
export function applyOps(items: Items, ops: ResourceOp[]): Items {
  for (const op of ops) {
    if (op.op === 'remove') { delete items[op.id]; continue; }
    if (op.op === 'set') { items[op.id] = { ...op.value }; continue; }
    const cur = items[op.id];
    if (!cur) continue;
    const next: Item = { ...cur };
    for (const [k, v] of Object.entries(op.value)) {
      if (v === null) delete next[k]; else next[k] = v;
    }
    items[op.id] = next;
  }
  return items;
}

/**
 * Ops that turn `prev` into `next`: `set` for new or changed items (stable JSON
 * compare), `remove` for items gone. Used to sync computed resources (sessions, notices).
 */
export function diffOps(prev: Items, next: Items): ResourceOp[] {
  const ops: ResourceOp[] = [];
  for (const [id, value] of Object.entries(next)) {
    const old = prev[id];
    if (!old || stableJson(old) !== stableJson(value)) ops.push({ op: 'set', id, value });
  }
  for (const id of Object.keys(prev)) if (!(id in next)) ops.push({ op: 'remove', id });
  return ops;
}

function validateOps(resource: string, ops: unknown): asserts ops is ResourceOp[] {
  if (!RESOURCE_SET.has(resource)) {
    throw new BoundsError(`unknown resource "${resource}"; expected one of ${RESOURCE_NAMES.join(', ')}`);
  }
  if (!Array.isArray(ops)) throw new BoundsError(`${resource}: ops must be an array of {op, id, value?}`);
  ops.forEach((raw, i) => {
    const at = `${resource} ops[${i}]`;
    if (!isPlainObject(raw)) throw new BoundsError(`${at}: each op must be an object {op, id, value?}`);
    const { op, id, value } = raw;
    if (op !== 'set' && op !== 'patch' && op !== 'remove') throw new BoundsError(`${at}: op must be "set", "patch" or "remove", got ${JSON.stringify(op) ?? 'nothing'}`);
    if (typeof id !== 'string' || id.length < 1 || id.length > MAX_ID_LENGTH) throw new BoundsError(`${at}: id must be a string of 1-${MAX_ID_LENGTH} characters`);
    if (op === 'remove') return;
    if (!isPlainObject(value)) throw new BoundsError(`${at}: ${op} needs value to be a JSON object`);
    try { JSON.stringify(value); } catch { throw new BoundsError(`${at}: value is not serializable as JSON`); }
  });
}

function isPast(v: unknown, now: number): boolean {
  if (typeof v !== 'string') return false;
  const t = Date.parse(v);
  return Number.isFinite(t) && t <= now;
}

function countLive(resource: ResourceName, items: Items, now: number): number {
  // E100: tombstones (terminal events) and expired-but-not-yet-swept events do not count.
  if (resource === 'events') return Object.values(items).filter((e) => isLiveEvent(e, now)).length;
  return Object.keys(items).length;
}

const CAPS: Partial<Record<ResourceName, { max: number; noun: string }>> = {
  events: { max: BOUNDS.eventsPerSurface, noun: 'live events' },
  slots: { max: BOUNDS.slotsPerSurface, noun: 'slot overrides' },
  widgets: { max: BOUNDS.widgetsPerSurface, noun: 'widgets' },
};

// ── Hub ─────────────────────────────────────────────────────────────────────

interface Window { timer: NodeJS.Timeout; pending: { base_rev: number; rev: number; ops: ResourceOp[] } | null }

export function createResourceHub(opts: ResourceHubOptions): ResourceHubImpl {
  const { db, sink } = opts;
  const coalesceMs = Math.max(0, opts.coalesceMs ?? 250);
  const retention = Math.max(1, opts.logRetentionRevs ?? 500);
  const tombstoneMs = Math.max(0, opts.tombstoneHours ?? DEFAULT_TOMBSTONE_HOURS) * 3_600_000;
  const nowFn = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});

  const q = {
    rev: db.prepare(`SELECT rev FROM surface_resource_revs WHERE surface_id = ? AND resource = ?`),
    revs: db.prepare(`SELECT resource, rev FROM surface_resource_revs WHERE surface_id = ?`),
    setRev: db.prepare(`INSERT INTO surface_resource_revs(surface_id, resource, rev) VALUES (?,?,?)
      ON CONFLICT(surface_id, resource) DO UPDATE SET rev = excluded.rev`),
    items: db.prepare(`SELECT item_id, data FROM surface_resource_items WHERE surface_id = ? AND resource = ?`),
    item: db.prepare(`SELECT data FROM surface_resource_items WHERE surface_id = ? AND resource = ? AND item_id = ?`),
    putItem: db.prepare(`INSERT INTO surface_resource_items(surface_id, resource, item_id, data, updated_at) VALUES (?,?,?,?,?)
      ON CONFLICT(surface_id, resource, item_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`),
    delItem: db.prepare(`DELETE FROM surface_resource_items WHERE surface_id = ? AND resource = ? AND item_id = ?`),
    logOps: db.prepare(`INSERT INTO surface_resource_log(surface_id, resource, rev, ops, created_at) VALUES (?,?,?,?,?)`),
    trimLog: db.prepare(`DELETE FROM surface_resource_log WHERE surface_id = ? AND resource = ? AND rev <= ?`),
    readLog: db.prepare(`SELECT rev, ops FROM surface_resource_log WHERE surface_id = ? AND resource = ? AND rev > ? AND rev <= ? ORDER BY rev`),
    surfacesWith: db.prepare(`SELECT DISTINCT surface_id FROM surface_resource_items WHERE resource = ?`),
  };

  function currentRev(surfaceId: string, resource: ResourceName): number {
    return (q.rev.get(surfaceId, resource) as { rev: number } | undefined)?.rev ?? 0;
  }

  function readItems(surfaceId: string, resource: ResourceName): Items {
    const out: Items = {};
    for (const row of q.items.all(surfaceId, resource) as { item_id: string; data: string }[]) out[row.item_id] = JSON.parse(row.data) as Item;
    return out;
  }

  // ── Delta push ──
  const windows = new Map<string, Window>();
  const keyOf = (surfaceId: string, resource: ResourceName) => `${surfaceId}\u0000${resource}`;

  function send(surfaceId: string, frame: DeltaFrame): void {
    try { sink(surfaceId, frame); } catch (err) {
      log(`[surface] delta sink failed for ${surfaceId}/${frame.resource}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function startWindow(surfaceId: string, resource: ResourceName): NodeJS.Timeout {
    const t = setTimeout(() => onWindowEnd(surfaceId, resource), coalesceMs);
    t.unref?.();
    return t;
  }

  function onWindowEnd(surfaceId: string, resource: ResourceName): void {
    const key = keyOf(surfaceId, resource);
    const w = windows.get(key);
    if (!w) return;
    if (!w.pending) { windows.delete(key); return; }
    const p = w.pending;
    w.pending = null;
    w.timer = startWindow(surfaceId, resource);
    send(surfaceId, { type: 'delta', resource, base_rev: p.base_rev, rev: p.rev, ops: p.ops });
  }

  function emit(surfaceId: string, resource: ResourceName, baseRev: number, rev: number, ops: ResourceOp[]): void {
    if (coalesceMs === 0) { send(surfaceId, { type: 'delta', resource, base_rev: baseRev, rev, ops }); return; }
    const key = keyOf(surfaceId, resource);
    const w = windows.get(key);
    if (!w) {
      // Leading edge: quiet window, send now and open a window.
      windows.set(key, { timer: startWindow(surfaceId, resource), pending: null });
      send(surfaceId, { type: 'delta', resource, base_rev: baseRev, rev, ops });
      return;
    }
    if (w.pending) { w.pending.rev = rev; w.pending.ops.push(...ops); }
    else w.pending = { base_rev: baseRev, rev, ops: [...ops] };
  }

  // ── Writes ──
  const writeTx = db.transaction((surfaceId: string, resource: ResourceName, baseRev: number, ops: ResourceOp[], next: Items, touched: Set<string>, at: string) => {
    for (const id of touched) {
      const item = next[id];
      if (item) q.putItem.run(surfaceId, resource, id, JSON.stringify(item), at);
      else q.delItem.run(surfaceId, resource, id);
    }
    const rev = baseRev + 1;
    q.setRev.run(surfaceId, resource, rev);
    q.logOps.run(surfaceId, resource, rev, JSON.stringify(ops), at);
    q.trimLog.run(surfaceId, resource, rev - retention);
    return rev;
  });

  function apply(surfaceId: string, resource: ResourceName, ops: ResourceOp[]): number {
    validateOps(resource, ops);
    const baseRev = currentRev(surfaceId, resource);
    if (ops.length === 0) return baseRev;

    const prev = readItems(surfaceId, resource);
    const next: Items = { ...prev };
    const touched = new Set<string>();
    ops.forEach((op, i) => {
      if (op.op === 'patch' && !next[op.id]) {
        throw new BoundsError(`${resource} ops[${i}]: cannot patch "${op.id}": no such item (use set to create it)`);
      }
      applyOps(next, [op]);
      touched.add(op.id);
    });

    const now = nowFn();
    const cap = CAPS[resource];
    if (cap) {
      const before = countLive(resource, prev, now);
      const after = countLive(resource, next, now);
      if (after > cap.max && after > before) {
        throw new BoundsError(`${resource}: this change would leave ${after} ${cap.noun} on surface "${surfaceId}" (limit ${cap.max}); remove some first`);
      }
    }
    if (resource === 'widgets') {
      for (const id of touched) {
        const data = next[id]?.['data'];
        if (data === undefined) continue;
        const bytes = Buffer.byteLength(JSON.stringify(data) ?? '', 'utf8');
        if (bytes > BOUNDS.widgetDataBytes) {
          throw new BoundsError(`widgets["${id}"]: data is ${bytes} bytes as JSON (limit ${BOUNDS.widgetDataBytes}); send less data`);
        }
      }
    }

    // Store copies so later mutation by the caller cannot change logged ops.
    const logged = JSON.parse(JSON.stringify(ops)) as ResourceOp[];
    const rev = writeTx(surfaceId, resource, baseRev, logged, next, touched, new Date(now).toISOString()) as number;
    emit(surfaceId, resource, baseRev, rev, logged);
    return rev;
  }

  // ── Reads ──
  function get(surfaceId: string, resource: ResourceName, id: string): Item | null {
    const row = q.item.get(surfaceId, resource, id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) as Item : null;
  }

  function snapshot(surfaceId: string, resource: ResourceName): ResourceSnapshot {
    return { rev: currentRev(surfaceId, resource), items: readItems(surfaceId, resource) };
  }

  function revs(surfaceId: string): Record<ResourceName, number> {
    const out = Object.fromEntries(RESOURCE_NAMES.map((n) => [n, 0])) as Record<ResourceName, number>;
    for (const row of q.revs.all(surfaceId) as { resource: string; rev: number }[]) {
      if (RESOURCE_SET.has(row.resource)) out[row.resource as ResourceName] = row.rev;
    }
    return out;
  }

  function reset(surfaceId: string, resource: ResourceName): DeltaFrame {
    const snap = snapshot(surfaceId, resource);
    return { type: 'delta', resource, rev: snap.rev, reset: true, items: snap.items };
  }

  function resume(surfaceId: string, clientRevs: Partial<Record<ResourceName, number>>): DeltaFrame[] {
    const frames: DeltaFrame[] = [];
    const current = revs(surfaceId);
    for (const resource of RESOURCE_NAMES) {
      const cur = current[resource];
      const raw = clientRevs?.[resource];
      const client = typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : undefined;
      if (client === undefined) { if (cur > 0) frames.push(reset(surfaceId, resource)); continue; }
      if (client === cur) continue;
      if (client < cur) {
        const rows = q.readLog.all(surfaceId, resource, client, cur) as { rev: number; ops: string }[];
        if (rows.length === cur - client) {
          const ops = rows.flatMap((r) => JSON.parse(r.ops) as ResourceOp[]);
          frames.push({ type: 'delta', resource, base_rev: client, rev: cur, ops });
          continue;
        }
      }
      frames.push(reset(surfaceId, resource));
    }
    return frames;
  }

  // ── Expiry ──
  function sweepExpired(now = nowFn()): SweptItem[] {
    const out: SweptItem[] = [];
    const at = new Date(now).toISOString();
    // Events (E100): an open event past expires_at becomes an `expired` tombstone (ended_at = its expires_at);
    // a tombstone past its retention is removed. One change per surface.
    for (const { surface_id } of q.surfacesWith.all('events') as { surface_id: string }[]) {
      const ops: ResourceOp[] = [];
      const swept: SweptItem[] = [];
      for (const [id, item] of Object.entries(readItems(surface_id, 'events'))) {
        if (isTerminal(item)) {
          if (tombstoneDue(item, now, tombstoneMs)) { ops.push({ op: 'remove', id }); swept.push({ surface: surface_id, resource: 'events', id, change: 'removed' }); }
        } else if (isPast(item['expires_at'], now)) {
          const ended = new Date(Date.parse(item['expires_at'] as string)).toISOString();
          const value = tombstone(item, 'expired', ended, at);
          // Retention already over (the bus was down a long time): skip the tombstone.
          if (tombstoneDue(value, now, tombstoneMs)) { ops.push({ op: 'remove', id }); swept.push({ surface: surface_id, resource: 'events', id, change: 'removed' }); }
          else { ops.push({ op: 'set', id, value }); swept.push({ surface: surface_id, resource: 'events', id, change: 'expired' }); }
        }
      }
      if (ops.length === 0) continue;
      apply(surface_id, 'events', ops);
      out.push(...swept);
    }
    for (const { surface_id } of q.surfacesWith.all('slots') as { surface_id: string }[]) {
      const ids = Object.entries(readItems(surface_id, 'slots')).filter(([, item]) => isPast(item['until'], now)).map(([id]) => id);
      if (ids.length === 0) continue;
      apply(surface_id, 'slots', ids.map((id) => ({ op: 'remove', id })));
      for (const id of ids) out.push({ surface: surface_id, resource: 'slots', id, change: 'removed' });
    }
    return out;
  }

  function flush(): void {
    for (const [key, w] of windows) {
      if (!w.pending) continue;
      const [surfaceId, resource] = key.split('\u0000') as [string, ResourceName];
      const p = w.pending;
      w.pending = null;
      send(surfaceId, { type: 'delta', resource, base_rev: p.base_rev, rev: p.rev, ops: p.ops });
    }
  }

  function stop(): void {
    for (const w of windows.values()) clearTimeout(w.timer);
    windows.clear();
  }

  const removeSurfaceTx = db.transaction((surfaceId: string) => {
    db.prepare(`DELETE FROM surface_resource_items WHERE surface_id = ?`).run(surfaceId);
    db.prepare(`DELETE FROM surface_resource_revs WHERE surface_id = ?`).run(surfaceId);
    db.prepare(`DELETE FROM surface_resource_log WHERE surface_id = ?`).run(surfaceId);
  });

  function removeSurface(surfaceId: string): void {
    removeSurfaceTx(surfaceId);
    for (const resource of RESOURCE_NAMES) {
      const key = keyOf(surfaceId, resource);
      const w = windows.get(key);
      if (w) { clearTimeout(w.timer); windows.delete(key); }
    }
  }

  return { apply, get, snapshot, revs, resume, sweepExpired, flush, stop, removeSurface };
}

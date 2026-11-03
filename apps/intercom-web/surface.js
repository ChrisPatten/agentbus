// Surface API v2 client state: a revisioned resource store and the delta rules (docs/SURFACE_API.md).
// Pure: no DOM, no network, so it is unit-tested under vitest.

export const RESOURCES = ['faces', 'events', 'slots', 'widgets', 'sessions', 'notices', 'device'];

export function createStore() {
  const revs = {};
  const items = {};
  for (const r of RESOURCES) { revs[r] = 0; items[r] = {}; }
  return { revs, items };
}

/** The per-resource revs a hello frame carries. Zero revs are left out (the server treats "none" as "send a reset if anything changed"). */
export function revsOf(store) {
  const out = {};
  for (const r of RESOURCES) if (store.revs[r] > 0) out[r] = store.revs[r];
  return out;
}

/**
 * Apply one `delta` frame. Returns:
 *   'reset'   the collection was replaced
 *   'applied' ops applied, rev advanced
 *   'stale'   the frame's rev is not newer than ours (ignored)
 *   'gap'     base_rev does not match our rev (ignored; the caller must re-sync)
 *   'ignored' unknown resource or malformed frame
 * Ops are applied atomically: a patch of a missing item makes the whole frame a 'gap'.
 */
export function applyDelta(store, f) {
  if (!f || !RESOURCES.includes(f.resource) || typeof f.rev !== 'number') return 'ignored';
  const r = f.resource;
  if (f.reset) {
    store.items[r] = { ...(f.items || {}) };
    store.revs[r] = f.rev;
    return 'reset';
  }
  if (f.rev <= store.revs[r]) return 'stale';
  if (typeof f.base_rev !== 'number' || f.base_rev !== store.revs[r]) return 'gap';
  const next = { ...store.items[r] };
  for (const op of f.ops || []) {
    if (!op || typeof op.id !== 'string') return 'ignored';
    if (op.op === 'set') next[op.id] = { ...(op.value || {}) };
    else if (op.op === 'remove') delete next[op.id];
    else if (op.op === 'patch') {
      if (!next[op.id]) return 'gap';
      const merged = { ...next[op.id] };
      for (const [k, v] of Object.entries(op.value || {})) { if (v === null) delete merged[k]; else merged[k] = v; }
      next[op.id] = merged;
    } else return 'ignored';
  }
  store.items[r] = next;
  store.revs[r] = f.rev;
  return 'applied';
}

/** Apply a `GET /state` snapshot. A resource whose snapshot rev is older than ours is kept. Returns the resources replaced. */
export function applyState(store, snap) {
  const changed = [];
  if (!snap || !snap.resources) return changed;
  for (const r of RESOURCES) {
    const items = snap.resources[r];
    const rev = snap.revs && snap.revs[r];
    if (!items || typeof rev !== 'number') continue;
    if (rev < store.revs[r]) continue;
    if (rev === store.revs[r] && Object.keys(items).length === Object.keys(store.items[r]).length) continue;
    store.items[r] = { ...items };
    store.revs[r] = rev;
    changed.push(r);
  }
  return changed;
}

export const itemsOf = (store, r) => Object.values((store && store.items[r]) || {});

/** A slot is live until its `until` (no `until` means live). */
export function activeSlot(store, name, nowMs) {
  const s = store && store.items.slots[name];
  if (!s) return null;
  const until = Date.parse(s.until || '');
  return !isNaN(until) && until <= nowMs ? null : s;
}

/** Face names the web app can draw, in the bus's order, skipping disabled ones. Falls back to day, status. */
export const KNOWN_FACES = ['day', 'status'];
export function faceOrder(store) {
  const faces = itemsOf(store, 'faces').filter((f) => f.enabled !== false && KNOWN_FACES.includes(f.id));
  faces.sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
  const names = faces.map((f) => f.id);
  return names.length ? names : KNOWN_FACES.slice();
}
/** The face `step` places along the order, wrapping; an unknown current face goes to the first. */
export function stepFace(order, face, step = 1) {
  const i = order.indexOf(face);
  if (i < 0) return order[0];
  return order[(i + step + order.length) % order.length];
}

/** What the bus says a face draws. Absent layout keeps the built-in default (everything on, date above the time). */
export function faceLayout(store, face) {
  const f = store && store.items.faces[face];
  const s = (f && f.layout && f.layout.slots) || {};
  return { ring: s.event_ring !== false, primary: s.primary !== false, context: s.context === 'lines' || s.context === 'widgets' ? s.context : null };
}

/** Pending approval Events as needs-you items (the web app has no Approvals face; they ride the Needs-you screen). */
export function approvalItems(store, nowMs) {
  const out = [];
  for (const e of itemsOf(store, 'events')) {
    if (e.kind !== 'approval') continue;
    const exp = Date.parse(e.expires_at || '');
    if (!isNaN(exp) && exp <= nowMs) continue;
    out.push({ id: `approval:${e.id}`, event_id: e.id, approval: true, title: e.title || 'Approval needed', body: 'Approval needed', level: e.level || 'attention', state: 'active', actions: [{ label: 'Review', style: 'primary' }], updated_at: e.updated_at, created_at: e.created_at, expires_at: e.expires_at });
  }
  return out;
}

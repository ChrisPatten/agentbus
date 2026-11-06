// The Earlier tray (spec 7.3): cleared, expired, withdrawn and set-aside items seen by this client.
// Kept in localStorage per device; the app fills it from the bus's ended Events (E100 tombstones, with their word and end
// time) and from local set-asides. Pure apart from the injected storage, unit-tested under vitest.

export const EARLIER_KEY = 'phase.earlier';
export const EARLIER_CAP = 30;
export const EARLIER_STATES = ['open', 'answered', 'cleared', 'expired', 'withdrawn'];

/**
 * storage: an object with getItem/setItem (localStorage, or a stub in tests). Every call tolerates a storage that throws.
 * An entry: { id, title, kind: 'notice' | 'decision' | 'urgent' | 'job', icon, state, at (ms), object? }.
 */
export function createEarlier(storage, key = EARLIER_KEY, cap = EARLIER_CAP) {
  const read = () => {
    try { const v = JSON.parse(storage.getItem(key) || '[]'); return Array.isArray(v) ? v.filter((e) => e && e.id) : []; } catch { return []; }
  };
  const write = (list) => { try { storage.setItem(key, JSON.stringify(list.slice(0, cap))); } catch { /* storage full or blocked */ } };
  return {
    list: read,
    /** Add or replace (by id) and move to the top: newest first. */
    add(entry) {
      if (!entry || !entry.id) return read();
      const state = EARLIER_STATES.includes(entry.state) ? entry.state : 'cleared';
      const list = read().filter((e) => e.id !== entry.id);
      list.unshift({ ...entry, state, at: Number(entry.at) || Date.now() });
      write(list);
      return read();
    },
    /** Change an entry's state (an open item answered elsewhere becomes withdrawn, and so on). */
    setState(id, state, at = Date.now()) {
      const list = read();
      const e = list.find((x) => x.id === id);
      if (e && EARLIER_STATES.includes(state)) { e.state = state; e.at = at; write(list); }
      return read();
    },
    remove(id) { write(read().filter((e) => e.id !== id)); return read(); },
    has: (id) => read().some((e) => e.id === id),
    /** HOLD TO CLEAR: drop everything except open items (those are still live on the bus). */
    clear() { write(read().filter((e) => e.state === 'open')); return read(); },
    /** Count of entries since `sinceMs` that were missed (expired or still open): the "N missed" caption. */
    missed(sinceMs) { return read().filter((e) => (e.state === 'expired' || e.state === 'open') && e.at >= sinceMs).length; },
  };
}

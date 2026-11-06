// "Keep screen on": a manual Screen Wake Lock toggle for the phone's real screen. Independent of the client's own simulated
// dim and rest. Never throws; a failed request leaves the preference as the user set it. Unit-tested under vitest.
export const KEEP_AWAKE_KEY = 'phase.keepAwake';

/** Read the preference from a getItem/setItem store (default off; a throwing store reads as off). */
export function readKeepAwake(storage) {
  try { return storage.getItem(KEEP_AWAKE_KEY) === '1'; } catch { return false; }
}
export function writeKeepAwake(storage, on) {
  try { storage.setItem(KEEP_AWAKE_KEY, on ? '1' : '0'); } catch { /* blocked */ }
}

/**
 * @param {{ storage?: {getItem:Function,setItem:Function}, nav?: object, doc?: object }} [opts]
 * @returns {{ supported: boolean, enabled: () => boolean, set: (on: boolean) => Promise<void>, visible: () => Promise<void>, gesture: () => Promise<void> }}
 */
export function createKeepAwake(opts = {}) {
  const nav = opts.nav ?? (typeof navigator !== 'undefined' ? navigator : {});
  const doc = opts.doc ?? (typeof document !== 'undefined' ? document : null);
  const storage = opts.storage ?? { getItem: () => null, setItem: () => {} };
  const supported = !!(nav.wakeLock && typeof nav.wakeLock.request === 'function');
  let on = readKeepAwake(storage);
  let lock = null;
  let pending = false;

  const isVisible = () => !doc || doc.visibilityState === 'visible';

  async function release() {
    const l = lock; lock = null;
    try { await l?.release(); } catch { /* already released */ }
  }

  async function acquire() {
    if (!supported || !on || lock || pending || !isVisible()) return;
    pending = true;
    try {
      const l = await nav.wakeLock.request('screen');
      lock = l;
      try { l.addEventListener?.('release', () => { if (lock === l) lock = null; }); } catch { /* ignore */ }
      if (!on) await release(); // switched off while the request was in flight
    } catch { lock = null; /* denied or not allowed yet: retried on the next visible or gesture */ } finally { pending = false; }
  }

  return {
    supported,
    enabled: () => on,
    async set(v) {
      on = !!v;
      writeKeepAwake(storage, on);
      if (on) await acquire(); else await release();
    },
    /** Call on visibilitychange: the system drops the lock while hidden, so ask again when shown. */
    async visible() { if (isVisible()) { lock = null; await acquire(); } },
    /** Call on pointerdown: some iOS versions only grant the lock inside a gesture. */
    async gesture() { await acquire(); },
  };
}

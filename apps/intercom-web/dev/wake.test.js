import { describe, it, expect } from 'vitest';
import { createKeepAwake, readKeepAwake, writeKeepAwake, KEEP_AWAKE_KEY } from '../phase/wake.js';

const mem = (init = {}) => { const m = { ...init }; return { m, getItem: (k) => m[k] ?? null, setItem: (k, v) => { m[k] = String(v); } }; };
function fakeNav({ fail = false } = {}) {
  const nav = { requests: 0, released: 0, sentinels: [], failNext: fail,
    wakeLock: { async request(type) {
      nav.requests++;
      if (nav.failNext) throw new Error('NotAllowedError');
      const s = { type, released: false, async release() { s.released = true; nav.released++; }, addEventListener() {} };
      nav.sentinels.push(s); return s;
    } } };
  return nav;
}
const fakeDoc = () => ({ visibilityState: 'visible' });

describe('keep-awake preference', () => {
  it('defaults off, round-trips, and tolerates a throwing store', () => {
    const st = mem();
    expect(readKeepAwake(st)).toBe(false);
    writeKeepAwake(st, true); expect(st.m[KEEP_AWAKE_KEY]).toBe('1'); expect(readKeepAwake(st)).toBe(true);
    writeKeepAwake(st, false); expect(readKeepAwake(st)).toBe(false);
    const bad = { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); } };
    expect(readKeepAwake(bad)).toBe(false);
    expect(() => writeKeepAwake(bad, true)).not.toThrow();
  });
});

describe('keep-awake wake lock', () => {
  it('is unsupported without navigator.wakeLock', async () => {
    const k = createKeepAwake({ nav: {}, doc: fakeDoc(), storage: mem() });
    expect(k.supported).toBe(false);
    await expect(k.set(true)).resolves.toBeUndefined();
  });
  it('requests on enable, persists, and releases on disable', async () => {
    const nav = fakeNav(), st = mem(), k = createKeepAwake({ nav, doc: fakeDoc(), storage: st });
    await k.set(true);
    expect(nav.requests).toBe(1); expect(nav.sentinels[0].type).toBe('screen'); expect(st.m[KEEP_AWAKE_KEY]).toBe('1');
    await k.set(true); expect(nav.requests).toBe(1); // already held
    await k.set(false);
    expect(nav.sentinels[0].released).toBe(true); expect(st.m[KEEP_AWAKE_KEY]).toBe('0');
  });
  it('restores a saved preference and re-requests when the page is visible again', async () => {
    const nav = fakeNav(), doc = fakeDoc(), k = createKeepAwake({ nav, doc, storage: mem({ [KEEP_AWAKE_KEY]: '1' }) });
    expect(k.enabled()).toBe(true);
    await k.visible(); expect(nav.requests).toBe(1);
    doc.visibilityState = 'hidden'; await k.visible(); expect(nav.requests).toBe(1);
    doc.visibilityState = 'visible'; await k.visible(); expect(nav.requests).toBe(2); // the system dropped the first
  });
  it('does nothing on visible or gesture while off', async () => {
    const nav = fakeNav(), k = createKeepAwake({ nav, doc: fakeDoc(), storage: mem() });
    await k.visible(); await k.gesture(); expect(nav.requests).toBe(0);
  });
  it('fails quietly, keeps the setting, and retries on a gesture', async () => {
    const nav = fakeNav({ fail: true }), st = mem(), k = createKeepAwake({ nav, doc: fakeDoc(), storage: st });
    await expect(k.set(true)).resolves.toBeUndefined();
    expect(k.enabled()).toBe(true); expect(st.m[KEEP_AWAKE_KEY]).toBe('1');
    nav.failNext = false; await k.gesture();
    expect(nav.requests).toBe(2); expect(nav.sentinels).toHaveLength(1);
  });
});

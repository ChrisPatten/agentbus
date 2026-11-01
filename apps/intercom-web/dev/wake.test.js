import { describe, it, expect } from 'vitest';
import { shouldHoldWakeLock } from '../logic.js';
import { createWakeKeeper } from '../wake.js';

const TZ = 'America/New_York';
const at = (hm) => new Date(`2026-11-02T${hm}:00-05:00`);

describe('shouldHoldWakeLock', () => {
  it('holds by day, not in quiet hours, not when hidden', () => {
    expect(shouldHoldWakeLock({ now: at('12:00'), tz: TZ })).toBe(true);
    expect(shouldHoldWakeLock({ now: at('06:30'), tz: TZ })).toBe(true);
    expect(shouldHoldWakeLock({ now: at('21:59'), tz: TZ })).toBe(true);
    expect(shouldHoldWakeLock({ now: at('22:00'), tz: TZ })).toBe(false);
    expect(shouldHoldWakeLock({ now: at('03:00'), tz: TZ })).toBe(false);
    expect(shouldHoldWakeLock({ now: at('06:29'), tz: TZ })).toBe(false);
    expect(shouldHoldWakeLock({ now: at('12:00'), tz: TZ, visible: false })).toBe(false);
  });
  it('honours the dev quiet override', () => {
    expect(shouldHoldWakeLock({ now: at('03:00'), tz: TZ, forceQuiet: false })).toBe(true);
    expect(shouldHoldWakeLock({ now: at('12:00'), tz: TZ, forceQuiet: true })).toBe(false);
  });
});

function fakeLock() {
  const l = { released: false, handlers: [], addEventListener(_, f) { this.handlers.push(f); }, async release() { this.released = true; }, fire() { this.released = true; this.handlers.forEach((f) => f()); } };
  return l;
}
function setup(timeHm = '12:00') {
  const locks = [];
  const state = { time: at(timeHm), visible: 'visible' };
  const nav = { wakeLock: { request: async () => { const l = fakeLock(); locks.push(l); return l; } } };
  const doc = { get visibilityState() { return state.visible; } };
  const keeper = createWakeKeeper({ tz: TZ, nav, doc, clock: () => state.time });
  return { locks, state, keeper };
}

describe('wake keeper', () => {
  it('acquires once, releases at quiet start, re-acquires at quiet end', async () => {
    const { locks, state, keeper } = setup('12:00');
    await keeper.evaluate(); await keeper.evaluate();
    expect(locks).toHaveLength(1);
    state.time = at('22:00'); await keeper.evaluate();
    expect(locks[0].released).toBe(true);
    state.time = at('06:30'); await keeper.evaluate();
    expect(locks).toHaveLength(2);
    expect(locks[1].released).toBe(false);
  });
  it('re-requests when the held lock is released while visible, not while hidden or quiet', async () => {
    const { locks, state, keeper } = setup();
    await keeper.evaluate();
    locks[0].fire(); await Promise.resolve(); await Promise.resolve();
    expect(locks).toHaveLength(2);
    state.visible = 'hidden'; locks[1].fire(); await Promise.resolve(); await Promise.resolve();
    expect(locks).toHaveLength(2);
    state.visible = 'visible'; await keeper.evaluate();
    expect(locks).toHaveLength(3);
  });
  it('never throws when the API rejects or is missing', async () => {
    const bad = createWakeKeeper({ tz: TZ, nav: { wakeLock: { request: async () => { throw new Error('denied'); } } }, doc: { visibilityState: 'visible' }, clock: () => at('12:00') });
    await expect(bad.evaluate()).resolves.toBeUndefined();
    const none = createWakeKeeper({ tz: TZ, nav: {}, doc: null, clock: () => at('12:00') });
    none.gesture();
    await expect(none.evaluate()).resolves.toBeUndefined();
  });
  it('fallback video starts after a gesture and pauses in quiet hours', async () => {
    const mk = () => ({ paused: true, style: {}, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, play() { this.paused = false; return Promise.resolve(); }, pause() { this.paused = true; } });
    const vids = []; const state = { time: at('12:00') };
    const doc = { visibilityState: 'visible', body: { appendChild: (v) => vids.push(v) }, createElement: () => mk() };
    const keeper = createWakeKeeper({ tz: TZ, nav: {}, doc, clock: () => state.time });
    await keeper.evaluate();
    expect(vids).toHaveLength(0);
    keeper.gesture();
    expect(vids).toHaveLength(1); expect(vids[0].paused).toBe(false); expect(vids[0].muted).toBe(true);
    state.time = at('23:00'); await keeper.evaluate();
    expect(vids[0].paused).toBe(true);
  });
});

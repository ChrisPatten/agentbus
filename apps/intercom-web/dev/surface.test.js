import { describe, it, expect } from 'vitest';
import { createStore, applyDelta, applyState, revsOf, activeSlot, faceOrder, stepFace, faceLayout, approvalItems, dropEnded, isEnded } from '../surface.js';
import { ringModel, hitTest, nearestRingEvent, carouselOrder, inRingBand, RING_TAP, ballHit, pointToHours, scrubStart, scrubMove, scrubRelease, scrubActive, scrubRemaining, scrubInfo, SNAP_MS, TICK_HIT_TOL, OVERLAP_R, PRIMARY, OVERLAP_W, travelDeparture, pickDeparture, primaryView, nextUp, contextView, widgetView, colorValue, countdownText } from '../dayv2.js';
import { polar, RING_R } from '../logic.js';
import { statusModel, RING_CAP, sessionsFromDesk, mergeOlder, appendMessage } from '../statusv2.js';
import { interpretResult, needsConfirm, buildRequest, ButtonStates, submitAction, btnKey } from '../actions.js';
import { IntercomSocket } from '../socket.js';
import { render } from '../screens.js';
import { STEPS } from '../demo.js';

const TZ = 'America/New_York';
const NOW = new Date('2026-11-03T09:00:00-05:00');
const t = (hhmm, day = '03') => `2026-11-${day}T${hhmm}:00-05:00`;
const ev = (id, s, e, extra = {}) => ({ id, kind: 'event', title: id, level: 'info', at: s && t(s), end: e && t(e), actions: [], ...extra });

describe('delta apply', () => {
  const delta = (o) => ({ type: 'delta', resource: 'events', ...o });
  it('applies ops when base_rev matches and advances rev', () => {
    const st = createStore();
    expect(applyDelta(st, delta({ base_rev: 0, rev: 1, ops: [{ op: 'set', id: 'a', value: { id: 'a', title: 'A' } }] }))).toBe('applied');
    expect(st.revs.events).toBe(1);
    expect(applyDelta(st, delta({ base_rev: 1, rev: 2, ops: [{ op: 'patch', id: 'a', value: { title: 'B', extra: 1 } }, { op: 'set', id: 'b', value: { id: 'b' } }] }))).toBe('applied');
    expect(st.items.events.a).toEqual({ id: 'a', title: 'B', extra: 1 });
    expect(applyDelta(st, delta({ base_rev: 2, rev: 3, ops: [{ op: 'patch', id: 'a', value: { extra: null } }, { op: 'remove', id: 'b' }] }))).toBe('applied');
    expect(st.items.events).toEqual({ a: { id: 'a', title: 'B' } });
  });
  it('a base_rev mismatch is a gap: nothing applied, rev unchanged', () => {
    const st = createStore();
    applyDelta(st, delta({ base_rev: 0, rev: 1, ops: [{ op: 'set', id: 'a', value: { id: 'a' } }] }));
    expect(applyDelta(st, delta({ base_rev: 3, rev: 5, ops: [{ op: 'remove', id: 'a' }] }))).toBe('gap');
    expect(st.revs.events).toBe(1);
    expect(st.items.events.a).toBeTruthy();
  });
  it('ignores a stale or duplicate frame', () => {
    const st = createStore();
    applyDelta(st, delta({ base_rev: 0, rev: 2, ops: [{ op: 'set', id: 'a', value: {} }] }));
    expect(applyDelta(st, delta({ base_rev: 0, rev: 2, ops: [{ op: 'set', id: 'z', value: {} }] }))).toBe('stale');
    expect(st.items.events.z).toBeUndefined();
  });
  it('a reset replaces the collection at the given rev, even a lower one', () => {
    const st = createStore();
    applyDelta(st, delta({ base_rev: 0, rev: 4, ops: [{ op: 'set', id: 'a', value: {} }] }));
    expect(applyDelta(st, delta({ rev: 2, reset: true, items: { q: { id: 'q' } } }))).toBe('reset');
    expect(st.items.events).toEqual({ q: { id: 'q' } });
    expect(st.revs.events).toBe(2);
  });
  it('is atomic: a patch of a missing item voids the whole frame', () => {
    const st = createStore();
    expect(applyDelta(st, delta({ base_rev: 0, rev: 1, ops: [{ op: 'set', id: 'a', value: {} }, { op: 'patch', id: 'nope', value: { x: 1 } }] }))).toBe('gap');
    expect(st.items.events).toEqual({});
    expect(st.revs.events).toBe(0);
  });
  it('ignores unknown resources; revsOf leaves out zero revs; state snapshots replace newer-or-equal resources only', () => {
    const st = createStore();
    expect(applyDelta(st, { resource: 'bogus', rev: 1 })).toBe('ignored');
    applyDelta(st, { resource: 'slots', base_rev: 0, rev: 3, ops: [{ op: 'set', id: 'primary', value: { id: 'primary' } }] });
    expect(revsOf(st)).toEqual({ slots: 3 });
    const changed = applyState(st, { revs: { slots: 2, events: 4 }, resources: { slots: {}, events: { e: { id: 'e' } } } });
    expect(changed).toEqual(['events']);
    expect(st.items.slots.primary).toBeTruthy();
  });
});

describe('E100: ended Events are gone for this client', () => {
  const delta = (o) => ({ type: 'delta', resource: 'events', ...o });
  it('drops tombstones after a delta or a snapshot, keeps open and state-less events, and takes a re-opened one back', () => {
    const st = createStore();
    applyDelta(st, delta({ base_rev: 0, rev: 1, ops: [
      { op: 'set', id: 'old', value: ev('old', '10:00', '11:00') },
      { op: 'set', id: 'open', value: ev('open', '12:00', '13:00', { state: 'open' }) },
      { op: 'set', id: 'gone', value: ev('gone', '14:00', '15:00', { state: 'open' }) },
    ] }));
    expect(dropEnded(st)).toEqual([]);
    applyDelta(st, delta({ base_rev: 1, rev: 2, ops: [{ op: 'set', id: 'gone', value: ev('gone', '14:00', '15:00', { state: 'withdrawn', ended_at: t('09:00') }) }] }));
    expect(dropEnded(st)).toEqual(['gone']);
    expect(Object.keys(st.items.events).sort()).toEqual(['old', 'open']);
    expect(st.revs.events).toBe(2);
    expect(ringModel(Object.values(st.items.events), NOW, TZ).segs.map((x) => x.id)).not.toContain('gone');
    // The next delta still applies on top (rev kept); a re-publish brings it back.
    expect(applyDelta(st, delta({ base_rev: 2, rev: 3, ops: [{ op: 'set', id: 'gone', value: ev('gone', '14:00', '15:00', { state: 'open' }) }] }))).toBe('applied');
    dropEnded(st);
    expect(st.items.events.gone).toBeTruthy();
    // A /state snapshot with tombstones in it.
    applyState(st, { revs: { events: 4 }, resources: { events: { open: ev('open', '12:00', '13:00', { state: 'open' }), x: ev('x', '16:00', '17:00', { state: 'expired' }), y: { ...ev('y'), kind: 'approval', state: 'answered' } } } });
    dropEnded(st);
    expect(Object.keys(st.items.events)).toEqual(['open']);
    expect(approvalItems(st, NOW.getTime())).toEqual([]);
    expect(isEnded({ state: 'cleared' })).toBe(true);
    expect(isEnded({ state: 'open' })).toBe(false);
    expect(isEnded({})).toBe(false);
  });
});

describe('socket: v2 hello, resume and fallback', () => {
  class FakeWS {
    static all = [];
    constructor(url) { this.url = url; this.readyState = 1; this.sent = []; FakeWS.all.push(this); }
    send(s) { this.sent.push(JSON.parse(s)); } close() {}
  }
  const timers = { setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {} };
  const urls = { v1: 'ws://x/v1', v2: 'ws://x/v2' };
  const mk = (extra = {}) => {
    FakeWS.all = [];
    const st = createStore(); const modes = []; const deltas = []; const unauth = [];
    const s = new IntercomSocket({ token: 'tok', urls, WS: FakeWS, timers, getRevs: () => revsOf(st), handlers: { onMode: (m) => modes.push(m), onDelta: (f) => { deltas.push(applyDelta(st, f)); }, onUnauthorized: () => unauth.push(1) }, ...extra });
    return { s, st, modes, deltas, unauth };
  };
  const last = () => FakeWS.all.at(-1);
  const frame = (ws, f) => ws.onmessage({ data: JSON.stringify(f) });

  it('says hello with protocol 2 and the held revs, applies deltas, and resumes with the new revs after a drop', () => {
    const { s, st, deltas } = mk();
    s.connect(); let ws = last(); ws.onopen();
    expect(ws.url).toBe(urls.v2);
    expect(ws.sent[0]).toMatchObject({ type: 'hello', protocol: 2, token: 'tok', revs: {} });
    frame(ws, { type: 'welcome', version: 2, latest_seq: 0, reset: false });
    frame(ws, { type: 'delta', resource: 'events', rev: 3, reset: true, items: { a: { id: 'a' } } });
    frame(ws, { type: 'delta', resource: 'events', base_rev: 3, rev: 4, ops: [{ op: 'set', id: 'b', value: { id: 'b' } }] });
    expect(deltas).toEqual(['reset', 'applied']);
    ws.onclose({ code: 1006 });
    s.connect(); ws = last(); ws.onopen();
    expect(ws.sent[0].revs).toEqual({ events: 4 });
    expect(Object.keys(st.items.events)).toEqual(['a', 'b']);
  });
  it('falls back to the legacy path and protocol 1 when the v2 path refuses the credential', () => {
    const { s, modes, unauth } = mk();
    s.connect(); last().onopen(); last().onclose({ code: 4401 });
    expect(modes).toEqual(['v1']);
    const ws = last(); ws.onopen();
    expect(ws.url).toBe(urls.v1);
    expect(ws.sent[0].protocol).toBeUndefined();
    expect(unauth).toEqual([]);
    ws.onclose({ code: 4401 }); // refused on both: now the credential is bad
    expect(unauth).toEqual([1]);
    expect(s.stopped).toBe(true);
  });
  it('probes the legacy path after two v2 attempts that never reach a welcome, and treats a v1 welcome to a v2 hello as v1', () => {
    const { s, modes } = mk();
    s.connect(); last().onclose({ code: 1006 }); s.connect(); last().onclose({ code: 1006 });
    expect(modes).toEqual(['v1']);
    s.connect(); expect(last().url).toBe(urls.v1);
    const m2 = mk();
    m2.s.connect(); const ws = last(); ws.onopen(); frame(ws, { type: 'welcome', version: 1, latest_seq: 0 });
    expect(m2.modes).toEqual(['v1']);
  });
  it('sends the view frame only on a v2 connection', () => {
    const { s } = mk();
    s.connect(); const ws = last(); ws.onopen(); frame(ws, { type: 'welcome', version: 2, latest_seq: 0 });
    expect(s.sendView('conversation:c1')).toBe(true);
    expect(ws.sent.at(-1)).toEqual({ type: 'view', view: 'conversation:c1' });
    const v1 = mk({ v2: false }); v1.s.connect(); const w1 = last(); w1.onopen(); frame(w1, { type: 'welcome', version: 1, latest_seq: 0 });
    expect(v1.s.sendView('conversation:c1')).toBe(false);
  });
});

describe('event ring geometry', () => {
  it('a segment has both times; primary draws wide on the main track, overlaps narrow inside then outside', () => {
    const m = ringModel([ev('p', '10:00', '12:00'), ev('o1', '10:30', '11:30', { layer: 'overlap' }), ev('o2', '11:00', '11:45', { layer: 'overlap' })], NOW, TZ);
    const g = Object.fromEntries(m.segs.map((s) => [s.id, s]));
    expect(g.p).toMatchObject({ lane: 'primary', r: PRIMARY.r, w: PRIMARY.w, startH: 10, endH: 12 });
    expect(g.o1).toMatchObject({ lane: 'in', r: OVERLAP_R.in, w: OVERLAP_W });
    expect(g.o2).toMatchObject({ lane: 'out', r: OVERLAP_R.out, w: OVERLAP_W });
    expect(OVERLAP_W).toBeLessThan(PRIMARY.w);
  });
  it('reuses the inside lane once the first overlap has ended; honours colour names and hex', () => {
    const m = ringModel([ev('a', '10:00', '11:00', { layer: 'overlap', color: 'teal' }), ev('b', '11:00', '12:00', { layer: 'overlap', color: '#abc' })], NOW, TZ);
    expect(m.segs.map((s) => s.lane)).toEqual(['in', 'in']);
    expect(m.segs.map((s) => s.color)).toEqual([colorValue('teal'), '#abc']);
    expect(colorValue('nonsense', '#123456')).toBe('#123456');
  });
  it('an Event with only `at` is a tick at that hour; approvals and other days never draw', () => {
    const m = ringModel([ev('bill', '17:30', null), { id: 'ap', kind: 'approval', title: 'x', at: t('10:00'), end: t('11:00') }, ev('tomorrow', '10:00', '11:00', { at: t('10:00', '04'), end: t('11:00', '04') })], NOW, TZ);
    expect(m.segs).toEqual([]);
    expect(m.ticks.map((x) => [x.id, x.h])).toEqual([['bill', 17.5]]);
  });
  it('past segments are flagged (they fade), travel makes a wedge before the event', () => {
    const m = ringModel([ev('early', '07:00', '08:00'), ev('dent', '15:00', '16:00', { travel: { minutes: 30, mode: 'drive' } })], NOW, TZ);
    expect(m.segs.find((s) => s.id === 'early').past).toBe(true);
    expect(m.segs.find((s) => s.id === 'dent').travel).toEqual({ startH: 14.5, endH: 15 });
  });
  it('clamps an event that runs past midnight to the end of the ring', () => {
    const m = ringModel([{ ...ev('late', '23:00', null), end: t('01:00', '04') }], NOW, TZ);
    expect(m.segs[0]).toMatchObject({ startH: 23, endH: 24 });
  });
});

describe('hit testing and scrub', () => {
  const m = ringModel([ev('p', '10:00', '12:00'), ev('o', '10:30', '11:00', { layer: 'overlap' }), ev('bill', '17:30', null), ev('later', '14:00', '15:00')], NOW, TZ);
  const at = (h, r) => polar(h, r);
  it('hits a primary segment on its track and misses empty ring', () => {
    expect(hitTest(...at(11.5, 208), m)).toEqual({ kind: 'seg', id: 'p' });
    expect(hitTest(...at(8, 208), m)).toBeNull();
    expect(hitTest(233, 233, m)).toBeNull();
  });
  it('the narrow overlap is easy to hit, and wins over the primary beside it', () => {
    expect(hitTest(...at(10.75, OVERLAP_R.in), m)).toEqual({ kind: 'seg', id: 'o' });
    expect(hitTest(...at(10.75, OVERLAP_R.in - 10), m)).toEqual({ kind: 'seg', id: 'o' }); // 10 px off its track: still inside the tolerance
  });
  it('a tap near (not on) a segment edge or a tick picks the nearest within tolerance', () => {
    expect(hitTest(...at(9.9, 208), m)).toEqual({ kind: 'seg', id: 'p' });
    expect(hitTest(...at(17.5 + 0.2, 212), m)).toEqual({ kind: 'tick', id: 'bill' });
    expect(hitTest(...at(17.5 + 2, 212), m)).toBeNull();
  });
  describe('tick priority', () => {
    const arcH = (px, r) => px / ((2 * Math.PI * r) / 24); // hours spanned by px along the ring at radius r
    const mt = ringModel([ev('seg', '09:00', '12:00'), ev('tk', '10:00', null), ev('tk2', '10:20', null), ev('ov', '09:30', '10:30', { layer: 'overlap' })], NOW, TZ);
    it('a tap exactly on a tick that sits over a segment opens the tick', () => {
      expect(hitTest(...at(10, 212), mt)).toEqual({ kind: 'tick', id: 'tk' });
    });
    it('a tap 20 px off the tick, still over the segment, opens the tick', () => {
      expect(hitTest(...at(10 - arcH(20, 208), 208), mt)).toEqual({ kind: 'tick', id: 'tk' });
    });
    it('a tap just outside the rim band still counts as the tick', () => {
      expect(hitTest(...at(10, 238), mt)).toEqual({ kind: 'tick', id: 'tk' });
    });
    it('a tap 45 px from the tick, on the segment, opens the segment', () => {
      expect(TICK_HIT_TOL).toBeLessThan(45);
      expect(hitTest(...at(10 - arcH(45, 208), 208), mt)).toEqual({ kind: 'seg', id: 'seg' });
    });
    it('with two ticks in range the nearest wins; an exact tie goes to the earlier', () => {
      expect(hitTest(...at(10.2, 212), mt)).toEqual({ kind: 'tick', id: 'tk2' });
      const two = ringModel([ev('a', '10:00', null), ev('b', '10:20', null)], NOW, TZ);
      expect(hitTest(...at(10.1, 212), two)).toEqual({ kind: 'tick', id: 'a' });
    });
    it('overlap preference over the primary segment is unchanged when no tick is near', () => {
      expect(hitTest(...at(10.75, OVERLAP_R.in), m)).toEqual({ kind: 'seg', id: 'o' });
    });
  });
  it('maps points to hours, midnight at the top, clockwise', () => {
    expect(pointToHours(233, 25)).toBeCloseTo(0, 5);
    expect(pointToHours(441, 233)).toBeCloseTo(6, 5);
    expect(pointToHours(233, 441)).toBeCloseTo(12, 5);
    expect(pointToHours(25, 233)).toBeCloseTo(18, 5);
  });
  it('only the ball starts a scrub', () => {
    const [bx, by] = polar(9, RING_R);
    expect(ballHit(bx, by, 9)).toBe(true);
    expect(ballHit(bx + 20, by, 9)).toBe(true);
    expect(ballHit(...polar(15, RING_R), 9)).toBe(false);
    expect(ballHit(233, 233, 9)).toBe(false);
  });
  it('scrub follows the drag, then snaps back about four seconds after release', () => {
    let s = scrubStart(9);
    s = scrubMove(s, 13.25);
    expect(s.hours).toBe(13.25);
    expect(scrubActive(s, 1e6)).toBe(true);
    s = scrubRelease(s, 1000);
    expect(scrubMove(s, 20).hours).toBe(13.25); // no longer dragging
    expect(scrubActive(s, 1000 + SNAP_MS - 1)).toBe(true);
    expect(scrubActive(s, 1000 + SNAP_MS)).toBe(false);
    expect(scrubRemaining(s, 2000)).toBe(SNAP_MS - 1000);
    expect(SNAP_MS).toBe(4000);
  });
  it('the centre shows the event at that time, else Free', () => {
    const cal = [{ startH: 13, endH: 14, title: 'Standup', color: '#fff' }];
    expect(scrubInfo(10.75, m, cal)).toMatchObject({ title: 'p', time: '10:45', free: false });
    expect(scrubInfo(13.5, m, cal).title).toBe('Standup');
    expect(scrubInfo(8.25, m, cal)).toMatchObject({ title: 'Free', free: true, time: '8:15' });
  });
});

describe('travel and the leave line', () => {
  const nowMs = NOW.getTime();
  it('derives a departure from the soonest live Event with travel', () => {
    const d = travelDeparture([ev('a', '15:00', '16:00', { travel: { minutes: 30 } }), ev('b', '13:00', '14:00', { travel: { minutes: 20 } })], nowMs);
    expect(d).toMatchObject({ kind: 'travel', event_id: 'b' });
    expect(Date.parse(d.leave_at)).toBe(Date.parse(t('12:40')));
  });
  it('picks the earlier of the train and a travel Event, and shows Leave in N min', () => {
    const train = { leave_at: t('11:00'), kind: 'train' };
    const v = pickDeparture(train, [ev('b', '09:50', '10:30', { travel: { minutes: 20 } })], nowMs, TZ);
    expect(v.text).toBe('Leave in 30 min');
    expect(pickDeparture(null, [], nowMs, TZ)).toBeNull();
    expect(pickDeparture(null, [ev('x', '09:25', '10:00', { travel: { minutes: 30 } })], nowMs, TZ).text).toBe('Late');
  });
});

describe('slots', () => {
  const store = (slots = {}, widgets = {}) => { const s = createStore(); s.items.slots = slots; s.items.widgets = widgets; return s; };
  const nowMs = NOW.getTime();
  const next = { h: 10, title: 'ENT' };
  it('the primary line defaults to the next Event', () => {
    expect(primaryView(store(), next, nowMs)).toMatchObject({ source: 'next', text: '10:00 · ENT', action: null });
    expect(primaryView(store(), null, nowMs)).toBeNull();
  });
  it('a live primary slot overrides it, with an optional action; an expired one does not', () => {
    const live = store({ primary: { id: 'primary', text: 'Call Kate', until: t('10:00'), action: { id: 'go', label: 'Call' } } });
    expect(primaryView(live, next, nowMs)).toMatchObject({ source: 'slot', text: 'Call Kate', action: { id: 'go' } });
    const gone = store({ primary: { id: 'primary', text: 'Old', until: t('08:00') } });
    expect(activeSlot(gone, 'primary', nowMs)).toBeNull();
    expect(primaryView(gone, next, nowMs).source).toBe('next');
  });
  it('nextUp takes the earliest of calendar spans, segments and ticks after now', () => {
    const m = ringModel([ev('a', '12:00', '13:00'), ev('bill', '10:30', null)], NOW, TZ);
    expect(nextUp([{ startH: 14, title: 'cal' }], m, 9)).toEqual({ h: 10.5, title: 'bill' });
    expect(nextUp([], { segs: [], ticks: [] }, 9)).toBeNull();
  });
  it('context: the date by default, lines (max two) from the slot, the leave line first', () => {
    expect(contextView(store(), { nowMs }).map((i) => i.kind)).toEqual(['date']);
    const lines = store({ context: { id: 'context', lines: ['one', 'two', 'three'], until: t('12:00') } });
    expect(contextView(lines, { nowMs })).toEqual([{ kind: 'line', text: 'one' }, { kind: 'line', text: 'two' }]);
    const dep = { text: 'Leave in 5 min', pressure: 'red' };
    expect(contextView(lines, { nowMs, departure: dep }).map((i) => i.kind)).toEqual(['leave', 'line']);
    expect(contextView(store(), { nowMs, departure: dep }).map((i) => i.kind)).toEqual(['leave']);
  });
  it('context widgets: up to three that exist and can be drawn; the layout can force lines or widgets', () => {
    const widgets = { g: { id: 'g', type: 'gauge', data: { value: 40 } }, c: { id: 'c', type: 'countdown', data: { to: t('11:30'), label: 'Kate' } }, u: { id: 'u', type: 'mystery', data: {} }, t: { id: 't', type: 'text', data: { text: 'hi' } }, x: { id: 'x', type: 'icon', data: { icon: 'R', value: '3' } } };
    const s = store({ context: { id: 'context', widgets: ['g', 'missing', 'c', 'u', 't', 'x'], until: t('12:00') } }, widgets);
    const items = contextView(s, { nowMs });
    expect(items).toHaveLength(1);
    expect(items[0].list.map((w) => w.kind)).toEqual(['gauge', 'countdown']); // first three ids only: g, missing (dropped), c
    expect(contextView(s, { nowMs, layout: { context: 'lines' } }).map((i) => i.kind)).toEqual(['date']);
  });
  it('widget registry: gauge, countdown, icon, sparkline, text, and unknown types fall back to their text', () => {
    expect(widgetView({ type: 'gauge', data: { value: 30, max: 60 } }, 0)).toMatchObject({ kind: 'gauge', frac: 0.5, text: '50%' });
    expect(widgetView({ type: 'progress', data: { value: 500 } }, 0).frac).toBe(1);
    expect(widgetView({ type: 'countdown', data: { to: t('11:15') } }, NOW.getTime())).toMatchObject({ kind: 'countdown', text: '2h 15m' });
    expect(widgetView({ type: 'icon-with-value', data: { icon: 'R', value: '3' } }, 0)).toMatchObject({ kind: 'icon', icon: 'R', text: '3' });
    expect(widgetView({ type: 'sparkline-lite', data: { points: [1, 3, 2] } }, 0).points).toEqual([0, 1, 0.5]);
    expect(widgetView({ type: 'weather', data: { text: '54F rain' } }, 0)).toMatchObject({ kind: 'text', text: '54F rain' });
    expect(widgetView({ type: 'weather', data: { temp: 54 } }, 0)).toBeNull();
    expect(countdownText(NOW.getTime() - 1, NOW.getTime())).toBe('now');
  });
});

describe('agent status', () => {
  const ses = (id, extra = {}) => ({ id, title: `T${id}`, subject: null, state: 'working', conversation_id: `c${id}`, since: t('08:50'), last_activity_at: t('08:55'), needs_you: false, ...extra });
  it('keeps the server order, prefers the subject, colours by state, needs_you is amber', () => {
    const m = statusModel([ses('a', { needs_you: true, state: 'waiting' }), ses('b', { subject: 'Highlander' }), ses('c', { state: 'stuck' })], NOW.getTime());
    expect(m.rows.map((r) => r.name)).toEqual(['Ta', 'Highlander', 'Tc']);
    expect(m.rows[0].color).toBe('#ffb347');
    expect(m.rows[2].color).toBe('#ef6a5d');
    expect(m.rows[1].age).toBe('5m');
    expect(m.needs).toBe(true);
    expect(m.segs).toHaveLength(3);
  });
  it('caps rim segments at eight and reports the rest as +N', () => {
    const many = Array.from({ length: 11 }, (_, i) => ses(String(i)));
    const m = statusModel(many, NOW.getTime());
    expect(m.segs).toHaveLength(RING_CAP);
    expect(m.more).toBe(3);
    expect(m.rows).toHaveLength(11);
    const h = render('status', { sessions: many, now: NOW, tz: TZ });
    expect(h).toContain('+3');
    expect((h.match(/class="srow2/g) || []).length).toBe(11);
    expect(statusModel([ses('z')], NOW.getTime()).more).toBe(0);
  });
  it('maps the legacy desk payload to the same shape', () => {
    const s = sessionsFromDesk({ sessions: [{ id: 'x', title: 'Main', state: 'waiting', since: t('08:00') }, { id: 'y', title: 'K', state: 'idle', since: t('08:00') }] });
    expect(s.map((x) => x.needs_you)).toEqual([true, false]);
  });
  it('merges older pages in front without duplicates and ignores a repeated live message', () => {
    const held = [{ id: 'm3' }, { id: 'm4' }];
    expect(mergeOlder(held, [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }]).map((m) => m.id)).toEqual(['m1', 'm2', 'm3', 'm4']);
    expect(appendMessage(held, { id: 'm5' })).toBe(true);
    expect(appendMessage(held, { id: 'm5' })).toBe(false);
  });
});

describe('actions', () => {
  it('maps every result to what the button shows', () => {
    expect(interpretResult({ status: 'done' })).toMatchObject({ state: 'sent', label: 'Sent', disabled: true });
    expect(interpretResult({ status: 'already_done' })).toMatchObject({ state: 'already', disabled: true });
    expect(interpretResult({ status: 'expired' })).toMatchObject({ state: 'expired', label: 'Expired', disabled: true });
    expect(interpretResult({ status: 'failed', reason: 'internal_error' })).toMatchObject({ state: 'failed', label: 'Failed', disabled: false });
    expect(interpretResult({ status: 'failed', reason: 'forbidden' }).disabled).toBe(true);
    expect(interpretResult(null)).toMatchObject({ state: 'failed' });
  });
  it('builds the request: object, action id as string, fresh key, draft and message id only when given', () => {
    expect(buildRequest({ object: 'events:a', actionId: 'go', key: 'k' })).toEqual({ object: 'events:a', action_id: 'go', idempotency_key: 'k' });
    expect(buildRequest({ object: 'conversations:c', actionId: 1, key: 'k', messageId: 'm' })).toEqual({ object: 'conversations:c', action_id: '1', idempotency_key: 'k', message_id: 'm' });
    expect(buildRequest({ object: 'x:y', actionId: 'a', key: 'k', draft: 'hi' }).draft).toBe('hi');
  });
  const respond = (body, status = 200) => { const calls = []; const f = async (url, init) => { calls.push({ url, body: JSON.parse(init.body), headers: init.headers }); return { status, json: async () => body }; }; f.calls = calls; return f; };
  it('a done tap disables the button; a later tap is not sent; every tap carries a fresh key', async () => {
    const states = new ButtonStates(); const f = respond({ status: 'done', message_id: 'm1' });
    const a = await submitAction({ fetchImpl: f, url: '/a', token: 'T', object: 'events:e', actionId: 'go', states });
    expect(a.interp.state).toBe('sent');
    expect(f.calls[0].headers.Authorization).toBe('Bearer T');
    const b = await submitAction({ fetchImpl: f, url: '/a', token: 'T', object: 'events:e', actionId: 'go', states });
    expect(b.skipped).toBe(true);
    expect(f.calls).toHaveLength(1);
    expect(states.get(btnKey('events:e', 'go')).disabled).toBe(true);
    const f2 = respond({ status: 'failed', reason: 'internal_error' }); const s2 = new ButtonStates(4000);
    await submitAction({ fetchImpl: f2, url: '/a', token: 'T', object: 'events:e', actionId: 'x', states: s2, now: () => 0 });
    expect(s2.get(btnKey('events:e', 'x'), 100).label).toBe('Failed');
    expect(s2.get(btnKey('events:e', 'x'), 5000).state).toBe('idle'); // retryable failure re-enables after a moment
    await submitAction({ fetchImpl: f2, url: '/a', token: 'T', object: 'events:e', actionId: 'x', states: s2, now: () => 6000 });
    expect(f2.calls[0].body.idempotency_key).not.toBe(f2.calls[1].body.idempotency_key);
  });
  it('a network failure is a retryable Failed; expired and already_done are final', async () => {
    const states = new ButtonStates();
    const bad = async () => { throw new Error('offline'); };
    const r = await submitAction({ fetchImpl: bad, url: '/a', token: 'T', object: 'slots:primary', actionId: 'g', states });
    expect(r.interp).toMatchObject({ state: 'failed', reason: 'network', disabled: false });
    const e = await submitAction({ fetchImpl: respond({ status: 'expired' }), url: '/a', token: 'T', object: 'events:e', actionId: 'z', states });
    expect(e.interp.label).toBe('Expired');
    const d = await submitAction({ fetchImpl: respond({ status: 'already_done' }), url: '/a', token: 'T', object: 'events:e', actionId: 'w', states });
    expect(d.interp.label).toBe('Already sent');
  });
  it('confirm gating: an action with a draft is never sent without the exact draft echoed back', async () => {
    const action = { id: 'here', label: 'Here', confirm: { draft: 'Arrived.' } };
    expect(needsConfirm(action)).toBe(true);
    expect(needsConfirm({ id: 'x', label: 'X' })).toBe(false);
    const f = respond({ status: 'done' });
    const none = await submitAction({ fetchImpl: f, url: '/a', token: 'T', object: 'events:e', actionId: 'here', action });
    expect(none.result.reason).toBe('confirm_required');
    const wrong = await submitAction({ fetchImpl: f, url: '/a', token: 'T', object: 'events:e', actionId: 'here', action, draft: 'Something else' });
    expect(wrong.result.reason).toBe('draft_mismatch');
    expect(f.calls).toHaveLength(0);
    const ok = await submitAction({ fetchImpl: f, url: '/a', token: 'T', object: 'events:e', actionId: 'here', action, draft: 'Arrived.' });
    expect(ok.interp.state).toBe('sent');
    expect(f.calls[0].body.draft).toBe('Arrived.');
    const plain = await submitAction({ fetchImpl: f, url: '/a', token: 'T', object: 'events:e', actionId: 'p', action: { id: 'p', label: 'P' }, draft: 'ignored' });
    expect(plain.interp.state).toBe('sent');
    expect(f.calls[1].body.draft).toBeUndefined();
  });
});

describe('faces, layout and approvals', () => {
  it('orders enabled known faces by the bus and wraps; layout flags default on', () => {
    const st = createStore();
    st.items.faces = { day: { id: 'day', order: 1, enabled: true }, status: { id: 'status', order: 0, enabled: true }, desk: { id: 'desk', order: 2, enabled: true }, off: { id: 'off', order: 3, enabled: false } };
    expect(faceOrder(st)).toEqual(['status', 'day']);
    expect(stepFace(['status', 'day'], 'day', 1)).toBe('status');
    expect(stepFace(['status', 'day'], 'status', -1)).toBe('day');
    expect(faceOrder(createStore())).toEqual(['day', 'status']);
    expect(faceLayout(st, 'day')).toEqual({ ring: true, primary: true, context: null });
    st.items.faces.day.layout = { slots: { event_ring: false, context: 'widgets' } };
    expect(faceLayout(st, 'day')).toEqual({ ring: false, primary: true, context: 'widgets' });
  });
  it('pending approval Events become Needs-you items with a Review action', () => {
    const st = createStore();
    st.items.events = { 'approval-1': { id: 'approval-1', kind: 'approval', title: 'Bash: ls', level: 'attention', expires_at: t('12:00') }, 'approval-2': { id: 'approval-2', kind: 'approval', title: 'Old', expires_at: t('08:00') }, e: { id: 'e', kind: 'event' } };
    const items = approvalItems(st, NOW.getTime());
    expect(items.map((i) => i.id)).toEqual(['approval:approval-1']);
    expect(items[0].actions[0].label).toBe('Review');
  });
});

describe('surface rendering', () => {
  it('in v2 the calendar does not draw: no calendar arcs and no "Clear for today" when nothing is published', () => {
    const cal = [{ id: 'c', title: 'Cal', start: t('10:00'), end: t('11:00'), color: '#123456' }];
    const h2 = render('idle', { events: [], v2: true, now: NOW, tz: TZ, surfaceEvents: [] });
    expect(h2).not.toContain('Clear for today');
    expect(h2).not.toContain('#123456');
    const h1 = render('idle', { events: cal, now: NOW, tz: TZ });
    expect(h1).toContain('#123456');
    expect(render('idle', { events: [], now: NOW, tz: TZ })).toContain('Clear for today');
  });
  it('draws surface segments, ticks, the primary button and the context lines', () => {
    const st = createStore();
    st.items.slots = { primary: { id: 'primary', text: 'Call Kate', until: t('12:00'), action: { id: 'go', label: 'Call', style: 'primary' } }, context: { id: 'context', lines: ['Rain at four'], until: t('12:00') } };
    const h = render('idle', { events: [], v2: true, now: NOW, tz: TZ, store: st, surfaceEvents: [ev('p', '10:00', '11:00', { color: '#ff0000' }), ev('bill', '17:00', null, { color: '#00ff00' })] });
    expect(h).toContain('stroke="#ff0000" stroke-width="20"');
    expect(h).toContain('stroke="#00ff00" stroke-width="5"');
    expect(h).toContain('Call Kate');
    expect(h).toContain('data-act="slotaction"');
    expect(h).toContain('Rain at four');
    expect(h).not.toContain('NOV');
  });
  it('a button shows Sent after a done tap and the exact draft is in the draft view', () => {
    const h = render('event', { ev: { id: 'e', title: 'T', at: t('10:00'), end: t('11:00'), actions: [{ id: 'a', label: 'Go' }] }, tz: TZ, btn: () => ({ state: 'sent', label: 'Sent', disabled: true }) });
    expect(h).toContain('Sent');
    expect(h).toContain('off');
    const d = render('draft', { to: 'Text Kate', text: 'Running late <now>' });
    expect(d).toContain('Running late &lt;now&gt;');
    expect(d).toContain('data-act="dsend"');
    expect(d).toContain('data-act="dhold"');
  });
  it('the conversation view lists bubbles by role with tappable buttons', () => {
    const h = render('convo', { title: 'Plan', convId: 'c1', messages: [{ id: 'm1', role: 'user', text: 'hi' }, { id: 'm2', role: 'agent', text: 'which?', answer_needed: true, buttons: [{ index: 0, label: 'A' }, { index: 1, label: 'B' }] }] });
    expect(h).toContain('msg me');
    expect(h).toContain('msg them');
    expect(h).toContain('data-act="cbtn" data-mid="m2" data-i="1"');
    expect(h).toContain('Needs your answer');
  });
  it('renders every demo step', () => {
    for (const s of STEPS) expect(render(s.name, s.props(0))).toBeTruthy();
  });
});

describe('ring tap carousel', () => {
  const at = (h, r = 208) => polar(h, r);
  const mk = (list) => ringModel(list, NOW, TZ);
  const m = mk([ev('late', '15:00', '16:00'), ev('tk', '12:00', null), ev('early', '09:00', '10:00'), ev('ov', '09:30', '09:45', { layer: 'overlap' }), ev('tk2', '15:00', null)]);
  describe('carouselOrder', () => {
    it('orders segments and ticks together by start; a segment precedes a tick at the same time', () => {
      expect(carouselOrder(m).map((x) => x.id)).toEqual(['early', 'ov', 'tk', 'late', 'tk2']);
      expect(carouselOrder(m).map((x) => x.kind)).toEqual(['seg', 'seg', 'tick', 'seg', 'tick']);
    });
    it('keeps past Events and is empty for an empty or missing model', () => {
      expect(carouselOrder(m)[0].id).toBe('early'); // 09:00 is "now" in the fixture, earlier ones would be past too
      expect(carouselOrder(mk([]))).toEqual([]);
      expect(carouselOrder(null)).toEqual([]);
    });
  });
  describe('nearestRingEvent', () => {
    it('picks the Event whose start is nearest the tapped hour, anywhere on the ring', () => {
      expect(nearestRingEvent(...at(11.6, 175), m)).toEqual({ kind: 'tick', id: 'tk' });
      expect(nearestRingEvent(...at(14.9, 240), m)).toEqual({ kind: 'seg', id: 'late' });
      expect(nearestRingEvent(...at(3), m)).toEqual({ kind: 'seg', id: 'early' });
    });
    it('a tap inside a segment span wins even when a tick starts closer', () => {
      const w = mk([ev('wide', '08:00', '14:00'), ev('tk', '12:30', null)]);
      expect(nearestRingEvent(...at(10), w)).toEqual({ kind: 'seg', id: 'wide' }); // tick is 2.5 h away, but 10 is inside the span
    });
    it('measures to the start only outside the span, around midnight too', () => {
      const w = mk([ev('a', '23:00', '23:30'), ev('b', '03:00', '04:00')]);
      expect(nearestRingEvent(...at(0.5), w)).toEqual({ kind: 'seg', id: 'a' }); // 1.5 h from 23:00, 2.5 h from 03:00
    });
    it('an exact tie goes to the earlier Event', () => {
      const w = mk([ev('a', '10:00', null), ev('b', '12:00', null)]);
      expect(nearestRingEvent(...at(11), w)).toEqual({ kind: 'tick', id: 'a' });
      const x = mk([ev('tk', '11:00', null), ev('sg', '11:00', '12:00')]);
      expect(nearestRingEvent(...at(10), x)).toEqual({ kind: 'seg', id: 'sg' }); // same start: segment first
    });
    it('returns null for an empty model so a tap does nothing', () => {
      expect(nearestRingEvent(...at(10), mk([]))).toBeNull();
    });
  });
  describe('ring band', () => {
    it('is generous: just inside the inner track to just outside the rim, not the centre', () => {
      expect(inRingBand(...polar(5, 208))).toBe(true);
      expect(inRingBand(...polar(5, RING_TAP.in + 1))).toBe(true);
      expect(inRingBand(...polar(5, RING_TAP.out - 1))).toBe(true);
      expect(inRingBand(...polar(5, 160))).toBe(false);
      expect(inRingBand(233, 233)).toBe(false);
    });
    it('covers a spot well away from any bar or tick', () => {
      expect(hitTest(...at(20, 208), m)).toBeNull();
      expect(inRingBand(...at(20, 208))).toBe(true);
      expect(nearestRingEvent(...at(20, 208), m)).not.toBeNull();
    });
  });
  describe('carousel card', () => {
    const e1 = { ...ev('d', '09:00', '10:00', { body: 'Second floor.', detail: { location: '12 Main', description: 'Bring card.' }, travel: { minutes: 20, mode: 'drive' }, actions: [{ id: 'go', label: 'Go' }] }), color: 'orange' };
    it('shows the counter, the Event focus content and its buttons', () => {
      const h = render('carousel', { ev: e1, tz: TZ, index: 1, total: 4 });
      expect(h).toContain('2 of 4');
      expect(h).toContain('data-act="cprev"');
      expect(h).toContain('data-act="cnext"');
      expect(h).toContain('Second floor.');
      expect(h).toContain('12 Main');
      expect(h).toContain('Bring card.');
      expect(h).toContain('20 min by drive');
      expect(h).toContain('data-act="efire"');
      expect(h).toContain('data-act="back"');
      expect(h).not.toContain('copenconv');
    });
    it('offers Open conversation for an opens: conversation Event, and marks a past card', () => {
      const h = render('carousel', { ev: { ...e1, opens: 'conversation', conversation_id: 'c1' }, tz: TZ, index: 0, total: 1, past: true });
      expect(h).toContain('data-act="copenconv"');
      expect(h).toContain('class="scroller car past"');
      expect(h).toContain('carr off');
    });
  });
});

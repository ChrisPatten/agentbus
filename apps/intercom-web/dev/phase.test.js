import { describe, it, expect } from 'vitest';
import { clockPoint, clockDeg, drainLit, drainDots, upperArc, lowerArc, moonDeg, WALK, walkAt, sliderHit, sliderArcs, arcD } from '../phase/geom.js';
import { sunTimes, crescentLeft, crescentCx } from '../phase/sun.js';
import { zonedMs, hm, hmA, zparts, timer, lengthText, shortHour } from '../phase/time.js';
import * as M from '../phase/model.js';
import { createEarlier } from '../phase/earlier.js';
import { STATES, STATE_IDS, buildState } from '../phase/states.js';
import { compose, fitCaption, setMeasure, capsule, segWidths } from '../phase/prims.js';

const TZ = 'America/New_York';
const at = (h, m, s = 0) => zonedMs(2026, 11, 5, h, m, TZ, s);
const iso = (h, m) => new Date(at(h, m)).toISOString();
const ev = (id, h, m, end = null, extra = {}) => M.momentFromEvent({ id, kind: 'event', title: id, level: 'info', at: iso(h, m), end: end ? iso(end[0], end[1]) : null, ...extra });

describe('clock to point (spec 4.2)', () => {
  const near = (p, x, y) => { expect(Math.abs(p.x - x)).toBeLessThanOrEqual(0.1); expect(Math.abs(p.y - y)).toBeLessThanOrEqual(0.1); };
  it('matches the spec check values on r 214', () => {
    near(clockPoint(14, 48), 445.8, 210.6);
    near(clockPoint(15, 6), 446.7, 244.2);
    near(clockPoint(14, 22), 435.3, 163.3);
  });
  it('puts 12 at the top, 3 on the right, 7:30 lower left, and wraps 12-hour', () => {
    near(clockPoint(0, 0), 233, 19);
    near(clockPoint(3, 0), 447, 233);
    near(clockPoint(19, 30), 81.7, 384.3);
    expect(clockDeg(14, 48)).toBeCloseTo(84, 6);
    expect(clockDeg(2, 48)).toBe(clockDeg(14, 48));
  });
  it('draws arcs clockwise with the large-arc flag past 180 degrees', () => {
    expect(arcD(75, 97.5, 197)).toMatch(/^M423\.3 182A197 197 0 0 1 /);
    expect(arcD(144, 360, 214)).toMatch(/ 0 1 1 /);
  });
});

describe('daylight crescent (spec 5.3)', () => {
  const rise = at(6, 25), set = at(16, 37);
  const table = [[6, 25, -27], [7, 0, 29], [9, 30, 271], [11, 31, 466], [14, 48, -203], [15, 6, -174], [16, 30, -38], [16, 37, -27]];
  for (const [h, m, left] of table) {
    it(`box left at ${h}:${String(m).padStart(2, '0')} is ${left} (within 2 px)`, () => {
      expect(Math.abs(crescentLeft(at(h, m), rise, set) - left)).toBeLessThanOrEqual(2);
    });
  }
  it('is fully shaded at night and handles polar day and night', () => {
    expect(crescentCx(at(3, 0), rise, set)).toBe(233);
    expect(crescentCx(at(22, 0), rise, set)).toBe(233);
    expect(crescentCx(0, 0, 0, 'night')).toBe(233);
    expect(crescentCx(0, 0, 0, 'day')).toBe(726);
  });
  it('computes sunrise and sunset with the NOAA method', () => {
    const b = sunTimes(2026, 6, 21, 42.3601, -71.0589); // Boston, June solstice: 5:07 AM and 8:24 PM EDT
    expect(hm(b.rise, TZ)).toBe('5:07');
    expect(Math.abs(b.set - zonedMs(2026, 6, 21, 20, 24, TZ))).toBeLessThan(90000);
    const g = sunTimes(2026, 3, 20, 51.4769, 0); // Greenwich, equinox: about 06:03 and 18:13 UTC
    expect(Math.abs(g.rise - Date.UTC(2026, 2, 20, 6, 3))).toBeLessThan(120000);
    expect(Math.abs(g.set - Date.UTC(2026, 2, 20, 18, 13))).toBeLessThan(120000);
    const n = sunTimes(2026, 11, 5, 42.0334, -71.219); // Mansfield, the default location
    expect(zparts(n.rise, TZ).h).toBe(6); expect(zparts(n.set, TZ).h).toBe(16);
    expect(sunTimes(2026, 6, 21, 78.2, 15.6)).toEqual({ polar: 'day' });
    expect(sunTimes(2026, 12, 21, 78.2, 15.6)).toEqual({ polar: 'night' });
  });
});

describe('alert rim drain (spec 7.1)', () => {
  const a = at(15, 0), e = at(15, 60);
  it('starts with all 60 dots and loses one per 1/60 of the window', () => {
    expect(drainLit(a, e, a)).toBe(60);
    expect(drainLit(a, e, a + 59000)).toBe(60);
    expect(drainLit(a, e, a + 60000)).toBe(59);
    expect(drainLit(a, e, a + 0.4 * 3600000)).toBe(36);
    expect(drainLit(a, e, e)).toBe(0);
    expect(drainLit(a, e, e + 1)).toBe(0);
  });
  it('keeps every dot without a window', () => {
    expect(drainLit(a, NaN, a + 1e9)).toBe(60);
    expect(drainLit(a, a, a)).toBe(60);
  });
  it('lights the dots from the drain point clockwise back to 12; they go out clockwise from 12', () => {
    const d = drainDots(36);
    expect(d.length).toBe(36); expect(d[0]).toBe(144); expect(d[35]).toBe(354);
    expect(drainDots(60)[0]).toBe(0); expect(drainDots(0)).toEqual([]);
  });
});

describe('Now face arcs, moon, burn-in walk', () => {
  it('draws the upper arc from 10 o\'clock and the lower from 8 o\'clock', () => {
    expect(upperArc(0).start.x).toBeCloseTo(103.1, 1); expect(upperArc(1).head.x).toBeCloseTo(362.9, 1);
    expect(lowerArc(0.5).head.x).toBeCloseTo(233, 1); expect(lowerArc(0.5).head.y).toBeCloseTo(383, 1);
  });
  it('steps the moon 6 degrees a second and parks it at 12', () => {
    expect(moonDeg(0)).toBe(0); expect(moonDeg(20)).toBe(120); expect(moonDeg(59.9)).toBe(354); expect(moonDeg(31, true)).toBe(0);
  });
  it('walks 12 positions 3 px apart on a 3 x 4 grid, one step at a time', () => {
    expect(WALK.length).toBe(12);
    expect(new Set(WALK.map((p) => `${p.x},${p.y}`)).size).toBe(12);
    for (let i = 0; i < 12; i++) { const a = walkAt(i), b = walkAt(i + 1); if (i !== 11) expect(Math.abs(a.x - b.x) + Math.abs(a.y - b.y)).toBe(3); }
  });
  it('maps the Settings rim sliders', () => {
    const lo = sliderArcs('left', 0).knob, hi = sliderArcs('left', 1).knob;
    expect(sliderHit(lo.x, lo.y)).toEqual({ side: 'left', value: 0 });
    expect(sliderHit(hi.x, hi.y).value).toBeCloseTo(1, 5);
    expect(sliderHit(233, 233)).toBeNull();
  });
});

describe('countdown rules (spec 7.1, 10)', () => {
  it('shows minutes up to 119 and the clock time from 120', () => {
    expect(M.countdown(at(15, 30), at(14, 48, 20), TZ)).toMatchObject({ kind: 'min', numeral: '42', unit: 'MIN', size: 'xl' });
    expect(M.countdown(at(16, 49), at(14, 50), TZ).numeral).toBe('119');
    expect(M.countdown(at(16, 50), at(14, 50), TZ)).toMatchObject({ kind: 'clock', numeral: '4:50', unit: null, size: 'l', tomorrow: false });
    expect(M.countdown(zonedMs(2026, 11, 6, 7, 30, TZ), at(23, 42), TZ)).toMatchObject({ kind: 'clock', numeral: '7:30', tomorrow: true });
    expect(M.countdown(at(15, 0), at(15, 0), TZ).numeral).toBe('0');
  });
  it('never puts more than three characters in a minutes numeral', () => {
    for (let m = 0; m < 120; m++) expect(M.countdown(at(15, 0) + m * 60000, at(15, 0), TZ).numeral.length).toBeLessThanOrEqual(3);
  });
  const QUIET = [ev('lunch', 12, 0, [13, 0]), ev('design', 15, 30, null, { detail: { location: 'Room 4B' } }), ev('b', 16, 0), ev('c', 17, 45), ev('d', 19, 30)];
  it('builds the quiet-day Now face', () => {
    const m = M.nowModel(QUIET, at(14, 48, 20), TZ);
    expect(m).toMatchObject({ label: 'NEXT 3:30', numeral: '42', unit: 'MIN', top: 'Clear until 3:30', bottom: 'design · Room 4B', status: { text: '4 LEFT TODAY', amber: false } });
    expect(m.arcs.upper).toBeCloseTo(108.33 / 150, 2);
    expect(m.arcs.lower).toBeCloseTo((7 * 60 + 48.33) / 900, 2);
    expect(m.marks.filter((k) => k.type === 'dot').length).toBe(4);
  });
  it('labels a Moment already started NOW with the minutes left', () => {
    const m = M.nowModel([ev('meet', 14, 30, [15, 15])], at(14, 40), TZ);
    expect(m).toMatchObject({ label: 'NOW', numeral: '35', top: 'Until 3:15' });
    expect(m.marks[0]).toMatchObject({ type: 'arc', a1: clockDeg(14, 40) });
  });
  it('shows the clock, NOTHING ON and a bare rim with nothing today', () => {
    const m = M.nowModel([ev('tomorrow', 0, 0)], at(14, 48), TZ);
    expect(m).toMatchObject({ nothing: true, label: 'NOTHING ON', numeral: '2:48', unit: null, size: 'l' });
    expect(m.marks).toEqual([]);
  });
  it('reports an overlap in amber and counts down with a tilde offline', () => {
    const busy = [ev('q4', 14, 30, [15, 15]), ev('vendor', 15, 0, [15, 45])];
    expect(M.nowModel(busy, at(14, 22, 41), TZ, { missed: 2 })).toMatchObject({ top: '2 missed · overlap at 3:00', status: { text: '◆ OVERLAP 15 MIN', amber: true } });
    const off = M.nowModel(QUIET, at(14, 52), TZ, { offline: true, offlineSince: at(14, 41) });
    expect(off).toMatchObject({ numeral: '~38', top: 'Offline since 2:41 PM' });
    expect(off.arcs).toEqual({ upper: null, lower: null });
  });
});

describe('rim marks (spec 5.1)', () => {
  it('moves the later overlapping span to lane 2 in amber and drops a third', () => {
    const r = M.rimMarks([ev('a', 14, 30, [15, 15]), ev('b', 15, 0, [15, 45]), ev('c', 15, 5, [15, 20]), ev('d', 16, 0)], at(14, 22), TZ);
    expect(r.marks.map((k) => [k.id, k.type, k.lane, k.amber])).toEqual([['a', 'arc', 1, false], ['b', 'arc', 2, true], ['d', 'dot', undefined, undefined]]);
    expect(r.hidden).toBe(1);
  });
  it('draws nothing more than 12 hours ahead or already past', () => {
    const r = M.rimMarks([ev('past', 9, 0, [10, 0]), ev('far', 23, 0), ev('ok', 23, 0)], at(11, 30), TZ);
    expect(r.marks.map((k) => k.id)).toEqual(['far', 'ok']);
    expect(M.rimMarks([ev('far', 23, 31)], at(11, 30), TZ).marks).toEqual([]);
  });
});

describe('day list (spec 7.2)', () => {
  it('lists three Moments, one overlap note, one gap row and the rest as +N LATER TODAY', () => {
    const d = M.dayModel([ev('q4', 14, 30, [15, 15]), ev('vendor', 15, 0, [15, 15]), ev('board', 16, 0, [16, 45]), ev('x', 17, 45), ev('y', 19, 30)], at(14, 22), TZ);
    expect(d.items.map((i) => i.kind)).toEqual(['row', 'note', 'row', 'gap', 'row']);
    expect(d.items[0]).toMatchObject({ time: '2:30', next: true }); expect(d.items[1].text).toBe('◆ OVERLAPS 15 MIN');
    expect(d.items[3].text).toBe('45 MIN FREE'); expect(d.more).toBe('+2 LATER TODAY'); expect(d.top).toBe('Thursday · 5 Nov');
  });
  it('builds the detail rows and drops missing ones', () => {
    const q4 = ev('q4', 14, 30, [15, 15], { detail: { location: 'Room 4B' }, travel: { minutes: 10, mode: 'walk' } });
    const d = M.detailModel(q4, [q4, ev('Vendor call', 15, 0, [15, 45])], at(14, 22), TZ);
    expect(d).toMatchObject({ top: 'In 8 min', range: '2:30–3:15', sub: 'PM · 45 MIN', place: 'Room 4B', travel: 'LEAVE 2:20 · 10 MIN WALK', conflict: '◆ OVERLAPS Vendor call, 3:00', sparse: false });
    const sp = M.detailModel(ev('v', 15, 0), [], at(14, 22), TZ);
    expect(sp).toMatchObject({ sparse: true, range: '3:00', sub: 'PM', place: null, travel: null, conflict: null });
  });
});

describe('weight mapping (spec 6.2)', () => {
  it('uses an Event weight field when present, else maps level', () => {
    expect(M.weightOf({ weight: 'notice', level: 'urgent' })).toBe('notice');
    expect(M.weightOf({ level: 'info' })).toBe('ambient');
    expect(M.weightOf({ level: 'attention' })).toBe('decision');
    expect(M.weightOf({ level: 'urgent' })).toBe('urgent');
    expect(M.weightOf({ weight: 'bogus' })).toBe('ambient');
  });
  it('maps notices info / attention / urgent to notice / decision / urgent', () => {
    expect(M.momentFromNotice({ id: 'n', level: 'info', state: 'active' }).weight).toBe('notice');
    expect(M.momentFromNotice({ id: 'n', level: 'attention', state: 'active' }).weight).toBe('decision');
    expect(M.momentFromNotice({ id: 'n', level: 'urgent', state: 'active' }).weight).toBe('urgent');
  });
  it('makes an approval a decision with the exact detail, and a draft action a hold with a preview', () => {
    const ap = M.momentFromEvent({ id: 'approval-1', kind: 'approval', title: 'Bash: rm', level: 'attention', approval: { detail: 'rm -rf build' }, actions: [{ id: 'approve', label: 'Approve' }, { id: 'deny', label: 'Deny', style: 'destructive' }] });
    expect(ap).toMatchObject({ src: 'approval', weight: 'decision', start: null, preview: { text: 'rm -rf build' } });
    const dr = M.momentFromEvent({ id: 'e', kind: 'event', title: 'Reply', level: 'attention', actions: [{ id: 'send', label: 'Send', confirm: { draft: 'Thursday works.' } }] });
    expect(dr.actions[0]).toMatchObject({ kind: 'hold', draft: 'Thursday works.', primary: true });
    expect(dr.preview.text).toBe('Thursday works.');
  });
  it('reads consequence and changed when present and leaves them absent otherwise', () => {
    expect(M.momentFromEvent({ id: 'e', kind: 'event', title: 't', level: 'urgent', consequence: 'Misses the 7:15', changed: { field: 'at', old: '6:42', new: '6:58' } })).toMatchObject({ consequence: 'Misses the 7:15', changed: { new: '6:58' } });
    expect(M.momentFromEvent({ id: 'e', kind: 'event', title: 't', level: 'urgent' })).toMatchObject({ consequence: null, changed: null });
  });
  it('cuts action labels to 10 characters without an ellipsis and logs it', () => {
    const log = []; expect(M.capLabel('Reschedule it', (s) => log.push(s))).toBe('RESCHEDULE'); expect(log.length).toBe(1);
  });
  it('orders alerts by weight then newest and skips set-aside and expired ones', () => {
    const n = (id, level, t, extra = {}) => M.momentFromNotice({ id, level, state: 'active', created_at: new Date(t).toISOString(), updated_at: 'u', ...extra });
    const list = [n('a', 'info', 1), n('b', 'urgent', 2), n('c', 'attention', 3), n('d', 'attention', 4), n('e', 'urgent', 5, { expires_at: new Date(10).toISOString() })];
    expect(M.alertList(list, new Map([['d', 'u']]), 100).map((m) => m.id)).toEqual(['b', 'c', 'a']);
  });
  it('gives the glass to capture, listening, urgent, decision, notice, overlays, the face, then rest (spec 8.2)', () => {
    expect(M.pickLayer({ capture: true, listening: true, alert: { weight: 'urgent' } })).toBe('capture');
    expect(M.pickLayer({ listening: true, alert: { weight: 'urgent' } })).toBe('listening');
    expect(M.pickLayer({ alert: { weight: 'decision' }, overlay: 'settings' })).toBe('decision');
    expect(M.pickLayer({ alert: { weight: 'notice' }, resting: true })).toBe('rest');
    expect(M.pickLayer({ overlay: 'earlier' })).toBe('earlier');
    expect(M.pickLayer({})).toBe('face');
  });
});

describe('session state mapping (spec 6.3, 7.4)', () => {
  it('maps needs_you and waiting to waiting, stuck to failed, finished to done, and hides idle', () => {
    expect(M.sessionState({ state: 'idle', needs_you: true })).toBe('waiting');
    expect(M.sessionState({ state: 'waiting' })).toBe('waiting');
    expect(M.sessionState({ state: 'stuck' })).toBe('failed');
    expect(M.sessionState({ state: 'working' })).toBe('working');
    expect(M.sessionState({ state: 'finished' })).toBe('done');
    expect(M.sessionState({ state: 'idle' })).toBeNull();
  });
  it('sorts waiting, failed, working, done; counts working; summarises past three', () => {
    const now = at(14, 44);
    const s = (id, state, extra = {}) => ({ id, title: id, state, since: new Date(now - 12 * 60000).toISOString(), last_activity_at: new Date(now - 2 * 60000).toISOString(), ...extra });
    const a = M.agentsModel([s('done1', 'finished'), s('w1', 'working'), s('idle', 'idle'), s('f1', 'stuck'), s('w2', 'working')], now);
    expect(a.rows.map((r) => r.id)).toEqual(['f1', 'w1', 'w2']);
    expect(a.more).toBe('+1 MORE'); expect(a.caption).toBe('1 failed · 2 working'); expect(a.working).toBe(2);
    expect(a.rows[1].detail).toBe('working · 12m');
    const b = M.agentsModel([s('w1', 'working'), s('w2', 'working'), s('w3', 'working'), s('w4', 'working')], now);
    expect(b.more).toBe('+1 WORKING');
    const c = M.agentsModel([s('d', 'finished'), s('i', 'idle')], now);
    expect(c.nothing).toBe(true); expect(c.lastDone.id).toBe('d');
  });
  it('takes a waiting job\'s question from its answer-needed message', () => {
    const q = M.questionOf({ needs_you_message_id: 'm2' }, [{ id: 'm1', text: 'old' }, { id: 'm2', text: 'Aloft or Hyatt?', created_at: iso(14, 40), buttons: [{ index: 0, label: 'Aloft' }, { index: 1, label: 'Hyatt' }] }]);
    expect(q).toMatchObject({ messageId: 'm2', text: 'Aloft or Hyatt?', options: [{ index: 0, label: 'Aloft' }, { index: 1, label: 'Hyatt' }] });
    expect(M.questionOf({}, [{ id: 'x', text: 'q', answer_needed: true }]).messageId).toBe('x');
    expect(M.questionOf({}, [])).toBeNull();
  });
});

describe('Earlier tray storage', () => {
  const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) }; };
  it('keeps entries newest first, replacing by id, capped', () => {
    const e = createEarlier(mem(), 'k', 3);
    e.add({ id: 'a', title: 'A', state: 'cleared', at: 1 }); e.add({ id: 'b', title: 'B', state: 'expired', at: 2 }); e.add({ id: 'a', title: 'A2', state: 'withdrawn', at: 3 });
    expect(e.list().map((x) => `${x.id}:${x.state}`)).toEqual(['a:withdrawn', 'b:expired']);
    e.add({ id: 'c', at: 4 }); e.add({ id: 'd', at: 5 });
    expect(e.list().map((x) => x.id)).toEqual(['d', 'c', 'a']);
    expect(e.list()[0].state).toBe('cleared');
  });
  it('clears everything but open items, changes state, counts missed', () => {
    const e = createEarlier(mem());
    e.add({ id: 'o', state: 'open', at: 10 }); e.add({ id: 'x', state: 'expired', at: 20 }); e.add({ id: 'c', state: 'cleared', at: 30 });
    expect(e.missed(0)).toBe(2); expect(e.missed(15)).toBe(1);
    e.setState('o', 'answered', 40); expect(e.list().find((x) => x.id === 'o').state).toBe('answered');
    e.add({ id: 'o2', state: 'open' }); e.clear();
    expect(e.list().map((x) => x.id)).toEqual(['o2']);
  });
  it('survives storage that throws or holds junk', () => {
    const bad = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
    const e = createEarlier(bad);
    expect(e.add({ id: 'a' })).toEqual([]); expect(e.list()).toEqual([]); expect(e.clear()).toEqual([]);
    const junk = mem(); junk.setItem('phase.earlier', '{"not":"a list"}');
    expect(createEarlier(junk).list()).toEqual([]);
  });
});

describe('captions, capsule and the reference states', () => {
  it('truncates a caption by measured length with an ellipsis', () => {
    expect(M.fitText('Short', 100, (s) => s.length * 10)).toBe('Short');
    expect(M.fitText('Q4 planning with platform + data teams', 260, (s) => s.length * 10)).toBe('Q4 planning with platform…');
    setMeasure((t) => t.length * 13);
    expect(fitCaption('Q4 planning with platform + data teams', 'bottom').endsWith('…')).toBe(true);
    expect(fitCaption('Design review', 'bottom')).toBe('DESIGN REVIEW');
  });
  it('fits capsule segments to their labels and marks hold segments', () => {
    setMeasure((t) => t.length * 10);
    const w = segWidths(['ON MY WAY', 'SNOOZE', 'CALL']);
    expect(w.reduce((a, b) => a + b, 0)).toBe(296); expect(w[0]).toBeGreaterThan(w[1]); expect(w[1]).toBeGreaterThan(w[2]);
    expect(capsule({ top: 322, segs: [{ label: 'Send', act: 'x', hold: true }, { label: 'No', act: 'y' }] })).toContain('data-hold="HOLD TO SEND"');
  });
  it('builds all 28 board states with token colours only', () => {
    expect(STATES.length).toBe(28); expect(new Set(STATE_IDS).size).toBe(28);
    for (const id of STATE_IDS) {
      const html = compose(buildState(id));
      expect(html.length).toBeGreaterThan(500);
      expect(html.replace(/href="#ph(Top|Bot)"/g, '')).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(/);
    }
  });
});

describe('time formats', () => {
  it('formats 12-hour times, timers and lengths', () => {
    expect(hmA(at(16, 37), TZ)).toBe('4:37 PM'); expect(hm(at(0, 5), TZ)).toBe('12:05');
    expect(timer(3)).toBe('00:03'); expect(timer(47 * 60 + 12, true)).toBe('00:47:12');
    expect(lengthText(47 * 60 + 12)).toBe('47 MIN 12 S'); expect(shortHour(1320)).toBe('10P'); expect(shortHour(390)).toBe('6:30A');
  });
  it('knows quiet hours and when they end', () => {
    expect(M.isQuiet(at(23, 0), TZ)).toBe(true); expect(M.isQuiet(at(6, 59), TZ)).toBe(true); expect(M.isQuiet(at(7, 0), TZ)).toBe(false);
    expect(M.isQuiet(at(23, 0), TZ, { on: false, start: 1320, end: 420 })).toBe(false);
    expect(hmA(M.quietEndsAt(at(23, 42), TZ), TZ)).toBe('7:00 AM');
    expect(zparts(M.quietEndsAt(at(23, 42), TZ), TZ).d).toBe(6);
  });
});

describe('E100 Moment fields from the bus', () => {
  it('weight wins over level; level alone still maps', () => {
    expect(M.momentFromEvent({ id: 'e', kind: 'event', title: 't', level: 'info', weight: 'notice' }).weight).toBe('notice');
    expect(M.momentFromEvent({ id: 'e', kind: 'event', title: 't', level: 'attention', weight: 'decision' }).weight).toBe('decision');
    expect(M.momentFromEvent({ id: 'e', kind: 'event', title: 't', level: 'attention' }).weight).toBe('decision');
  });
  it('the bus-resolved action kind drives tap versus hold', () => {
    const m = M.momentFromEvent({ id: 'e', kind: 'event', title: 't', level: 'urgent', actions: [
      { id: 'a', label: 'Dismiss', kind: 'tap' }, { id: 'b', label: 'Cancel', kind: 'hold' }, { id: 'c', label: 'Tell Kate', kind: 'hold', confirm: { draft: 'Late' } },
    ] });
    expect(m.actions.map((a) => [a.id, a.kind, a.draft])).toEqual([['a', 'tap', null], ['b', 'hold', null], ['c', 'hold', 'Late']]);
  });
  it('reads the bus state and ended_at; a terminal Moment never takes the face, the rim, the day list or the glass', () => {
    const now = at(14, 0);
    const open = ev('open', 15, 0, [16, 0], { state: 'open' });
    const gone = ev('gone', 14, 30, [15, 0], { state: 'withdrawn', ended_at: iso(13, 50), weight: 'urgent' });
    expect(gone).toMatchObject({ state: 'withdrawn', ended: at(13, 50) });
    expect(M.timedMoments([open, gone]).map((m) => m.id)).toEqual(['open']);
    expect(M.nowModel([open, gone], now, TZ).focusId).toBe('open');
    expect(M.nowModel([gone], now, TZ).nothing).toBe(true);
    expect(M.rimMarks([gone], now, TZ).marks).toEqual([]);
    expect(M.dayModel([gone], now, TZ).empty).toBe(true);
    expect(M.alertList([gone], new Map(), now)).toEqual([]);
    expect(M.momentFromEvent({ id: 'x', kind: 'event', title: 't', state: 'bogus' }).state).toBe('open');
  });
  it('files terminal alerts in Earlier with their word and end time; ambient and open ones are not filed', () => {
    const e = (state, weight, extra = {}) => M.momentFromEvent({ id: `e-${state}`, kind: 'event', title: 'Train delayed', weight, level: 'info', state, ended_at: iso(18, 42), ...extra });
    expect(M.earlierEntryOf(e('expired', 'urgent', { level: 'urgent' }), 'urgent')).toMatchObject({ id: 'e-expired', kind: 'urgent', icon: 'urgent', state: 'expired', at: at(18, 42) });
    expect(M.earlierEntryOf(e('cleared', 'notice'))).toMatchObject({ kind: 'notice', state: 'cleared' });
    expect(M.earlierEntryOf(e('withdrawn', 'decision', { level: 'attention' }))).toMatchObject({ kind: 'decision', state: 'withdrawn' });
    expect(M.earlierEntryOf(e('answered', 'decision', { level: 'attention' }))).toMatchObject({ state: 'answered' });
    expect(M.earlierEntryOf(e('cleared', 'ambient'))).toBeNull();
    expect(M.earlierEntryOf(e('open', 'urgent', { level: 'urgent' }))).toBeNull();
    const words = ['cleared', 'expired', 'withdrawn', 'answered'].map((st) => M.earlierDetail({ state: st, at: at(14, 14) }, TZ));
    expect(words).toEqual(['2:14 PM · cleared', '2:14 PM · expired', '2:14 PM · withdrawn', '2:14 PM · answered']);
    const mem = {}; const tray = createEarlier({ getItem: (k) => mem[k] ?? null, setItem: (k, v) => { mem[k] = v; } });
    tray.add(M.earlierEntryOf(e('expired', 'urgent', { level: 'urgent' })));
    expect(tray.list()[0]).toMatchObject({ state: 'expired', at: at(18, 42) });
  });
});

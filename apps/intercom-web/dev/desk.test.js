import { describe, it, expect } from 'vitest';
import {
  deskStateColor, sessionNeedsYou, deskCounts, statusLines, ringSegments, ageText, listRows, matchNotice, departureView,
  chooseDeskFace, nextFace, quietTone, pickScreen, DESK_COLORS,
} from '../logic.js';
import { render } from '../screens.js';
import { STEPS } from '../demo.js';

const TZ = 'America/New_York';
const NOW = Date.parse('2026-11-03T07:00:00-05:00');
const mins = (m) => new Date(NOW + m * 60000).toISOString();
const train = (leaveInMin, extra = {}) => ({ label: '7:37 train', kind: 'train', leave_at: mins(leaveInMin), train: { number: '814', departs: mins(leaveInMin + 15) }, ...extra });
const ses = (id, state, extra = {}) => ({ id, title: id, state, channel: 'c', since: mins(-4), ...extra });

describe('state to colour', () => {
  it('maps every state and falls back to idle grey', () => {
    expect(deskStateColor('working')).toBe(DESK_COLORS.working);
    expect(deskStateColor('waiting')).toBe('#ffb347');
    expect(deskStateColor('stuck')).toBe('#ef6a5d');
    expect(deskStateColor('finished')).toBe('#c9a14a');
    expect(deskStateColor('idle')).toBe(DESK_COLORS.idle);
    expect(deskStateColor('???')).toBe(DESK_COLORS.idle);
  });
  it('waiting and stuck need you', () => {
    expect(['working', 'waiting', 'stuck', 'idle', 'finished'].map((s) => sessionNeedsYou({ state: s }))).toEqual([false, true, true, false, false]);
  });
});

describe('counts and centre lines', () => {
  it('uses server counts, else derives them', () => {
    expect(deskCounts({ counts: { working: 3, needs_you: 1 }, sessions: [] })).toEqual({ working: 3, needs_you: 1 });
    expect(deskCounts({ sessions: [ses('a', 'working'), ses('b', 'stuck'), ses('c', 'waiting'), ses('d', 'idle')] })).toEqual({ working: 1, needs_you: 2 });
    expect(deskCounts(null)).toEqual({ working: 0, needs_you: 0 });
  });
  it('omits a zero line and says All quiet when nothing is active', () => {
    expect(statusLines({ working: 3, needs_you: 1 }).map((l) => l.text)).toEqual(['3 working', '1 needs you']);
    expect(statusLines({ working: 0, needs_you: 2 }).map((l) => l.text)).toEqual(['2 needs you']);
    expect(statusLines({ working: 2, needs_you: 0 }).map((l) => l.text)).toEqual(['2 working']);
    expect(statusLines({ working: 0, needs_you: 0 }).map((l) => l.text)).toEqual(['All quiet']);
  });
});

describe('ring segments and list', () => {
  it('splits the rim equally with gaps', () => {
    expect(ringSegments(0)).toEqual([]);
    const four = ringSegments(4, 8);
    expect(four).toHaveLength(4);
    const span = four[0].a1 - four[0].a0;
    expect(span).toBeCloseTo(Math.PI / 2 - (8 * Math.PI) / 180, 5);
    expect(four[1].a0 - four[0].a1).toBeCloseTo((8 * Math.PI) / 180, 5);
    const one = ringSegments(1);
    expect(one[0].a1 - one[0].a0).toBeGreaterThan(2 * Math.PI - 0.01);
  });
  it('formats ages', () => {
    expect(ageText(mins(0), NOW)).toBe('now');
    expect(ageText(mins(-4), NOW)).toBe('4m');
    expect(ageText(mins(-125), NOW)).toBe('2h');
    expect(ageText(mins(-60 * 72), NOW)).toBe('3d');
    expect(ageText('nope', NOW)).toBe('');
  });
  it('lists at most five rows with title, state and age', () => {
    const rows = listRows(Array.from({ length: 8 }, (_, i) => ses(`s${i}`, i === 0 ? 'waiting' : 'working')), NOW);
    expect(rows).toHaveLength(5);
    expect(rows[0]).toMatchObject({ title: 's0', sub: 'waiting · 4m', needs: true });
    expect(rows[1].needs).toBe(false);
  });
  it('matches a notice by source or key, otherwise none', () => {
    const items = [{ id: 'n1', source: 'Intercom Build' }, { id: 'n2', key: 'agent:peggy-pool-2:wait' }];
    expect(matchNotice({ id: 'x', title: 'Intercom Build' }, items).id).toBe('n1');
    expect(matchNotice({ id: 'agent:peggy-pool-2', title: 'Other' }, items).id).toBe('n2');
    expect(matchNotice({ id: 'y', title: 'Nothing' }, items)).toBeNull();
    expect(matchNotice(undefined, items)).toBeNull();
  });
});

describe('departure and pressure', () => {
  const v = (dep, at = NOW) => departureView(dep, at, TZ);
  it('shows Leave in N min within an hour, with the pressure colour', () => {
    expect(v(train(45))).toMatchObject({ kind: 'in', text: 'Leave in 45 min', pressure: 'calm' });
    expect(v(train(31)).pressure).toBe('calm');
    expect(v(train(30)).pressure).toBe('amber');
    expect(v(train(10)).pressure).toBe('amber');
    expect(v(train(9.5)).pressure).toBe('red');
    expect(v(train(5)).pressure).toBe('red');
    expect(v(train(4))).toMatchObject({ pressure: 'pulse', text: 'Leave in 4 min' });
    expect(v(train(0.2)).text).toBe('Leave in 1 min');
  });
  it('shows the departure time dimmed beyond an hour', () => {
    expect(v(train(80))).toMatchObject({ kind: 'time', text: 'Leave 8:20', dim: true, pressure: 'calm' });
  });
  it('shows Late in red for ten minutes, then drops', () => {
    expect(v(train(-1))).toMatchObject({ kind: 'late', text: 'Late', pressure: 'late' });
    expect(v(train(-9.5)).kind).toBe('late');
    expect(v(train(-10.5))).toBeNull();
  });
  it('formats the train line and applies a delay', () => {
    expect(v(train(45)).train).toEqual({ text: '8:00 train', delayed: false });
    const d = v(train(45, { delay_min: 6 }));
    expect(d.train).toEqual({ text: '8:06 train', delayed: true });
    expect(d.text).toBe('Leave in 51 min');
  });
  it('has no train line for events and nothing without a departure', () => {
    expect(v({ label: 'Dentist', kind: 'event', leave_at: mins(20) }).train).toBeNull();
    expect(v(null)).toBeNull();
    expect(v({ kind: 'train', leave_at: 'bad' })).toBeNull();
  });
});

describe('face choice and quiet gating', () => {
  it('quiet hours replace both faces; otherwise the chosen face stays', () => {
    expect(chooseDeskFace({ quiet: true, preferred: 'status' })).toBe('quiet');
    expect(chooseDeskFace({ quiet: true, preferred: 'day' })).toBe('quiet');
    expect(chooseDeskFace({ quiet: false, preferred: 'status' })).toBe('status');
    expect(chooseDeskFace({})).toBe('day');
    expect(chooseDeskFace({ preferred: 'junk' })).toBe('day');
    expect(nextFace('day')).toBe('status');
    expect(nextFace('status')).toBe('day');
  });
  it('picks the colour: stuck red, needs amber, notice brass, calm teal; brighter when something needs you', () => {
    const calm = quietTone({});
    expect(calm).toMatchObject({ color: '#5fc0b3', name: 'calm' });
    expect(quietTone({ notes: 1 }).name).toBe('notice');
    expect(quietTone({ counts: { working: 1, needs_you: 1 } }).name).toBe('needs');
    expect(quietTone({ attention: 1 }).name).toBe('needs');
    expect(quietTone({ stuck: true, counts: { working: 0, needs_you: 1 } }).name).toBe('stuck');
    expect(calm.alpha).toBeLessThanOrEqual(0.12);
    expect(quietTone({ notes: 1 }).alpha).toBeLessThanOrEqual(0.12);
    expect(quietTone({ stuck: true }).alpha).toBeLessThanOrEqual(0.2);
  });
  it('desk faces never outrank notices or replies', () => {
    const c = { paired: true, quiet: false };
    expect(pickScreen({ ...c, needs: true })).toBe('needs');
    expect(pickScreen({ ...c, reply: true })).toBe('reply');
    expect(pickScreen({ ...c })).toBe('idle');
    expect(pickScreen({ ...c, quiet: true })).toBe('quiet');
  });
});

describe('rendering', () => {
  const desk = { sessions: [ses('a', 'waiting', { title: 'Intercom Build' }), ses('b', 'working'), ses('c', 'idle')], counts: { working: 1, needs_you: 1 } };
  it('status face shows the counts and a segment per session, with no message text', () => {
    const h = render('status', { desk, now: new Date(NOW) });
    expect(h).toContain('1 working');
    expect(h).toContain('1 needs you');
    expect((h.match(/<path /g) || []).length).toBe(3);
    expect(h).toContain('class="breathe"');
  });
  it('status face says All quiet and does not breathe when idle', () => {
    const h = render('status', { desk: { sessions: [], counts: { working: 0, needs_you: 0 } }, now: new Date(NOW) });
    expect(h).toContain('All quiet');
    expect(h).not.toContain('breathe');
  });
  it('status list shows titles and opens a notice only for rows that have one', () => {
    const h = render('status', { desk, now: new Date(NOW), list: true, noticeFor: (s) => s.id === 'a' });
    expect(h).toContain('Intercom Build');
    expect(h).toContain('waiting · 4m');
    expect(h).toContain('data-act="session" data-id="a"');
    expect(render('status', { desk, now: new Date(NOW), list: true })).not.toContain('data-act');
  });
  it('quiet face has no text at all', () => {
    const h = render('quiet', { tone: quietTone({ counts: { working: 0, needs_you: 1 } }) });
    expect(h.replace(/<[^>]+>/g, '').trim()).toBe('');
    expect(h).toContain('#ffb347');
  });
  it('day face replaces the date with the leave line and adds the train line and rim colour', () => {
    const events = [];
    const dep = departureView(train(14, { delay_min: 5 }), NOW, TZ);
    const h = render('idle', { events, now: new Date(NOW), tz: TZ, departure: dep });
    expect(h).toContain('Leave in 19 min');
    expect(h).toContain('trainline delayed');
    expect(h).toContain('7:34 train');
    expect(h).toContain('stroke="#ffb347" stroke-width="6"'); // 19 min: amber rim
    expect(h).not.toContain('NOV');
    const plain = render('idle', { events, now: new Date(NOW), tz: TZ });
    expect(plain).toContain('NOV');
    expect(plain).not.toContain('trainline');
  });
  it('renders every demo step', () => {
    for (const s of STEPS) expect(render(s.name, s.props(0))).toBeTruthy();
  });
});

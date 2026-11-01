import { describe, it, expect } from 'vitest';
import { hourToAngle, polar, arcPath, daySpans, assignLanes, nextEvent, clockText, backoffDelay, glanceOf, parsePairInput, replyIsFresh, Outbox, shortTime } from '../logic.js';
import { IntercomSocket } from '../socket.js';

const TZ = 'America/New_York';
const ev = (id, s, e, extra = {}) => ({ id, title: id, start: `2026-11-02T${s}:00-05:00`, end: `2026-11-02T${e}:00-05:00`, all_day: false, ...extra });
const NOW = new Date('2026-11-02T07:52:00-05:00');

describe('geometry', () => {
  it('puts midnight at the top and 6h at the right', () => {
    const [x0, y0] = polar(0, 100); expect(Math.round(x0)).toBe(233); expect(Math.round(y0)).toBe(133);
    const [x6, y6] = polar(6, 100); expect(Math.round(x6)).toBe(333); expect(Math.round(y6)).toBe(233);
    expect(hourToAngle(12)).toBeCloseTo(Math.PI / 2);
  });
  it('uses the large-arc flag past 12 hours', () => {
    expect(arcPath(1, 5)).toMatch(/ 0 0 1 /);
    expect(arcPath(1, 15)).toMatch(/ 0 1 1 /);
  });
});

describe('calendar selection', () => {
  const events = [ev('b', '12:30', '14:30'), ev('a', '07:00', '09:00'), ev('c', '13:00', '13:30'), { id: 'ad', title: 'Holiday', all_day: true, start: '2026-11-02T00:00:00-05:00', end: '2026-11-03T00:00:00-05:00' }];
  it('splits all-day from timed and sorts', () => {
    const { timed, allDay } = daySpans(events, NOW, TZ);
    expect(timed.map((t) => t.id)).toEqual(['a', 'b', 'c']);
    expect(allDay).toHaveLength(1);
    expect(timed[0].startH).toBe(7);
  });
  it('clamps events crossing midnight and drops other days', () => {
    const e = [{ id: 'x', title: 'x', start: '2026-11-01T23:00:00-05:00', end: '2026-11-02T01:00:00-05:00' }, { id: 'y', title: 'y', start: '2026-11-05T09:00:00-05:00', end: '2026-11-05T10:00:00-05:00' }];
    const { timed } = daySpans(e, NOW, TZ);
    expect(timed).toHaveLength(1); expect(timed[0].startH).toBe(0); expect(timed[0].endH).toBe(1);
  });
  it('puts overlapping events on inner lanes', () => {
    const lanes = assignLanes(daySpans(events, NOW, TZ).timed);
    expect(lanes.map((l) => l.lane)).toEqual([0, 0, 1]);
  });
  it('finds the next event and formats the clock', () => {
    const { timed } = daySpans(events, NOW, TZ);
    expect(nextEvent(timed, NOW, TZ).id).toBe('b');
    expect(nextEvent(timed, new Date('2026-11-02T20:00:00-05:00'), TZ)).toBeNull();
    expect(clockText(NOW, TZ)).toBe('7:52');
    expect(clockText(new Date('2026-11-02T00:05:00-05:00'), TZ)).toBe('12:05');
    expect(shortTime(16.1667)).toBe('4:10');
  });
});

describe('misc', () => {
  it('backs off 0.5s to 10s', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 20].map((n) => backoffDelay(n))).toEqual([500, 1000, 2000, 4000, 8000, 10000, 10000, 10000]);
    expect(backoffDelay(5, () => 1)).toBe(8000);
  });
  it('derives a glance', () => {
    expect(glanceOf({ glance: 'Hi there', body: 'x' })).toBe('Hi there');
    expect(glanceOf({ body: 'First sentence. Second one.' })).toBe('First sentence.');
    expect(glanceOf({ body: 'word '.repeat(60) }).length).toBeLessThanOrEqual(101);
  });
  it('parses pairing input', () => {
    expect(parsePairInput(' abc123 ')).toBe('abc123');
    expect(parsePairInput('https://x.ts.net/intercom/#pair=ABC-9')).toBe('ABC-9');
  });
  it('treats old replayed replies as stale', () => {
    const now = Date.parse('2026-11-02T10:00:00Z');
    expect(replyIsFresh({ created_at: '2026-11-02T09:59:30Z' }, now)).toBe(true);
    expect(replyIsFresh({ created_at: '2026-11-02T09:00:00Z' }, now)).toBe(false);
  });
});

describe('outbox', () => {
  it('keeps unacked sends with stable ids until acked', () => {
    let n = 0;
    const o = new Outbox([], () => `id${++n}`);
    const a = o.add('one'); o.add('two');
    expect(o.pending().map((i) => i.client_msg_id)).toEqual(['id1', 'id2']);
    expect(o.pending()[0].client_msg_id).toBe(a.client_msg_id);
    expect(o.ack('id1')).toBe(true); expect(o.ack('id1')).toBe(false);
    expect(o.size).toBe(1);
  });
});

describe('socket', () => {
  class FakeWS {
    static last; constructor() { FakeWS.last = this; this.readyState = 1; this.sent = []; }
    send(s) { this.sent.push(JSON.parse(s)); } close() {}
  }
  const timers = { setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {} };
  it('says hello, resends the outbox after welcome, tracks cursor and answers ping', () => {
    const events = []; const states = [];
    const s = new IntercomSocket({ token: 'tok', url: 'ws://x', WS: FakeWS, timers, handlers: { onState: (x) => states.push(x), onEvent: (n, d, q) => events.push([n, q]) } });
    s.cursor = 0; s.outbox.items = [{ client_msg_id: 'm1', body: 'hi' }];
    s.connect(); const ws = FakeWS.last; ws.onopen();
    expect(ws.sent[0]).toMatchObject({ type: 'hello', token: 'tok', cursor: 0 });
    ws.onmessage({ data: JSON.stringify({ type: 'welcome', latest_seq: 3, reset: false }) });
    expect(ws.sent[1]).toEqual({ type: 'send', client_msg_id: 'm1', body: 'hi' });
    ws.onmessage({ data: JSON.stringify({ type: 'event', event: 'reply', seq: 5, data: {} }) });
    expect(s.cursor).toBe(5);
    ws.onmessage({ data: JSON.stringify({ type: 'ping' }) });
    expect(ws.sent.at(-1)).toEqual({ type: 'pong' });
    ws.onmessage({ data: JSON.stringify({ type: 'ack', client_msg_id: 'm1', status: 'queued' }) });
    expect(s.outbox.size).toBe(0);
    expect(states).toContain('online');
  });
  it('flags 4401 as unauthorized without retrying', () => {
    let unauth = 0;
    const s = new IntercomSocket({ token: 't', url: 'ws://x', WS: FakeWS, timers, handlers: { onUnauthorized: () => unauth++ } });
    s.connect(); FakeWS.last.onclose({ code: 4401 });
    expect(unauth).toBe(1); expect(s.stopped).toBe(true);
  });
});

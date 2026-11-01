import { describe, it, expect } from 'vitest';
import { applyNotification, activeItems, needsList, infoList, attentionLevel, cycleId, isQuietHours, waitingCount, pickScreen, needsLayout, isAckLabel, needsMore, Outbox, frameOf } from '../logic.js';
import { IntercomSocket } from '../socket.js';
import { needs } from '../screens.js';

const n = (id, level = 'attention', extra = {}) => ({ id, title: id, level, state: 'active', actions: [], updated_at: '2026-11-02T10:00:00Z', ...extra });

describe('notification map', () => {
  it('stores, updates and drops terminal states; ignores stale updates', () => {
    const m = new Map();
    applyNotification(m, n('a'));
    applyNotification(m, n('a', 'urgent', { updated_at: '2026-11-02T10:05:00Z' }));
    expect(m.get('a').level).toBe('urgent');
    expect(applyNotification(m, n('a', 'info', { updated_at: '2026-11-02T09:00:00Z' }))).toBe(false);
    expect(m.get('a').level).toBe('urgent');
    applyNotification(m, n('a', 'urgent', { state: 'resolved' }));
    expect(m.size).toBe(0);
    applyNotification(m, n('b', 'info', { state: 'expired' }));
    expect(m.size).toBe(0);
  });
});

describe('active items and attention', () => {
  const m = new Map();
  [n('i', 'info'), n('a', 'attention', { updated_at: '2026-11-02T10:01:00Z' }), n('u', 'urgent', { updated_at: '2026-11-02T09:00:00Z' }),
    n('k', 'attention', { state: 'acknowledged' }), n('x', 'attention', { expires_at: '2026-11-02T10:02:00Z' })].forEach((i) => m.set(i.id, i));
  const now = Date.parse('2026-11-02T10:03:00Z');
  it('lists active only, urgent first, then newest; hides expired', () => {
    expect(activeItems(m, now).map((i) => i.id)).toEqual(['u', 'a', 'i']);
  });
  it('hides locally acknowledged items', () => {
    expect(activeItems(m, now, new Map([['u', '']])).map((i) => i.id)).toEqual(['a', 'i']);
  });
  it('splits needs from info and finds the level', () => {
    const items = activeItems(m, now);
    expect(needsList(items).map((i) => i.id)).toEqual(['u', 'a']);
    expect(infoList(items).map((i) => i.id)).toEqual(['i']);
    expect(attentionLevel(items)).toBe('urgent');
    expect(attentionLevel(infoList(items))).toBe('info');
    expect(attentionLevel([])).toBe('none');
  });
  it('counts waiting from the server, less local acks', () => {
    const items = activeItems(m, now);
    expect(waitingCount({ level: 'urgent', count: 3 }, items)).toBe(3);
    expect(waitingCount({ level: 'urgent', count: 3 }, items, new Map([['u', '']]))).toBe(2);
    expect(waitingCount(null, items)).toBe(3);
  });
});

describe('cycling', () => {
  const l = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  it('wraps both ways and recovers from an unknown id', () => {
    expect(cycleId(l, 'a', 1)).toBe('b');
    expect(cycleId(l, 'c', 1)).toBe('a');
    expect(cycleId(l, 'a', -1)).toBe('c');
    expect(cycleId(l, 'zzz', 1)).toBe('a');
    expect(cycleId([], 'a')).toBeNull();
  });
});

describe('quiet hours', () => {
  const at = (hhmm) => new Date(`2026-11-02T${hhmm}:00-05:00`);
  const TZ = 'America/New_York';
  it('covers 22:00 to 06:30 across midnight', () => {
    expect(isQuietHours(at('21:59'), TZ)).toBe(false);
    expect(isQuietHours(at('22:00'), TZ)).toBe(true);
    expect(isQuietHours(at('00:00'), TZ)).toBe(true);
    expect(isQuietHours(at('06:29'), TZ)).toBe(true);
    expect(isQuietHours(at('06:30'), TZ)).toBe(false);
    expect(isQuietHours(at('12:00'), TZ)).toBe(false);
  });
});

describe('screen priority', () => {
  const base = { paired: true };
  it('follows the contract order', () => {
    expect(pickScreen({ paired: false, reply: true })).toBe('pairing');
    expect(pickScreen({ ...base, offline: true, reply: true })).toBe('offline');
    expect(pickScreen({ ...base, listening: true, reply: true })).toBe('listening');
    expect(pickScreen({ ...base, reply: true, ownWorking: true, needs: true })).toBe('reply');
    expect(pickScreen({ ...base, ownWorking: true, needs: true })).toBe('working');
    expect(pickScreen({ ...base, needs: true, otherWorking: true })).toBe('needs');
    expect(pickScreen({ ...base, otherWorking: true })).toBe('working');
    expect(pickScreen({ ...base })).toBe('idle');
  });
  it('never glows while quiet', () => {
    expect(pickScreen({ ...base, needs: true, quiet: true })).toBe('quiet');
    expect(pickScreen({ ...base, quiet: true })).toBe('quiet');
    expect(pickScreen({ ...base, reply: true, quiet: true })).toBe('reply');
  });
});

describe('needs screen buttons and expansion', () => {
  const html = (item, extra = {}) => needs({ item: { level: 'attention', ...item }, ...extra });
  const count = (h, act) => (h.match(new RegExp(`data-act="${act}"`, 'g')) || []).length;
  it('matches Got it labels loosely', () => {
    expect(isAckLabel(' got IT ')).toBe(true);
    expect(isAckLabel('Got it!')).toBe(false);
  });
  it('adds one automatic Got it unless an action already is one', () => {
    const dup = html({ title: 'T', actions: [{ label: 'Got it', style: 'success' }, { label: 'Dismiss' }] });
    expect(count(dup, 'ack')).toBe(0);
    expect(count(dup, 'action')).toBe(2);
    const plain = html({ title: 'T', actions: [{ label: 'Snooze' }] });
    expect(count(plain, 'ack')).toBe(1);
  });
  it('shows Tap to read only when text is probably cut off', () => {
    expect(html({ title: 'ENT', body: 'Leave by 3:45' })).not.toContain('Tap to read');
    const long = html({ title: 'ENT', body: 'Morning test of the dial with a long message' });
    expect(long).toContain('Tap to read');
    expect(long).toContain('data-act="expand"');
    expect(needsMore({ title: 'x'.repeat(40) })).toBe(true);
  });
  it('expanded view carries full text, buttons and a way back', () => {
    const body = 'Morning test of the dial with a long message\nsecond line';
    const h = html({ title: 'ENT', body, actions: [{ label: 'Snooze' }] }, { expanded: true });
    expect(h).toContain('data-scroller');
    expect(h).toContain('second line');
    expect(h).not.toContain('Tap to read');
    expect(count(h, 'action')).toBe(1);
    expect(count(h, 'ack')).toBe(1);
    expect(count(h, 'collapse')).toBe(2);
  });
});

describe('layout and frames', () => {
  it('stacks short titles with two buttons, otherwise a grid', () => {
    expect(needsLayout({ title: 'ENT at 4:10', actions: [{ label: 'a' }] }, 1)).toBe('stack');
    expect(needsLayout({ title: 'ENT at 4:10', actions: [{}, {}] }, 1)).toBe('grid');
    expect(needsLayout({ title: 'A much longer title here', actions: [] }, 1)).toBe('grid');
  });
  it('builds action frames and keeps them in the outbox until acked', () => {
    let k = 0; const o = new Outbox([], () => `id${++k}`);
    const a = o.addAction('n1', 1, 1000); o.add('hi');
    expect(frameOf(a)).toEqual({ type: 'notification_action', client_msg_id: 'id1', id: 'n1', index: 1 });
    expect(frameOf(o.pending()[1])).toEqual({ type: 'send', client_msg_id: 'id2', body: 'hi' });
    expect(o.dropActions(600000, 1000 + 700000)).toBe(1);
    expect(o.size).toBe(1);
  });
  it('socket resends a queued action after welcome and routes notification events', () => {
    class FakeWS { constructor() { FakeWS.last = this; this.readyState = 1; this.sent = []; } send(s) { this.sent.push(JSON.parse(s)); } close() {} }
    const timers = { setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {} };
    const ev = [];
    const s = new IntercomSocket({ token: 't', url: 'ws://x', WS: FakeWS, timers, handlers: { onEvent: (nm, d) => ev.push(nm) } });
    s.outbox.items = [{ client_msg_id: 'q1', kind: 'action', id: 'n9', index: 0, at: Date.now() }];
    s.connect(); const ws = FakeWS.last; ws.onopen();
    ws.onmessage({ data: JSON.stringify({ type: 'welcome', latest_seq: 0 }) });
    expect(ws.sent[1]).toEqual({ type: 'notification_action', client_msg_id: 'q1', id: 'n9', index: 0 });
    ws.onmessage({ data: JSON.stringify({ type: 'event', event: 'notification', data: n('z') }) });
    ws.onmessage({ data: JSON.stringify({ type: 'event', event: 'attention', data: { level: 'attention', count: 1 } }) });
    expect(ev).toEqual(['notification', 'attention']);
    expect(s.ackNotification('z')).toBe(true);
    expect(ws.sent.at(-1)).toEqual({ type: 'notification_ack', id: 'z' });
    ws.onmessage({ data: JSON.stringify({ type: 'error', code: 'notification_not_found' }) });
    expect(s.outbox.size).toBe(0);
  });
});

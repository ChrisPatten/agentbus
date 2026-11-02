import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { runMigrations } from '../db/schema.js';
import { IntercomAdapterSchema } from '../config/schema.js';
import type { CalendarEvent, CalendarFeed } from './calendar.js';
import {
  buildDeparture, buildDeskPayload, classifyPane, collectDeskSessions, DEFAULT_COMMUTE_FILE, deskCounts, deskSignature, isCommuteDay,
  loadCommute, parseCommute, sortSessions, type CommuteConfig, type DeskSession, type PaneFacts,
} from './desk.js';
import { IntercomService, type Client } from './service.js';

const NOW_MS = Date.parse('2026-11-03T12:00:00Z'); // Tuesday
const base: PaneFacts = { leaseState: 'leased', hasConversation: true, incidentSince: null, waitingSince: null, unhandledSince: null, lastTurnEndedAt: null, lastActivityAt: '2026-11-03T10:00:00Z', leasedAt: '2026-11-03T09:00:00Z' };

describe('classifyPane', () => {
  it('maps pane facts to a state', () => {
    expect(classifyPane({ ...base, leaseState: 'free' }, NOW_MS)).toBeNull();
    expect(classifyPane({ ...base, leaseState: 'dead' }, NOW_MS)?.state).toBe('stuck');
    expect(classifyPane({ ...base, leaseState: 'dead', hasConversation: false }, NOW_MS)).toBeNull();
    expect(classifyPane({ ...base, incidentSince: 'i', waitingSince: 'w', unhandledSince: 'u' }, NOW_MS)).toEqual({ state: 'stuck', since: 'i' });
    expect(classifyPane({ ...base, waitingSince: 'w', unhandledSince: 'u' }, NOW_MS)).toEqual({ state: 'waiting', since: 'w' });
    expect(classifyPane({ ...base, unhandledSince: 'u' }, NOW_MS)).toEqual({ state: 'working', since: 'u' });
    expect(classifyPane({ ...base, leaseState: 'launching' }, NOW_MS)?.state).toBe('working');
  });
  it('finished within ten minutes of a turn end, idle after', () => {
    expect(classifyPane({ ...base, lastTurnEndedAt: '2026-11-03T11:55:00Z' }, NOW_MS)).toEqual({ state: 'finished', since: '2026-11-03T11:55:00Z' });
    expect(classifyPane({ ...base, lastTurnEndedAt: '2026-11-03T11:40:00Z' }, NOW_MS)?.state).toBe('idle');
    expect(classifyPane({ ...base, leaseState: 'draining' }, NOW_MS)?.state).toBe('idle');
  });
});

describe('sessions and counts', () => {
  const s = (id: string, state: DeskSession['state'], since = '2026-11-03T10:00:00Z'): DeskSession => ({ id, title: id, state, channel: 'c', since });
  it('sorts needs-you first and counts waiting plus stuck as needs_you', () => {
    const list = [s('i', 'idle'), s('w', 'working'), s('a', 'waiting'), s('x', 'stuck'), s('f', 'finished'), s('w2', 'working')];
    expect(sortSessions(list).map((x) => x.id)).toEqual(['x', 'a', 'w', 'w2', 'f', 'i']);
    expect(deskCounts(list)).toEqual({ working: 2, needs_you: 2 });
  });
  it('counts all sessions even when the list is capped at 12', () => {
    const many = Array.from({ length: 15 }, (_, i) => s(`s${i}`, 'working'));
    const p = buildDeskPayload({ now: new Date(NOW_MS), sessions: many, departure: null });
    expect(p.sessions).toHaveLength(12);
    expect(p.counts.working).toBe(15);
  });
  it('signature ignores generated_at', () => {
    const a = buildDeskPayload({ now: new Date(1), sessions: [], departure: null });
    const b = buildDeskPayload({ now: new Date(99999), sessions: [], departure: null });
    expect(deskSignature(a)).toBe(deskSignature(b));
  });
});

const COMMUTE: CommuteConfig = {
  timezone: 'America/New_York', buffer_min: 5, am_travel_min: 10, pm_travel_min: 25, holidays: ['2026-11-26'],
  am: [{ number: '814', departs: '07:01' }, { number: '818', departs: '07:42' }],
  pm: [{ number: '867', departs: '17:37' }],
};
const at = (hhmm: string, day = '2026-11-03') => new Date(`${day}T${hhmm}:00-05:00`);
const ev = (over: Partial<CalendarEvent>): CalendarEvent => ({ id: 'e', title: 'Dentist', start: '2026-11-03T16:00:00-05:00', end: '2026-11-03T17:00:00-05:00', all_day: false, calendar: 'Home', color: '#fff', ...over });
const dep = (now: Date, events: CalendarEvent[] = [], commute: CommuteConfig | null = COMMUTE) =>
  buildDeparture({ now, commute, events, eventTravelMin: 20, tz: 'America/New_York' });

describe('train selection', () => {
  it('computes leave_at as departure minus travel minus buffer', () => {
    const d = dep(at('06:00'))!;
    expect(d.kind).toBe('train');
    expect(d.label).toBe('7:01 train');
    expect(d.train).toEqual({ number: '814', departs: '2026-11-03T07:01:00-05:00' });
    expect(d.leave_at).toBe('2026-11-03T06:46:00-05:00');
  });
  it('moves to the next train once the late grace has passed', () => {
    expect(dep(at('06:50'))!.train!.number).toBe('814'); // 4 min past leave, still within the 10 minute grace
    expect(dep(at('06:57'))!.train!.number).toBe('818');
  });
  it('uses the PM list with the longer walk after the AM trains', () => {
    const d = dep(at('12:00'))!;
    expect(d.train!.number).toBe('867');
    expect(d.leave_at).toBe('2026-11-03T17:07:00-05:00');
  });
  it('returns null after the last train, on weekends and on holidays', () => {
    expect(dep(at('17:30'))).toBeNull();
    expect(dep(at('06:00', '2026-11-07'))).toBeNull();
    expect(dep(at('06:00', '2026-11-26'))).toBeNull();
    expect(isCommuteDay(COMMUTE, at('06:00', '2026-11-03'))).toBe(true);
    expect(isCommuteDay(COMMUTE, at('06:00', '2026-11-08'))).toBe(false);
  });
});

describe('event departure', () => {
  it('subtracts default travel and buffer from a located event', () => {
    const d = dep(at('10:00', '2026-11-07'), [ev({ start: '2026-11-07T16:00:00-05:00', location: 'ENT Specialists, Plainville, MA' })])!;
    expect(d.kind).toBe('event');
    expect(d.label).toBe('Dentist');
    expect(d.leave_at).toBe('2026-11-07T15:35:00-05:00');
  });
  it('ignores events with no location, virtual locations, all-day and started events', () => {
    const now = at('10:00', '2026-11-07');
    const mk = (o: Partial<CalendarEvent>) => dep(now, [ev({ start: '2026-11-07T16:00:00-05:00', ...o })]);
    expect(mk({})).toBeNull();
    expect(mk({ location: 'https://zoom.us/j/1' })).toBeNull();
    expect(mk({ location: 'Microsoft Teams Meeting' })).toBeNull();
    expect(mk({ location: 'Home', all_day: true })).toBeNull();
    expect(mk({ location: 'Somewhere', start: '2026-11-07T09:00:00-05:00' })).toBeNull();
  });
  it('picks the earliest leave time between a train and an event', () => {
    const d = dep(at('06:00'), [ev({ start: '2026-11-03T07:00:00-05:00', location: 'Walpole, MA' })])!;
    expect(d.kind).toBe('event'); // 06:35 beats the 06:46 train
  });
});

describe('commute file', () => {
  it('drops malformed trains and rejects an empty timetable', () => {
    expect(parseCommute({ am: [{ number: '1', departs: '7:01' }, { number: '2', departs: '07:01' }], pm: [] })?.am).toHaveLength(1);
    expect(parseCommute({ am: [], pm: [] })).toBeNull();
    expect(parseCommute(null)).toBeNull();
  });
  it('ships a timetable matching the reference commute file', () => {
    const c = loadCommute()!;
    expect(c.am.map((t) => t.number)).toEqual(['814', '818', '824']);
    expect(c.pm.map((t) => t.number)).toEqual(['847', '851', '855', '857', '861', '867', '871']);
    expect(c.pm.find((t) => t.number === '867')!.departs).toBe('17:37');
    expect(c.holidays).toContain('2026-11-26');
    expect(JSON.parse(readFileSync(DEFAULT_COMMUTE_FILE, 'utf8')).buffer_min).toBe(5);
  });
  it('returns null for a missing file', () => {
    const log = vi.fn();
    expect(loadCommute('/nonexistent/commute.json', log)).toBeNull();
    expect(log).toHaveBeenCalled();
  });
});

describe('collectDeskSessions', () => {
  let db: Database.Database;
  const lease = (o: Record<string, unknown>) => ({
    pool_id: 'agent:peggy', pane_id: 'p:1', agent_id: 'agent:peggy-pool-1', conversation_id: 'conv1', claude_session_id: null, state: 'leased',
    leased_at: '2026-11-03T09:00:00Z', last_activity_at: '2026-11-03T10:00:00Z', last_turn_ended_at: null, model: null, ...o,
  });
  const pools = (rows: unknown[]) => [{ poolId: 'agent:peggy', leaseStore: { list: () => rows as never } }];
  beforeEach(() => {
    db = new Database(':memory:'); runMigrations(db);
    db.prepare(`INSERT INTO conversation_registry(id,contact_id,channel,topic,first_seen,last_seen) VALUES ('conv1','chris','telegram:peggy','thread:abc','a','b')`).run();
    db.prepare(`INSERT INTO threads(channel,topic,thread_key,metadata,updated_at) VALUES ('telegram:peggy','thread:abc','k','{"topicName":"Intercom Build"}','x')`).run();
  });
  it('titles a session from the topic name, never message text', () => {
    const out = collectDeskSessions(db, pools([lease({ last_turn_ended_at: new Date(NOW_MS - 60_000).toISOString() })]), NOW_MS);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 'agent:peggy-pool-1', title: 'Intercom Build', channel: 'telegram:peggy', state: 'finished' });
    expect(Object.keys(out[0]!).sort()).toEqual(['channel', 'id', 'since', 'state', 'title']);
  });
  it('skips free panes and falls back to the channel when no name is stored', () => {
    db.prepare(`DELETE FROM threads`).run();
    const out = collectDeskSessions(db, pools([lease({}), lease({ pane_id: 'p:2', agent_id: 'agent:peggy-pool-2', state: 'free', conversation_id: null })]), NOW_MS);
    expect(out.map((s) => s.title)).toEqual(['peggy topic']);
    expect(out[0]!.state).toBe('idle');
  });
  it('marks a pane waiting on a pending approval and stuck on an open incident', () => {
    db.prepare(`INSERT INTO approval_requests(id,adapter_id,agent_id,conversation_id,contact_id,tool_name,summary,status,requested_at,expires_at) VALUES ('a1','cc-pool','peggy-pool-1','conv1','chris','Bash','run','pending','2026-11-03T11:00:00Z','2026-11-04T00:00:00Z')`).run();
    expect(collectDeskSessions(db, pools([lease({})]), NOW_MS)[0]).toMatchObject({ state: 'waiting', since: '2026-11-03T11:00:00Z' });
    db.prepare(`INSERT INTO pane_incidents(id,pool_id,pane_id,conversation_id,class,detected_at,screen_snapshot,actions) VALUES ('i1','agent:peggy','p:1','conv1','frozen_turn','2026-11-03T11:30:00Z','','[]')`).run();
    expect(collectDeskSessions(db, pools([lease({})]), NOW_MS)[0]!.state).toBe('stuck');
  });
});

describe('IntercomService desk feed', () => {
  const calendar = { today: async () => ({ date: '2026-11-03', tz: 'America/New_York', generated_at: 'x', events: [] }) } as unknown as CalendarFeed;
  function build(sessions: () => DeskSession[]) {
    const db = new Database(':memory:'); runMigrations(db);
    const config = IntercomAdapterSchema.parse({ surfaces: [{ id: 's', token_env: 'T', follow: { contact: 'chris', channel: 'telegram:peggy' } }] });
    return new IntercomService({ config, db, calendar, env: { T: 'a'.repeat(40) }, log: () => {}, commute: COMMUTE, deskSessions: sessions, submitInbound: async () => { throw new Error('unused'); } });
  }
  it('answers desk() and sends a snapshot on attach', async () => {
    let list: DeskSession[] = [{ id: 'x', title: 'Main', state: 'working', channel: 'app', since: '2026-11-03T10:00:00Z' }];
    const service = build(() => list);
    const p = await service.desk(new Date('2026-11-03T11:00:00Z'));
    expect(p.counts).toEqual({ working: 1, needs_you: 0 });
    expect(p.departure?.kind).toBe('train');
    const frames: any[] = [];
    const client: Client = { socket: { readyState: 1, send: (d: string) => frames.push(JSON.parse(d)), close: vi.fn() }, surface: service.surfaces.get('s')!, ready: false, cursor: 0, lastPong: Date.now() };
    await service.attach(client, 0);
    const desk = frames.find((f) => f.event === 'desk');
    expect(desk.data.sessions[0].title).toBe('Main');
    list = [];
  });
  it('pushes desk on change only, at most once per 5 s check', async () => {
    vi.useFakeTimers();
    try {
      let list: DeskSession[] = [];
      const service = build(() => list);
      const frames: any[] = [];
      const client: Client = { socket: { readyState: 1, send: (d: string) => frames.push(JSON.parse(d)), close: vi.fn() }, surface: service.surfaces.get('s')!, ready: false, cursor: 0, lastPong: Date.now() };
      await service.attach(client, 0);
      service.start();
      frames.length = 0;
      await vi.advanceTimersByTimeAsync(5000);
      const first = frames.filter((f) => f.event === 'desk').length;
      await vi.advanceTimersByTimeAsync(15000);
      expect(frames.filter((f) => f.event === 'desk').length).toBe(first); // nothing changed
      list = [{ id: 'x', title: 'T', state: 'waiting', channel: 'c', since: 's' }];
      await vi.advanceTimersByTimeAsync(5000);
      expect(frames.filter((f) => f.event === 'desk').length).toBe(first + 1);
      service.stop();
    } finally { vi.useRealTimers(); }
  });
});

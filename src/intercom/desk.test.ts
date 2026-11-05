import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LivePrediction, LiveSource, StopQuery } from './mbta.js';
import { NotifyInput } from './notifications-store.js';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../db/schema.js';
import { IntercomAdapterSchema } from '../config/schema.js';
import type { CalendarEvent, CalendarFeed } from './calendar.js';
import {
  buildDeparture, buildDeskPayload, liveState, liveTargets, type LiveView, classifyPane, collectDeskSessions, DEFAULT_COMMUTE_FILE, deskCounts, createPlanSource, deskSignature, isOfficeDay,
  loadCommute, parseCommute, parseCommutePlan, sortSessions, type CommutePlan, type CommuteConfig, type DeskSession, type PaneFacts,
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
  timezone: 'America/New_York', holidays: ['2026-11-26'],
  am: [{ number: '6008', departs: '07:01' }, { number: '6010', departs: '07:42' }],
  pm: [{ number: '6027', departs: '16:52' }, { number: '6029', departs: '17:37' }],
};
const PLAN: CommutePlan = { office_days: [2, 4], am_train: '6008', pm_train: null, am_travel_min: 15, pm_travel_min: 30, overrides: [] };
const at = (hhmm: string, day = '2026-11-03') => new Date(`${day}T${hhmm}:00-05:00`);
const ev = (over: Partial<CalendarEvent>): CalendarEvent => ({ id: 'e', title: 'Dentist', start: '2026-11-03T16:00:00-05:00', end: '2026-11-03T17:00:00-05:00', all_day: false, calendar: 'Home', color: '#fff', ...over });
const dep = (now: Date, events: CalendarEvent[] = [], plan: CommutePlan | null = PLAN, commute: CommuteConfig | null = COMMUTE) =>
  buildDeparture({ now, commute, plan });
const withPlan = (o: Partial<CommutePlan>): CommutePlan => ({ ...PLAN, ...o });

describe('train selection', () => {
  it('Tuesday: leave_at is departure minus am_travel_min', () => {
    const d = dep(at('06:00'))!;
    expect(d.kind).toBe('train');
    expect(d.label).toBe('7:01 train');
    expect(d.train).toEqual({ number: '6008', departs: '2026-11-03T07:01:00-05:00' });
    expect(d.leave_at).toBe('2026-11-03T06:46:00-05:00');
  });
  it('Thursday is an office day too', () => {
    expect(dep(at('06:00', '2026-11-05'))!.train!.number).toBe('6008');
  });
  it('keeps the late grace, then shows nothing (no PM train set)', () => {
    expect(dep(at('06:50'))!.train!.number).toBe('6008'); // 4 min past leave, within the 10 minute grace
    expect(dep(at('06:57'))).toBeNull();
  });
  it('Monday is not an office day: no train, and at 2026-11-02 16:24 ET nothing is produced', () => {
    expect(dep(at('06:00', '2026-11-02'))).toBeNull();
    expect(dep(at('16:24', '2026-11-02'))).toBeNull();
    expect(dep(at('16:24', '2026-11-02'), [], withPlan({ pm_train: '6027' }))).toBeNull();
  });
  it('null pm_train yields no PM line; a set pm_train gives one', () => {
    expect(dep(at('12:00'))).toBeNull();
    const d = dep(at('12:00'), [], withPlan({ pm_train: '6027' }))!;
    expect(d.train!.number).toBe('6027');
    expect(d.leave_at).toBe('2026-11-03T16:22:00-05:00'); // 16:52 minus pm_travel_min 30
  });
  it('a wfh override cancels an office day', () => {
    expect(dep(at('06:00'), [], withPlan({ overrides: [{ date: '2026-11-03', mode: 'wfh' }] }))).toBeNull();
  });
  it('an office override adds a day and may pick its own trains', () => {
    const plan = withPlan({ overrides: [{ date: '2026-11-02', mode: 'office', am_train: '6010', pm_train: '6029' }] });
    expect(dep(at('06:00', '2026-11-02'), [], plan)!.train!.number).toBe('6010');
    expect(dep(at('12:00', '2026-11-02'), [], plan)!.train!.number).toBe('6029');
    const dflt = withPlan({ overrides: [{ date: '2026-11-02', mode: 'office' }] });
    expect(dep(at('06:00', '2026-11-02'), [], dflt)!.train!.number).toBe('6008');
  });
  it('an override applies to its own date only', () => {
    const plan = withPlan({ overrides: [{ date: '2026-11-03', mode: 'wfh' }] });
    expect(dep(at('06:00', '2026-11-05'), [], plan)!.train!.number).toBe('6008');
  });
  it('holidays, weekends, a missing plan and an unknown train number give no train', () => {
    expect(dep(at('06:00', '2026-11-26'))).toBeNull();
    expect(dep(at('06:00', '2026-11-26'), [], withPlan({ overrides: [{ date: '2026-11-26', mode: 'office' }] }))).toBeNull();
    expect(dep(at('06:00', '2026-11-07'))).toBeNull();
    expect(dep(at('06:00'), [], null)).toBeNull();
    expect(dep(at('06:00'), [], withPlan({ am_train: '9999' }))).toBeNull();
    expect(isOfficeDay(COMMUTE, PLAN, at('06:00', '2026-11-03'))).toBe(true);
    expect(isOfficeDay(COMMUTE, PLAN, at('06:00', '2026-11-02'))).toBe(false);
  });
  it('calendar entries with a location never produce a leave-by, with or without a plan', () => {
    const e = ev({ start: '2026-11-02T17:00:00-05:00', location: 'Walpole, MA' });
    expect(dep(at('16:24', '2026-11-02'), [e])).toBeNull();
    expect(dep(at('16:24', '2026-11-02'), [e], null, null)).toBeNull();
  });
});

describe('commute plan', () => {
  const doc = (body: string) => `# Plan\n\nprose\n\n\`\`\`commute-plan\n${body}\n\`\`\`\n`;
  const VALID = `office_days: [tue, thu]
am_train: "6008"
pm_train: null          # unknown
am_travel_min: 15
pm_travel_min: 30
leave_before_min: 15
walk_min: 30
overrides: [{date: "2026-11-05", mode: "wfh"}, {date: "2026-11-06", mode: "office", am_train: "6010", pm_train: "6029"}]`;
  it('parses a valid block', () => {
    expect(parseCommutePlan(doc(VALID))).toEqual({
      office_days: [2, 4], am_train: '6008', pm_train: null, am_travel_min: 15, pm_travel_min: 30,
      overrides: [{ date: '2026-11-05', mode: 'wfh' }, { date: '2026-11-06', mode: 'office', am_train: '6010', pm_train: '6029' }],
    });
  });
  it('is tolerant: numeric trains, unquoted dates, bad entries dropped, defaults applied', () => {
    const p = parseCommutePlan(doc('office_days: [Tuesday, bogus, THU]\nam_train: 6008\noverrides:\n  - {date: 2026-11-05, mode: wfh}\n  - {date: nope, mode: wfh}\n  - {date: "2026-11-06", mode: maybe}\n  - 7'));
    expect(p).toMatchObject({ office_days: [2, 4], am_train: '6008', pm_train: null, am_travel_min: 15, pm_travel_min: 30 });
    expect(p.overrides).toEqual([{ date: '2026-11-05', mode: 'wfh' }]);
  });
  it('travel-minute fallbacks: legacy aliases, old files keep one lead for both directions', () => {
    const base = 'office_days: [tue]\n';
    expect(parseCommutePlan(doc(base + 'leave_before_min: 15\nwalk_min: 30'))).toMatchObject({ am_travel_min: 15, pm_travel_min: 30 });
    expect(parseCommutePlan(doc(base + 'leave_before_min: 20'))).toMatchObject({ am_travel_min: 20, pm_travel_min: 20 });
    expect(parseCommutePlan(doc(base + 'am_travel_min: 10\npm_travel_min: 25\nleave_before_min: 15'))).toMatchObject({ am_travel_min: 10, pm_travel_min: 25 });
    expect(parseCommutePlan(doc(base))).toMatchObject({ am_travel_min: 15, pm_travel_min: 30 });
  });
  it('throws on a missing block or a malformed one', () => {
    expect(() => parseCommutePlan('no block here')).toThrow();
    expect(() => parseCommutePlan(doc('office_days: [tue\n  : : ['))).toThrow();
    expect(() => parseCommutePlan(doc('- just\n- a list'))).toThrow();
  });
  it('source: missing and malformed files log once and return null; a changed mtime is re-read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plan-'));
    const f = join(dir, 'plan.md');
    const log = vi.fn();
    const src = createPlanSource(f, log);
    expect(src.get()).toBeNull();
    expect(src.get()).toBeNull();
    expect(log).toHaveBeenCalledTimes(1);
    writeFileSync(f, 'garbage');
    expect(src.get()).toBeNull();
    expect(src.get()).toBeNull();
    expect(log).toHaveBeenCalledTimes(2);
    writeFileSync(f, doc(VALID));
    expect(src.get()!.am_train).toBe('6008');
    writeFileSync(f, doc(VALID.replace('"6008"', '"6010"')));
    utimesSync(f, new Date(), new Date(Date.now() + 5000));
    expect(src.get()!.am_train).toBe('6010');
    expect(log).toHaveBeenCalledTimes(2);
  });
});

describe('event departure', () => {
  it('ignores located calendar events entirely; only the train remains on an office day', () => {
    const e = ev({ start: '2026-11-03T07:00:00-05:00', location: 'Walpole, MA' });
    const d = dep(at('06:00'), [e])!;
    expect(d.kind).toBe('train'); // the 06:35 event leave-by no longer wins
    expect(dep(at('10:00', '2026-11-07'), [ev({ start: '2026-11-07T16:00:00-05:00', location: 'ENT Specialists, Plainville, MA' })])).toBeNull();
  });
});

describe('commute file', () => {
  it('drops malformed trains and rejects an empty timetable', () => {
    expect(parseCommute({ am: [{ number: '1', departs: '7:01' }, { number: '2', departs: '07:01' }], pm: [] })?.am).toHaveLength(1);
    expect(parseCommute({ am: [], pm: [] })).toBeNull();
    expect(parseCommute(null)).toBeNull();
  });
  it('ships a timetable matching the reference commute file (renumbered Oct 26, 2026)', () => {
    const c = loadCommute()!;
    expect(c.am.map((t) => t.number)).toEqual(['6006', '6008', '6010', '6012', '6014', '6016']);
    expect(c.pm.map((t) => t.number)).toEqual(['6021', '6023', '6025', '6027', '6029', '6031', '6033']);
    expect(c.am.find((t) => t.number === '6008')!.departs).toBe('07:01');
    expect(c.pm.find((t) => t.number === '6029')!.departs).toBe('17:37');
    expect(c.holidays).toContain('2026-11-26');
    expect(JSON.parse(readFileSync(DEFAULT_COMMUTE_FILE, 'utf8')).buffer_min).toBeUndefined();
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
    return new IntercomService({ config, db, calendar, env: { T: 'a'.repeat(40) }, log: () => {}, commute: COMMUTE, plan: { get: () => PLAN }, deskSessions: sessions, submitInbound: async () => { throw new Error('unused'); } });
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

describe('live train departure (on my way)', () => {
  // 6008 departs 07:01 ET on Tue 2026-11-03; leave 06:46.
  const at = (hm: string) => new Date(`2026-11-03T${hm}:00-05:00`);
  const pred = (hm: string): LivePrediction => ({ departsMs: at(hm).getTime(), scheduledMs: at('07:01').getTime(), status: null });
  const build = (now: string, live: LiveView | null, omw: string[] = []) =>
    buildDeparture({ now: at(now), commute: COMMUTE, plan: PLAN, live, onMyWay: new Set(omw) });

  it('adds delay_min for a late train and shifts its leave time', () => {
    const d = build('06:40', new Map([['6008', pred('07:09')]]))!;
    expect(d.delay_min).toBe(8);
    expect(d.on_my_way).toBeUndefined();
    expect(build('06:55', new Map([['6008', pred('07:09')]]))).not.toBeNull();          // 06:46 + 8 = 06:54, inside the grace
    expect(build('07:03', new Map([['6008', pred('07:09')]]))).not.toBeNull();          // still within 10 min grace of 06:54
    expect(build('07:03', null)).toBeNull();                                             // 06:46 + 10 grace = 06:56 passed
    expect(build('07:05', new Map([['6008', pred('07:09')]]))).toBeNull();
  });
  it('keeps an on-my-way train with its live time past the grace, until the API shows it gone', () => {
    const live: LiveView = new Map([['6008', pred('07:09')]]);
    const d = build('07:08', live, ['6008'])!;
    expect(d).toMatchObject({ kind: 'train', on_my_way: true, delay_min: 8, live: { departs: at('07:09').toISOString() } });
    expect(build('07:08', live)).toBeNull();                                             // not flagged: clears as before
    expect(build('07:11', live, ['6008'])).toBeNull();                                   // prediction passed: departed
    expect(build('07:08', new Map([['6008', null]]), ['6008'])).toBeNull();              // prediction vanished after the scheduled time
  });
  it('falls back to the schedule when the API is unavailable, flagged or not', () => {
    expect(build('07:08', new Map(), ['6008'])).toBeNull();
    expect(build('06:50', new Map(), ['6008'])).toMatchObject({ kind: 'train' });
    expect(build('06:50', new Map(), ['6008'])!.on_my_way).toBeUndefined();
    expect(build('06:50', new Map([['6008', null]]), ['6008'])!.on_my_way).toBeUndefined(); // no prediction yet
  });
  it('liveState and liveTargets', () => {
    const sched = at('07:01').getTime();
    expect(liveState(sched, undefined, sched + 3_600_000)).toBe('unknown');
    expect(liveState(sched, null, sched - 60_000)).toBe('unknown');
    expect(liveState(sched, null, sched + 61_000)).toBe('departed');
    expect(liveState(sched, pred('07:09'), at('07:09').getTime() + 30_000)).toBe('live');
    expect(liveState(sched, pred('07:09'), at('07:09').getTime() + 61_000)).toBe('departed');
    const t = (now: string, omw: string[] = []) => liveTargets({ now: at(now), commute: COMMUTE, plan: PLAN, onMyWay: new Set(omw) });
    expect(t('05:00')).toEqual([]);
    expect(t('05:45')).toEqual([{ number: '6008', side: 'am', schedMs: sched }]);
    expect(t('05:00', ['6008'])).toHaveLength(1);
    expect(t('07:40')).toEqual([]);
  });
});

describe('on-my-way tap and live ETA through the service', () => {
  const calendar = { today: async () => ({ date: '2026-11-03', tz: 'America/New_York', generated_at: 'x', events: [] }) } as unknown as CalendarFeed;
  const at = (hm: string) => new Date(`2026-11-03T${hm}:00-05:00`);
  function build(nowRef: { t: number }, mbta: LiveSource | null, calls: StopQuery[] = []) {
    const db = new Database(':memory:'); runMigrations(db);
    const config = IntercomAdapterSchema.parse({ surfaces: [{ id: 's', token_env: 'T', follow: { contact: 'chris', channel: 'telegram:peggy' } }] });
    const src: LiveSource | null = mbta && { get: async (q) => { calls.push(q); return mbta.get(q); } };
    const service = new IntercomService({
      config, db, calendar, env: { T: 'a'.repeat(40) }, log: () => {}, now: () => nowRef.t, commute: COMMUTE, plan: { get: () => PLAN },
      notifications: { enabled: true, api_tokens_env: [] } as never, mbta: src, submitInbound: async () => { throw new Error('unused'); },
    });
    return { service, db };
  }
  const feed = (hm: string): LiveSource => ({ get: async () => new Map([['6008', { departsMs: at(hm).getTime(), scheduledMs: at('07:01').getTime(), status: null }]]) });

  it('flags the train on the Commute "On my way" tap, shows the live ETA past the leave time, and clears once departed', async () => {
    const clock = { t: at('06:50').getTime() };
    let predicted = '07:09';
    const calls: StopQuery[] = [];
    const { service } = build(clock, { get: (q) => feed(predicted).get(q) }, calls);
    const n = service.raise(NotifyInput.parse({ key: 'commute-am', title: 'Leave in 10 min', body: '6008 at 7:01', source: 'Commute', actions: [{ label: 'On my way' }] })).notification;
    expect((await service.desk(at('06:50'))).departure?.on_my_way).toBeUndefined();
    await service.handleNotificationAction(service.surfaces.get('s')!, { client_msg_id: 'c1', id: n.id, index: 0 });
    let dep = (await service.desk(at('07:05'))).departure!;
    expect(dep).toMatchObject({ kind: 'train', delay_min: 8, on_my_way: true, live: { departs: at('07:09').toISOString() } });
    expect(calls[0]).toEqual({ stop: 'place-NEC-2040', direction: 1 });
    predicted = '07:10';                                                        // the API moves it again
    dep = (await service.desk(at('07:08'))).departure!;
    expect(dep.live?.departs).toBe(at('07:10').toISOString());
    clock.t = at('07:12').getTime();                                            // past the prediction: departed
    expect((await service.desk(at('07:12'))).departure).toBeNull();
    expect((await service.desk(at('07:09'))).departure?.on_my_way).toBeUndefined(); // the flag was cleared, not just hidden
  });
  it('ignores other notifications and labels, and an unavailable API leaves the scheduled behaviour', async () => {
    const clock = { t: at('06:50').getTime() };
    const { service } = build(clock, { get: async () => null });
    const act = async (key: string, source: string, label: string, cid: string) => {
      const n = service.raise(NotifyInput.parse({ key, title: 'x', body: 'y', source, actions: [{ label }] })).notification;
      await service.handleNotificationAction(service.surfaces.get('s')!, { client_msg_id: cid, id: n.id, index: 0 });
    };
    await act('commute-am', 'Commute', 'Later train', 'a');
    await act('dentist', 'Commute', 'On my way', 'b');
    await act('commute-am', 'Mail Watcher', 'On my way', 'c');
    expect((await service.desk(at('06:50'))).departure?.on_my_way).toBeUndefined();
    await act('commute-am', 'Commute', 'On my way', 'd');
    const dep = (await service.desk(at('06:50'))).departure!;                   // flagged, but the API is down
    expect(dep.on_my_way).toBeUndefined();
    expect(dep.delay_min).toBeUndefined();
    expect((await service.desk(at('07:05'))).departure).toBeNull();             // as before: gone after the grace
  });
  it('a PM "Taking it" tap flags the train named in the key', async () => {
    const { service, db } = build({ t: at('16:00').getTime() }, null);
    const n = service.raise(NotifyInput.parse({ key: 'commute-pm-6029', title: 'x', body: 'y', source: 'Commute', actions: [{ label: 'Taking it' }] })).notification;
    await service.handleNotificationAction(service.surfaces.get('s')!, { client_msg_id: 'p', id: n.id, index: 0 });
    expect(db.prepare('SELECT date, train FROM intercom_on_my_way').all()).toEqual([{ date: '2026-11-03', train: '6029' }]);
  });
});

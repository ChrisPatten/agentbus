/**
 * E94 — Intercom desk mode: the read-only summary behind the agent-status ring and the leave-by line.
 *
 *   sessions   one entry per leased cc-pool pane (title is the topic or channel name, never message text)
 *   counts     working / needs_you (waiting on Chris or stuck)
 *   departure  next train or event departure, computed here so the Compact reuses it
 *
 * Everything below `collectDeskSessions` is pure and unit-tested. See docs/INTERCOM.md.
 */
import { readFileSync, statSync } from 'node:fs';
import yaml from 'js-yaml';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { toBareAgentId, type PoolLeaseRow } from '../pool/types.js';
import { getUnhandledSince } from '../pool/unhandled-work.js';
import { isoInTz, type CalendarEvent } from './calendar.js';

export type DeskState = 'working' | 'waiting' | 'stuck' | 'idle' | 'finished';
export interface DeskSession { id: string; title: string; state: DeskState; channel: string; since: string }
export interface DeskDeparture {
  label: string;
  /** Scheduled leave time (ISO). Clients add `delay_min` themselves. */
  leave_at: string;
  kind: 'train' | 'event';
  train?: { number: string; departs: string };
  delay_min?: number;
}
export interface DeskPayload {
  generated_at: string;
  sessions: DeskSession[];
  counts: { working: number; needs_you: number };
  departure: DeskDeparture | null;
}

export const MAX_DESK_SESSIONS = 12;
/** A turn that ended within this window shows as "finished recently". */
export const FINISHED_WINDOW_MS = 10 * 60_000;
/** A departure stays on the face this long after its leave time (the client shows "Late"). */
export const LATE_GRACE_MS = 10 * 60_000;

// ── Sessions ────────────────────────────────────────────────────────────────

export interface PaneFacts {
  leaseState: PoolLeaseRow['state'];
  hasConversation: boolean;
  incidentSince: string | null;
  waitingSince: string | null;
  unhandledSince: string | null;
  lastTurnEndedAt: string | null;
  lastActivityAt: string | null;
  leasedAt: string | null;
}

/** State and "since" for one pane, or null when the pane is not a session (free). */
export function classifyPane(f: PaneFacts, nowMs: number): { state: DeskState; since: string } | null {
  const fallback = f.lastActivityAt ?? f.leasedAt ?? new Date(nowMs).toISOString();
  if (f.leaseState === 'free') return null;
  if (f.leaseState === 'dead') return f.hasConversation ? { state: 'stuck', since: fallback } : null;
  if (f.incidentSince) return { state: 'stuck', since: f.incidentSince };
  if (f.waitingSince) return { state: 'waiting', since: f.waitingSince };
  if (f.leaseState === 'launching') return { state: 'working', since: fallback };
  if (f.unhandledSince) return { state: 'working', since: f.unhandledSince };
  const ended = f.lastTurnEndedAt ? Date.parse(f.lastTurnEndedAt) : NaN;
  if (!Number.isNaN(ended) && nowMs - ended <= FINISHED_WINDOW_MS) return { state: 'finished', since: f.lastTurnEndedAt! };
  return { state: 'idle', since: fallback };
}

const ORDER: Record<DeskState, number> = { stuck: 0, waiting: 1, working: 2, finished: 3, idle: 4 };

export function sortSessions(list: DeskSession[]): DeskSession[] {
  return list.slice().sort((a, b) => ORDER[a.state] - ORDER[b.state] || b.since.localeCompare(a.since) || a.id.localeCompare(b.id));
}

export function deskCounts(list: DeskSession[]): { working: number; needs_you: number } {
  return {
    working: list.filter((s) => s.state === 'working').length,
    needs_you: list.filter((s) => s.state === 'waiting' || s.state === 'stuck').length,
  };
}

interface PoolLike { poolId: string; leaseStore: { list(poolId: string): PoolLeaseRow[] } }

/** Title for a conversation: the app topic title, a stored forum-topic name, or the channel. Never message text. */
function titleFor(db: Database.Database, conversationId: string | null, fallback: string): { title: string; channel: string } {
  if (!conversationId) return { title: fallback, channel: '' };
  try {
    const cr = db.prepare('SELECT channel, topic FROM conversation_registry WHERE id = ?').get(conversationId) as { channel: string; topic: string } | undefined;
    if (!cr) return { title: fallback, channel: '' };
    let name: string | null = null;
    try {
      const row = db.prepare('SELECT metadata FROM threads WHERE channel = ? AND topic = ?').get(cr.channel, cr.topic) as { metadata: string } | undefined;
      const md = row ? (JSON.parse(row.metadata) as { title?: unknown; topicName?: unknown }) : {};
      const raw = cr.channel === 'app' ? md.title : md.topicName;
      if (typeof raw === 'string' && raw.trim()) name = raw.trim();
    } catch { /* no title stored */ }
    if (!name && cr.channel === 'app' && cr.topic === 'general') name = 'Main';
    const chan = cr.channel.replace(/^telegram:/, '');
    return { title: (name ?? (cr.topic === 'general' ? chan : `${chan} topic`)).slice(0, 40), channel: cr.channel };
  } catch { return { title: fallback, channel: '' }; }
}

/** Sessions from the cc-pool lease state, approvals, choice prompts and watchdog incidents. Read-only. */
export function collectDeskSessions(db: Database.Database, pools: Iterable<PoolLike>, nowMs = Date.now()): DeskSession[] {
  const nowIso = new Date(nowMs).toISOString();
  const rows = <T>(sql: string, ...args: unknown[]): T[] => { try { return db.prepare(sql).all(...args) as T[]; } catch { return []; } };
  const approvals = rows<{ agent_id: string; requested_at: string }>(`SELECT agent_id, requested_at FROM approval_requests WHERE status = 'pending' AND expires_at > ?`, nowIso);
  const choices = rows<{ channel: string; topic: string; created_at: string }>(`SELECT channel, topic, created_at FROM choice_prompts WHERE status = 'open' AND expires_at > ?`, nowIso);
  const incidents = rows<{ pool_id: string; pane_id: string; detected_at: string }>('SELECT pool_id, pane_id, detected_at FROM pane_incidents WHERE resolved_at IS NULL');
  const out: DeskSession[] = [];
  for (const pool of pools) {
    let leases: PoolLeaseRow[] = [];
    try { leases = pool.leaseStore.list(pool.poolId); } catch { continue; }
    for (const lease of leases) {
      let unhandled: string | null = null;
      try { unhandled = lease.state === 'leased' ? getUnhandledSince(db, lease) : null; } catch { /* treat as handled */ }
      const reg = lease.conversation_id
        ? rows<{ channel: string; topic: string }>('SELECT channel, topic FROM conversation_registry WHERE id = ?', lease.conversation_id)[0]
        : undefined;
      const bare = toBareAgentId(lease.agent_id);
      const waits = [
        ...approvals.filter((a) => toBareAgentId(a.agent_id) === bare).map((a) => a.requested_at),
        ...(reg ? choices.filter((c) => c.channel === reg.channel && c.topic === reg.topic).map((c) => c.created_at) : []),
      ].sort();
      const inc = incidents.find((i) => i.pool_id === lease.pool_id && i.pane_id === lease.pane_id);
      const cls = classifyPane({
        leaseState: lease.state, hasConversation: !!lease.conversation_id, incidentSince: inc?.detected_at ?? null,
        waitingSince: waits[0] ?? null, unhandledSince: unhandled, lastTurnEndedAt: lease.last_turn_ended_at,
        lastActivityAt: lease.last_activity_at, leasedAt: lease.leased_at,
      }, nowMs);
      if (!cls) continue;
      const t = titleFor(db, lease.conversation_id, bare);
      out.push({ id: lease.agent_id, title: t.title, state: cls.state, channel: t.channel, since: cls.since });
    }
  }
  return sortSessions(out).slice(0, MAX_DESK_SESSIONS);
}

// ── Departure ───────────────────────────────────────────────────────────────

export interface Train { number: string; departs: string; arrives?: string }
export interface CommuteConfig {
  timezone: string;
  holidays: string[];
  am: Train[];
  pm: Train[];
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
/** Validate the timetable JSON; unusable trains are dropped. Returns null when nothing usable remains. */
export function parseCommute(raw: unknown): CommuteConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const trains = (v: unknown): Train[] => (Array.isArray(v) ? v : [])
    .filter((t): t is Train => !!t && typeof (t as Train).number === 'string' && HHMM.test(String((t as Train).departs)))
    .map((t) => ({ number: t.number, departs: t.departs, ...(t.arrives ? { arrives: t.arrives } : {}) }));
  const cfg: CommuteConfig = {
    timezone: typeof r['timezone'] === 'string' ? r['timezone'] : 'America/New_York',
    holidays: (Array.isArray(r['holidays']) ? r['holidays'] : []).filter((h): h is string => typeof h === 'string'),
    am: trains(r['am']), pm: trains(r['pm']),
  };
  return cfg.am.length + cfg.pm.length ? cfg : null;
}

export const DEFAULT_COMMUTE_FILE = fileURLToPath(new URL('../../integrations/intercom/commute.json', import.meta.url));

export function loadCommute(file: string = DEFAULT_COMMUTE_FILE, log: (l: string) => void = () => {}): CommuteConfig | null {
  try { return parseCommute(JSON.parse(readFileSync(file, 'utf8'))); }
  catch (err) { log(`warn: commute timetable unavailable (${file}): ${String(err)}`); return null; }
}

/** Local date (`YYYY-MM-DD`), weekday (0 = Sunday) and zone offset suffix in `tz`. */
export function localDay(now: Date, tz: string): { date: string; weekday: number; offset: string } {
  const iso = isoInTz(now, tz);
  const date = iso.slice(0, 10);
  return { date, weekday: new Date(`${date}T12:00:00Z`).getUTCDay(), offset: iso.slice(-6) };
}

// ── Office-day plan ─────────────────────────────────────────────────────────

/** Fixed lead for a located calendar event: start minus `event_travel_min` minus this many minutes. */
export const EVENT_BUFFER_MIN = 5;
export const DEFAULT_PLAN_FILE = '/Users/chrispatten/workspace/peggy-claude-code/memory/project_commute_plan.md';

export interface PlanOverride { date: string; mode: 'office' | 'wfh'; am_train?: string | null; pm_train?: string | null }
export interface CommutePlan {
  /** Weekdays, 0 = Sunday. */
  office_days: number[];
  am_train: string | null;
  pm_train: string | null;
  leave_before_min: number;
  overrides: PlanOverride[];
}

const DAYS: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const trainNo = (v: unknown): string | null => (typeof v === 'string' || typeof v === 'number') && String(v).trim() ? String(v).trim() : null;
const dateStr = (v: unknown): string | null => {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? v.trim() : null;
};

/** Pull the YAML-ish body of the fenced `commute-plan` block out of the plan file's text; null when absent. */
export function extractPlanBlock(text: string): string | null {
  const m = /^[ \t]*```[ \t]*commute-plan[ \t]*\r?\n([\s\S]*?)^[ \t]*```/m.exec(text);
  return m ? m[1]! : null;
}

/** Tolerant parse of the plan file's text. Throws a readable Error when the block is missing or unusable. */
export function parseCommutePlan(text: string): CommutePlan {
  const body = extractPlanBlock(text);
  if (body === null) throw new Error('no commute-plan block');
  const doc = yaml.load(body);
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('commute-plan block is not a mapping');
  const r = doc as Record<string, unknown>;
  const days = (Array.isArray(r['office_days']) ? r['office_days'] : [])
    .map((d) => (typeof d === 'string' ? DAYS[d.trim().toLowerCase().slice(0, 3)] : undefined))
    .filter((d): d is number => d !== undefined);
  const lead = typeof r['leave_before_min'] === 'number' && Number.isFinite(r['leave_before_min']) && r['leave_before_min'] >= 0 ? r['leave_before_min'] : 15;
  const overrides: PlanOverride[] = [];
  for (const o of Array.isArray(r['overrides']) ? r['overrides'] : []) {
    if (!o || typeof o !== 'object') continue;
    const x = o as Record<string, unknown>;
    const date = dateStr(x['date']);
    const mode = x['mode'] === 'office' || x['mode'] === 'wfh' ? x['mode'] : null;
    if (!date || !mode) continue;
    overrides.push({
      date, mode,
      ...('am_train' in x ? { am_train: trainNo(x['am_train']) } : {}),
      ...('pm_train' in x ? { pm_train: trainNo(x['pm_train']) } : {}),
    });
  }
  return { office_days: [...new Set(days)], am_train: trainNo(r['am_train']), pm_train: trainNo(r['pm_train']), leave_before_min: lead, overrides };
}

/** Re-reads the plan file when its mtime changes (one stat per call). Never throws; a bad file logs once and yields null. */
export function createPlanSource(file: string = DEFAULT_PLAN_FILE, log: (l: string) => void = () => {}): { get(): CommutePlan | null } {
  let sig = '';
  let plan: CommutePlan | null = null;
  return {
    get() {
      let key: string;
      try { const st = statSync(file); key = `${st.mtimeMs}:${st.size}`; } catch { key = 'missing'; }
      if (key === sig) return plan;
      sig = key;
      try {
        if (key === 'missing') throw new Error('file not found');
        plan = parseCommutePlan(readFileSync(file, 'utf8'));
      } catch (err) {
        plan = null;
        log(`warn: commute plan unavailable (${file}): ${err instanceof Error ? err.message : String(err)}; no train line`);
      }
      return plan;
    },
  };
}

export interface OfficeDay { am: string | null; pm: string | null }

/** The trains for this local date, or null when it is not an office day (no plan, wfh, weekend rule, holiday). */
export function officeDay(c: CommuteConfig, plan: CommutePlan | null, now: Date): OfficeDay | null {
  if (!plan) return null;
  const d = localDay(now, c.timezone);
  if (c.holidays.includes(d.date)) return null;
  const ov = plan.overrides.find((o) => o.date === d.date);
  if (ov?.mode === 'wfh') return null;
  if (!ov && !plan.office_days.includes(d.weekday)) return null;
  return {
    am: ov && 'am_train' in ov ? ov.am_train ?? null : plan.am_train,
    pm: ov && 'pm_train' in ov ? ov.pm_train ?? null : plan.pm_train,
  };
}

export const isOfficeDay = (c: CommuteConfig, plan: CommutePlan | null, now: Date): boolean => officeDay(c, plan, now) !== null;

interface Candidate { leaveMs: number; dep: DeskDeparture }

const trainCandidates = (c: CommuteConfig, plan: CommutePlan | null, now: Date): Candidate[] => {
  const day = officeDay(c, plan, now);
  if (!day || !plan) return [];
  const { date, offset } = localDay(now, c.timezone);
  const mk = (t: Train): Candidate => {
    const departs = `${date}T${t.departs}:00${offset}`;
    const leaveMs = Date.parse(departs) - plan.leave_before_min * 60_000;
    const h = Number(t.departs.slice(0, 2));
    return { leaveMs, dep: { label: `${h % 12 || 12}:${t.departs.slice(3)} train`, leave_at: isoInTz(new Date(leaveMs), c.timezone), kind: 'train', train: { number: t.number, departs } } };
  };
  const out: Candidate[] = [];
  const am = day.am ? c.am.find((t) => t.number === day.am) : undefined;
  const pm = day.pm ? c.pm.find((t) => t.number === day.pm) : undefined;
  if (am) out.push(mk(am));
  if (pm) out.push(mk(pm));
  return out;
};

const VIRTUAL = /https?:|zoom|teams|meet\.google|webex|virtual|microsoft|phone|call/i;

const eventCandidates = (events: CalendarEvent[], now: Date, travelMin: number, tz: string): Candidate[] => {
  const out: Candidate[] = [];
  for (const e of events) {
    if (e.all_day || !e.location || VIRTUAL.test(e.location)) continue;
    const start = Date.parse(e.start);
    if (Number.isNaN(start) || start <= now.getTime()) continue;
    const leaveMs = start - (travelMin + EVENT_BUFFER_MIN) * 60_000;
    out.push({ leaveMs, dep: { label: e.title.slice(0, 40), leave_at: isoInTz(new Date(leaveMs), tz), kind: 'event' } });
  }
  return out;
};

/**
 * The departure the desk face should show: the earliest train or located event whose leave time has not passed
 * by more than the late grace. Trains appear only on office days per the plan; null otherwise with no located events. Estimates only: no routing service.
 */
export function buildDeparture(opts: { now: Date; commute: CommuteConfig | null; plan?: CommutePlan | null; events: CalendarEvent[]; eventTravelMin: number; tz: string }): DeskDeparture | null {
  const { now, commute, plan = null, events, eventTravelMin, tz } = opts;
  const floor = now.getTime() - LATE_GRACE_MS;
  const all = [
    ...(commute ? trainCandidates(commute, plan, now) : []),
    ...eventCandidates(events, now, eventTravelMin, tz),
  ].filter((c) => c.leaveMs >= floor).sort((a, b) => a.leaveMs - b.leaveMs);
  return all[0]?.dep ?? null;
}

export function buildDeskPayload(opts: { now: Date; sessions: DeskSession[]; departure: DeskDeparture | null }): DeskPayload {
  const sorted = sortSessions(opts.sessions);
  return { generated_at: opts.now.toISOString(), sessions: sorted.slice(0, MAX_DESK_SESSIONS), counts: deskCounts(sorted), departure: opts.departure };
}

/** Stable signature used to push `desk` only on change. */
export const deskSignature = (p: DeskPayload): string => JSON.stringify({ s: p.sessions, c: p.counts, d: p.departure });

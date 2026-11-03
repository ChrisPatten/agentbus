/**
 * E96 S96.6 — the surface `sessions` resource.
 *
 * Built from E94's desk classification ({@link collectDeskSessionDetails}) plus:
 *
 *   subject           `status(subject)` per conversation (`surface_session_subjects`).
 *   needs_you         an open `surface_answer_needed` row for the session's conversation, and
 *                     nothing else. A desk state of `waiting`/`stuck` (pending approval, open
 *                     choice prompt, watchdog incident) stays in `state`; it does NOT set
 *                     `needs_you`, so "a reply without `answer_needed` never sets it" holds.
 *   activity timeout  `idle`/`finished` sessions with no activity for `activityTimeoutMin`
 *                     drop out. `working`, `waiting`, `stuck` and every `needs_you` session stay.
 *   system sessions   excluded unless `includeSystem` (a `needs_you` session is never hidden).
 *                     System = channel `system`/`system:*`; a conversation whose contact is
 *                     `system:*` or `agent:*` (bus-internal, agent-to-agent); a scheduled
 *                     routine's conversation (topic `sched:*`, or the channel+topic of an active
 *                     cron schedule). cc-headless instances are not in the desk input at all.
 *
 * A conversation flagged `answer_needed` whose pane has been released still appears (state
 * `idle`, id = conversation id), so an open question never disappears from the surface.
 *
 * Ids: the conversation id (64 hex chars) when the pane has one, else the bare pane agent id
 * made `ID_RE`-safe. Order: `needs_you` first, then the desk order (stuck, waiting, working,
 * finished, idle; newest `since` first; id). Pure apart from DB reads.
 */
import type Database from 'better-sqlite3';
import { conversationTitle, type DeskSessionDetail, type DeskState } from '../intercom/desk.js';
import { listAnswerNeeded, listSubjects } from './flags.js';
import { BOUNDS, ID_RE, type ResourceOp, type SurfaceSession } from './types.js';

/** At most this many sessions in the resource (needs_you sessions sort first, so they are never cut). */
export const MAX_SURFACE_SESSIONS = 24;

export interface BuildSurfaceSessionsInput {
  db: Database.Database;
  /** `collectDeskSessionDetails(db, poolManagers.values(), now)`. */
  desk: DeskSessionDetail[];
  /** Epoch ms or Date. */
  now: number | Date;
  /** `surface_api.sessions.activity_timeout_min` (default 30). */
  activityTimeoutMin: number;
  /** `surface_api.sessions.include_system` (default false). */
  includeSystem: boolean;
}

const ORDER: Record<DeskState, number> = { stuck: 0, waiting: 1, working: 2, finished: 3, idle: 4 };
const ACTIVE: ReadonlySet<DeskState> = new Set(['working', 'waiting', 'stuck']);

/** `agent:peggy-pool-2` → `peggy-pool-2`, lowercased, anything outside `[a-z0-9_-]` → `-`, max 64. */
export function sessionIdForPane(agentId: string): string {
  const bare = agentId.replace(/^agent:/, '').toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^[-_]+/, '');
  return (bare || 'pane').slice(0, 64);
}

function sessionId(conversationId: string | null, agentId: string): string {
  return conversationId && ID_RE.test(conversationId) ? conversationId : sessionIdForPane(agentId);
}

interface RegistryRow { id: string; contact_id: string; channel: string; topic: string; last_seen: string }

/** True for scheduled routines, `system` channels and bus-internal / agent-to-agent conversations. */
export function isSystemConversation(reg: Pick<RegistryRow, 'contact_id' | 'channel' | 'topic'> | null, cronTopics: ReadonlySet<string>): boolean {
  if (!reg) return false;
  if (reg.channel === 'system' || reg.channel.startsWith('system:')) return true;
  if (reg.contact_id.startsWith('system:') || reg.contact_id.startsWith('agent:')) return true;
  if (reg.topic.startsWith('sched:')) return true;
  return cronTopics.has(`${reg.channel}\u0000${reg.topic}`);
}

function cronScheduleTopics(db: Database.Database): Set<string> {
  try {
    const rows = db.prepare(`SELECT channel, topic FROM scheduled_items WHERE type = 'cron' AND status = 'active' AND topic IS NOT NULL`)
      .all() as { channel: string; topic: string }[];
    return new Set(rows.filter((r) => r.topic !== 'general').map((r) => `${r.channel}\u0000${r.topic}`));
  } catch { return new Set(); }
}

function registry(db: Database.Database, id: string | null): RegistryRow | null {
  if (!id) return null;
  try {
    return (db.prepare('SELECT id, contact_id, channel, topic, last_seen FROM conversation_registry WHERE id = ?').get(id) as RegistryRow | undefined) ?? null;
  } catch { return null; }
}

const ms = (iso: string | null | undefined): number => { const v = iso ? Date.parse(iso) : NaN; return Number.isNaN(v) ? 0 : v; };
const latest = (...isos: (string | null | undefined)[]): string =>
  isos.filter((v): v is string => typeof v === 'string' && ms(v) > 0).sort((a, b) => ms(b) - ms(a))[0] ?? new Date(0).toISOString();

export function buildSurfaceSessions(input: BuildSurfaceSessionsInput): SurfaceSession[] {
  const { db, desk, activityTimeoutMin, includeSystem } = input;
  const nowMs = input.now instanceof Date ? input.now.getTime() : input.now;
  const timeoutMs = Math.max(1, activityTimeoutMin) * 60_000;
  const subjects = listSubjects(db);
  const flags = new Map(listAnswerNeeded(db).map((f) => [f.conversation_id, f]));
  const cron = cronScheduleTopics(db);

  const out = new Map<string, SurfaceSession>();
  const consider = (s: SurfaceSession): void => {
    if (s.system && !includeSystem && !s.needs_you) return;
    if (!s.needs_you && !ACTIVE.has(s.state) && nowMs - ms(s.last_activity_at) > timeoutMs) return;
    if (!out.has(s.id)) out.set(s.id, s);   // desk input is sorted: the first pane on a conversation wins
  };

  for (const d of desk) {
    const reg = registry(db, d.conversation_id);
    const flag = d.conversation_id ? flags.get(d.conversation_id) : undefined;
    consider({
      id: sessionId(d.conversation_id, d.agent_id),
      title: d.title,
      subject: subjectOf(subjects, d.conversation_id),
      state: d.state,
      channel: d.channel,
      conversation_id: d.conversation_id,
      since: d.since,
      last_activity_at: latest(d.last_activity_at, flag?.set_at),
      needs_you: !!flag,
      needs_you_message_id: flag?.message_id ?? null,
      system: isSystemConversation(reg, cron),
    });
  }

  // Open questions whose pane is gone (released or never pool-backed): still shown.
  const covered = new Set(desk.map((d) => d.conversation_id));
  for (const flag of flags.values()) {
    if (covered.has(flag.conversation_id)) continue;
    const reg = registry(db, flag.conversation_id);
    const t = conversationTitle(db, flag.conversation_id, flag.agent_id ? flag.agent_id.replace(/^agent:/, '') : 'Conversation');
    consider({
      id: sessionId(flag.conversation_id, flag.agent_id ?? flag.conversation_id),
      title: t.title,
      subject: subjectOf(subjects, flag.conversation_id),
      state: 'idle',
      channel: t.channel,
      conversation_id: flag.conversation_id,
      since: flag.set_at,
      last_activity_at: latest(flag.set_at, reg?.last_seen),
      needs_you: true,
      needs_you_message_id: flag.message_id,
      system: isSystemConversation(reg, cron),
    });
  }

  return [...out.values()].sort(compareSessions).slice(0, MAX_SURFACE_SESSIONS);
}

function subjectOf(subjects: Map<string, string>, conversationId: string | null): string | null {
  const s = conversationId ? subjects.get(conversationId) : undefined;
  return s ? s.slice(0, BOUNDS.subject) : null;
}

export function compareSessions(a: SurfaceSession, b: SurfaceSession): number {
  return Number(b.needs_you) - Number(a.needs_you)
    || ORDER[a.state] - ORDER[b.state]
    || b.since.localeCompare(a.since)
    || a.id.localeCompare(b.id);
}

/** The `sessions` resource items, keyed by id (for `ResourceHub` / `GET /state`). */
export function sessionsAsItems(list: SurfaceSession[]): Record<string, Record<string, unknown>> {
  const items: Record<string, Record<string, unknown>> = {};
  for (const s of list) items[s.id] = { ...s };
  return items;
}

/**
 * Ops that turn collection `prev` into `next`: `set` for new or changed items (deep JSON
 * compare), `remove` for gone ones. Empty when nothing changed, so a poller can call
 * `hub.apply` only when needed.
 */
export function diffItems(prev: Record<string, Record<string, unknown>>, next: Record<string, Record<string, unknown>>): ResourceOp[] {
  const ops: ResourceOp[] = [];
  for (const [id, value] of Object.entries(next)) {
    const old = prev[id];
    if (!old || JSON.stringify(old) !== JSON.stringify(value)) ops.push({ op: 'set', id, value });
  }
  for (const id of Object.keys(prev)) if (!(id in next)) ops.push({ op: 'remove', id });
  return ops;
}

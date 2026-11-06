/**
 * E100 — Moment lifecycle of Surface Events.
 *
 * Every `events` item has a bus-owned `state`: `open` while it is live, then one of the
 * terminal states `answered`, `expired`, `withdrawn` or `cleared`. A terminal event is a
 * **tombstone**: it stays in the `events` resource (with `state` and `ended_at`) so devices
 * can show it in an Earlier tray with the right word, and is purged after the retention
 * period. Tombstones never count toward `eventsPerSurface`, never block the ring-overlap
 * check, and their actions answer `expired` (reason = the state).
 *
 * Items written before E100 have no `state`; they read as `open`.
 *
 * Pure helpers: no I/O, safe for every module to import.
 */
import type { EventState, Level, Weight } from './types.js';

export const EVENT_STATES: readonly EventState[] = ['open', 'answered', 'expired', 'withdrawn', 'cleared'];
export const TERMINAL_STATES: readonly EventState[] = ['answered', 'expired', 'withdrawn', 'cleared'];
/** Reasons an agent may give when it removes an event (`surface_remove_event`). */
export const REMOVE_REASONS = ['withdrawn', 'answered', 'cleared'] as const;
export type RemoveReason = (typeof REMOVE_REASONS)[number];

/** Default tombstone retention (`surface_api.event_tombstone_hours`). */
export const DEFAULT_TOMBSTONE_HOURS = 24;

export const WEIGHTS: readonly Weight[] = ['ambient', 'notice', 'decision', 'urgent'];
/** The level a weight implies (stored next to the weight for clients that read only `level`). */
export const LEVEL_FOR_WEIGHT: Record<Weight, Level> = { ambient: 'info', notice: 'info', decision: 'attention', urgent: 'urgent' };

type Item = Record<string, unknown>;

/** The item's state; a missing or unknown one is `open` (events stored before E100). */
export function stateOf(item: Item | null | undefined): EventState {
  const s = item?.['state'];
  return typeof s === 'string' && (EVENT_STATES as readonly string[]).includes(s) ? (s as EventState) : 'open';
}

export function isTerminal(item: Item | null | undefined): boolean {
  return stateOf(item) !== 'open';
}

function isPast(v: unknown, now: number): boolean {
  if (typeof v !== 'string') return false;
  const t = Date.parse(v);
  return Number.isFinite(t) && t <= now;
}

/** Open and not past its `expires_at`: what counts toward the cap and the ring. */
export function isLiveEvent(item: Item, now: number): boolean {
  return !isTerminal(item) && !isPast(item['expires_at'], now);
}

/** Decision or urgent, by weight or (without a weight) by level attention/urgent. These are auto-answered by a fired action. */
export function isDecisionOrUrgent(item: Item): boolean {
  const w = item['weight'];
  if (typeof w === 'string' && (WEIGHTS as readonly string[]).includes(w)) return w === 'decision' || w === 'urgent';
  return item['level'] === 'attention' || item['level'] === 'urgent';
}

/** The tombstone of `item`: same content, `state` terminal, `ended_at` and `updated_at` set. */
export function tombstone(item: Item, state: Exclude<EventState, 'open'>, endedAt: string, updatedAt: string = endedAt): Item {
  return { ...item, state, ended_at: endedAt, updated_at: updatedAt };
}

/** True when a tombstone's retention ran out (`ended_at` + retention at or before `now`). A tombstone without a usable `ended_at` uses `updated_at`. */
export function tombstoneDue(item: Item, now: number, retentionMs: number): boolean {
  if (!isTerminal(item)) return false;
  const at = Date.parse(String(item['ended_at'] ?? item['updated_at'] ?? ''));
  return !Number.isFinite(at) || at + retentionMs <= now;
}

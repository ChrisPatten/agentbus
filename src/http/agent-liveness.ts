/**
 * S48.4 — bus-side agent-poll liveness tracker (E48), plus E88's per-launch
 * fence.
 *
 * In-memory (not persisted — resets on bus-core restart, which is fine: a
 * live pane's cc.ts repolls within its own poll_interval_ms anyway) tracker
 * of the last time each bare agent id was seen polling
 * /api/v1/messages/pending. Used by cc-pool's pane-launch readiness gate to
 * detect "this pane's cc.ts has come up" without scraping tmux output.
 *
 * Every cc.ts process, once running, polls
 * `GET /api/v1/messages/pending?agent=<id>&limit=N` on a timer — there is no
 * adapter registration for it, so this poll is the only external signal that
 * a launched pane's cc.ts is actually alive and talking to the bus.
 *
 * E88 — launch fencing. A cc-pool pane is identified only by its agent id, so
 * any process holding that id (an orphaned tmux server's old `claude`, for
 * example) could poll, take the pane's messages and satisfy the readiness
 * gate. Each pane launch now carries a launch id (`AGENTBUS_LAUNCH_ID`),
 * sent on every poll. The pool registers the current launch id per pane
 * agent id with `registerAgentLaunch()`; from then on a poll carrying any
 * other launch id (or none) is stale: it is answered with no messages, and
 * is not recorded as a poll. An agent id that never had a launch id
 * registered (every non-pool adapter, and every pane until its first launch
 * after an upgrade or a bus-core restart) keeps the old behavior.
 */

interface PollRecord {
  at: string;
  /** Launch id the poll carried, or null for a poll without one. */
  launchId: string | null;
}

const lastPoll = new Map<string, PollRecord>();
const registeredLaunch = new Map<string, string>();
/** `${agentId}\u0000${launchId}` -> ms of the last stale-poll warning. */
const staleWarnedAt = new Map<string, number>();

/** Stale polls for one agent id + launch id are logged at most this often. */
export const STALE_POLL_WARN_INTERVAL_MS = 60_000;

/** Record that `agentId` (BARE form, e.g. "peggy-pool-2") just polled. */
export function recordAgentPoll(agentId: string, at?: Date, launchId?: string | null): void {
  lastPoll.set(agentId, { at: (at ?? new Date()).toISOString(), launchId: launchId || null });
}

/** ISO timestamp of the last recorded poll for `agentId`, or null if never seen. */
export function getLastPollAt(agentId: string): string | null {
  return lastPoll.get(agentId)?.at ?? null;
}

/** E88 — the last recorded poll for `agentId` with the launch id it carried, or null if never seen. */
export function getLastPoll(agentId: string): { lastPollAt: string; lastLaunchId: string | null } | null {
  const rec = lastPoll.get(agentId);
  return rec ? { lastPollAt: rec.at, lastLaunchId: rec.launchId } : null;
}

/**
 * E88 — make `launchId` the only launch allowed to poll as `agentId`. Called
 * by cc-pool right before it types a pane's launch line, so the new
 * `claude`'s first poll is already the registered one.
 */
export function registerAgentLaunch(agentId: string, launchId: string): void {
  registeredLaunch.set(agentId, launchId);
}

/** E88 — the launch id registered for `agentId`, or null when none is (no fence). */
export function getRegisteredLaunch(agentId: string): string | null {
  return registeredLaunch.get(agentId) ?? null;
}

/**
 * E88 — true when a poll as `agentId` carrying `launchId` must be refused:
 * a launch id is registered for that agent id and the poll's differs (a poll
 * with no launch id counts as differing). Unregistered agent ids are never
 * stale.
 */
export function isStaleLaunch(agentId: string, launchId: string | null | undefined): boolean {
  const current = registeredLaunch.get(agentId);
  if (current === undefined) return false;
  return (launchId || null) !== current;
}

/**
 * E88 — log a refused poll, at most once per `STALE_POLL_WARN_INTERVAL_MS`
 * per agent id + launch id. Returns true when it logged.
 */
export function warnStalePoll(agentId: string, launchId: string | null | undefined, now: number = Date.now()): boolean {
  const key = `${agentId}\u0000${launchId || ''}`;
  const last = staleWarnedAt.get(key);
  if (last !== undefined && now - last < STALE_POLL_WARN_INTERVAL_MS) return false;
  staleWarnedAt.set(key, now);
  console.warn(
    `[agent-liveness] Refused a stale poll for agent ${agentId}: launch_id=${launchId || '(none)'}, ` +
      `current launch_id=${registeredLaunch.get(agentId) ?? '(none)'}. Another process is polling with this ` +
      `agent id (an orphaned pane?) — see docs/CC_POOL_ADAPTER.md "Orphaned tmux servers".`,
  );
  return true;
}

/** Test-only: clear all module state. */
export function resetAgentLivenessForTests(): void {
  lastPoll.clear();
  registeredLaunch.clear();
  staleWarnedAt.clear();
}

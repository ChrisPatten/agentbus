/**
 * S48.4 — bus-side agent-poll liveness tracker (E48).
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
 */

const lastPollAt = new Map<string, string>();

/** Record that `agentId` (BARE form, e.g. "peggy-pool-2") just polled. */
export function recordAgentPoll(agentId: string, at?: Date): void {
  lastPollAt.set(agentId, (at ?? new Date()).toISOString());
}

/** ISO timestamp of the last recorded poll for `agentId`, or null if never seen. */
export function getLastPollAt(agentId: string): string | null {
  return lastPollAt.get(agentId) ?? null;
}

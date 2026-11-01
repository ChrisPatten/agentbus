/**
 * The interactive Claude Code adapter's poll loop (`src/adapters/cc.ts`),
 * kept in a side-effect-free module so it can be tested without that
 * entrypoint's config load and stdio server.
 *
 * Every tick: `GET /api/v1/messages/pending?agent=<id>&limit=10`, ack each
 * message, hand the acked ones to `onMessages`, then fire each source
 * channel's typing indicator.
 *
 * E88 — with a launch id (`AGENTBUS_LAUNCH_ID`, set by cc-pool for each pane
 * launch), every poll carries `&launch_id=<id>`. When the bus answers
 * `409 { stale_launch: true }` — cc-pool has since launched a different
 * process for this agent id — the loop logs once and stops for good: this
 * process is left over from an earlier launch and must not take the pane's
 * messages.
 */
import type { HealthState } from '../mcp/tools/index.js';
import type { MessageEnvelope } from '../types/envelope.js';

export const DEGRADED_THRESHOLD = 3;
export const DISCONNECTED_THRESHOLD = 10;
export const BACKOFF_INTERVAL_MS = 5000;

export type PollStopReason = 'shutdown' | 'stale_launch';

export interface PollLoopOptions {
  busBaseUrl: string;
  agentId: string;
  /** E88 — this process's launch id; omitted for adapters not launched by cc-pool. */
  launchId?: string;
  pollIntervalMs: number;
  healthState: HealthState;
  /** Called with each batch of successfully acked messages. */
  onMessages: (acked: MessageEnvelope[]) => void;
  fetchFn?: typeof fetch;
  log?: (line: string) => void;
}

export interface PollLoop {
  /** Stop polling (no further requests are started). */
  stop(): void;
  /** Resolves once the loop has stopped, with why. */
  readonly stopped: Promise<PollStopReason>;
  /** Run one poll now (the loop's own timer also calls this). */
  pollOnce(): Promise<void>;
}

/** The pending-messages URL for one poll. */
export function pendingUrl(busBaseUrl: string, agentId: string, launchId?: string): string {
  const base = `${busBaseUrl}/api/v1/messages/pending?agent=${encodeURIComponent(agentId)}&limit=10`;
  return launchId ? `${base}&launch_id=${encodeURIComponent(launchId)}` : base;
}

/** Start the poll loop; the first poll runs immediately. */
export function startPollLoop(opts: PollLoopOptions): PollLoop {
  // Resolved per call, so a global fetch patched later (installBusTokenFetch) is still used.
  const fetchFn: typeof fetch = opts.fetchFn ?? ((input, init) => fetch(input, init));
  const log = opts.log ?? ((line: string) => console.error(line));
  const { healthState } = opts;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stoppedFlag = false;
  let resolveStopped: (reason: PollStopReason) => void = () => {};
  const stopped = new Promise<PollStopReason>((res) => {
    resolveStopped = res;
  });

  function finish(reason: PollStopReason): void {
    if (stoppedFlag) return;
    stoppedFlag = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    resolveStopped(reason);
  }

  async function pollOnce(): Promise<void> {
    if (stoppedFlag) return;

    try {
      const res = await fetchFn(pendingUrl(opts.busBaseUrl, opts.agentId, opts.launchId));

      if (res.status === 409) {
        const body = (await res.json().catch(() => ({}))) as { stale_launch?: boolean; error?: string };
        if (body.stale_launch || body.error === 'stale_launch') {
          log(
            `[agentbus] Bus reports launch ${opts.launchId ?? '(none)'} of agent:${opts.agentId} is stale — ` +
              `another launch now owns this agent id. Stopping the poll loop; this process gets no more messages.`,
          );
          finish('stale_launch');
          return;
        }
      }

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const data = (await res.json()) as {
        ok: boolean;
        messages: MessageEnvelope[];
        count: number;
      };

      // Ack each message and only buffer those that acked successfully
      const acked: MessageEnvelope[] = [];
      await Promise.all(
        data.messages.map(async (envelope) => {
          try {
            const ackRes = await fetchFn(`${opts.busBaseUrl}/api/v1/messages/${envelope.id}/ack`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ status: 'delivered' }),
            });
            if (ackRes.ok) {
              acked.push(envelope);
            } else {
              log(`[agentbus] ack rejected for ${envelope.id}: HTTP ${ackRes.status}`);
            }
          } catch (err: unknown) {
            log(`[agentbus] ack failed for ${envelope.id}: ${String(err)}`);
          }
        }),
      );

      if (acked.length > 0) {
        opts.onMessages(acked);

        // Now that Claude Code has the messages, signal each source adapter to
        // start its typing indicator. Fire-and-forget — never blocks the poll loop.
        // Email channels have no typing indicator, so skip them.
        for (const envelope of acked) {
          if (envelope.channel === 'email' || envelope.channel.startsWith('email:')) continue;
          fetchFn(`${opts.busBaseUrl}/api/v1/adapters/${envelope.channel}/typing`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contact_id: envelope.sender }),
          }).catch(() => {});
        }
      }

      // Reset health on success
      if (!healthState.busReachable) {
        log('[agentbus] Bus reconnected');
      }
      healthState.busReachable = true;
      healthState.consecutiveFailures = 0;
      healthState.lastPollAt = new Date().toISOString();
      healthState.status = 'healthy';
    } catch (err) {
      healthState.consecutiveFailures++;
      healthState.busReachable = false;

      if (healthState.consecutiveFailures === DEGRADED_THRESHOLD) {
        healthState.status = 'degraded';
        log(
          `[agentbus] Bus unreachable after ${DEGRADED_THRESHOLD} failures — ` +
            `backing off to ${BACKOFF_INTERVAL_MS}ms intervals (${String(err)})`,
        );
      } else if (healthState.consecutiveFailures === DISCONNECTED_THRESHOLD) {
        healthState.status = 'disconnected';
        log(`[agentbus] Disconnected (${DISCONNECTED_THRESHOLD}+ consecutive failures)`);
      }
    }
  }

  async function tick(): Promise<void> {
    await pollOnce();
    if (stoppedFlag) return;
    const nextInterval =
      healthState.consecutiveFailures >= DEGRADED_THRESHOLD ? BACKOFF_INTERVAL_MS : opts.pollIntervalMs;
    timer = setTimeout(() => {
      void tick();
    }, nextInterval);
  }

  void tick();

  return {
    stop: () => finish('shutdown'),
    stopped,
    pollOnce,
  };
}

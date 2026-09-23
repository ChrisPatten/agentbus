/**
 * S48.5 — pool manager: ties `LeaseStore` and `PaneLifecycle` together and
 * answers the one question the rest of the pipeline needs — "which concrete
 * pane agent id should this conversation be delivered to, right now?" (E48).
 *
 * See src/pool/types.ts's module doc for the agent-id prefix convention
 * (bare vs. "agent:"-prefixed) and the session-id lifecycle split this
 * module has to keep straight: `pool_leases.claude_session_id` is a
 * transient, pane-scoped cache; `sessions.claude_session_id` is the durable,
 * conversation-scoped record cc-headless also writes (see
 * src/adapters/cc-headless.ts's storeClaudeSessionId/getActiveSession).
 *
 * Architecture reminder: there is no AdapterInstance/registry.send() path
 * for agent-bound message routing in this codebase — delivery is pure
 * string-match polling convention (queue.enqueue() with
 * recipient = route.recipientId; GET /api/v1/messages/pending?agent=<bare
 * id> picks it up). This module's job is narrow and specific: given a
 * conversation, decide (and make ready) which pane's agent id should
 * receive it, and hand that id back so the caller
 * (src/pipeline/stages/pool-route-resolve.ts) can rewrite the route's
 * recipientId before fan-out enqueues. PoolManager never touches the
 * queue/enqueue machinery itself, and never talks to tmux directly — all
 * pane mechanics go through the injected `PaneLauncher` seam.
 */
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { getCcPoolInstances, type AppConfig, type CcPoolInstanceConfig } from '../config/schema.js';
import { LeaseStore } from './lease-store.js';
import { PaneLifecycle, type LaunchParams } from './pane.js';
import { createTmuxController, realTmuxExec, type TmuxController } from './tmux.js';
import { PaneWatchdog } from './watchdog.js';
import { resolveWatchdogConfig } from './watchdog-config.js';
import { IncidentStore } from './watchdog-store.js';
import { derivePaneAgentId, derivePaneWindowName, toBareAgentId, toPrefixedAgentId } from './types.js';
import type { JournalingRunner } from '../memory/session-tracker.js';
import type { MessageQueue } from '../core/queue.js';

/** Footer line of Claude Code's interactive permission dialog ("Esc to cancel · Tab to amend"), observed in live captures — see the E51 epic. */
const PERMISSION_DIALOG_PATTERN = /esc to cancel/i;

/**
 * S48.7 tuning constants — not exposed via config (mirrors LAUNCH_READY_TIMEOUT_MS
 * in pane.ts, which is also a fixed constant rather than a config field).
 */
/** Default interval (ms) for start()'s recurring sweepHardIdle()+drainParked() tick. */
const DEFAULT_SWEEP_INTERVAL_MS = 60_000;
/** Max parked messages processed per drainParked() call, to bound one tick's work. */
const PARK_DRAIN_BATCH_SIZE = 20;
/** Tail length (lines) captured from a dead pane for reconcileLiveness()'s restart notice. */
const RECONCILE_CAPTURE_LINES = 50;

/**
 * The minimal surface `PoolManager` needs from something that can launch and
 * release a pane. `PaneLifecycle` satisfies this structurally (TypeScript
 * structural typing — no explicit `implements` needed). Exists purely as a
 * testing seam: tests inject a fake here instead of a real `PaneLifecycle`,
 * so PoolManager's own orchestration logic (lease decisions, sessions-table
 * bookkeeping, parking) is tested in isolation from tmux/claude-launch
 * mechanics, which are already covered by `pane.test.ts`.
 */
export interface PaneLauncher {
  launch(params: LaunchParams): Promise<void>;
  release(paneId: string, onEvict: 'clear' | 'kill'): Promise<void>;
}

export interface PoolManagerDeps {
  cfg: CcPoolInstanceConfig;
  db: Database.Database;
  busBaseUrl: string;
  /** Injectable for tests. Defaults to a real TmuxController when omitted.
   *  Resolved unconditionally — even when `paneLauncher` is also given —
   *  and kept as its own field on `PoolManager`: `reconcileLiveness()`
   *  (S48.7) needs `paneAlive()`/`capturePane()` directly, and
   *  `PaneLauncher`'s own narrow interface only exposes `launch()`/
   *  `release()`. When `paneLauncher` is NOT injected, this same instance
   *  is also the one wired into the internally-constructed `PaneLifecycle`. */
  tmux?: TmuxController;
  /** Injectable for tests — defaults to constructing a real `PaneLifecycle`
   *  wired to `tmux`/`busBaseUrl`/`cfg`. */
  paneLauncher?: PaneLauncher;
  scratchDir?: string;
  /**
   * Message queue, used by `drainParked()` (S48.7) to dequeue/ack/enqueue/
   * dead-letter parked messages. Optional — rather than required — purely
   * so `createPoolManagers()`'s existing signature/behavior stays untouched
   * by this story: a `PoolManager` built without one still works for
   * `resolveRoute()`/`reconcileLiveness()`/`sweepHardIdle()`; `drainParked()`
   * just logs and no-ops. A later story (the same one that wires
   * `PoolManager` into index.ts's runtime) should thread a real queue
   * through `createPoolManagers()`.
   */
  queue?: MessageQueue;
  /** Injectable fetch for tests — defaults to global fetch. Used by
   *  `notifySystem()` to POST the `channel: 'system'` restart/parked notice
   *  to `busBaseUrl + '/api/v1/inbound'`. Mirrors pane.ts's
   *  `PaneLifecycleDeps.fetchFn` convention. */
  fetchFn?: typeof fetch;
  /** Override for the recurring `sweepHardIdle()`+`drainParked()` interval
   *  `start()` schedules. Defaults to `DEFAULT_SWEEP_INTERVAL_MS` (60s). */
  sweepIntervalMs?: number;
  /** Injectable for tests — defaults to a `PaneWatchdog` built from `cfg.watchdog`. */
  watchdog?: PaneWatchdog;
}

/**
 * Row shape read back from `sessions`. Mirrors (does not import)
 * `getActiveSession()`'s query in src/adapters/cc-headless.ts, trimmed to
 * the two columns this module needs.
 */
interface ActiveSessionRow {
  id: string;
  claude_session_id: string | null;
}

export class PoolManager {
  /** = cfg.agent_id (bare) — validated unique across instances already by getCcPoolInstances. */
  readonly poolId: string;
  readonly leaseStore: LeaseStore;
  /** E52 stall detector; started/stopped with the manager. */
  readonly watchdog: PaneWatchdog;
  /** Permanent, deliberate no-op — see the constructor assignment below for the full rationale. */
  readonly journalingRunner: JournalingRunner;

  private readonly cfg: CcPoolInstanceConfig;
  private readonly db: Database.Database;
  private readonly paneLauncher: PaneLauncher;
  private readonly tmux: TmuxController;
  private readonly busBaseUrl: string;
  private readonly queue: MessageQueue | undefined;
  private readonly fetchFn: typeof fetch;
  private readonly sweepIntervalMs: number;
  /** conversationIds already notified about a parked-timeout dead-letter, so
   *  drainParked() sends at most one notice per conversation. In-memory
   *  only — resets on process restart — and entries are never pruned (a
   *  conversation that later resolves and re-exhausts the pool will not be
   *  notified again for the remainder of this process's life). Documented
   *  tradeoff, not an oversight — see this story's report. */
  private readonly notifiedParkTimeout = new Set<string>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(deps: PoolManagerDeps) {
    this.cfg = deps.cfg;
    this.db = deps.db;
    this.poolId = deps.cfg.agent_id;
    this.leaseStore = new LeaseStore(deps.db);
    this.busBaseUrl = deps.busBaseUrl;
    this.queue = deps.queue;
    this.fetchFn = deps.fetchFn ?? fetch;
    this.sweepIntervalMs = deps.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;

    // Resolved unconditionally (even when paneLauncher is injected) so
    // reconcileLiveness() always has a TmuxController to call
    // paneAlive()/capturePane() on directly — see PoolManagerDeps.tmux's own
    // doc comment for the full rationale.
    this.tmux = deps.tmux ?? createTmuxController(realTmuxExec);

    if (deps.paneLauncher) {
      this.paneLauncher = deps.paneLauncher;
    } else {
      // Shared-by-default scratch dir is safe across multiple pool
      // instances: every file PaneLifecycle writes into it is named with a
      // fresh randomUUID() (see pane.ts/mcp-config.ts), so no two pools (or
      // two panes within one pool) can collide on a filename.
      this.paneLauncher = new PaneLifecycle({
        tmux: this.tmux,
        busBaseUrl: deps.busBaseUrl,
        cfg: deps.cfg,
        scratchDir: deps.scratchDir ?? join(tmpdir(), 'agentbus-pool-scratch'),
      });
    }

    // Permanent, deliberate no-op — not a placeholder to fill in later.
    //
    // Pool-managed sessions are interactive and long-lived: a human, or the
    // live `claude` process already running in the pane, can update its own
    // memory files directly at any time. Unlike cc-headless's batch
    // `claude -p` turns — which have no ambient session to journal from
    // between invocations, hence the silent `--resume` journaling turn —
    // there is no out-of-band turn this bus process could productively fire
    // for a pool pane.
    //
    // It still has to be registered. src/pool/types.ts's module doc explains
    // why `sessions.claude_session_id` is deliberately written for
    // pool-owned sessions (not left NULL): doing so opts them INTO
    // `SessionTracker.dispatchJournaling()`'s base candidate query
    // (`claude_session_id IS NOT NULL AND ...`), same as cc-headless
    // sessions. `registerJournalingRunner()` requires *a* callable for
    // whatever key it's registered under, so this exists to be that
    // callable — a safe, correct default if it is ever actually invoked.
    //
    // Verified directly against src/memory/session-tracker.ts (not
    // assumed): as `dispatchJournaling()` is written today, a pool
    // session's runner is NOT actually reachable yet. Per-session dispatch
    // resolves the owning instance via `instanceByAgentId`, which is built
    // exclusively from `getCcHeadlessInstances(this.config)` — cc-pool
    // instances are never in that map. So for a session whose `agent_id` is
    // a pool pane's id (e.g. "agent:peggy-pool-3"), `instCfg` is
    // `undefined` and the loop `continue`s before it even looks up
    // `journalingRunners.get(agentKey)` — a registered pool runner is inert
    // today regardless of this function's body. Closing that gap (teaching
    // `dispatchJournaling()` to also consult `getCcPoolInstances()`)
    // touches session-tracker.ts, which is outside this story's file list —
    // left for the story that wires `PoolManager` into
    // index.ts/SessionTracker.
    this.watchdog =
      deps.watchdog ??
      new PaneWatchdog({
        poolId: this.poolId,
        leaseStore: this.leaseStore,
        tmux: this.tmux,
        db: deps.db,
        incidentStore: new IncidentStore(deps.db),
        cfg: resolveWatchdogConfig(deps.cfg.watchdog),
      });

    this.journalingRunner = async (_conversationId: string) => {
      return { skipped: true };
    };
  }

  /**
   * Idempotent cold-start: for each of `cfg.panes` pane slots (1-based index
   * 1..panes), derive its pane id (`${cfg.tmux_session}:${derivePaneWindowName(i)}`)
   * and its own concrete agent id
   * (`toPrefixedAgentId(derivePaneAgentId(cfg.agent_id, i))`), then seed a
   * `free` `pool_leases` row for each via `leaseStore.seedPanes()` — a no-op
   * for any pane that already has a row (any state), so calling this more
   * than once never duplicates or resets rows.
   *
   * Deliberately does NOT talk to tmux, directly or via `paneLauncher`, and
   * does NOT launch `claude` in any pane: `PaneLauncher` only exposes
   * `launch()` (which launches a live Claude session, not just a bare
   * window) and `release()` — there is no "create an empty window"
   * primitive to call here even if this method wanted one. The tmux window
   * and the `claude` process for a given pane are both created lazily,
   * together, the first time `resolveRoute()` claims that pane for a
   * conversation (via `PaneLifecycle.launch()`'s own `ensureWindowExists()`
   * step). This method's only job is making sure `pool_leases` has a row
   * for `acquire()` to find.
   *
   * (A later story, S48.7, hardens this for a warm restart where
   * windows/claude processes already exist — this only handles the
   * cold-start/nothing-exists-yet case. No reconciliation beyond "seed rows
   * for the panes list, idempotently.")
   */
  async ensureStarted(): Promise<void> {
    const panes: Array<{ paneId: string; agentId: string }> = [];
    for (let i = 1; i <= this.cfg.panes; i++) {
      panes.push({
        paneId: `${this.cfg.tmux_session}:${derivePaneWindowName(i)}`,
        agentId: toPrefixedAgentId(derivePaneAgentId(this.cfg.agent_id, i)),
      });
    }
    this.leaseStore.seedPanes(this.poolId, panes);
  }

  /**
   * THE core method — called once per inbound envelope by
   * `src/pipeline/stages/pool-route-resolve.ts`. Returns the concrete
   * `agent:...`-prefixed recipientId the caller should rewrite
   * `route.recipientId` to. NEVER throws — every failure path degrades to
   * the parked-bucket id rather than propagating, since this runs inline in
   * inbound message processing and must not take down the pipeline. The
   * outer try/catch is a defensive backstop beyond the specific failure
   * paths handled below (e.g. an unexpected DB error) — it should not
   * normally trigger.
   */
  async resolveRoute(
    conversationId: string,
    promptContext: { contact_id: string; channel: string; topic?: string },
  ): Promise<string> {
    try {
      const result = this.leaseStore.acquire(this.poolId, conversationId, {
        poolAgentId: this.cfg.agent_id,
        panes: this.cfg.panes,
        maxPanes: this.cfg.max_panes ?? this.cfg.panes,
        growth: this.cfg.growth,
        idleEvictMs: this.cfg.lease.idle_evict_ms,
      });

      if (result.kind === 'reuse') {
        // acquire()'s own reuse branch already bumps last_activity_at in the
        // same transaction (verified by reading lease-store.ts directly) —
        // no separate touch() call needed here.
        return result.lease.agent_id;
      }

      if (result.kind === 'exhausted') {
        return this.parkedRecipientId();
      }

      if (result.kind === 'evict') {
        // The DB-side claim already happened atomically inside acquire() —
        // a failed /clear or kill on the displaced occupant must not block
        // seating the new conversation.
        try {
          await this.paneLauncher.release(result.lease.pane_id, this.cfg.on_evict);
        } catch (err) {
          console.error(
            `[pool:${this.poolId}] Failed to release evicted pane ${result.lease.pane_id} ` +
              `(on_evict=${this.cfg.on_evict}) — proceeding to seat the new conversation anyway:`,
            err,
          );
        }
      }

      // bound | grow | evict-fallthrough: launch/resume Claude in the claimed pane.
      const lease = result.lease;

      const priorRow = this.getActiveSessionRow(conversationId);
      const sessionId = priorRow?.claude_session_id ?? randomUUID();
      const resume = priorRow?.claude_session_id != null;

      // Every non-reuse outcome (bound/grow/evict) is about to block on a
      // real launch — the ack handshake + readiness poll below can take
      // several seconds, up to the 30s launch timeout. Fire a "One moment"
      // placeholder now, before that wait, so the user sees something
      // immediately instead of silence; the pane's own tool-status hook (or
      // its final reply, if no tool calls happen) then replaces it once real
      // activity starts. Fire-and-forget — must never add to launch latency.
      this.notifyColdStart(promptContext.channel, promptContext.contact_id, promptContext.topic);

      try {
        await this.paneLauncher.launch({
          paneId: lease.pane_id,
          paneAgentId: toBareAgentId(lease.agent_id),
          promptContext,
          sessionId,
          resume,
          ensureWindow: {
            cwd: this.cfg.working_dir ?? process.cwd(),
            env: this.cfg.pane_env,
          },
        });
      } catch (err) {
        console.error(
          `[pool:${this.poolId}] Pane launch failed for ${lease.pane_id} — marking dead and parking ` +
            `conversation ${conversationId}:`,
          err,
        );
        this.leaseStore.markDead(this.poolId, lease.pane_id);
        return this.parkedRecipientId();
      }

      this.leaseStore.confirmReady(this.poolId, lease.pane_id);
      this.leaseStore.setClaudeSessionId(this.poolId, lease.pane_id, sessionId);

      if (priorRow) {
        this.db.prepare(`UPDATE sessions SET claude_session_id = ? WHERE id = ?`).run(sessionId, priorRow.id);
      } else {
        // No `sessions` row exists yet for this conversation — Stage 80
        // (transcript-log) hasn't run for this envelope yet; it runs later
        // in the same pipeline pass and will INSERT the row itself (with
        // claude_session_id left NULL, since it has no way to know the id
        // we just minted here). Re-check once for a race (another resolver
        // creating the row between our lookup above and here) before giving
        // up — `sessions` has no unique constraint on conversation_id alone
        // (confirmed by reading src/db/migrations/001_initial_schema.sql:
        // only a non-unique `idx_sess_conversation` index), so there is no
        // safe `INSERT ... ON CONFLICT(conversation_id)` to fall back on.
        const raceRow = this.getActiveSessionRow(conversationId);
        if (raceRow) {
          this.db.prepare(`UPDATE sessions SET claude_session_id = ? WHERE id = ?`).run(sessionId, raceRow.id);
        }
        // TODO(E48-S48.6 or a later follow-up): this conversation's
        // first-ever pool message leaves its minted claude_session_id
        // living only in pool_leases (via setClaudeSessionId above) until
        // its NEXT message arrives — Stage 80 creates the `sessions` row
        // with claude_session_id NULL, and nothing currently backfills it
        // on that first row. Teach Stage 80 (src/pipeline/stages/
        // transcript-log.ts) to consult LeaseStore.findByConversation() /
        // pool_leases for an already-minted claude_session_id when it
        // INSERTs a brand-new row, instead of always defaulting that column
        // to NULL. Until then this is a narrow, self-healing gap: the `if
        // (priorRow)` branch above fixes the row up on the conversation's
        // second message.
      }

      return lease.agent_id;
    } catch (err) {
      console.error(
        `[pool:${this.poolId}] resolveRoute failed unexpectedly for conversation ${conversationId} — parking:`,
        err,
      );
      return this.parkedRecipientId();
    }
  }

  /**
   * S51.4 (E51) — resolve a pending interactive-approval request against
   * THIS pool by sending the mapped keystroke into agentId's CURRENT lease.
   * Re-resolves the lease at answer time (not cached from when the request
   * was raised) — the one thing the Sep 20 partial turn-ended fix didn't do
   * for the mid-turn lease-reassignment case, and exactly the bug this epic
   * exists to close (see the epic's Risks section).
   *
   * `approve` sends `Enter` (accepts the pre-highlighted default option,
   * observed to be the least-destructive "Yes" in both real dialog
   * instances this epic's keystroke mapping is based on); `deny` sends
   * `Escape` (the dialog's own documented cancel key).
   *
   * Returns `'resolved'` after sending the keystroke, or `'stale'` (no
   * keystroke sent) when: no lease row exists for `agentId` in this pool,
   * the row isn't currently `leased`, (`expectedConversationId` given) the
   * lease has moved on to a different conversation since the request was
   * raised, or the pane no longer shows a permission dialog — someone
   * already answered it at the terminal, or the turn moved on. That last
   * check matters because `Escape` sent to a pane that is NOT at a dialog
   * interrupts its live turn, and `Enter` would submit whatever is in its
   * input box.
   */
  async resolveApproval(
    agentId: string,
    expectedConversationId: string | null,
    decision: 'approve' | 'deny',
  ): Promise<{ result: 'resolved'; key: string } | { result: 'stale'; reason: string }> {
    const leaseRow = this.leaseStore.findByAgent(this.poolId, toPrefixedAgentId(agentId));
    if (!leaseRow || leaseRow.state !== 'leased') return { result: 'stale', reason: 'pane is no longer leased' };
    if (expectedConversationId && leaseRow.conversation_id !== expectedConversationId) {
      return { result: 'stale', reason: 'pane lease moved to another conversation' };
    }

    const screen = await this.tmux.capturePane(leaseRow.pane_id, 30);
    if (!PERMISSION_DIALOG_PATTERN.test(screen)) {
      return { result: 'stale', reason: 'no permission dialog showing in the pane' };
    }

    const key = decision === 'approve' ? 'Enter' : 'Escape';
    await this.tmux.sendKeys(leaseRow.pane_id, key);
    return { result: 'resolved', key };
  }

  /**
   * `toPrefixedAgentId(`${cfg.agent_id}__parked`)` — the synthetic recipient
   * id nothing ever polls. A later story's sweep timer drains it by
   * dequeuing from this id and retrying `resolveRoute`. Exposed as a method
   * (not a stored field) so it's trivially derivable by other modules
   * without holding a `PoolManager` reference — pure function of `cfg`.
   */
  parkedRecipientId(): string {
    return toPrefixedAgentId(`${this.cfg.agent_id}__parked`);
  }

  /**
   * Read-only snapshot of the parked queue — for observability (S48.8's
   * `/pool` command and `GET /api/v1/pool` route), NOT for draining.
   * Deliberately a raw query against `db` rather than
   * `MessageQueue.dequeue()`, which mutates matched rows to `processing` —
   * unsafe to call from a status view. `MessageQueue` has no read-only
   * "peek" equivalent, so this stays a small local query here rather than
   * adding one to `src/core/queue.ts`.
   */
  parkedStatus(): { count: number; oldestParkedAt: string | null } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count, MIN(created_at) AS oldest
         FROM message_queue WHERE recipient = ? AND status = 'pending'`,
      )
      .get(this.parkedRecipientId()) as { count: number; oldest: string | null };
    return { count: row.count, oldestParkedAt: row.oldest };
  }

  /**
   * Mirrors (does not import) `getActiveSession()`'s query shape in
   * src/adapters/cc-headless.ts, trimmed to the columns this module needs.
   */
  private getActiveSessionRow(conversationId: string): ActiveSessionRow | undefined {
    return this.db
      .prepare(
        `SELECT id, claude_session_id FROM sessions
         WHERE conversation_id = ? AND ended_at IS NULL
         ORDER BY started_at DESC LIMIT 1`,
      )
      .get(conversationId) as ActiveSessionRow | undefined;
  }

  // ── S48.7: startup reconciliation, hard-idle sweep, park-queue drain ───────

  /**
   * Idempotent reconciliation pass — run once right after `ensureStarted()`
   * at startup, AND on every recurring sweep tick (see `sweepTick()`), not
   * just once. A crash between two ticks would otherwise go unnoticed until
   * the next full bus-core restart, silently stranding that pane for
   * however long the process happens to stay up.
   *
   * For every row with state 'leased' or 'draining', checks whether its
   * tmux window is still alive. A live pane is adopted as-is — left
   * completely untouched — so a bus-core restart doesn't interrupt a
   * conversation already flowing to it. A pane whose window has vanished is
   * the crash-recovery case: capture whatever pane output remains
   * (best-effort), free the row (the conversation's `claude_session_id` is
   * preserved in `sessions`, so it resumes correctly wherever it's next
   * claimed), and fire a restart notice.
   *
   * For every row with state 'dead' (a previous launch attempt failed —
   * see `resolveRoute()`'s catch path): `dead` is otherwise a permanent
   * dead end — `LeaseStore.acquire()` never selects a `dead` row, so
   * without this, one transient launch failure (a momentary CLI hiccup, a
   * network blip during the ack handshake) permanently costs the pool one
   * pane of capacity, forever, even across restarts. Recover it: best-effort
   * `tmux.killWindow()` (a failed launch may have left a partially-started
   * window behind — clear it so the pane starts clean next time; errors are
   * swallowed the same way a "window already gone" kill is elsewhere),
   * then release the row back to 'free'.
   *
   * A 'free' row is left alone WITHOUT ever calling `tmux.paneAlive()` on
   * it — a free pane with no live window is the normal, expected steady
   * state for any pane that hasn't been claimed yet (`ensureStarted()` only
   * seeds DB rows; tmux windows/claude processes are created lazily on
   * first claim — see that method's own doc comment), not a problem to fix.
   * A 'launching' row is left alone too — it's mid-claim, handled by
   * whichever `resolveRoute()` call is already in flight for it.
   */
  async reconcileLiveness(): Promise<void> {
    const allRows = this.leaseStore.list(this.poolId);

    const liveCheckRows = allRows.filter((row) => row.state === 'leased' || row.state === 'draining');
    for (const row of liveCheckRows) {
      try {
        const alive = await this.tmux.paneAlive(row.pane_id);
        if (alive) continue; // adopted as-is — completely untouched

        // Crash-recovery case: the tmux window backing a leased/draining
        // row has vanished. Capture whatever pane output remains,
        // best-effort — a capture failure must not block recovering the
        // row itself.
        let tail = '';
        try {
          tail = await this.tmux.capturePane(row.pane_id, RECONCILE_CAPTURE_LINES);
        } catch (err) {
          console.error(`[pool:${this.poolId}] reconcileLiveness: capturePane failed for ${row.pane_id}:`, err);
        }

        const conversationId = row.conversation_id ?? 'unknown';
        this.leaseStore.release(this.poolId, row.pane_id);

        const snippet = tail.trim();
        const body =
          `[pool:${this.poolId}] Pane ${row.pane_id} was found dead on reconciliation ` +
          `(was serving conversation ${conversationId}) and has been released — its session will ` +
          `resume correctly wherever it is next claimed.` +
          (snippet ? `\n\nLast pane output:\n${snippet}` : '');
        await this.notifySystem(body);
      } catch (err) {
        console.error(`[pool:${this.poolId}] reconcileLiveness: failed to reconcile pane ${row.pane_id}:`, err);
      }
    }

    const deadRows = allRows.filter((row) => row.state === 'dead');
    for (const row of deadRows) {
      try {
        try {
          await this.tmux.killWindow(row.pane_id);
        } catch (err) {
          console.error(`[pool:${this.poolId}] reconcileLiveness: killWindow failed for dead pane ${row.pane_id}:`, err);
        }
        this.leaseStore.release(this.poolId, row.pane_id);
      } catch (err) {
        console.error(`[pool:${this.poolId}] reconcileLiveness: failed to revive dead pane ${row.pane_id}:`, err);
      }
    }
  }

  /**
   * Hard-idle release: for every 'leased' row idle past
   * `cfg.lease.hard_idle_ms`, runs the exact same release sequence
   * `resolveRoute()`'s evict path uses for a displaced pane —
   * `paneLauncher.release(pane_id, cfg.on_evict)` (best-effort: a rejection
   * is logged and does not stop the sweep) then
   * `leaseStore.release(poolId, pane_id)`. Unlike `acquire()`'s LRU
   * eviction (which only reassigns an idle pane when a NEW conversation
   * needs it), this proactively frees idle panes even when nothing is
   * waiting, so a pool doesn't sit fully "leased" forever on stale
   * conversations.
   */
  async sweepHardIdle(): Promise<void> {
    const cutoffIso = new Date(Date.now() - this.cfg.lease.hard_idle_ms).toISOString();
    const idleRows = this.leaseStore.findIdleOlderThan(this.poolId, cutoffIso);

    for (const row of idleRows) {
      try {
        await this.paneLauncher.release(row.pane_id, this.cfg.on_evict);
      } catch (err) {
        console.error(
          `[pool:${this.poolId}] sweepHardIdle: failed to release pane ${row.pane_id} ` +
            `(on_evict=${this.cfg.on_evict}) — freeing the lease anyway:`,
          err,
        );
      }
      this.leaseStore.release(this.poolId, row.pane_id);
    }
  }

  /**
   * Park-queue draining. Dequeues a batch from `parkedRecipientId()` and
   * retries `resolveRoute()` for each. A message that now resolves to a
   * real pane is re-addressed and re-enqueued there. A message that's still
   * exhausted is re-parked (carrying forward when it was first parked)
   * unless it has now been parked longer than `cfg.lease.park_timeout_ms`,
   * in which case it is dead-lettered and — once per conversation — a
   * system notice is sent.
   *
   * Requires an injected `queue` (`PoolManagerDeps.queue`) — see that
   * field's doc comment for why it's optional there. Logs and no-ops
   * without one.
   */
  async drainParked(): Promise<void> {
    if (!this.queue) {
      console.error(`[pool:${this.poolId}] drainParked: no queue injected — skipping (see PoolManagerDeps.queue)`);
      return;
    }
    const queue = this.queue;

    const parked = queue.dequeue(this.parkedRecipientId(), undefined, PARK_DRAIN_BATCH_SIZE);

    for (const { messageId, envelope } of parked) {
      try {
        const conversationId = envelope.metadata['conversation_id'];
        if (typeof conversationId !== 'string' || conversationId.length === 0) {
          // Shouldn't happen — every enqueued envelope is stamped with
          // metadata.conversation_id by the inbound fan-out loop
          // (src/http/api.ts's processInbound). Defensive fallback only:
          // dead-letter rather than leave the row stuck in 'processing'.
          console.error(
            `[pool:${this.poolId}] drainParked: message ${messageId} has no metadata.conversation_id — dead-lettering`,
          );
          queue.deadLetter(messageId, 'pool drainParked: missing conversation_id in metadata');
          continue;
        }

        // Same stripping convention as pipeline/stages/pool-route-resolve.ts.
        const contactId = envelope.sender.startsWith('contact:')
          ? envelope.sender.slice('contact:'.length)
          : envelope.sender;

        const resolved = await this.resolveRoute(conversationId, {
          contact_id: contactId,
          channel: envelope.channel,
        });

        if (resolved !== this.parkedRecipientId()) {
          // A pane became available — re-address this exact message to it.
          // The old row's id can't be reused for the new enqueue (ack()
          // below flips its status to 'delivered', it does not delete the
          // row), so mint a fresh id — the same "same-content, different
          // id" approach api.ts's fan-out loop uses when it re-addresses a
          // copy for a second route target.
          queue.ack(messageId);
          queue.enqueue({ ...envelope, id: randomUUID(), recipient: resolved });
          continue;
        }

        // Still exhausted. Stamp pool_parked_since the FIRST time this
        // message is (re)parked; carry it forward unchanged on every
        // subsequent pass so the timeout clock starts once, not on every
        // retry.
        const existingStamp = envelope.metadata['pool_parked_since'];
        const parkedSince = typeof existingStamp === 'string' ? existingStamp : new Date().toISOString();
        const metadata = { ...envelope.metadata, pool_parked_since: parkedSince };

        const parkedMs = Date.now() - new Date(parkedSince).getTime();
        if (parkedMs > this.cfg.lease.park_timeout_ms) {
          // Terminal: this message will never be delivered. deadLetter()
          // ALONE is the correct terminal call here — not ack()-then-
          // deadLetter(). Read directly from src/core/queue.ts: ack() only
          // flips status 'processing' -> 'delivered' (it never deletes the
          // row), while deadLetter() has NO status precondition at all —
          // its SELECT/INSERT-into-dead_letter/DELETE-from-message_queue
          // sequence works against the row regardless of current status.
          // So deadLetter() alone fully and correctly finalizes the row;
          // calling ack() first would be redundant AND semantically wrong
          // (it would falsely mark a never-delivered message 'delivered',
          // if only for an instant before deadLetter() deletes the row).
          queue.deadLetter(messageId, 'pool exhausted — parked timeout exceeded');

          if (!this.notifiedParkTimeout.has(conversationId)) {
            this.notifiedParkTimeout.add(conversationId);
            await this.notifySystem(
              `[pool:${this.poolId}] This conversation's pool has been full for over ` +
                `${this.cfg.lease.park_timeout_ms}ms — a message could not be delivered and was dropped ` +
                `(conversation ${conversationId}).`,
            );
          }
          continue;
        }

        // Still within the timeout — re-enqueue onto the parked bucket for
        // the next sweep tick to retry, carrying the pool_parked_since
        // stamp forward. This trades a small amount of enqueue/ack churn
        // for not needing any change to src/core/queue.ts (out of scope
        // for this story).
        queue.ack(messageId);
        queue.enqueue({ ...envelope, id: randomUUID(), recipient: this.parkedRecipientId(), metadata });
      } catch (err) {
        console.error(`[pool:${this.poolId}] drainParked: failed to process parked message ${messageId}:`, err);
      }
    }
  }

  /**
   * Runs `reconcileLiveness()` once (only meaningful right after startup —
   * safe but wasteful to call repeatedly, so it happens here in `start()`,
   * not on every recurring tick), then starts a recurring interval
   * (`sweepIntervalMs` from the constructor deps, default
   * `DEFAULT_SWEEP_INTERVAL_MS` = 60s) that runs `sweepHardIdle()` then
   * `drainParked()` on every tick. Errors from any of the three are logged,
   * not thrown, so one bad call/tick doesn't kill the timer or abort
   * startup. No-op if already started (guards against creating two
   * overlapping intervals).
   */
  start(): void {
    if (this.running) return;
    this.running = true;

    this.reconcileLiveness().catch((err) => {
      console.error(`[pool:${this.poolId}] Startup reconcileLiveness() failed:`, err);
    });

    this.sweepTimer = setInterval(() => {
      void this.sweepTick();
    }, this.sweepIntervalMs);

    this.watchdog.start();
  }

  /** Clears the interval from start(). No-op if not started. */
  stop(): void {
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.watchdog.stop();
    this.running = false;
  }

  /** One recurring tick's worth of work — see start(). Each phase is caught
   *  independently so a failure in sweepHardIdle() doesn't prevent
   *  drainParked() from still running in the same tick. */
  private async sweepTick(): Promise<void> {
    try {
      await this.reconcileLiveness();
    } catch (err) {
      console.error(`[pool:${this.poolId}] reconcileLiveness() tick failed:`, err);
    }
    try {
      await this.sweepHardIdle();
    } catch (err) {
      console.error(`[pool:${this.poolId}] sweepHardIdle() tick failed:`, err);
    }
    try {
      await this.drainParked();
    } catch (err) {
      console.error(`[pool:${this.poolId}] drainParked() tick failed:`, err);
    }
  }

  /**
   * POSTs a `channel: 'system'` inbound notice. Used by
   * `reconcileLiveness()` (recovered-dead pane) and `drainParked()`
   * (timed-out parked message). Body shape confirmed directly against
   * src/http/api.ts's `InboundSchemaObject`/`InboundMessage` (not just the
   * watchdog script's assumed shape): `channel`/`sender` are any non-empty
   * strings, `payload` is the standard `{ type: 'text', body }` payload.
   * Errors are logged, not thrown — a notice failure must not abort the
   * surrounding reconciliation/drain work.
   */
  private async notifySystem(body: string): Promise<void> {
    try {
      await this.fetchFn(`${this.busBaseUrl}/api/v1/inbound`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel: 'system',
          sender: `pool-manager:${this.poolId}`,
          payload: { type: 'text', body },
        }),
      });
    } catch (err) {
      console.error(`[pool:${this.poolId}] Failed to post system notice: ${String(err)}`);
    }
  }

  /**
   * Fire-and-forget "One moment" placeholder for a cold-starting launch —
   * posted through the same `POST /api/v1/adapters/:channel/tool-status`
   * endpoint `reportToolCall()`'s real tool-call lines use (`placeholder:
   * true`), so it's subject to the same capability check and no-ops
   * silently on any channel that doesn't support it, exactly like a real
   * tool-status line. Deliberately not awaited by the caller — this must
   * never add to launch latency, which is already budgeted up to 30s. A
   * failure here is logged and otherwise inconsequential: the user just
   * doesn't see the placeholder, launch proceeds unaffected either way.
   */
  private notifyColdStart(channel: string, contactId: string, topic: string | undefined): void {
    void this.fetchFn(`${this.busBaseUrl}/api/v1/adapters/${channel}/tool-status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contact_id: contactId, text: 'One moment…', topic, placeholder: true }),
    }).catch((err) => {
      console.error(`[pool:${this.poolId}] Failed to post cold-start placeholder: ${String(err)}`);
    });
  }
}

/**
 * Construct one `PoolManager` per configured `cc-pool` instance. Convenience
 * factory for index.ts wiring (a later story) — NOT called by anything in
 * this story. `busBaseUrl` is passed through to every instance uniformly
 * (all instances share one bus-core process, per the existing cc-headless
 * pattern).
 */
export function createPoolManagers(
  config: AppConfig,
  db: Database.Database,
  busBaseUrl: string,
  queue?: MessageQueue,
): Map<string, PoolManager> {
  const managers = new Map<string, PoolManager>();
  for (const cfg of getCcPoolInstances(config)) {
    managers.set(toPrefixedAgentId(cfg.agent_id), new PoolManager({ cfg, db, busBaseUrl, queue }));
  }
  return managers;
}

/**
 * S51.4 (E51) — find the `PoolManager` instance that currently owns a lease
 * row for `agentId` (bare or prefixed), across every configured pool. A pane
 * agent id is unique to the pool that derived it (see
 * `derivePaneAgentId`/types.ts's module doc), so at most one manager's
 * `leaseStore` will ever have a matching row — this just saves the caller
 * (the `POST /api/v1/approvals/:id/resolve` handler) from having to know or
 * guess which configured pool a request's `agent_id` belongs to. Returns
 * `undefined` if no configured pool has ever seeded a row for this agentId.
 */
export function findPoolManagerForAgent(
  poolManagers: Map<string, PoolManager>,
  agentId: string,
): PoolManager | undefined {
  const prefixed = toPrefixedAgentId(agentId);
  for (const manager of poolManagers.values()) {
    if (manager.leaseStore.findByAgent(manager.poolId, prefixed)) {
      return manager;
    }
  }
  return undefined;
}

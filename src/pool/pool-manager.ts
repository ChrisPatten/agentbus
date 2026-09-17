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
import { derivePaneAgentId, derivePaneWindowName, toBareAgentId, toPrefixedAgentId } from './types.js';
import type { JournalingRunner } from '../memory/session-tracker.js';

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
  /** Injectable for tests. Defaults to a real TmuxController when omitted AND
   *  `paneLauncher` is also omitted (if `paneLauncher` is given, `tmux` is
   *  unused — PoolManager never talks to tmux directly, only through the
   *  launcher). */
  tmux?: TmuxController;
  /** Injectable for tests — defaults to constructing a real `PaneLifecycle`
   *  wired to `tmux`/`busBaseUrl`/`cfg`. */
  paneLauncher?: PaneLauncher;
  scratchDir?: string;
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
  /** Permanent, deliberate no-op — see the constructor assignment below for the full rationale. */
  readonly journalingRunner: JournalingRunner;

  private readonly cfg: CcPoolInstanceConfig;
  private readonly db: Database.Database;
  private readonly paneLauncher: PaneLauncher;

  constructor(deps: PoolManagerDeps) {
    this.cfg = deps.cfg;
    this.db = deps.db;
    this.poolId = deps.cfg.agent_id;
    this.leaseStore = new LeaseStore(deps.db);

    if (deps.paneLauncher) {
      this.paneLauncher = deps.paneLauncher;
    } else {
      const tmux = deps.tmux ?? createTmuxController(realTmuxExec);
      // Shared-by-default scratch dir is safe across multiple pool
      // instances: every file PaneLifecycle writes into it is named with a
      // fresh randomUUID() (see pane.ts/mcp-config.ts), so no two pools (or
      // two panes within one pool) can collide on a filename.
      this.paneLauncher = new PaneLifecycle({
        tmux,
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
    promptContext: { contact_id: string; channel: string },
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
): Map<string, PoolManager> {
  const managers = new Map<string, PoolManager>();
  for (const cfg of getCcPoolInstances(config)) {
    managers.set(toPrefixedAgentId(cfg.agent_id), new PoolManager({ cfg, db, busBaseUrl }));
  }
  return managers;
}

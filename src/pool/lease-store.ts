/**
 * S48.3 — SQLite-backed lease store for the interactive Claude Code session
 * pool (E48).
 *
 * Owns the `pool_leases` table (migration 016) and every state transition a
 * pane's lease can go through. See src/pool/types.ts for the full contract —
 * `PaneState`, `PoolLeaseRow`, `AcquireResult`, `AcquireOptions` — and in
 * particular its module doc comment for the agent-id prefix convention and
 * the `claude_session_id` transient-cache-vs-`sessions`-durable-record split.
 *
 * All operations are synchronous (better-sqlite3 is sync by design), which is
 * what makes `acquire()`'s atomicity guarantee possible: since there is no
 * `await` anywhere in this file, two "concurrent" calls from application code
 * can never actually interleave mid-transaction — the first call's
 * `db.transaction()` fully commits before the second call's code can run.
 */
import type Database from 'better-sqlite3';
import {
  type AcquireOptions,
  type AcquireResult,
  type PoolLeaseRow,
  derivePaneAgentId,
  toPrefixedAgentId,
} from './types.js';

export class LeaseStore {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Idempotent startup seed: ensure a `free` row exists for every given
   * (paneId, agentId) pair in this pool. Existing rows (any state) are left
   * untouched — this only inserts rows that don't exist yet. Used both at
   * first startup (fixed pool sizing) and by reconciliation (S48.7, later
   * story). `agentId` is stored verbatim into the `agent_id` column — the
   * caller is responsible for passing the PREFIXED form (per types.ts's
   * convention).
   */
  seedPanes(poolId: string, panes: Array<{ paneId: string; agentId: string }>): void {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO pool_leases (pool_id, pane_id, agent_id, state)
       VALUES (?, ?, ?, 'free')`,
    );
    const seed = this.db.transaction((rows: Array<{ paneId: string; agentId: string }>) => {
      for (const { paneId, agentId } of rows) {
        insert.run(poolId, paneId, agentId);
      }
    });
    seed(panes);
  }

  /**
   * The core allocation decision + atomic claim. See the big doc comment on
   * `AcquireResult` in types.ts for the full contract. Runs as a single
   * `db.transaction()` so two calls issued back-to-back with no intervening
   * `await` can never both claim the same pane — see the module doc above.
   *
   * Resolution order (first match wins): reuse an existing `leased` row for
   * this conversation -> claim a `free` pane -> grow (if `dynamic` and under
   * `maxPanes`) -> evict the least-recently-active idle `leased` pane -> give
   * up (`exhausted`).
   */
  acquire(poolId: string, conversationId: string, opts: AcquireOptions): AcquireResult {
    const run = this.db.transaction((): AcquireResult => {
      const now = opts.now?.() ?? new Date();
      const nowIso = now.toISOString();

      // 1. Reuse: an existing live lease for this exact conversation.
      const reuseRow = this.db
        .prepare(
          `SELECT * FROM pool_leases WHERE pool_id = ? AND conversation_id = ? AND state = 'leased'`,
        )
        .get(poolId, conversationId) as PoolLeaseRow | undefined;
      if (reuseRow) {
        this.db
          .prepare(`UPDATE pool_leases SET last_activity_at = ? WHERE pool_id = ? AND pane_id = ?`)
          .run(nowIso, poolId, reuseRow.pane_id);
        return { kind: 'reuse', lease: { ...reuseRow, last_activity_at: nowIso } };
      }

      // 2. Bound: claim a free pane. Tie-break deterministically (lowest
      // pane_id) so tests are stable.
      const freeRow = this.db
        .prepare(`SELECT * FROM pool_leases WHERE pool_id = ? AND state = 'free' ORDER BY pane_id ASC LIMIT 1`)
        .get(poolId) as PoolLeaseRow | undefined;
      if (freeRow) {
        this.db
          .prepare(
            `UPDATE pool_leases
             SET state = 'launching', conversation_id = ?, claude_session_id = NULL,
                 leased_at = ?, last_activity_at = ?, last_turn_ended_at = NULL
             WHERE pool_id = ? AND pane_id = ? AND state = 'free'`,
          )
          .run(conversationId, nowIso, nowIso, poolId, freeRow.pane_id);
        const bound: PoolLeaseRow = {
          ...freeRow,
          state: 'launching',
          conversation_id: conversationId,
          claude_session_id: null,
          leased_at: nowIso,
          last_activity_at: nowIso,
          last_turn_ended_at: null,
        };
        return { kind: 'bound', lease: bound };
      }

      // 3. Grow: insert a brand-new pane row, only for `dynamic` pools under
      // their `maxPanes` ceiling. `acquire()` doesn't know tmux naming
      // conventions (that's a later story) — it only synthesizes the DB-side
      // pane_id/agent_id. Both are derived from counts captured in THIS
      // transaction, so repeated growth (and the pane index used for
      // agent-id derivation) is race-safe.
      if (opts.growth === 'dynamic') {
        const totalRow = this.db
          .prepare(`SELECT COUNT(*) AS n FROM pool_leases WHERE pool_id = ?`)
          .get(poolId) as { n: number };
        if (totalRow.n < opts.maxPanes) {
          const growRow = this.db
            .prepare(`SELECT COUNT(*) AS n FROM pool_leases WHERE pool_id = ? AND pane_id LIKE ?`)
            .get(poolId, `${poolId}:grow-%`) as { n: number };
          const newPaneId = `${poolId}:grow-${growRow.n + 1}`;
          const paneIndex = totalRow.n + 1;
          const newAgentId = toPrefixedAgentId(derivePaneAgentId(opts.poolAgentId, paneIndex));

          this.db
            .prepare(
              `INSERT INTO pool_leases
                 (pool_id, pane_id, agent_id, conversation_id, claude_session_id, state, leased_at, last_activity_at)
               VALUES (?, ?, ?, ?, NULL, 'launching', ?, ?)`,
            )
            .run(poolId, newPaneId, newAgentId, conversationId, nowIso, nowIso);

          const grown: PoolLeaseRow = {
            pool_id: poolId,
            pane_id: newPaneId,
            agent_id: newAgentId,
            conversation_id: conversationId,
            claude_session_id: null,
            state: 'launching',
            leased_at: nowIso,
            last_activity_at: nowIso,
            last_turn_ended_at: null,
          };
          return { kind: 'grow', lease: grown };
        }
      }

      // 4. Evict: the least-recently-active `leased` pane that's been idle
      // past `idleEvictMs`, if any. Capture what it held BEFORE the claim
      // overwrites it.
      const cutoffIso = new Date(now.getTime() - opts.idleEvictMs).toISOString();
      const evictRow = this.db
        .prepare(
          `SELECT * FROM pool_leases
           WHERE pool_id = ? AND state = 'leased'
             AND last_activity_at IS NOT NULL AND last_activity_at < ?
           ORDER BY last_activity_at ASC, pane_id ASC
           LIMIT 1`,
        )
        .get(poolId, cutoffIso) as PoolLeaseRow | undefined;
      if (evictRow) {
        // Invariant: a 'leased' row always has a non-null conversation_id
        // (acquire() never sets state='leased'/'launching' without one).
        const evicted = {
          conversationId: evictRow.conversation_id as string,
          claudeSessionId: evictRow.claude_session_id,
        };
        this.db
          .prepare(
            `UPDATE pool_leases
             SET state = 'launching', conversation_id = ?, claude_session_id = NULL,
                 leased_at = ?, last_activity_at = ?, last_turn_ended_at = NULL
             WHERE pool_id = ? AND pane_id = ? AND state = 'leased'`,
          )
          .run(conversationId, nowIso, nowIso, poolId, evictRow.pane_id);
        const claimed: PoolLeaseRow = {
          ...evictRow,
          state: 'launching',
          conversation_id: conversationId,
          claude_session_id: null,
          leased_at: nowIso,
          last_activity_at: nowIso,
          last_turn_ended_at: null,
        };
        return { kind: 'evict', lease: claimed, evicted };
      }

      // 5. Nothing available.
      return { kind: 'exhausted' };
    });

    return run();
  }

  /**
   * state 'launching' -> 'leased'. No-op (does not throw) if the row is
   * already 'leased' or doesn't exist in that state.
   */
  confirmReady(poolId: string, paneId: string): void {
    const result = this.db
      .prepare(`UPDATE pool_leases SET state = 'leased' WHERE pool_id = ? AND pane_id = ? AND state = 'launching'`)
      .run(poolId, paneId);
    if (result.changes === 0) {
      console.error(
        `[LeaseStore] confirmReady: pane "${paneId}" in pool "${poolId}" was not in 'launching' state (no-op)`,
      );
    }
  }

  /**
   * Any state -> 'dead'. Does not clear conversation_id (a dead pane's
   * conversation still needs its claude_session_id recoverable from the
   * `sessions` table by a later story — don't destroy data here).
   */
  markDead(poolId: string, paneId: string): void {
    this.db.prepare(`UPDATE pool_leases SET state = 'dead' WHERE pool_id = ? AND pane_id = ?`).run(poolId, paneId);
  }

  /**
   * 'leased'/'draining'/'dead' -> 'free'. Clears conversation_id AND
   * claude_session_id (the durable copy lives in `sessions`, owned by a
   * later story, not this one). Also clears leased_at.
   */
  release(poolId: string, paneId: string): void {
    this.db
      .prepare(
        `UPDATE pool_leases
         SET state = 'free', conversation_id = NULL, claude_session_id = NULL, leased_at = NULL,
             last_turn_ended_at = NULL
         WHERE pool_id = ? AND pane_id = ?`,
      )
      .run(poolId, paneId);
  }

  /**
   * 'leased' -> 'draining' (used when an in-flight turn must finish before
   * the pane can be reused — later story wires this up).
   */
  markDraining(poolId: string, paneId: string): void {
    this.db.prepare(`UPDATE pool_leases SET state = 'draining' WHERE pool_id = ? AND pane_id = ?`).run(poolId, paneId);
  }

  /** Bump last_activity_at to now (or `now` param if given, for tests). */
  touch(poolId: string, paneId: string, now?: Date): void {
    const nowIso = (now ?? new Date()).toISOString();
    this.db
      .prepare(`UPDATE pool_leases SET last_activity_at = ? WHERE pool_id = ? AND pane_id = ?`)
      .run(nowIso, poolId, paneId);
  }

  /**
   * Record that the pane's Claude turn finished (Stop hook). Sets
   * last_turn_ended_at and last_activity_at. No-op when the pane doesn't exist.
   */
  markTurnEnded(poolId: string, paneId: string, nowIso = new Date().toISOString()): void {
    this.db
      .prepare(`UPDATE pool_leases SET last_turn_ended_at = ?, last_activity_at = ? WHERE pool_id = ? AND pane_id = ?`)
      .run(nowIso, nowIso, poolId, paneId);
  }

  setClaudeSessionId(poolId: string, paneId: string, claudeSessionId: string): void {
    this.db
      .prepare(`UPDATE pool_leases SET claude_session_id = ? WHERE pool_id = ? AND pane_id = ?`)
      .run(claudeSessionId, poolId, paneId);
  }

  findByConversation(poolId: string, conversationId: string): PoolLeaseRow | null {
    const row = this.db
      .prepare(`SELECT * FROM pool_leases WHERE pool_id = ? AND conversation_id = ?`)
      .get(poolId, conversationId) as PoolLeaseRow | undefined;
    return row ?? null;
  }

  /**
   * `agentId` is the PREFIXED form (e.g. "agent:peggy-pool-2") per types.ts's
   * convention — matches the `agent_id` column directly, no transformation.
   */
  findByAgent(poolId: string, agentId: string): PoolLeaseRow | null {
    const row = this.db
      .prepare(`SELECT * FROM pool_leases WHERE pool_id = ? AND agent_id = ?`)
      .get(poolId, agentId) as PoolLeaseRow | undefined;
    return row ?? null;
  }

  /**
   * Same as `findByAgent`, but without a `pool_id` filter — for callers (e.g.
   * the outbound stale-sender guard in src/http/api.ts, E48 S48.6) that only
   * have an `agentId` (from `envelope.sender`) and no way to know which
   * pool's id to scope the lookup to. `agentId` is the PREFIXED form, same
   * convention as `findByAgent`. Agent ids are expected-unique across pools
   * by construction (each pool derives its panes' ids from its own distinct
   * `agent_id` prefix — see derivePaneAgentId in types.ts), but this query
   * does not assume that: if somehow more than one row matches, it returns
   * the first.
   */
  findByAgentAnyPool(agentId: string): PoolLeaseRow | null {
    const row = this.db
      .prepare(`SELECT * FROM pool_leases WHERE agent_id = ? LIMIT 1`)
      .get(agentId) as PoolLeaseRow | undefined;
    return row ?? null;
  }

  list(poolId: string): PoolLeaseRow[] {
    return this.db
      .prepare(`SELECT * FROM pool_leases WHERE pool_id = ? ORDER BY pane_id ASC`)
      .all(poolId) as PoolLeaseRow[];
  }

  /**
   * Rows in this pool with state='leased' and last_activity_at older than
   * `cutoffIso`. Used by a later story's hard-idle sweep.
   */
  findIdleOlderThan(poolId: string, cutoffIso: string): PoolLeaseRow[] {
    return this.db
      .prepare(
        `SELECT * FROM pool_leases
         WHERE pool_id = ? AND state = 'leased'
           AND last_activity_at IS NOT NULL AND last_activity_at < ?
         ORDER BY last_activity_at ASC`,
      )
      .all(poolId, cutoffIso) as PoolLeaseRow[];
  }
}

/**
 * Shared types and pure helpers for the cc-pool subsystem (E48).
 *
 * This module is the seam every other `src/pool/*` module and `cc-pool.ts`
 * code against — it has no I/O and no dependencies beyond stdlib, so it is
 * safe for every layer (lease store, pane lifecycle, adapter) to import
 * without creating a dependency cycle.
 *
 * ── Agent id convention ─────────────────────────────────────────────────────
 * Two forms of "agent id" are used throughout the pool subsystem, and mixing
 * them up silently breaks message routing:
 *
 *   - BARE form, e.g. "peggy-pool-2" — what `AGENTBUS_AGENT_ID` is set to in a
 *     pane's tmux environment, and what `cc.ts` polls with
 *     (`?agent=peggy-pool-2`). `CcPoolInstanceConfig.agent_id` (the *pool's*
 *     logical identity, e.g. "peggy") is also bare, mirroring
 *     `CcHeadlessInstanceConfig.agent_id`.
 *   - PREFIXED form, e.g. "agent:peggy-pool-2" — what appears in
 *     `MessageEnvelope.sender`/`recipient`, `sessions.agent_id`, and
 *     `pool_leases.agent_id`. This is the form used in `pipeline.routes`
 *     targets (`{ adapterId: 'cc-pool', recipientId: 'agent:peggy' }`).
 *
 * `pool_leases.agent_id` always stores the PREFIXED form of the *pane's own*
 * derived id (not the pool's logical id) — this lets the outbound lease guard
 * compare `envelope.sender` against `pool_leases.agent_id` directly, with no
 * string transformation at the one comparison that must never be wrong.
 *
 * ── Session id lifecycle (important — read before touching acquire/release) ──
 * `pool_leases.claude_session_id` is a *transient, pane-scoped* cache of "the
 * Claude session currently loaded in this pane" — it is cleared on `release()`.
 * It is NOT the durable record. The durable, conversation-scoped record is
 * `sessions.claude_session_id` (same column cc-headless already writes via its
 * own `storeClaudeSessionId` helper — see `src/adapters/cc-headless.ts`).
 *
 * Consequence for callers: when `acquire()` returns `bound`/`grow`/`evict`
 * with `lease.claude_session_id === null`, that does NOT necessarily mean
 * "brand new conversation" — it means "this pane doesn't currently have a
 * session loaded for it." The caller MUST also look up `sessions` for this
 * `conversation_id` (mirror cc-headless's `getActiveSession(db, conversationId)`)
 * before deciding `--session-id <new-uuid>` (nothing found) vs.
 * `--resume <existing-uuid>` (found). Once the session id is known, the caller
 * writes it to BOTH `pool_leases` (via `setClaudeSessionId`, for pool-manager's
 * own hot-path reads) AND `sessions.claude_session_id` (for cross-cutting
 * consumers — SessionTracker, `/clear`, `/cost`).
 *
 * Deliberately writing `sessions.claude_session_id` for pool-owned sessions
 * (rather than leaving it NULL) is a considered design choice, not an
 * oversight — see docs/CC_POOL_ADAPTER.md#session-tracker-interaction for the
 * full rationale. In short: it opts pool sessions out of
 * `SessionTracker.closeIdleSessions()`'s legacy idle-close path (which
 * requires `claude_session_id IS NULL`) since the pool manages its own
 * idle/hard-idle eviction via `pool_leases`, and it opts pool sessions INTO
 * `dispatchJournaling()`'s candidate query — which is why every cc-pool
 * instance MUST register a `JournalingRunner` (even a documented no-op) with
 * `SessionTracker`, exactly like cc-headless does, or that dispatch loop has
 * no runner to call for a pool-owned agent_id.
 */

/** Lifecycle state of one tmux pane in a pool. */
export type PaneState = 'free' | 'launching' | 'leased' | 'draining' | 'dead';

/** A `pool_leases` row. Snake_case to mirror the DB column names directly. */
export interface PoolLeaseRow {
  pool_id: string;
  /** tmux target, e.g. "peggy-pool:2". */
  pane_id: string;
  /** PREFIXED form of this pane's own derived agent id, e.g. "agent:peggy-pool-2". */
  agent_id: string;
  /** null when the pane is free (or newly reserved but not yet bound to a conversation). */
  conversation_id: string | null;
  /** Transient cache — see module doc. null after release() or before a session id is known. */
  claude_session_id: string | null;
  state: PaneState;
  leased_at: string | null;
  last_activity_at: string | null;
  /** Set by the Stop hook (`markTurnEnded`); cleared when the pane is (re)assigned or released. */
  last_turn_ended_at: string | null;
  /**
   * The model this pane's current Claude session was launched with (E53,
   * migration 023). `null` means either the pane is free/unclaimed, or it
   * was launched with no `--model` flag (CLI default via `~/.claude/settings.json`).
   * Cleared on `release()`, reset to `NULL` on every fresh claim (`bound`/
   * `evict`), and written by `PoolManager.resolveRoute()` once a launch (or
   * relaunch — see S53.5) actually completes, via `setModel()`.
   */
  model: string | null;
}

/**
 * Result of `LeaseStore.acquire()`. In every non-`exhausted` case, the DB-side
 * claim has ALREADY happened atomically (the target row's `state` is already
 * `launching`, `conversation_id` already set to the caller's conversation) —
 * a second concurrent `acquire()` call cannot also claim the same pane. The
 * discriminant just tells the caller what async tmux/claude-launch work is
 * needed next:
 *
 *   - `reuse`  — an existing lease for this exact conversation_id was already
 *     `leased` and live. No tmux work needed; caller should `touch()` and hand
 *     off the message immediately.
 *   - `bound`  — a `free` pane was claimed. Caller launches/resumes Claude in
 *     it, then calls `confirmReady()`.
 *   - `grow`   — a brand-new pane row was inserted (no tmux window exists
 *     yet). Caller creates the tmux window, launches Claude, then
 *     `confirmReady()`.
 *   - `evict`  — an idle `leased` pane belonging to a DIFFERENT conversation
 *     was claimed for this one. `evicted` carries what was displaced (its
 *     `claude_session_id` is captured here since the row's own
 *     `conversation_id`/`claude_session_id` were already overwritten by the
 *     claim). Caller must run the on-evict hook for `evicted` first, then
 *     launch/resume the new conversation, then `confirmReady()`.
 *   - `exhausted` — no pane available and none evictable. Caller should park
 *     the message.
 */
export type AcquireResult =
  | { kind: 'reuse'; lease: PoolLeaseRow }
  | { kind: 'bound'; lease: PoolLeaseRow }
  | { kind: 'grow'; lease: PoolLeaseRow }
  | {
      kind: 'evict';
      lease: PoolLeaseRow;
      evicted: { conversationId: string; claudeSessionId: string | null };
    }
  | { kind: 'exhausted' };

/** Policy inputs `acquire()` needs — sourced from `CcPoolInstanceConfig`. */
export interface AcquireOptions {
  /**
   * The pool's own bare (unprefixed) agent id, e.g. "peggy" — mirrors
   * `CcPoolInstanceConfig.agent_id`. Needed on the `grow` path to derive a
   * freshly-inserted pane's own agent id via `derivePaneAgentId()`.
   */
  poolAgentId: string;
  /** Fixed pool size (existing pane rows expected to be pre-seeded up to this count). */
  panes: number;
  /** Ceiling for `growth: 'dynamic'`; irrelevant when `growth: 'fixed'`. */
  maxPanes: number;
  growth: 'fixed' | 'dynamic';
  /** A `leased` pane idle for at least this long becomes evict-eligible. */
  idleEvictMs: number;
  /** Wall-clock now, injectable for tests. */
  now?: () => Date;
}

const AGENT_PREFIX = 'agent:';

/** "agent:peggy-pool-2" -> "peggy-pool-2". Idempotent on an already-bare id. */
export function toBareAgentId(id: string): string {
  return id.startsWith(AGENT_PREFIX) ? id.slice(AGENT_PREFIX.length) : id;
}

/** "peggy-pool-2" -> "agent:peggy-pool-2". Idempotent on an already-prefixed id. */
export function toPrefixedAgentId(id: string): string {
  return id.startsWith(AGENT_PREFIX) ? id : `${AGENT_PREFIX}${id}`;
}

/**
 * Derive one pane's own bare agent id from the pool's logical (bare) agent id
 * and a 1-based pane index, e.g. ("peggy", 2) -> "peggy-pool-2". `poolAgentId`
 * is normalized to bare first, so passing either form is safe.
 */
export function derivePaneAgentId(poolAgentId: string, paneIndex: number): string {
  return `${toBareAgentId(poolAgentId)}-pool-${paneIndex}`;
}

/** Derive one pane's tmux window name from its 1-based index. Kept as a named
 * helper (not inlined) so the naming convention has exactly one definition. */
export function derivePaneWindowName(paneIndex: number): string {
  return String(paneIndex);
}

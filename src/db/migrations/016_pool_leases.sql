-- Migration 016 — pool_leases table (E48 / S48.3)
--
-- Tracks lease state for each tmux pane in an interactive Claude Code session
-- pool. One row per (pool_id, pane_id) — a pane never has more than one lease
-- row, and its `state` column drives the pool manager's allocation decisions
-- (see LeaseStore.acquire() in src/pool/lease-store.ts and the PaneState /
-- AcquireResult contracts in src/pool/types.ts).
--
-- `agent_id` stores the PREFIXED form of the pane's own derived agent id
-- (e.g. "agent:peggy-pool-2"), not the pool's logical agent id — this lets
-- the outbound lease guard compare envelope.sender against this column
-- directly, with no string transformation.
--
-- `claude_session_id` is a transient, pane-scoped cache of "the Claude
-- session currently loaded in this pane" — it is cleared on release(). The
-- durable, conversation-scoped record lives in `sessions.claude_session_id`
-- (see src/adapters/cc-headless.ts's storeClaudeSessionId/getActiveSession).
--
-- Indexes:
--   idx_pool_leases_conv  — acquire()'s reuse lookup, keyed by (pool_id, conversation_id)
--   idx_pool_leases_agent — findByAgent()'s lookup, keyed by (pool_id, agent_id)

CREATE TABLE IF NOT EXISTS pool_leases (
  pool_id            TEXT NOT NULL,
  pane_id            TEXT NOT NULL,
  agent_id           TEXT NOT NULL,
  conversation_id    TEXT,
  claude_session_id  TEXT,
  state              TEXT NOT NULL,
  leased_at          TEXT,
  last_activity_at   TEXT,
  PRIMARY KEY (pool_id, pane_id)
);

CREATE INDEX IF NOT EXISTS idx_pool_leases_conv ON pool_leases (pool_id, conversation_id);
CREATE INDEX IF NOT EXISTS idx_pool_leases_agent ON pool_leases (pool_id, agent_id);

-- Migration 014 — turn_costs table (E39, /cost command)
--
-- Captures the cost/token/turn-count data every `claude -p` turn already
-- computes but previously discarded (see HeadlessInstance.invokeClaude()'s
-- `result` stream-json event). Keyed by agent_id so /cost can scope a
-- day/week/month summary to "the agent it's called for" (E23).
--
-- agent_id/session_id are nullable, mirroring sessions.agent_id's own
-- nullability (migration 011): a turn that can't be attributed to a specific
-- agent still gets its cost recorded, just unattributed, rather than dropped.
CREATE TABLE turn_costs (
  id            INTEGER PRIMARY KEY,
  agent_id      TEXT,
  session_id    TEXT,
  ts            TEXT NOT NULL,
  cost_usd      REAL NOT NULL,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  num_turns     INTEGER
);

-- Fast day/week/month range scans scoped to one agent (the hot path for /cost).
CREATE INDEX IF NOT EXISTS idx_turn_costs_agent_ts
  ON turn_costs (agent_id, ts);

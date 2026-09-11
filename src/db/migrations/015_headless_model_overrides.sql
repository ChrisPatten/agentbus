-- Migration 015 — headless_model_overrides table
--
-- Stores runtime model overrides for headless Claude spawns (cc-headless adapter).
-- Allows per-schedule, per-agent, or global model configuration overrides.
--
-- Priority ordering (first match wins):
--   1. (schedule_id + agent_id) — most specific
--   2. agent_id only
--   3. schedule_id only
--   4. global (both null) — least specific
--
-- Indexes optimize queries on (schedule_id, agent_id) since that's the hot path
-- on every headless spawn.

CREATE TABLE headless_model_overrides (
  id            INTEGER PRIMARY KEY,
  schedule_id   TEXT,
  agent_id      TEXT,
  model         TEXT NOT NULL,
  priority      INTEGER DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- Unique constraint prevents duplicate overrides for the same (schedule_id, agent_id) combo.
-- Allows multiple global overrides (both NULL) to exist, with priority field to order them.
CREATE UNIQUE INDEX IF NOT EXISTS idx_model_overrides_schedule_agent
  ON headless_model_overrides (schedule_id, agent_id)
  WHERE schedule_id IS NOT NULL OR agent_id IS NOT NULL;

-- Fast lookup by agent (e.g., list all overrides for an agent).
CREATE INDEX IF NOT EXISTS idx_model_overrides_agent
  ON headless_model_overrides (agent_id);

-- Fast lookup by schedule (e.g., list all overrides for a schedule).
CREATE INDEX IF NOT EXISTS idx_model_overrides_schedule
  ON headless_model_overrides (schedule_id);

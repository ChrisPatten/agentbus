-- Migration 011 — Add agent_id to sessions
--
-- E23 multi-instance cc-headless. Records which headless agent (e.g.
-- "agent:peggy", "agent:pokeclaude") owns a session, so journaling dispatch
-- and /clear can route to that agent's own runner and threshold_ms instead of
-- a single global. NULL for sessions not owned by a cc-headless instance
-- (legacy MCP path, or a route with no cc-headless target).
ALTER TABLE sessions ADD COLUMN agent_id TEXT;

CREATE INDEX IF NOT EXISTS idx_sess_agent_id
  ON sessions (agent_id)
  WHERE agent_id IS NOT NULL;

-- Migration 027 — memory_recent_seen (E67 / S67.4)
--
-- The UserPromptSubmit freshness hook (scripts/hooks/agentbus_recent_memory_hook.sh,
-- GET /api/v1/memory/recent) injects the agent's memory/recent.md into a
-- live Claude Code session only when its content changed since that session
-- last saw it. This table remembers, per harness (Claude Code) session id,
-- the sha256 of the recent.md content the session has: recorded as a
-- baseline when the session starts (it loaded recent.md through its
-- CLAUDE.md import) and updated whenever the hook injects a newer version.
--
-- Keyed by the harness session id, not the bus session: one Claude session
-- loads the file once, whichever bus session it serves. Rows untouched for
-- 30 days are swept.
CREATE TABLE IF NOT EXISTS memory_recent_seen (
  harness_session_id  TEXT PRIMARY KEY,
  agent_id            TEXT NOT NULL,   -- prefixed logical id (pool id, not pane id)
  content_hash        TEXT NOT NULL,   -- sha256 hex of the recent.md content this session has
  seen_at             TEXT NOT NULL    -- ISO timestamp of the last check
);

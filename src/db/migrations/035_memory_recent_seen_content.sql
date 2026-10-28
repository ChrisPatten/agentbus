-- Migration 035 — memory_recent_seen.content (delta injection for the recent.md freshness hook)
--
-- The freshness hook now injects only the lines added to recent.md since the
-- session last saw it, which needs the text the session has, not just its
-- hash. NULL for rows written before this migration: the next change for
-- those sessions injects the whole file once, as before.
ALTER TABLE memory_recent_seen ADD COLUMN content TEXT;

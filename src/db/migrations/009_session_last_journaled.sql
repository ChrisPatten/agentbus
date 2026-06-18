-- Migration 009 — Add last_journaled_at to sessions
--
-- E20 journaling telemetry. Records the most recent time the journaling
-- dispatcher fired a silent journaling turn for a session. The dispatcher
-- journals a paused session only when last_journaled_at is NULL or older than
-- last_activity, so each pause produces exactly one journaling turn and new
-- activity re-arms it. NULL = never journaled.
ALTER TABLE sessions ADD COLUMN last_journaled_at TEXT;

CREATE INDEX IF NOT EXISTS idx_sess_last_journaled
  ON sessions (last_journaled_at)
  WHERE last_journaled_at IS NOT NULL;

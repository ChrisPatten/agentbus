-- Migration 006 — Attachments (E17)
--
-- Tracks inbound image files downloaded from platform adapters (currently
-- Telegram). Each row records the agent the file was downloaded for, its
-- on-disk location, and an expiration timestamp. The AttachmentSweeper
-- background task periodically deletes rows whose `expires_at` has passed
-- and unlinks the associated file from disk.
--
-- Timestamps are stored as Unix epoch milliseconds (integer) rather than
-- ISO strings — this keeps the `expires_at <= now` sweep query cheap and
-- matches the epic's acceptance criteria.

CREATE TABLE IF NOT EXISTS attachments (
  id                TEXT PRIMARY KEY,
  agent_id          TEXT NOT NULL,
  local_path        TEXT NOT NULL,
  original_filename TEXT,
  mime_type         TEXT,
  created_at        INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL
);

-- Hot path: sweeper scans for expired rows on every tick.
CREATE INDEX IF NOT EXISTS idx_attachments_expires_at
  ON attachments (expires_at);

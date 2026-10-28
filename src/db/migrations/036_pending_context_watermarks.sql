-- Migration 036 — pending-context watermarks (E69 S69.4)
--
-- Per-conversation record of the newest foreign outbound transcript row
-- already injected into an agent turn as pending context. Keyed by
-- conversation, not session, so it survives Main's session rotation. The
-- (created_at, transcript id) pair orders ties the same way history does.
CREATE TABLE IF NOT EXISTS pending_context_watermarks (
  conversation_id     TEXT PRIMARY KEY,
  injected_through    TEXT NOT NULL,  -- created_at of the newest injected transcript row
  injected_through_id TEXT NOT NULL,  -- that row's transcripts.id (tie-break)
  updated_at          TEXT NOT NULL
);

-- Migration 034 — feedback kind `lapsed-proposal` (E68 follow-up)
--
-- A self-edit proposal that went stale (the file changed since its base
-- hash, so an approval couldn't apply it) or expired (no answer within 7
-- days) is recorded as a feedback event, so the agent's journalers learn it
-- should re-propose if the change is still relevant. detail carries
-- proposal_id, path and reason ('stale' | 'expired').
--
-- SQLite can't alter a CHECK constraint, so the table is rebuilt with the
-- same columns and indexes and the rows copied over.
CREATE TABLE feedback_events_new (
  id              TEXT PRIMARY KEY,
  agent_id        TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('denied-approval', 'user-feedback', 'tool-error', 'lapsed-proposal')),
  conversation_id TEXT,
  session_id      TEXT,
  ref_message_id  TEXT,
  contact_id      TEXT,
  text            TEXT NOT NULL,
  detail          TEXT,
  created_at      TEXT NOT NULL,
  consumed_by_run TEXT,
  consumed_at     TEXT
);

INSERT INTO feedback_events_new
  (id, agent_id, kind, conversation_id, session_id, ref_message_id, contact_id, text, detail, created_at, consumed_by_run, consumed_at)
SELECT id, agent_id, kind, conversation_id, session_id, ref_message_id, contact_id, text, detail, created_at, consumed_by_run, consumed_at
FROM feedback_events;

DROP TABLE feedback_events;
ALTER TABLE feedback_events_new RENAME TO feedback_events;

CREATE INDEX IF NOT EXISTS idx_feedback_events_conversation
  ON feedback_events (conversation_id, created_at) WHERE consumed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_feedback_events_agent ON feedback_events (agent_id, created_at);

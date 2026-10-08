-- Migration 032 — feedback events (E68 / S68.2)
--
-- Signals that the agent went wrong, recorded for its journalers:
--   denied-approval  an owner or contact denied an approval request (E51),
--                    including a denied self-edit proposal (S68.3)
--   user-feedback    `/feedback <text>` in a conversation
--   tool-error       a tool call failed in a cc-headless turn, or a message the
--                    agent sent could not be delivered
--
-- Session journal runs receive the unconsumed events of their conversation
-- (`feedback[]`) and mark them consumed when the run succeeds. Consolidation
-- passes receive counts across conversations. denied-approval and
-- user-feedback make the session eligible to journal without
-- min_human_messages; tool-error does not. Swept after 90 days.
CREATE TABLE IF NOT EXISTS feedback_events (
  id              TEXT PRIMARY KEY,
  agent_id        TEXT NOT NULL,      -- prefixed logical id (a pool's id, not a pane id)
  kind            TEXT NOT NULL CHECK (kind IN ('denied-approval', 'user-feedback', 'tool-error')),
  conversation_id TEXT,               -- null when the event belongs to no conversation
  session_id      TEXT,
  ref_message_id  TEXT,               -- transcripts.message_id of the agent message it refers to, when known
  contact_id      TEXT,               -- who gave it (bare), when a person did
  text            TEXT NOT NULL,      -- truncated
  detail          TEXT,               -- JSON: tool name, approval id, channel, …
  created_at      TEXT NOT NULL,
  consumed_by_run TEXT,               -- the session journal run that received it
  consumed_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_feedback_events_conversation
  ON feedback_events (conversation_id, created_at) WHERE consumed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_feedback_events_agent ON feedback_events (agent_id, created_at);

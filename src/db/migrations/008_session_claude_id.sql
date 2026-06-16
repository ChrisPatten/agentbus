-- Migration 008 — Add claude_session_id to sessions
--
-- Stores the Claude session ID returned by `claude -p` stream-json output.
-- The cc-headless adapter passes --resume <claude_session_id> on subsequent
-- messages from the same contact while the AgentBus session is still active.
ALTER TABLE sessions ADD COLUMN claude_session_id TEXT;

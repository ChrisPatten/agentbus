-- Migration 031 — drop the legacy structured memory store (post-E66)
--
-- The E8/E9 structured memory store is removed: the Anthropic-API summarizer
-- that filled `memories` and `session_summaries` was retired in E66, and the
-- tools, routes and pipeline stage that read them (recall_memory, log_memory,
-- /api/v1/memories, stage 85 memory-inject) are gone. Agents keep memory in
-- their own files (docs/AGENT_MEMORY.md). Their contents are not migrated.
-- (030 is taken by the email IMAP state migration on dev.)
DROP TRIGGER IF EXISTS memories_ai;
DROP TRIGGER IF EXISTS memories_ad;
DROP TRIGGER IF EXISTS memories_au;
DROP TABLE IF EXISTS memories_fts;
DROP TABLE IF EXISTS memories;
DROP TABLE IF EXISTS session_summaries;

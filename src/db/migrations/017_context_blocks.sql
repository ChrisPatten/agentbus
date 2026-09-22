-- Migration 017 — context_blocks table (per-session context ledger)
--
-- cc-headless's system prompt is a cache prefix (tools -> system -> messages),
-- but {{memories}} and {{date}} changed on every rendered turn, which busted
-- the cache prefix and resent the same memory file content into the resumed
-- transcript over and over even though the transcript already had it from a
-- prior turn. This table lets the adapter track, per (session, memory file),
-- whether the current content has already been sent into that session's
-- transcript, so a turn only prepends a block to the user message when the
-- block is new or has changed since the last time it was sent — see
-- src/adapters/context-ledger.ts.
--
-- block_key identifies a source, not a specific content version, e.g.
-- 'memory:memory/MEMORY.md' or 'memory:memory/daily/2026-09-20.md'.
-- content_hash is a sha256 hex digest of the block's current content; a row
-- whose hash no longer matches the freshly-read file means the file changed
-- and must be resent.
--
-- Rows are cleared for a session (not just left stale) when detectCompaction()
-- concludes Claude Code's auto-compaction likely summarized the transcript —
-- at that point every assumption about what the resumed session already has
-- in context is void, so the next turn must resend everything from scratch.
--
-- ON DELETE CASCADE: a session's ledger has no meaning once the session row
-- itself is gone.
CREATE TABLE IF NOT EXISTS context_blocks (
  session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  block_key     TEXT NOT NULL,   -- e.g. 'memory:memory/MEMORY.md', 'memory:memory/daily/2026-09-20.md'
  content_hash  TEXT NOT NULL,
  sent_at       TEXT NOT NULL,
  PRIMARY KEY (session_id, block_key)
);

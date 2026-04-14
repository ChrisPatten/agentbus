-- Migration 003 — Memories table + session status columns
-- Adds session lifecycle status tracking and the memories storage layer for E8.

-- ── sessions: new columns ─────────────────────────────────────────────────────
-- status tracks the summarization lifecycle for ended sessions.
-- summary_attempts tracks retry count so the tracker can give up after 3 tries.
ALTER TABLE sessions ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE sessions ADD COLUMN summary_attempts INTEGER NOT NULL DEFAULT 0;

-- ── memories ──────────────────────────────────────────────────────────────────
-- Long-term agent memory extracted from session summaries (source='summarizer')
-- or logged manually by the agent (source='manual').
--
-- session_id: nullable — manually logged memories have no associated session.
-- category: classifies the memory for filtered recall (preference, fact, etc.)
-- confidence: 0.0-1.0 score set by the summarizer or caller.
-- superseded_by: UUID of the memory that replaced this one, or 'manual_forget'
--   when the /forget command was used. NULL = active memory.
-- expires_at: soft expiry timestamp. NULL = never expires.
--   Hard deletion of memories with expires_at older than 30 days is done by
--   the SessionTracker background sweep.
CREATE TABLE IF NOT EXISTS memories (
  id              TEXT PRIMARY KEY,
  session_id      TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  contact_id      TEXT NOT NULL,
  category        TEXT NOT NULL DEFAULT 'general',
  content         TEXT NOT NULL,
  confidence      REAL NOT NULL DEFAULT 0.9,
  source          TEXT NOT NULL DEFAULT 'summarizer',
  -- 'summarizer' | 'manual' | 'system'
  created_at      TEXT NOT NULL,
  expires_at      TEXT,                   -- NULL = never expires
  superseded_by   TEXT                    -- NULL = active; UUID or 'manual_forget'
);

CREATE INDEX IF NOT EXISTS idx_mem_contact_category
  ON memories (contact_id, category);

CREATE INDEX IF NOT EXISTS idx_mem_expires
  ON memories (expires_at)
  WHERE expires_at IS NOT NULL;

-- FTS5 virtual table for full-text search over memory content.
-- External content table — triggers keep it in sync.
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts
  USING fts5(content, content='memories', content_rowid='rowid');

CREATE TRIGGER IF NOT EXISTS memories_ai
  AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts (rowid, content) VALUES (new.rowid, new.content);
  END;

CREATE TRIGGER IF NOT EXISTS memories_ad
  AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts (memories_fts, rowid, content)
      VALUES ('delete', old.rowid, old.content);
  END;

CREATE TRIGGER IF NOT EXISTS memories_au
  AFTER UPDATE ON memories BEGIN
    INSERT INTO memories_fts (memories_fts, rowid, content)
      VALUES ('delete', old.rowid, old.content);
    INSERT INTO memories_fts (rowid, content) VALUES (new.rowid, new.content);
  END;

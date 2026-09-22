-- Migration 018 — Knowledge store (Phase 1: agent-managed structured knowledge)
--
-- Unlike the dormant E8/E9 `memories` / `session_summaries` tables (see
-- migration 003 and docs/MEMORY_MODEL.md's "Why the structured store is
-- dormant" section), `knowledge` is a NEW, always-on table: agents write to
-- it directly (via the write_knowledge MCP tool -> POST /api/v1/knowledge)
-- to build up their own structured record store — arbitrary JSON `payload`
-- under an agent-chosen `kind`/schema, not a fixed extraction pipeline. It is
-- not a revival of the legacy memories/summaries tables and does not sit
-- behind `memory.structured_extraction`.
--
-- payload / body_text split: `payload` is stored verbatim (arbitrary JSON,
-- the agent's own schema) so a consumer can reconstruct the original
-- structure exactly. `body_text` is a flattened, newline-joined string of
-- every string leaf in `payload` (see src/knowledge/store.ts), computed once
-- at write time so FTS5 has plain text to index without having to parse JSON
-- per row at query time.
--
-- content_hash: sha256 hex digest of `body_text`, computed at write time (see
-- src/knowledge/store.ts) and stored rather than computed on read. This lets
-- a future per-turn injection ledger (src/adapters/context-ledger.ts, added
-- in a separate change on this branch — migration 017) compare against the
-- stored hash directly to decide whether a knowledge row has already been
-- sent into a session's transcript, without re-hashing potentially large
-- payloads on every check.
--
-- tags / facets: `tags` is a JSON array of free-form string labels; `facets`
-- is a JSON object of scalar key/value pairs for exact-match filtering (e.g.
-- {"project": "agentbus"}). Both are stored as JSON text and also mirrored
-- into `knowledge_fts` (tags only) so a tag can be found by keyword search
-- as well as by exact filter.
--
-- Recency vs. relevance: `event_at` is when the fact/event the row describes
-- occurred (may differ from `created_at`, when the row was written).
-- `valid_from` / `relevant_until` bound the window during which the row
-- should be considered live for time-scoped facts; `expires_at` is a hard
-- deletion-eligible cutoff, independent of relevance. All four are nullable
-- free-form ISO 8601 strings — Phase 1 does no validation beyond that they
-- parse as passed.
--
-- Deliberately deferred to a later phase (not built here):
--   - Vector / embedding search (this migration is FTS5 keyword-only, same
--     external-content-table + trigger pattern as migration 003).
--   - `knowledge_edges` — relationships between knowledge rows (e.g.
--     "supersedes", "relates_to" beyond the single `superseded_by` column).
--   - A `knowledge_facets` catalog table constraining facet keys/types; for
--     now `facets` is a free-form JSON object with no schema enforcement.
--
-- FTS5 pattern: external-content table over `knowledge`, kept in sync by
-- ai/ad/au triggers — copied precisely from migration 003's
-- memories/memories_fts pattern, extended to the four indexed columns below.
CREATE TABLE knowledge (
  id              TEXT PRIMARY KEY,
  agent_id        TEXT NOT NULL,
  kind            TEXT NOT NULL,
  title           TEXT NOT NULL,
  payload         TEXT NOT NULL,           -- arbitrary JSON, agent's own schema — stored as given
  index_note      TEXT,                     -- optional agent-authored retrieval cue
  body_text       TEXT NOT NULL,            -- flattened string leaves of payload, for FTS
  tags            TEXT NOT NULL DEFAULT '[]',   -- JSON array
  facets          TEXT NOT NULL DEFAULT '{}',   -- JSON object of scalars
  content_hash    TEXT NOT NULL,            -- sha256(body_text), computed at write time
  event_at        TEXT,
  valid_from      TEXT,
  relevant_until  TEXT,
  expires_at      TEXT,
  importance      REAL NOT NULL DEFAULT 0.5,
  confidence      REAL NOT NULL DEFAULT 0.9,
  source          TEXT NOT NULL DEFAULT 'agent',
  session_id      TEXT,
  contact_id      TEXT,
  channel         TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  superseded_by   TEXT,
  last_recalled_at TEXT,
  recall_count    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_knowledge_agent_kind
  ON knowledge (agent_id, kind);

CREATE INDEX IF NOT EXISTS idx_knowledge_agent_event
  ON knowledge (agent_id, event_at);

CREATE INDEX IF NOT EXISTS idx_knowledge_agent_relevant
  ON knowledge (agent_id, relevant_until);

CREATE INDEX IF NOT EXISTS idx_knowledge_expires
  ON knowledge (expires_at)
  WHERE expires_at IS NOT NULL;

-- FTS5 virtual table for full-text search over title, retrieval cue, flattened
-- payload text, and tags. External content table — triggers keep it in sync.
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts
  USING fts5(title, index_note, body_text, tags, content='knowledge', content_rowid='rowid');

CREATE TRIGGER IF NOT EXISTS knowledge_ai
  AFTER INSERT ON knowledge BEGIN
    INSERT INTO knowledge_fts (rowid, title, index_note, body_text, tags)
      VALUES (new.rowid, new.title, new.index_note, new.body_text, new.tags);
  END;

CREATE TRIGGER IF NOT EXISTS knowledge_ad
  AFTER DELETE ON knowledge BEGIN
    INSERT INTO knowledge_fts (knowledge_fts, rowid, title, index_note, body_text, tags)
      VALUES ('delete', old.rowid, old.title, old.index_note, old.body_text, old.tags);
  END;

CREATE TRIGGER IF NOT EXISTS knowledge_au
  AFTER UPDATE ON knowledge BEGIN
    INSERT INTO knowledge_fts (knowledge_fts, rowid, title, index_note, body_text, tags)
      VALUES ('delete', old.rowid, old.title, old.index_note, old.body_text, old.tags);
    INSERT INTO knowledge_fts (rowid, title, index_note, body_text, tags)
      VALUES (new.rowid, new.title, new.index_note, new.body_text, new.tags);
  END;

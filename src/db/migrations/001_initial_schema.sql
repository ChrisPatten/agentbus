-- Migration 001 — Initial schema
-- All tables, indices, FTS5 virtual tables, and triggers.

-- ── message_queue ─────────────────────────────────────────────────────────────
-- Primary message store. All messages regardless of status live here.
CREATE TABLE IF NOT EXISTS message_queue (
  id              TEXT PRIMARY KEY,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  channel         TEXT NOT NULL,
  topic           TEXT NOT NULL,
  sender          TEXT NOT NULL,
  recipient       TEXT NOT NULL,
  reply_to        TEXT,
  priority        TEXT NOT NULL DEFAULT 'normal',
  status          TEXT NOT NULL DEFAULT 'pending',
  -- pending | processing | delivered | failed | dead_letter | expired
  payload         TEXT NOT NULL,          -- JSON: { type, body, command?, args_raw? }
  metadata        TEXT NOT NULL DEFAULT '{}',
  retry_count     INTEGER NOT NULL DEFAULT 0,
  expires_at      TEXT,                   -- ISO 8601; NULL = no expiry
  acked_at        TEXT,
  error           TEXT
);

CREATE INDEX IF NOT EXISTS idx_mq_status_recipient
  ON message_queue (status, recipient, created_at);

CREATE INDEX IF NOT EXISTS idx_mq_channel_topic
  ON message_queue (channel, topic, created_at);

CREATE INDEX IF NOT EXISTS idx_mq_expires
  ON message_queue (expires_at)
  WHERE expires_at IS NOT NULL AND status = 'pending';

-- ── dead_letter ───────────────────────────────────────────────────────────────
-- Messages that have exhausted retries or been manually dead-lettered.
CREATE TABLE IF NOT EXISTS dead_letter (
  id                  TEXT PRIMARY KEY,
  original_message_id TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  reason              TEXT NOT NULL,
  -- "max_retries_exceeded" | "undeliverable" | "manual" | "expired"
  retry_count         INTEGER NOT NULL DEFAULT 0,
  expires_at          TEXT,
  payload             TEXT NOT NULL       -- Full MessageEnvelope JSON
);

CREATE INDEX IF NOT EXISTS idx_dl_created
  ON dead_letter (created_at);

-- ── sessions ──────────────────────────────────────────────────────────────────
-- A session is a contiguous conversation window bounded by idle time.
-- A new session is created when the gap since the last message in a
-- conversation exceeds config.memory.session_idle_threshold_ms (default 30m).
-- Sessions are the unit of summarization: when a session ends (ended_at is
-- set), the SummarizerPipeline (E8) generates an AI summary and writes it to
-- session_summaries. Active sessions have ended_at = NULL.
CREATE TABLE IF NOT EXISTS sessions (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  channel         TEXT NOT NULL,
  contact_id      TEXT NOT NULL,
  started_at      TEXT NOT NULL,
  last_activity   TEXT NOT NULL,
  ended_at        TEXT,                   -- NULL = active
  message_count   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_sess_conversation
  ON sessions (conversation_id, last_activity);

CREATE INDEX IF NOT EXISTS idx_sess_contact
  ON sessions (contact_id, last_activity);

-- ── transcripts ───────────────────────────────────────────────────────────────
-- Full verbatim message log. Every message that passes through the pipeline is
-- written here by the transcript-log stage (Stage 8). These rows are the raw
-- material the SummarizerPipeline (E8) reads when a session becomes idle.
--
-- conversation_id: stable hash of the conversation context, computed as
--   sha256(sorted([contact_id, channel, topic]).join(':'))
-- This means the same two parties on the same channel always share a
-- conversation_id, regardless of which session they're in.
--
-- session_id → sessions(id): each transcript belongs to a session window.
-- Cascade-deletes ensure transcript rows are removed when a session is pruned.
-- Note: message_id references message_queue.id logically but NOT via FK —
-- messages can be dead-lettered or expired without losing the transcript.
CREATE TABLE IF NOT EXISTS transcripts (
  id              TEXT PRIMARY KEY,
  message_id      TEXT NOT NULL,
  conversation_id TEXT NOT NULL,          -- sha256(sorted([contact_id, channel, topic]).join(':'))
  session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  created_at      TEXT NOT NULL,
  channel         TEXT NOT NULL,
  contact_id      TEXT NOT NULL,
  direction       TEXT NOT NULL,          -- 'inbound' | 'outbound'
  body            TEXT NOT NULL,
  metadata        TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_tr_conversation
  ON transcripts (conversation_id, created_at);

CREATE INDEX IF NOT EXISTS idx_tr_session
  ON transcripts (session_id, created_at);

-- FTS5 virtual table for full-text search over transcript bodies.
-- Uses content= (external content table) so FTS only stores the index, not
-- a copy of the text. Triggers below keep it in sync; if the DB is restored
-- from backup without the FTS index, run `--rebuild-fts` on next startup.
CREATE VIRTUAL TABLE IF NOT EXISTS transcripts_fts
  USING fts5(body, content='transcripts', content_rowid='rowid');

CREATE TRIGGER IF NOT EXISTS transcripts_ai
  AFTER INSERT ON transcripts BEGIN
    INSERT INTO transcripts_fts (rowid, body) VALUES (new.rowid, new.body);
  END;

CREATE TRIGGER IF NOT EXISTS transcripts_ad
  AFTER DELETE ON transcripts BEGIN
    INSERT INTO transcripts_fts (transcripts_fts, rowid, body)
      VALUES ('delete', old.rowid, old.body);
  END;

-- ── session_summaries ─────────────────────────────────────────────────────────
-- AI-generated summaries of completed sessions.
CREATE TABLE IF NOT EXISTS session_summaries (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
  created_at      TEXT NOT NULL,
  channel         TEXT NOT NULL,
  contact_id      TEXT NOT NULL,
  started_at      TEXT NOT NULL,
  ended_at        TEXT NOT NULL,
  summary         TEXT NOT NULL,
  model           TEXT NOT NULL,
  token_count     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_ss_contact_created
  ON session_summaries (contact_id, created_at);

CREATE INDEX IF NOT EXISTS idx_ss_session
  ON session_summaries (session_id);

-- ── conversation_registry ─────────────────────────────────────────────────────
-- Tracks every known conversation for cross-channel linking (decision A6).
-- Supports the /resume slash command, which lets Peggy pick up a conversation
-- from a different channel than it started on.
--
-- id is a stable hash: sha256(sorted([contact_id, channel, topic]).join(':'))
-- Computed at message normalization time; same formula as conversation_id in
-- the transcripts table. Using a hash as PK makes upserts idempotent.
CREATE TABLE IF NOT EXISTS conversation_registry (
  id              TEXT PRIMARY KEY,       -- sha256(sorted([contact_id, channel, topic]).join(':'))
  contact_id      TEXT NOT NULL,
  channel         TEXT NOT NULL,
  topic           TEXT NOT NULL DEFAULT 'general',
  first_seen      TEXT NOT NULL,
  last_seen       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cr_contact
  ON conversation_registry (contact_id, last_seen);

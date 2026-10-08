-- Migration 026 — pluggable journaling state (E66 / S66.2)
--
-- Journal cursor: sessions.journal_cursor_at is the created_at of the last
-- transcript row a successful journal run covered. A run only sees rows
-- after it. It advances only when a run ends `done` or `nothing-to-do`.
-- sessions.last_journaled_at (migration 009) keeps meaning "when the last
-- successful run happened" and anchors the ceiling trigger.
--
-- Existing sessions start their cursor at their last journal time, so an
-- upgrade does not re-journal what the pre-E66 sweep already covered.
ALTER TABLE sessions ADD COLUMN journal_cursor_at TEXT;
UPDATE sessions SET journal_cursor_at = last_journaled_at WHERE last_journaled_at IS NOT NULL;

-- Per-session journaling state that must survive a restart: a final
-- trigger still waiting to be journaled (close, /clear, evict, pre-compact,
-- shutdown, …), the true end of the last turn (re-anchors the pause timer),
-- the harness's own session id and transcript path, and the exhausted-run
-- counter for the current window.
CREATE TABLE IF NOT EXISTS journal_state (
  session_id              TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  pending_trigger         TEXT,     -- final/manual trigger awaiting a successful run
  pending_since           TEXT,     -- when that trigger fired
  last_turn_ended_at      TEXT,     -- turn-ended hook, or the bus seeing a turn finish
  harness_session_id      TEXT,     -- e.g. the Claude session id a hook reported
  harness_transcript_path TEXT,     -- the harness's own transcript file, when reported
  attempts                INTEGER NOT NULL DEFAULT 0,  -- exhausted runs for attempts_window_to
  attempts_window_to      TEXT,     -- window end those attempts covered; new content re-arms
  last_attempt_at         TEXT,
  last_outcome            TEXT,     -- 'done' | 'nothing-to-do' | 'exhausted'
  updated_at              TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_journal_state_pending
  ON journal_state (pending_trigger) WHERE pending_trigger IS NOT NULL;

-- "Preserve now, journal later": transcript snapshots a hook saved before a
-- lossy event (pre-compact, clear). The next run for the session gets them
-- as input; a successful run marks them consumed.
CREATE TABLE IF NOT EXISTS journal_snapshots (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  event           TEXT NOT NULL,      -- 'pre-compact' | 'clear' | 'session-end'
  path            TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  consumed_by_run TEXT,
  consumed_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_journal_snapshots_pending
  ON journal_snapshots (session_id) WHERE consumed_at IS NULL;

-- Per-agent counters behind the exhaustion advisory and the health summary.
CREATE TABLE IF NOT EXISTS journal_agent_state (
  agent_id                TEXT PRIMARY KEY,  -- prefixed logical id (pool id, not pane id)
  consecutive_exhaustions INTEGER NOT NULL DEFAULT 0,
  last_exhausted_at       TEXT,
  last_success_at         TEXT,
  last_failure_at         TEXT,
  last_failure            TEXT,
  updated_at              TEXT NOT NULL
);

-- Hook health: the last time each harness event arrived for an agent.
CREATE TABLE IF NOT EXISTS journal_hook_events (
  agent_id     TEXT NOT NULL,
  event        TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  count        INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (agent_id, event)
);

-- One row per journaler attempt. Attempts of one run share run_id. Swept
-- after 90 days.
CREATE TABLE IF NOT EXISTS journal_runs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id          TEXT NOT NULL,
  agent_id        TEXT NOT NULL,     -- prefixed logical id
  session_id      TEXT,
  conversation_id TEXT,
  kind            TEXT NOT NULL DEFAULT 'session',  -- 'session' | 'consolidate' (E68)
  trigger         TEXT NOT NULL,
  journaler       TEXT NOT NULL,
  chain_position  INTEGER NOT NULL,  -- 0-based index in the configured chain
  fallback_from   TEXT,              -- journaler tried just before this one in the same run
  outcome         TEXT NOT NULL
                    CHECK (outcome IN ('done', 'nothing-to-do', 'unavailable', 'failed-before-start', 'failed-after-start')),
  error           TEXT,              -- truncated
  fidelity        TEXT CHECK (fidelity IS NULL OR fidelity IN ('bus-transcript', 'snapshot', 'full-session')),
  window_from     TEXT,
  window_to       TEXT,
  message_count   INTEGER NOT NULL DEFAULT 0,
  started_at      TEXT NOT NULL,
  duration_ms     INTEGER,
  files_changed   TEXT,              -- JSON array of paths
  notes           TEXT,
  cost_usd        REAL,
  input_tokens    INTEGER,
  output_tokens   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_journal_runs_agent ON journal_runs (agent_id, started_at);
CREATE INDEX IF NOT EXISTS idx_journal_runs_run ON journal_runs (run_id);
CREATE INDEX IF NOT EXISTS idx_journal_runs_started ON journal_runs (started_at);

-- Migration 020 — pool pane watchdog (E52)
--
-- last_turn_ended_at: set by POST /api/v1/pool/:agentId/turn-ended (the Stop
-- hook). Unlike last_activity_at, which acquire() also bumps when a message is
-- routed IN, this changes only when a turn actually finishes. The watchdog
-- compares it against message_queue.acked_at to tell "a message arrived and no
-- turn has ended since" (unhandled work) from an idle pane.
--
-- pane_incidents: one row per detected stall. screen_snapshot keeps the full
-- captured pane text locally as the input for writing better patterns; alerts
-- only ever carry a trimmed tail of it.

ALTER TABLE pool_leases ADD COLUMN last_turn_ended_at TEXT;

CREATE TABLE IF NOT EXISTS pane_incidents (
  id               TEXT PRIMARY KEY,
  pool_id          TEXT NOT NULL,
  pane_id          TEXT NOT NULL,
  conversation_id  TEXT,
  class            TEXT NOT NULL,   -- known_screen | idle_prompt | frozen_turn | unknown_blocked
  pattern          TEXT,            -- pattern-table entry name, if any
  detected_at      TEXT NOT NULL,
  unhandled_since  TEXT,
  screen_snapshot  TEXT NOT NULL,
  actions          TEXT,            -- JSON array: [{ at, action, result }]
  resolved_at      TEXT,
  resolution       TEXT             -- recovered | answered | answer_failed | released | superseded
);

CREATE INDEX IF NOT EXISTS idx_pane_incidents_open ON pane_incidents (pool_id, pane_id, resolved_at);

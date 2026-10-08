-- Migration 025 — advisories table (E65 / S65.2)
--
-- Bus advisories: conditions the bus wants an agent's owners to know about
-- (e.g. "journaling chain exhausted"). One row per occurrence of a
-- condition. While a condition is active (state != 'resolved') there is at
-- most one row for (agent_id, condition_key); raising it again updates that
-- row in place. Resolving it closes the row; a later recurrence inserts a
-- new row, so history is kept. See docs/ADVISORIES.md.
--
-- Lifecycle: open -> delivered -> acknowledged -> resolved (resolved can
-- follow any state). Severity escalation moves the row back to 'open' so it
-- is delivered again at the new severity.

CREATE TABLE IF NOT EXISTS advisories (
  id                TEXT PRIMARY KEY,                      -- uuid
  agent_id          TEXT NOT NULL,                          -- prefixed logical id, e.g. 'agent:baxter' (pool id, not pane id)
  condition_key     TEXT NOT NULL,                          -- producer-chosen, e.g. 'journaling:chain-exhausted'
  severity          TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  title             TEXT NOT NULL,
  body              TEXT NOT NULL,
  remediation       TEXT NOT NULL,                          -- what the owner can do about it
  source            TEXT,                                   -- producer name, e.g. 'journaling'
  state             TEXT NOT NULL DEFAULT 'open'
                      CHECK (state IN ('open', 'delivered', 'acknowledged', 'resolved')),
  raised_at         TEXT NOT NULL,                          -- first raise of this occurrence
  updated_at        TEXT NOT NULL,                          -- last change to any column
  last_raised_at    TEXT NOT NULL,                          -- last raise() call, even when nothing changed
  raise_count       INTEGER NOT NULL DEFAULT 1,
  delivered_at      TEXT,
  delivered_via     TEXT,                                   -- 'injection' | 'system-turn' | 'direct'
  delivery_attempts INTEGER NOT NULL DEFAULT 0,             -- proactive attempts since the last (re)open
  last_attempt_at   TEXT,
  last_error        TEXT,
  acknowledged_at   TEXT,
  acknowledged_by   TEXT,                                   -- agent id that called advisory_ack
  resolved_at       TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_advisories_active
  ON advisories(agent_id, condition_key) WHERE state != 'resolved';

CREATE INDEX IF NOT EXISTS idx_advisories_agent_state ON advisories(agent_id, state);

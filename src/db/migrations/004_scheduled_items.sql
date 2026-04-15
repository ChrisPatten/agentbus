/**
 * Migration 004 — Scheduled items
 *
 * Adds the scheduled_items table used by the Scheduler background worker (E18).
 * Each row represents a one-shot or recurring cron-based message that the
 * scheduler fires into the inbound pipeline on schedule.
 *
 * status lifecycle:
 *   active    → currently armed; scheduler will fire when fire_at <= now
 *   paused    → temporarily disabled; scheduler skips it
 *   cancelled → permanently disabled (manual cancel or config removal)
 *   completed → one-shot fired, or max_fires reached for a cron schedule
 */

CREATE TABLE IF NOT EXISTS scheduled_items (
  id            TEXT PRIMARY KEY,
  type          TEXT NOT NULL CHECK(type IN ('once', 'cron')),
  cron_expr     TEXT,                          -- null for type='once'
  timezone      TEXT NOT NULL DEFAULT 'UTC',   -- IANA tz string
  fire_at       TEXT NOT NULL,                 -- ISO UTC; next fire time
  channel       TEXT NOT NULL,
  sender        TEXT NOT NULL,                 -- e.g. contact:chris
  payload_body  TEXT NOT NULL,                 -- the prompt text
  topic         TEXT NOT NULL DEFAULT 'general',
  priority      TEXT NOT NULL DEFAULT 'normal'
                  CHECK(priority IN ('normal', 'high', 'urgent')),
  label         TEXT,                          -- optional human-readable name
  created_at    TEXT NOT NULL,
  created_by    TEXT NOT NULL DEFAULT 'http',  -- 'config' | 'http' | agent id
  last_fired_at TEXT,
  fire_count    INTEGER NOT NULL DEFAULT 0,
  max_fires     INTEGER,                       -- null = unlimited
  status        TEXT NOT NULL DEFAULT 'active'
                  CHECK(status IN ('active', 'paused', 'cancelled', 'completed'))
);

-- Fast lookup of due items (the hot path — hit on every scheduler tick)
CREATE INDEX IF NOT EXISTS idx_scheduled_items_fire_at
  ON scheduled_items (fire_at)
  WHERE status = 'active';

-- Fast lookup by creator (used to cancel removed config schedules on startup)
CREATE INDEX IF NOT EXISTS idx_scheduled_items_created_by
  ON scheduled_items (created_by);

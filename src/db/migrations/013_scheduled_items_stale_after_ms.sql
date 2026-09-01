-- Migration 013 — Staleness ceiling + dead_letter status for one-shot schedules (E40)
--
-- Adds an optional stale_after_ms column to scheduled_items. When set (only
-- meaningful for type='once'), the Scheduler dead-letters the item instead of
-- firing it if it goes due more than stale_after_ms after its fire_at — e.g. a
-- post-restart wake-up that shouldn't fire hours late if the process never
-- comes back up in time. Null (the default) preserves existing behavior
-- exactly: fire no matter how overdue.
--
-- Also adds 'dead_letter' to the status CHECK constraint. SQLite can't ALTER
-- a CHECK constraint in place, so the table is rebuilt: rename, recreate with
-- the new column/constraint, copy data, drop the old copy, recreate indices.

ALTER TABLE scheduled_items RENAME TO scheduled_items_old;

CREATE TABLE scheduled_items (
  id             TEXT PRIMARY KEY,
  type           TEXT NOT NULL CHECK(type IN ('once', 'cron')),
  cron_expr      TEXT,                          -- null for type='once'
  timezone       TEXT NOT NULL DEFAULT 'UTC',   -- IANA tz string
  fire_at        TEXT NOT NULL,                 -- ISO UTC; next fire time
  channel        TEXT NOT NULL,
  sender         TEXT NOT NULL,                 -- e.g. contact:chris
  payload_body   TEXT NOT NULL,                 -- the prompt text
  topic          TEXT NOT NULL DEFAULT 'general',
  priority       TEXT NOT NULL DEFAULT 'normal'
                   CHECK(priority IN ('normal', 'high', 'urgent')),
  label          TEXT,                          -- optional human-readable name
  created_at     TEXT NOT NULL,
  created_by     TEXT NOT NULL DEFAULT 'http',  -- 'config' | 'http' | agent id
  last_fired_at  TEXT,
  fire_count     INTEGER NOT NULL DEFAULT 0,
  max_fires      INTEGER,                       -- null = unlimited
  stale_after_ms INTEGER,                       -- null = no staleness limit (type='once' only)
  status         TEXT NOT NULL DEFAULT 'active'
                   CHECK(status IN ('active', 'paused', 'cancelled', 'completed', 'dead_letter'))
);

INSERT INTO scheduled_items
  (id, type, cron_expr, timezone, fire_at, channel, sender, payload_body,
   topic, priority, label, created_at, created_by, last_fired_at, fire_count,
   max_fires, status)
SELECT
  id, type, cron_expr, timezone, fire_at, channel, sender, payload_body,
  topic, priority, label, created_at, created_by, last_fired_at, fire_count,
  max_fires, status
FROM scheduled_items_old;

DROP TABLE scheduled_items_old;

-- Fast lookup of due items (the hot path — hit on every scheduler tick)
CREATE INDEX IF NOT EXISTS idx_scheduled_items_fire_at
  ON scheduled_items (fire_at)
  WHERE status = 'active';

-- Fast lookup by creator (used to cancel removed config schedules on startup)
CREATE INDEX IF NOT EXISTS idx_scheduled_items_created_by
  ON scheduled_items (created_by);

-- Fast lookup for /schedule list slash command (channel + status)
CREATE INDEX IF NOT EXISTS idx_scheduled_items_channel_status
  ON scheduled_items (channel, status);

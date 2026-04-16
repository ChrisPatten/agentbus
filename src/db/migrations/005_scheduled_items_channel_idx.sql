/**
 * Migration 005 — Scheduled items channel index
 *
 * Adds a (channel, status) index to support the /schedule list slash command,
 * which queries WHERE channel = ? AND status = 'active'.
 * The existing fire_at partial index only covers the tick hot path.
 */

CREATE INDEX IF NOT EXISTS idx_scheduled_items_channel_status
  ON scheduled_items (channel, status);

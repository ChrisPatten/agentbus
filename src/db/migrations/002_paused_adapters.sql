-- Migration 002 — Paused adapters
-- Persists adapter pause state across restarts.

CREATE TABLE IF NOT EXISTS paused_adapters (
  adapter_id  TEXT PRIMARY KEY,
  paused_at   TEXT NOT NULL,
  paused_by   TEXT NOT NULL    -- sender who issued /pause
);

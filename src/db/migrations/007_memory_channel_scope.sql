-- Migration 007 — Add channel scoping to memories
--
-- Memories were previously scoped only by contact_id, causing all agents to
-- see each other's learned facts for shared contacts. Adding a channel column
-- lets the memory-inject stage filter to only memories created in the same
-- channel (i.e. by the same agent). NULL = visible on all channels (manual
-- memories created via API with no channel specified).
ALTER TABLE memories ADD COLUMN channel TEXT;

CREATE INDEX IF NOT EXISTS idx_mem_contact_channel
  ON memories (contact_id, channel)
  WHERE channel IS NOT NULL;

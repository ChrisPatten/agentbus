-- Migration 040 — outbound_messages registry (E81 / S81.4)
--
-- One row per message the Telegram adapter delivered, keyed by the bus
-- message id (the id the `reply` / `send_message` tools return). It lets
-- `edit_message`, `pin_message` and `unpin_message` take a bus message id and
-- find the chat, forum topic and platform message id behind it. Rows are
-- written by the adapter's send path after Telegram returns a message id and
-- pruned after 30 days.
--
-- kind:  text | rich | location | venue | contact | document | photo | input
-- parts: number of Telegram messages the bus message was split into. A
--        multi-part text message records its LAST part in platform_message_id
--        and cannot be edited.
--
-- Indexes:
--   idx_outbound_messages_created — the retention prune.

CREATE TABLE IF NOT EXISTS outbound_messages (
  bus_message_id      TEXT PRIMARY KEY,
  channel             TEXT NOT NULL,
  chat_id             INTEGER NOT NULL,
  thread_id           INTEGER,                      -- forum topic message_thread_id; NULL for a DM or General
  platform_message_id INTEGER NOT NULL,
  kind                TEXT NOT NULL DEFAULT 'text',
  parts               INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_outbound_messages_created ON outbound_messages(created_at);

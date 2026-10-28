-- Migration 042 — input_prompts (E81 / S81.8)
--
-- Prompts sent by the `ask_input` tool. The Telegram adapter matches an
-- inbound location, contact, shared-user or force_reply answer to the open
-- prompt for the same chat/topic and contact, links it to the prompt via
-- reply_to, and removes the one-time reply keyboard afterward.
--
-- kind:   location | contact | person | text
-- status: open -> answered | expired
-- keyboard: 1 when a reply keyboard (request_location/contact/users) was shown
--           and still needs removing.
--
-- Indexes:
--   idx_input_prompts_open — the inbound match and the expiry sweep.

CREATE TABLE IF NOT EXISTS input_prompts (
  id                  TEXT PRIMARY KEY,
  channel             TEXT NOT NULL,
  topic               TEXT NOT NULL,
  contact_id          TEXT,                         -- addressee; NULL = any allow-listed sender
  kind                TEXT NOT NULL,
  chat_id             INTEGER NOT NULL,
  thread_id           INTEGER,
  platform_message_id INTEGER,
  bus_message_id      TEXT,
  request_id          INTEGER,                      -- request_users request_id (kind person)
  keyboard            INTEGER NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'open',
  answered_at         TEXT,
  created_at          TEXT NOT NULL,
  expires_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_input_prompts_open ON input_prompts(status, chat_id, thread_id);

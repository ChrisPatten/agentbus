-- Migration 035 — choice_prompts table (E74 / S74.2)
--
-- Single-choice button prompts an agent attaches to an outbound message via
-- the `choices` argument of the `reply` / `send_message` MCP tools. The
-- Telegram adapter renders one inline button per label and puts only
-- `choice:<id>:<index>` in `callback_data` (Telegram caps it at 64 bytes), so
-- the labels live here, server-side. See _bmad-output/epics/E74-telegram-choice-buttons.md.
--
-- Status machine: open -> answered | expired. A tap whose prompt is already
-- answered or expired is rejected and injects nothing.
--
-- Indexes:
--   idx_choice_prompts_status — the expiry sweep's `open` + `expires_at`
--   lookup and the expired-keyboard cleanup lookup.

CREATE TABLE IF NOT EXISTS choice_prompts (
  id                  TEXT PRIMARY KEY,            -- uuid; appears in callback_data
  channel             TEXT NOT NULL,               -- conversation channel the prompt was sent on (e.g. 'telegram:peggy:group:-100...')
  topic               TEXT NOT NULL,               -- conversation topic ('general' or 'thread:<hash>')
  contact_id          TEXT,                         -- addressee (bare contact id); NULL = any allow-listed sender may answer
  labels              TEXT NOT NULL,               -- JSON array of button labels
  platform_message_id TEXT,                        -- '{chatId}:{messageId}' of the message carrying the keyboard; NULL once cleaned up
  bus_message_id      TEXT,                        -- bus id of the outbound message; the tap's inbound message replies to it
  status              TEXT NOT NULL DEFAULT 'open', -- open | answered | expired
  chosen_index        INTEGER,
  answered_by         TEXT,
  answered_at         TEXT,
  created_at          TEXT NOT NULL,
  expires_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_choice_prompts_status ON choice_prompts(status, expires_at);

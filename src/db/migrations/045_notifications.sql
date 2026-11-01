-- E89: user notifications. One row per item; `key` is unique while the item is
-- non-terminal (active or acknowledged) so a writer can upsert by key.
-- (IF NOT EXISTS throughout: migration tests re-run versions on a populated database.)

CREATE TABLE IF NOT EXISTS notifications (
  id               TEXT PRIMARY KEY,
  key              TEXT,
  contact_id       TEXT NOT NULL DEFAULT 'chris',
  title            TEXT NOT NULL,
  body             TEXT,
  level            TEXT NOT NULL DEFAULT 'attention' CHECK (level IN ('info','attention','urgent')),
  state            TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','acknowledged','resolved','expired')),
  targets          TEXT NOT NULL DEFAULT '["*"]',   -- JSON array of surface ids, or ["*"]
  actions          TEXT NOT NULL DEFAULT '[]',      -- JSON array of {label, style?}
  source           TEXT NOT NULL,
  conversation_ref TEXT,
  acked_by         TEXT,
  acked_at         TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  expires_at       TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_open_key ON notifications(key)
  WHERE key IS NOT NULL AND state IN ('active','acknowledged');
CREATE INDEX IF NOT EXISTS idx_notifications_state ON notifications(state, updated_at);

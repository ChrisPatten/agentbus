-- E90/E91: Intercom surfaces. Pairing codes (stored hashed), a per-surface
-- durable event log with its own sequence counter, and send idempotency.
-- (IF NOT EXISTS throughout: migration tests re-run versions on a populated database.)

CREATE TABLE IF NOT EXISTS intercom_pair_codes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  surface_id TEXT NOT NULL,
  code_hash  TEXT NOT NULL UNIQUE,   -- sha256 hex of the normalised code
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at    TEXT
);

CREATE TABLE IF NOT EXISTS intercom_surface_seq (
  surface_id TEXT PRIMARY KEY,
  last_seq   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS intercom_events (
  surface_id TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  event      TEXT NOT NULL,
  data       TEXT NOT NULL,          -- JSON
  created_at TEXT NOT NULL,
  PRIMARY KEY (surface_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_intercom_events_created ON intercom_events(created_at);

CREATE TABLE IF NOT EXISTS intercom_sends (
  surface_id    TEXT NOT NULL,
  client_msg_id TEXT NOT NULL,
  message_id    TEXT NOT NULL,
  ack_json      TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (surface_id, client_msg_id)
);

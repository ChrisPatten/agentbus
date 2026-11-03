-- E96: Surface API v2. Surfaces (mirrored from config), devices with their own
-- credentials, revisioned per-surface resources with a replay log, action-triggered
-- jobs with idempotency keys, and the answer-needed flag per conversation.
-- (IF NOT EXISTS throughout: migration tests re-run versions on a populated database.)

-- ── S96.1 surfaces and devices ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS surfaces (
  id         TEXT PRIMARY KEY,
  profile    TEXT NOT NULL,
  follow     TEXT NOT NULL,              -- JSON {contact, channel, topic?}
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS surface_devices (
  id              TEXT PRIMARY KEY,
  surface_id      TEXT NOT NULL,
  name            TEXT NOT NULL,
  profile         TEXT NOT NULL,
  scope           TEXT NOT NULL DEFAULT 'interactive' CHECK (scope IN ('interactive','read_only')),
  credential_hash TEXT NOT NULL UNIQUE,  -- sha256 hex of the credential
  legacy          INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  last_seen_at    TEXT,
  revoked_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_surface_devices_surface ON surface_devices(surface_id, revoked_at);

-- Pairing codes for v2: carry the device's name, profile and scope. (v1 codes stay in intercom_pair_codes.)
CREATE TABLE IF NOT EXISTS surface_pair_codes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  surface_id TEXT NOT NULL,
  code_hash  TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  profile    TEXT NOT NULL,
  scope      TEXT NOT NULL DEFAULT 'interactive',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  device_id  TEXT
);

-- ── S96.3 resources ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS surface_resource_revs (
  surface_id TEXT NOT NULL,
  resource   TEXT NOT NULL,
  rev        INTEGER NOT NULL,
  PRIMARY KEY (surface_id, resource)
);

CREATE TABLE IF NOT EXISTS surface_resource_items (
  surface_id TEXT NOT NULL,
  resource   TEXT NOT NULL,
  item_id    TEXT NOT NULL,
  data       TEXT NOT NULL,              -- JSON object
  updated_at TEXT NOT NULL,
  PRIMARY KEY (surface_id, resource, item_id)
);

-- One row per rev: the ops that produced it. Trimmed to surface_api.log_retention_revs per resource.
CREATE TABLE IF NOT EXISTS surface_resource_log (
  surface_id TEXT NOT NULL,
  resource   TEXT NOT NULL,
  rev        INTEGER NOT NULL,
  ops        TEXT NOT NULL,              -- JSON ResourceOp[]
  created_at TEXT NOT NULL,
  PRIMARY KEY (surface_id, resource, rev)
);

-- ── S96.4 actions and jobs ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS surface_jobs (
  id              TEXT PRIMARY KEY,
  surface_id      TEXT NOT NULL,
  object_ref      TEXT NOT NULL,         -- events:<event id>:<action id>
  trigger         TEXT NOT NULL DEFAULT 'action' CHECK (trigger IN ('action')),
  channel         TEXT NOT NULL,
  sender          TEXT NOT NULL,
  topic           TEXT NOT NULL DEFAULT 'general',
  payload_body    TEXT NOT NULL,
  sends_on_behalf INTEGER NOT NULL DEFAULT 0,
  confirm_draft   TEXT,
  once            INTEGER NOT NULL DEFAULT 1,
  expires_at      TEXT,
  fire_count      INTEGER NOT NULL DEFAULT 0,
  last_fired_at   TEXT,
  created_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  UNIQUE (surface_id, object_ref)
);

CREATE TABLE IF NOT EXISTS surface_action_keys (
  surface_id      TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  device_id       TEXT NOT NULL,
  result_json     TEXT NOT NULL,         -- the ActionResult returned the first time
  created_at      TEXT NOT NULL,
  PRIMARY KEY (surface_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_surface_action_keys_created ON surface_action_keys(created_at);

-- ── S96.6 answer needed ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS surface_answer_needed (
  conversation_id TEXT PRIMARY KEY,
  message_id      TEXT NOT NULL,
  agent_id        TEXT,
  set_at          TEXT NOT NULL
);

-- `status(subject)` per conversation.
CREATE TABLE IF NOT EXISTS surface_session_subjects (
  conversation_id TEXT PRIMARY KEY,
  subject         TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- E59: per-contact cursor stream and idempotent app sends.
-- Triggers couple transcript/session writes to event creation in the same
-- SQLite statement/transaction, so a committed transcript cannot miss replay.
CREATE TABLE app_event_counters (
  contact_id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE app_events (
  contact_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('message', 'session')),
  session_id TEXT NOT NULL,
  transcript_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (contact_id, seq)
);
CREATE INDEX idx_app_events_retention ON app_events (created_at);
CREATE INDEX idx_app_events_session ON app_events (contact_id, session_id, seq);

CREATE TRIGGER app_transcript_event AFTER INSERT ON transcripts BEGIN
  INSERT INTO app_event_counters (contact_id, seq) VALUES (new.contact_id, 1)
    ON CONFLICT(contact_id) DO UPDATE SET seq = seq + 1;
  INSERT INTO app_events (contact_id, seq, kind, session_id, transcript_id, created_at)
    VALUES (new.contact_id,
      (SELECT seq FROM app_event_counters WHERE contact_id = new.contact_id),
      'message', new.session_id, new.id, new.created_at);
END;

CREATE TRIGGER app_session_created AFTER INSERT ON sessions BEGIN
  INSERT INTO app_event_counters (contact_id, seq) VALUES (new.contact_id, 1)
    ON CONFLICT(contact_id) DO UPDATE SET seq = seq + 1;
  INSERT INTO app_events (contact_id, seq, kind, session_id, created_at)
    VALUES (new.contact_id,
      (SELECT seq FROM app_event_counters WHERE contact_id = new.contact_id),
      'session', new.id, new.started_at);
END;

CREATE TRIGGER app_session_changed AFTER UPDATE OF ended_at, last_activity ON sessions
WHEN old.ended_at IS NOT new.ended_at OR old.last_activity IS NOT new.last_activity BEGIN
  INSERT INTO app_event_counters (contact_id, seq) VALUES (new.contact_id, 1)
    ON CONFLICT(contact_id) DO UPDATE SET seq = seq + 1;
  INSERT INTO app_events (contact_id, seq, kind, session_id, created_at)
    VALUES (new.contact_id,
      (SELECT seq FROM app_event_counters WHERE contact_id = new.contact_id),
      'session', new.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TABLE app_sends (
  contact_id TEXT NOT NULL,
  client_msg_id TEXT NOT NULL,
  ack_json TEXT NOT NULL,
  intent_json TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (contact_id, client_msg_id)
);

CREATE TABLE app_read_markers (
  contact_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (contact_id, session_id),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE TABLE app_uploads (
  attachment_id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  size INTEGER NOT NULL,
  FOREIGN KEY (attachment_id) REFERENCES attachments(id) ON DELETE CASCADE
);

-- Migration 043 — app_events: the 'choice' event kind (E86 / S86.2)
--
-- The Mac app draws choice buttons. When a prompt is answered or expires the
-- bus records a durable `choice` event in the per-contact seq stream, so
-- every client (and a reload) sees the new state. SQLite cannot alter a CHECK
-- constraint, so app_events is rebuilt:
--
--   kind             adds 'choice'.
--   transcript_id    for a choice event, the prompt message's transcript row.
--   choice_prompt_id new, nullable: the choice_prompts row a choice event is for.
--
-- Every existing row keeps its contact_id, seq, kind, session_id,
-- transcript_id, created_at and rotation (037). app_event_counters is not
-- touched, so new events continue the same per-contact seq. The three
-- triggers from 024 reference app_events, so they are dropped before the
-- rebuild (ALTER TABLE ... RENAME re-parses every trigger) and recreated
-- unchanged afterward, along with both indexes. The migration runner wraps
-- this file in one transaction, so no event can be written half way.

DROP TRIGGER IF EXISTS app_transcript_event;
DROP TRIGGER IF EXISTS app_session_created;
DROP TRIGGER IF EXISTS app_session_changed;

CREATE TABLE app_events_new (
  contact_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('message', 'session', 'choice')),
  session_id TEXT NOT NULL,
  transcript_id TEXT,
  created_at TEXT NOT NULL,
  rotation INTEGER NOT NULL DEFAULT 0,
  choice_prompt_id TEXT,
  PRIMARY KEY (contact_id, seq)
);

INSERT INTO app_events_new (contact_id, seq, kind, session_id, transcript_id, created_at, rotation)
  SELECT contact_id, seq, kind, session_id, transcript_id, created_at, rotation FROM app_events;

DROP TABLE app_events;
ALTER TABLE app_events_new RENAME TO app_events;

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

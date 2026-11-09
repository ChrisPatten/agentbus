-- Migration 047 — voice_style_injections (E102)
--
-- Which version of the Intercom voice style guide (adapters.intercom.voice.speech.style_file)
-- was last injected into which agent session. A voice message injects the guide only when its
-- session has none recorded or the file's content hash changed. Kept in the DB so a bus-core
-- restart does not re-inject into panes that are still running the same Claude session.
--
-- session_key: "<bus sessions.id>|<route recipient>" (the pane id for a cc-pool route), so a new
--              session, a /clear, or a different pane starts without a row.

CREATE TABLE IF NOT EXISTS voice_style_injections (
  session_key TEXT PRIMARY KEY,
  hash        TEXT NOT NULL,
  injected_at TEXT NOT NULL
);

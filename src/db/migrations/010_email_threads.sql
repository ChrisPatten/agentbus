-- Migration 010 — Email threads (E21)
--
-- Per-thread reply metadata for the email adapter. Inbound mail is grouped into
-- threads by a derived thread key (root id of References / In-Reply-To / own
-- Message-ID), which is hashed into a `thread:<hash>` topic. That topic, together
-- with the channel, is the row key — the same topic the pipeline carries through
-- to conversation_id, so the outbound send() path can look a thread up by the
-- envelope's (channel, topic) alone.
--
-- A row stores everything needed to thread a reply back into the conversation:
-- the latest inbound Message-ID (In-Reply-To), the accumulated References chain,
-- the subject (for the `Re:` reply), and the contact's address (the To: we reply
-- to, which may differ from the configured contact address).

CREATE TABLE IF NOT EXISTS email_threads (
  channel                 TEXT NOT NULL,
  topic                   TEXT NOT NULL,
  thread_key              TEXT NOT NULL,
  subject                 TEXT,
  last_inbound_message_id TEXT,
  references_chain        TEXT,
  contact_address         TEXT,
  updated_at              TEXT NOT NULL,
  PRIMARY KEY (channel, topic)
);

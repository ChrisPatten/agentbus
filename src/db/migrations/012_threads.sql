-- Migration 012 — Generic thread store (E27)
--
-- Generalizes migration 010's `email_threads` into a channel-agnostic `threads`
-- table. Every channel's per-thread reply state shares the same shape: a
-- `(channel, topic)` row key, a raw `thread_key` (the channel-specific id that
-- got hashed into the `thread:<hash>` topic), and an `updated_at` stamp.
-- Whatever's genuinely channel-specific (email's subject/References chain,
-- Telegram's chat_id/message_thread_id, anything a future channel needs) lives
-- in `metadata` as an opaque JSON blob, typed per-adapter at the call site
-- (see src/pipeline/thread-store.ts).
--
-- Backfills every existing `email_threads` row, packing its four metadata
-- columns into `metadata`, then drops `email_threads` — email's threading
-- behavior is unchanged, only its storage moved.

CREATE TABLE threads (
  channel    TEXT NOT NULL,
  topic      TEXT NOT NULL,
  thread_key TEXT NOT NULL,
  metadata   TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (channel, topic)
);

INSERT INTO threads (channel, topic, thread_key, metadata, updated_at)
SELECT
  channel,
  topic,
  thread_key,
  json_object(
    'subject', subject,
    'lastInboundMessageId', last_inbound_message_id,
    'referencesChain', references_chain,
    'contactAddress', contact_address
  ),
  updated_at
FROM email_threads;

DROP TABLE email_threads;

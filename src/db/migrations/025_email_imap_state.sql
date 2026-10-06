-- Email catch-up: the highest IMAP UID each email adapter has processed, per
-- mailbox. On (re)connect the adapter fetches anything newer, so mail that
-- arrived while the bus was down or reconnecting is still handled. UIDs are
-- only comparable within one UIDVALIDITY; a change resets the cursor.
CREATE TABLE email_imap_state (
  adapter_id   TEXT NOT NULL,
  mailbox      TEXT NOT NULL,
  uid_validity TEXT NOT NULL,
  last_uid     INTEGER NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (adapter_id, mailbox)
);

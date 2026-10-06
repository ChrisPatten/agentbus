/**
 * Email catch-up cursor (migration 025): the highest IMAP UID an email
 * adapter has processed per mailbox, so mail that arrives while the bus is
 * down or reconnecting is fetched on the next connect instead of skipped.
 */
import type Database from 'better-sqlite3';

export interface ImapCursor {
  uidValidity: string;
  lastUid: number;
}

export function loadImapCursor(db: Database.Database, adapterId: string, mailbox: string): ImapCursor | null {
  const row = db
    .prepare(`SELECT uid_validity, last_uid FROM email_imap_state WHERE adapter_id = ? AND mailbox = ?`)
    .get(adapterId, mailbox) as { uid_validity: string; last_uid: number } | undefined;
  return row ? { uidValidity: row.uid_validity, lastUid: row.last_uid } : null;
}

export function saveImapCursor(db: Database.Database, adapterId: string, mailbox: string, cursor: ImapCursor): void {
  db.prepare(
    `INSERT INTO email_imap_state (adapter_id, mailbox, uid_validity, last_uid, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(adapter_id, mailbox) DO UPDATE SET
       uid_validity = excluded.uid_validity,
       last_uid     = excluded.last_uid,
       updated_at   = excluded.updated_at`,
  ).run(adapterId, mailbox, cursor.uidValidity, cursor.lastUid, new Date().toISOString());
}

/**
 * Where to start watching after opening the mailbox.
 *
 * - A saved cursor for the same UIDVALIDITY: resume from it and catch up on
 *   everything newer (capped at the mailbox's current last UID, in case the
 *   saved value is ahead of the server's).
 * - No saved cursor (first setup) or a UIDVALIDITY change (UIDs renumbered):
 *   start after the mail already in the mailbox, as on first start, so old
 *   mail is never replayed to the agent.
 */
export function resolveStartUid(
  saved: ImapCursor | null,
  uidValidity: string,
  uidNext: number,
): { lastUid: number; catchUp: boolean } {
  const mailboxLastUid = Math.max(0, uidNext - 1);
  if (saved && saved.uidValidity === uidValidity) {
    const lastUid = Math.min(saved.lastUid, mailboxLastUid);
    return { lastUid, catchUp: lastUid < mailboxLastUid };
  }
  return { lastUid: mailboxLastUid, catchUp: false };
}

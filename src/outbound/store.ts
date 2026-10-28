/**
 * S81.4 — SQLite-backed store for the `outbound_messages` registry (E81).
 *
 * Maps a bus message id to the Telegram chat, forum topic and message id it
 * was delivered as, so `edit_message` / `pin_message` / `unpin_message` can
 * take the id the `reply` and `send_message` tools return. Mirrors
 * src/choices/store.ts: a small synchronous (better-sqlite3) wrapper.
 */
import type Database from 'better-sqlite3';

export type OutboundKind = 'text' | 'rich' | 'location' | 'venue' | 'contact' | 'document' | 'photo' | 'input';

export interface OutboundMessage {
  bus_message_id: string;
  channel: string;
  chat_id: number;
  thread_id: number | null;
  platform_message_id: number;
  kind: OutboundKind;
  parts: number;
  created_at: string;
}

export interface OutboundMessageInput {
  busMessageId: string;
  channel: string;
  chatId: number;
  threadId?: number | null;
  platformMessageId: number;
  kind: OutboundKind;
  parts?: number;
}

/** Registry rows older than this are pruned. */
export const OUTBOUND_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export class OutboundStore {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /** Records (or replaces) the delivery of a bus message. */
  record(input: OutboundMessageInput, now: Date = new Date()): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO outbound_messages
           (bus_message_id, channel, chat_id, thread_id, platform_message_id, kind, parts, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.busMessageId,
        input.channel,
        input.chatId,
        input.threadId ?? null,
        input.platformMessageId,
        input.kind,
        input.parts ?? 1,
        now.toISOString(),
      );
  }

  get(busMessageId: string): OutboundMessage | null {
    const row = this.db.prepare(`SELECT * FROM outbound_messages WHERE bus_message_id = ?`).get(busMessageId) as
      | OutboundMessage
      | undefined;
    return row ?? null;
  }

  /** Deletes rows older than the retention window; returns the number removed. */
  prune(now: Date = new Date(), retentionMs: number = OUTBOUND_RETENTION_MS): number {
    const cutoff = new Date(now.getTime() - retentionMs).toISOString();
    return this.db.prepare(`DELETE FROM outbound_messages WHERE created_at < ?`).run(cutoff).changes;
  }
}

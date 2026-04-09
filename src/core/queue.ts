import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { MessageEnvelope } from '../types/envelope.js';

/** A message row as returned from the queue (envelope + queue metadata) */
export interface QueuedMessage {
  messageId: string;
  envelope: MessageEnvelope;
  priority: 'normal' | 'high' | 'urgent';
  retryCount: number;
  createdAt: string;
  expiresAt: string | null;
}

/** Columns selected from message_queue — avoids SELECT * fragility */
const MESSAGE_COLS = `id, created_at, updated_at, channel, topic, sender, recipient,
  reply_to, priority, status, payload, metadata, retry_count, expires_at, acked_at, error`;

/** Raw row shape coming out of better-sqlite3 */
interface MessageRow {
  id: string;
  created_at: string;
  updated_at: string;
  channel: string;
  topic: string;
  sender: string;
  recipient: string;
  reply_to: string | null;
  priority: string;
  status: string;
  payload: string;
  metadata: string;
  retry_count: number;
  expires_at: string | null;
  acked_at: string | null;
  error: string | null;
}

function rowToQueuedMessage(row: MessageRow): QueuedMessage {
  const envelope: MessageEnvelope = {
    id: row.id,
    timestamp: row.created_at,
    channel: row.channel,
    topic: row.topic,
    sender: row.sender,
    recipient: row.recipient,
    reply_to: row.reply_to,
    priority: row.priority as 'normal' | 'high' | 'urgent',
    payload: JSON.parse(row.payload) as MessageEnvelope['payload'],
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
  };

  return {
    messageId: row.id,
    envelope,
    priority: row.priority as 'normal' | 'high' | 'urgent',
    retryCount: row.retry_count,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

/**
 * SQLite-backed message queue with at-least-once delivery semantics.
 *
 * All operations are synchronous (better-sqlite3 is sync by design).
 * Concurrent dequeue is protected by a transaction that atomically marks
 * selected rows as `processing`, preventing double-delivery.
 */
export class MessageQueue {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Enqueue a `MessageEnvelope` with status `pending`.
   * Returns the generated `message_id`.
   */
  enqueue(envelope: MessageEnvelope, expiresAt?: string): string {
    const id = envelope.id;
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO message_queue
           (id, created_at, updated_at, channel, topic, sender, recipient,
            reply_to, priority, status, payload, metadata, retry_count, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, 0, ?)`
      )
      .run(
        id,
        now,
        now,
        envelope.channel,
        envelope.topic,
        envelope.sender,
        envelope.recipient,
        envelope.reply_to ?? null,
        envelope.priority,
        JSON.stringify(envelope.payload),
        JSON.stringify(envelope.metadata),
        expiresAt ?? null
      );

    return id;
  }

  /**
   * Dequeue up to `limit` pending messages for `recipientId`.
   * Atomically marks selected rows as `processing` within a transaction.
   * Optional `topic` filter restricts to a specific topic.
   */
  dequeue(recipientId: string, topic?: string, limit = 10): QueuedMessage[] {
    const dequeueTransaction = this.db.transaction(
      (recipientId: string, topic: string | undefined, limit: number) => {
        const topicClause = topic ? 'AND topic = ?' : '';
        const params: unknown[] = topic
          ? [recipientId, topic, limit]
          : [recipientId, limit];

        const rows = this.db
          .prepare(
            `SELECT ${MESSAGE_COLS} FROM message_queue
             WHERE status = 'pending'
               AND recipient = ?
               ${topicClause}
             ORDER BY
               CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,
               created_at ASC
             LIMIT ?`
          )
          .all(...params) as MessageRow[];

        if (rows.length === 0) return [];

        const ids = rows.map((r) => r.id);
        const placeholders = ids.map(() => '?').join(', ');
        const now = new Date().toISOString();

        this.db
          .prepare(
            `UPDATE message_queue
             SET status = 'processing', updated_at = ?
             WHERE id IN (${placeholders})`
          )
          .run(now, ...ids);

        return rows.map(rowToQueuedMessage);
      }
    );

    return dequeueTransaction(recipientId, topic, limit);
  }

  /**
   * Acknowledge a message as delivered.
   * Only transitions messages in `processing` status.
   * Returns `true` if the message was acked, `false` if it was not in `processing` state.
   */
  ack(messageId: string): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE message_queue
         SET status = 'delivered', acked_at = ?, updated_at = ?
         WHERE id = ? AND status = 'processing'`
      )
      .run(now, now, messageId);
    return result.changes > 0;
  }

  /**
   * Move a message to the dead-letter table.
   * Removes from `message_queue` and inserts into `dead_letter`.
   * Returns `true` if the message was moved, `false` if it was not found.
   */
  deadLetter(messageId: string, reason: string): boolean {
    const moveTransaction = this.db.transaction(
      (messageId: string, reason: string): boolean => {
        const row = this.db
          .prepare(`SELECT ${MESSAGE_COLS} FROM message_queue WHERE id = ?`)
          .get(messageId) as MessageRow | undefined;

        if (!row) return false;

        const now = new Date().toISOString();
        const dlId = randomUUID();

        const envelope: MessageEnvelope = {
          id: row.id,
          timestamp: row.created_at,
          channel: row.channel,
          topic: row.topic,
          sender: row.sender,
          recipient: row.recipient,
          reply_to: row.reply_to,
          priority: row.priority as 'normal' | 'high' | 'urgent',
          payload: JSON.parse(row.payload) as MessageEnvelope['payload'],
          metadata: JSON.parse(row.metadata) as Record<string, unknown>,
        };

        this.db
          .prepare(
            `INSERT INTO dead_letter
               (id, original_message_id, created_at, reason, retry_count, expires_at, payload)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            dlId,
            messageId,
            now,
            reason,
            row.retry_count,
            row.expires_at ?? null,
            JSON.stringify(envelope)
          );

        this.db.prepare('DELETE FROM message_queue WHERE id = ?').run(messageId);
        return true;
      }
    );

    return moveTransaction(messageId, reason);
  }

  /**
   * Sweep messages past their `expires_at` into the dead-letter table.
   * Runs as a single atomic transaction without nesting. Returns the count swept.
   */
  sweepExpired(): number {
    const sweep = this.db.transaction(() => {
      const now = new Date().toISOString();

      const expired = this.db
        .prepare(
          `SELECT ${MESSAGE_COLS} FROM message_queue
           WHERE status = 'pending'
             AND expires_at IS NOT NULL
             AND expires_at < ?`
        )
        .all(now) as MessageRow[];

      if (expired.length === 0) return 0;

      for (const row of expired) {
        const envelope: MessageEnvelope = {
          id: row.id,
          timestamp: row.created_at,
          channel: row.channel,
          topic: row.topic,
          sender: row.sender,
          recipient: row.recipient,
          reply_to: row.reply_to,
          priority: row.priority as 'normal' | 'high' | 'urgent',
          payload: JSON.parse(row.payload) as MessageEnvelope['payload'],
          metadata: JSON.parse(row.metadata) as Record<string, unknown>,
        };
        this.db
          .prepare(
            `INSERT INTO dead_letter
               (id, original_message_id, created_at, reason, retry_count, expires_at, payload)
             VALUES (?, ?, ?, 'expired', ?, ?, ?)`
          )
          .run(randomUUID(), row.id, now, row.retry_count, row.expires_at ?? null, JSON.stringify(envelope));
      }

      const placeholders = expired.map(() => '?').join(', ');
      this.db
        .prepare(`DELETE FROM message_queue WHERE id IN (${placeholders})`)
        .run(...expired.map((r) => r.id));

      return expired.length;
    });

    return sweep();
  }

  /**
   * Reset messages stuck in `processing` for longer than `maxAgeMs` back to `pending`.
   * This recovers messages whose adapter crashed before acknowledging.
   * Returns the count of messages recovered.
   */
  recoverStuck(maxAgeMs: number): number {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE message_queue
         SET status = 'pending', updated_at = ?
         WHERE status = 'processing' AND updated_at <= ?`
      )
      .run(now, cutoff);
    return result.changes;
  }

  /**
   * Fetch a single message by ID regardless of status.
   * Falls back to the dead_letter table if not found in message_queue.
   * Returns `null` if no message with that ID exists anywhere.
   * Used by the reply tool to look up the original message.
   */
  getById(messageId: string): QueuedMessage | null {
    const row = this.db
      .prepare(`SELECT ${MESSAGE_COLS} FROM message_queue WHERE id = ?`)
      .get(messageId) as MessageRow | undefined;
    if (row) return rowToQueuedMessage(row);

    // Fallback: check dead_letter (messages that were delivered or expired)
    const dlRow = this.db
      .prepare(
        `SELECT original_message_id, created_at, retry_count, expires_at, payload
         FROM dead_letter WHERE original_message_id = ?`
      )
      .get(messageId) as
      | { original_message_id: string; created_at: string; retry_count: number; expires_at: string | null; payload: string }
      | undefined;
    if (!dlRow) return null;

    const envelope = JSON.parse(dlRow.payload) as MessageEnvelope;
    return {
      messageId: dlRow.original_message_id,
      envelope,
      priority: envelope.priority,
      retryCount: dlRow.retry_count,
      createdAt: dlRow.created_at,
      expiresAt: dlRow.expires_at,
    };
  }

  /**
   * Return the count of messages by status (for health reporting).
   */
  counts(): Record<string, number> {
    const rows = this.db
      .prepare('SELECT status, COUNT(*) as count FROM message_queue GROUP BY status')
      .all() as Array<{ status: string; count: number }>;

    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.status] = row.count;
    }
    return result;
  }
}

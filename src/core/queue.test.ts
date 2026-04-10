import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';
import { MessageQueue } from './queue.js';
import type { MessageEnvelope } from '../types/envelope.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function makeEnvelope(overrides: Partial<MessageEnvelope> = {}): MessageEnvelope {
  return {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    channel: 'telegram',
    topic: 'general',
    sender: 'contact:alice',
    recipient: 'agent:claude',
    reply_to: null,
    priority: 'normal',
    payload: { type: 'text', body: 'hello' },
    metadata: {},
    ...overrides,
  };
}

describe('MessageQueue', () => {
  let queue: MessageQueue;

  beforeEach(() => {
    queue = new MessageQueue(makeDb());
  });

  // Fix #1: dequeue was filtering by `channel` column when the HTTP API
  // passed `topic` as the second argument. Verify the filter is now correct.
  describe('dequeue — topic filter', () => {
    it('returns only messages matching the given topic', () => {
      queue.enqueue(makeEnvelope({ topic: 'code' }));
      queue.enqueue(makeEnvelope({ topic: 'general' }));

      const results = queue.dequeue('agent:claude', 'code', 10);
      expect(results).toHaveLength(1);
      expect(results[0].envelope.topic).toBe('code');
    });

    it('returns all topics when no filter is given', () => {
      queue.enqueue(makeEnvelope({ topic: 'code' }));
      queue.enqueue(makeEnvelope({ topic: 'general' }));

      const results = queue.dequeue('agent:claude', undefined, 10);
      expect(results).toHaveLength(2);
    });

    it('does not confuse topic with channel', () => {
      // topic='telegram' should NOT match channel='telegram'
      queue.enqueue(makeEnvelope({ channel: 'telegram', topic: 'general' }));

      const results = queue.dequeue('agent:claude', 'telegram', 10);
      expect(results).toHaveLength(0);
    });
  });

  // Fix #3: messages stuck in `processing` (e.g. after adapter crash) should
  // be recoverable. recoverStuck() resets them to `pending`.
  describe('recoverStuck', () => {
    it('resets processing messages older than maxAgeMs back to pending', () => {
      const envelope = makeEnvelope();
      queue.enqueue(envelope);
      queue.dequeue('agent:claude'); // transitions to processing

      // maxAgeMs=0 means anything in processing qualifies immediately
      const recovered = queue.recoverStuck(0);
      expect(recovered).toBe(1);

      // Should now be dequeue-able again
      const results = queue.dequeue('agent:claude');
      expect(results).toHaveLength(1);
      expect(results[0].envelope.id).toBe(envelope.id);
    });

    it('does not recover recently processing messages', () => {
      queue.enqueue(makeEnvelope());
      queue.dequeue('agent:claude');

      // 1-hour threshold: a just-dequeued message should not be recovered
      const recovered = queue.recoverStuck(60 * 60 * 1000);
      expect(recovered).toBe(0);
    });

    it('does not touch pending or delivered messages', () => {
      queue.enqueue(makeEnvelope()); // pending
      const recovered = queue.recoverStuck(0);
      expect(recovered).toBe(0);
    });
  });

  // Fix #5: getById previously only searched message_queue. After a message is
  // dead-lettered, the reply tool would return "Message not found". It now falls
  // back to the dead_letter table.
  describe('getById — dead_letter fallback', () => {
    it('finds a message that has been dead-lettered', () => {
      const envelope = makeEnvelope();
      queue.enqueue(envelope);
      queue.deadLetter(envelope.id, 'test');

      const found = queue.getById(envelope.id);
      expect(found).not.toBeNull();
      expect(found?.envelope.id).toBe(envelope.id);
      expect(found?.envelope.topic).toBe(envelope.topic);
    });

    it('returns null for a completely unknown message id', () => {
      expect(queue.getById(randomUUID())).toBeNull();
    });

    it('finds a message still in queue_message', () => {
      const envelope = makeEnvelope();
      queue.enqueue(envelope);
      expect(queue.getById(envelope.id)).not.toBeNull();
    });
  });

  // Fix #6: sweepExpired previously called deadLetter() inside a transaction,
  // nesting transactions (a performance hazard). It is now a single flat
  // transaction. Verify correctness is preserved.
  describe('sweepExpired', () => {
    it('moves expired pending messages to dead_letter and returns count', () => {
      const past = new Date(Date.now() - 1000).toISOString();
      const envelope = makeEnvelope();
      queue.enqueue(envelope, past);

      expect(queue.sweepExpired()).toBe(1);
      expect(queue.dequeue('agent:claude')).toHaveLength(0);
      expect(queue.getById(envelope.id)).not.toBeNull(); // findable via dead_letter
    });

    it('does not sweep messages with expires_at in the future', () => {
      const future = new Date(Date.now() + 60_000).toISOString();
      queue.enqueue(makeEnvelope(), future);

      expect(queue.sweepExpired()).toBe(0);
      expect(queue.dequeue('agent:claude')).toHaveLength(1);
    });

    it('does not sweep processing messages even if their expiry has passed', () => {
      const past = new Date(Date.now() - 1000).toISOString();
      queue.enqueue(makeEnvelope(), past);
      queue.dequeue('agent:claude'); // move to processing

      expect(queue.sweepExpired()).toBe(0);
    });

    it('does not sweep messages with no expiry', () => {
      queue.enqueue(makeEnvelope()); // no expires_at

      expect(queue.sweepExpired()).toBe(0);
      expect(queue.dequeue('agent:claude')).toHaveLength(1);
    });
  });
});

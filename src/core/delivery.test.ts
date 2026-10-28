import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { runMigrations } from '../db/schema.js';
import { MessageQueue } from './queue.js';
import { AdapterRegistry, type AdapterInstance } from './registry.js';
import { DeliveryWorker } from './delivery.js';
import type { MessageEnvelope } from '../types/envelope.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function makeAdapter(id: string, channel: string, send: AdapterInstance['send']): AdapterInstance {
  return {
    id,
    name: id,
    capabilities: { send: true, channels: [channel] },
    start: async () => {},
    stop: async () => {},
    health: async () => ({ status: 'healthy' as const }),
    send,
  };
}

function makeEnvelope(overrides: Partial<MessageEnvelope> = {}): MessageEnvelope {
  return {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    channel: 'telegram',
    topic: 'general',
    sender: 'agent:claude',
    recipient: 'contact:alice',
    reply_to: null,
    priority: 'normal',
    payload: { type: 'text', body: 'hello from the agent' },
    metadata: {},
    ...overrides,
  };
}

/** Seeds a conversation_registry row + active session, matching what the
 * inbound pipeline would have created for prior traffic from this contact. */
function seedConversation(
  db: Database.Database,
  { contactId, channel }: { contactId: string; channel: string },
): { conversationId: string; sessionId: string } {
  const now = new Date().toISOString();
  const conversationId = randomUUID();
  db.prepare(
    `INSERT INTO conversation_registry (id, contact_id, channel, topic, first_seen, last_seen)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(conversationId, contactId, channel, 'general', now, now);

  const sessionId = randomUUID();
  db.prepare(
    `INSERT INTO sessions (id, conversation_id, channel, contact_id, started_at, last_activity, message_count)
     VALUES (?, ?, ?, ?, ?, ?, 1)`,
  ).run(sessionId, conversationId, channel, contactId, now, now);

  return { conversationId, sessionId };
}

function getOutboundRows(db: Database.Database) {
  return db.prepare(`SELECT * FROM transcripts WHERE direction = 'outbound'`).all() as Array<{
    message_id: string;
    conversation_id: string;
    session_id: string;
    channel: string;
    contact_id: string;
    body: string;
    metadata: string;
  }>;
}

describe('DeliveryWorker — outbound transcript logging (E31)', () => {
  let db: Database.Database;
  let queue: MessageQueue;
  let registry: AdapterRegistry;

  beforeEach(() => {
    db = makeDb();
    queue = new MessageQueue(db);
    registry = new AdapterRegistry();
  });

  it('logs exactly one outbound transcript row on successful delivery', async () => {
    seedConversation(db, { contactId: 'alice', channel: 'telegram' });
    const send = vi.fn().mockResolvedValue({ success: true });
    registry.register(makeAdapter('telegram', 'telegram', send));

    const worker = new DeliveryWorker({ queue, registry, db });
    const envelope = makeEnvelope();
    const messageId = queue.enqueue(envelope);
    const dequeued = queue.dequeueByPrefix('contact:', 10);
    expect(dequeued).toHaveLength(1);

    await (worker as unknown as { deliver: (id: string, e: MessageEnvelope) => Promise<void> }).deliver(
      messageId,
      dequeued[0]!.envelope,
    );

    expect(send).toHaveBeenCalledTimes(1);
    const rows = getOutboundRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.message_id).toBe(messageId);
    expect(rows[0]!.channel).toBe('telegram');
    expect(rows[0]!.contact_id).toBe('alice');
    expect(rows[0]!.body).toBe('hello from the agent');
  });

  it('does not log a transcript row when delivery fails (dead-lettered)', async () => {
    seedConversation(db, { contactId: 'alice', channel: 'telegram' });
    const send = vi.fn().mockResolvedValue({ success: false, error: 'boom', retryable: false });
    registry.register(makeAdapter('telegram', 'telegram', send));

    const worker = new DeliveryWorker({ queue, registry, db });
    const envelope = makeEnvelope();
    const messageId = queue.enqueue(envelope);
    const dequeued = queue.dequeueByPrefix('contact:', 10);

    await (worker as unknown as { deliver: (id: string, e: MessageEnvelope) => Promise<void> }).deliver(
      messageId,
      dequeued[0]!.envelope,
    );

    expect(getOutboundRows(db)).toHaveLength(0);
  });

  it('does not log a transcript row when the adapter throws', async () => {
    seedConversation(db, { contactId: 'alice', channel: 'telegram' });
    const send = vi.fn().mockRejectedValue(new Error('adapter exploded'));
    registry.register(makeAdapter('telegram', 'telegram', send));

    const worker = new DeliveryWorker({ queue, registry, db });
    const envelope = makeEnvelope();
    const messageId = queue.enqueue(envelope);
    const dequeued = queue.dequeueByPrefix('contact:', 10);

    await (worker as unknown as { deliver: (id: string, e: MessageEnvelope) => Promise<void> }).deliver(
      messageId,
      dequeued[0]!.envelope,
    );

    expect(getOutboundRows(db)).toHaveLength(0);
  });

  it('skips logging (without failing delivery) when no conversation history exists for the contact', async () => {
    // No seedConversation call — contact:bob has no prior inbound traffic.
    const send = vi.fn().mockResolvedValue({ success: true });
    registry.register(makeAdapter('telegram', 'telegram', send));

    const worker = new DeliveryWorker({ queue, registry, db });
    const envelope = makeEnvelope({ recipient: 'contact:bob' });
    const messageId = queue.enqueue(envelope);
    const dequeued = queue.dequeueByPrefix('contact:', 10);

    await (worker as unknown as { deliver: (id: string, e: MessageEnvelope) => Promise<void> }).deliver(
      messageId,
      dequeued[0]!.envelope,
    );

    expect(send).toHaveBeenCalledTimes(1);
    expect(queue.getById(messageId)).not.toBeNull();
    expect(getOutboundRows(db)).toHaveLength(0);
  });
});

describe('DeliveryWorker — sends into a primary channel (E80)', () => {
  /** A DM conversation (older) and a forum-topic conversation (newer) for the same contact and channel, each with an open session. */
  function seedTwo(db: Database.Database, channel: string) {
    const add = (topic: string, seen: string) => {
      const conversationId = randomUUID();
      const sessionId = randomUUID();
      db.prepare(`INSERT INTO conversation_registry (id, contact_id, channel, topic, first_seen, last_seen) VALUES (?, 'alice', ?, ?, ?, ?)`)
        .run(conversationId, channel, topic, seen, seen);
      db.prepare(`INSERT INTO sessions (id, conversation_id, channel, contact_id, started_at, last_activity, message_count) VALUES (?, ?, ?, 'alice', ?, ?, 1)`)
        .run(sessionId, conversationId, channel, seen, seen);
      return conversationId;
    };
    return { dm: add('general', '2026-10-01T10:00:00.000Z'), thread: add('thread:0123456789abcdef', '2026-10-02T10:00:00.000Z') };
  }

  async function deliverOne(db: Database.Database, primaryChannels: string[] | undefined, envelope: MessageEnvelope) {
    const queue = new MessageQueue(db);
    const registry = new AdapterRegistry();
    registry.register(makeAdapter(envelope.channel, envelope.channel, vi.fn().mockResolvedValue({ success: true })));
    const worker = new DeliveryWorker({ queue, registry, db, ...(primaryChannels ? { primaryChannels } : {}) });
    const id = queue.enqueue(envelope);
    const [message] = queue.dequeueByPrefix('contact:', 10);
    await (worker as unknown as { deliver: (id: string, e: MessageEnvelope) => Promise<void> }).deliver(id, message!.envelope);
    return getOutboundRows(db);
  }

  it('logs a send with no topic or general into the general conversation, not the newest registry row', async () => {
    for (const topic of ['general', '']) {
      const db = makeDb();
      const { dm } = seedTwo(db, 'telegram:peggy');
      const rows = await deliverOne(db, ['telegram:peggy'], makeEnvelope({ channel: 'telegram:peggy', topic }));
      expect(rows.map((r) => r.conversation_id)).toEqual([dm]);
    }
  });

  it('leaves a thread topic and every unlisted channel as before: the newest conversation for the contact and channel', async () => {
    const db = makeDb();
    const { thread } = seedTwo(db, 'telegram:peggy');
    expect((await deliverOne(db, ['telegram:peggy'], makeEnvelope({ channel: 'telegram:peggy', topic: 'thread:0123456789abcdef' }))).map((r) => r.conversation_id)).toEqual([thread]);
    const db2 = makeDb();
    const two = seedTwo(db2, 'telegram:pokeclaude');
    expect((await deliverOne(db2, ['telegram:peggy'], makeEnvelope({ channel: 'telegram:pokeclaude', topic: 'general' }))).map((r) => r.conversation_id)).toEqual([two.thread]);
    const db3 = makeDb();
    const three = seedTwo(db3, 'telegram:peggy');
    expect((await deliverOne(db3, undefined, makeEnvelope({ channel: 'telegram:peggy', topic: 'general' }))).map((r) => r.conversation_id)).toEqual([three.thread]);
  });
});


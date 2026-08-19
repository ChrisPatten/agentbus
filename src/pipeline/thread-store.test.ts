import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';
import { getThread, upsertThread, patchThreadMetadata } from './thread-store.js';

interface TestMetadata {
  a: string;
  b: number;
}

describe('thread-store', () => {
  function fresh(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    return db;
  }

  it('returns null for a thread that does not exist', () => {
    const db = fresh();
    expect(getThread<TestMetadata>(db, 'email', 'thread:none')).toBeNull();
  });

  it('round-trips a typed metadata shape through upsert/get', () => {
    const db = fresh();
    upsertThread<TestMetadata>(db, {
      channel: 'email',
      topic: 'thread:abc',
      threadKey: 'root@msgid',
      metadata: { a: 'hello', b: 42 },
    });

    const thread = getThread<TestMetadata>(db, 'email', 'thread:abc');
    expect(thread).not.toBeNull();
    expect(thread!.threadKey).toBe('root@msgid');
    expect(thread!.metadata).toEqual({ a: 'hello', b: 42 });
    expect(typeof thread!.updatedAt).toBe('string');
  });

  it('upsert replaces an existing row for the same (channel, topic)', () => {
    const db = fresh();
    upsertThread<TestMetadata>(db, {
      channel: 'email',
      topic: 'thread:abc',
      threadKey: 'root@msgid',
      metadata: { a: 'first', b: 1 },
    });
    upsertThread<TestMetadata>(db, {
      channel: 'email',
      topic: 'thread:abc',
      threadKey: 'root@msgid',
      metadata: { a: 'second', b: 2 },
    });

    const rows = db.prepare(`SELECT COUNT(*) AS n FROM threads`).get() as { n: number };
    expect(rows.n).toBe(1);
    expect(getThread<TestMetadata>(db, 'email', 'thread:abc')!.metadata).toEqual({ a: 'second', b: 2 });
  });

  it('patchThreadMetadata shallow-merges onto an existing row', () => {
    const db = fresh();
    upsertThread<TestMetadata>(db, {
      channel: 'email',
      topic: 'thread:abc',
      threadKey: 'root@msgid',
      metadata: { a: 'hello', b: 42 },
    });

    patchThreadMetadata<TestMetadata>(db, 'email', 'thread:abc', { b: 99 });

    const thread = getThread<TestMetadata>(db, 'email', 'thread:abc');
    expect(thread!.metadata).toEqual({ a: 'hello', b: 99 });
    expect(thread!.threadKey).toBe('root@msgid');
  });

  it('patchThreadMetadata on a missing thread is a no-op', () => {
    const db = fresh();
    patchThreadMetadata<TestMetadata>(db, 'email', 'thread:missing', { a: 'x' });

    expect(getThread<TestMetadata>(db, 'email', 'thread:missing')).toBeNull();
    const rows = db.prepare(`SELECT COUNT(*) AS n FROM threads`).get() as { n: number };
    expect(rows.n).toBe(0);
  });

  it('two channels can hold independent rows under the same topic', () => {
    const db = fresh();
    upsertThread<TestMetadata>(db, {
      channel: 'email',
      topic: 'thread:shared',
      threadKey: 'email-root',
      metadata: { a: 'email', b: 1 },
    });
    upsertThread<TestMetadata>(db, {
      channel: 'telegram:group:123',
      topic: 'thread:shared',
      threadKey: 'telegram-root',
      metadata: { a: 'telegram', b: 2 },
    });

    expect(getThread<TestMetadata>(db, 'email', 'thread:shared')!.metadata.a).toBe('email');
    expect(getThread<TestMetadata>(db, 'telegram:group:123', 'thread:shared')!.metadata.a).toBe('telegram');
  });
});

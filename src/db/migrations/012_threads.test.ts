import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../schema.js';

describe('migration 012 — generic thread store', () => {
  function fresh() {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    return db;
  }

  it('creates the threads table and drops email_threads on a fresh DB', () => {
    const db = fresh();
    runMigrations(db);

    const threadsRow = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='threads'`)
      .get() as { name: string } | undefined;
    expect(threadsRow?.name).toBe('threads');

    const emailThreadsRow = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='email_threads'`)
      .get();
    expect(emailThreadsRow).toBeUndefined();
  });

  it('backfills pre-existing email_threads rows into threads with zero data loss', () => {
    const db = fresh();

    // Seed email_threads (010's shape) before running any migrations, so
    // migration 010's CREATE TABLE IF NOT EXISTS leaves these rows intact and
    // migration 012's backfill has something to migrate.
    db.exec(`
      CREATE TABLE email_threads (
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
    `);
    db.prepare(
      `INSERT INTO email_threads
         (channel, topic, thread_key, subject, last_inbound_message_id, references_chain, contact_address, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'email',
      'thread:abc123',
      'root@msgid',
      'Hello world',
      'reply1@msgid',
      '<root@msgid> <reply1@msgid>',
      'chris@example.com',
      '2026-08-18T00:00:00.000Z',
    );
    // A row with null metadata columns (e.g. a thread that never got a full
    // upsert) must survive the backfill too.
    db.prepare(
      `INSERT INTO email_threads
         (channel, topic, thread_key, subject, last_inbound_message_id, references_chain, contact_address, updated_at)
       VALUES (?, ?, ?, NULL, NULL, NULL, NULL, ?)`,
    ).run('email', 'thread:def456', 'root2@msgid', '2026-08-18T00:00:00.000Z');

    runMigrations(db);

    const rows = db
      .prepare(`SELECT * FROM threads ORDER BY topic`)
      .all() as Array<{ channel: string; topic: string; thread_key: string; metadata: string; updated_at: string }>;
    expect(rows).toHaveLength(2);

    const [abcRow, defRow] = rows;
    expect(abcRow!.channel).toBe('email');
    expect(abcRow!.thread_key).toBe('root@msgid');
    expect(abcRow!.updated_at).toBe('2026-08-18T00:00:00.000Z');
    expect(JSON.parse(abcRow!.metadata)).toEqual({
      subject: 'Hello world',
      lastInboundMessageId: 'reply1@msgid',
      referencesChain: '<root@msgid> <reply1@msgid>',
      contactAddress: 'chris@example.com',
    });

    expect(JSON.parse(defRow!.metadata)).toEqual({
      subject: null,
      lastInboundMessageId: null,
      referencesChain: null,
      contactAddress: null,
    });
  });

  it('is idempotent on re-run', () => {
    const db = fresh();
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();

    const count = (
      db.prepare(`SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 12`).get() as {
        n: number;
      }
    ).n;
    expect(count).toBe(1);
  });
});

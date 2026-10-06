import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';
import { loadImapCursor, saveImapCursor, resolveStartUid } from './email-imap-state.js';
import type { AppConfig, EmailInstanceConfig } from '../config/schema.js';
import type { MessageQueue } from '../core/queue.js';
import type { PipelineEngine } from '../pipeline/engine.js';

// ── A fake IMAP server, swapped in for imapflow ──────────────────────────────

interface FakeMailbox {
  uidValidity: bigint;
  uids: number[];
}
const server: { mailbox: FakeMailbox; fetchedRanges: string[]; clients: FakeImapFlow[] } = {
  mailbox: { uidValidity: 1n, uids: [] },
  fetchedRanges: [],
  clients: [],
};

class FakeImapFlow extends EventEmitter {
  constructor() {
    super();
    server.clients.push(this);
  }
  async connect(): Promise<void> {}
  async mailboxOpen(): Promise<{ uidValidity: bigint; uidNext: number }> {
    const uids = server.mailbox.uids;
    return { uidValidity: server.mailbox.uidValidity, uidNext: (uids.length ? Math.max(...uids) : 0) + 1 };
  }
  async *fetch(query: { uid: string }): AsyncGenerator<{ uid: number; source: Buffer }> {
    server.fetchedRanges.push(query.uid);
    const from = Number(query.uid.split(':')[0]);
    for (const uid of server.mailbox.uids) {
      if (uid >= from) yield { uid, source: Buffer.from(`mail ${uid}`) };
    }
  }
  async logout(): Promise<void> {
    this.emit('close');
  }
}

vi.mock('imapflow', () => ({ ImapFlow: FakeImapFlow }));

const { EmailAdapter } = await import('./email.js');

const instanceConfig = {
  name: null,
  imap: { host: 'imap.test', port: 993, user: 'agent@example.com', password: 'pw', mailbox: 'INBOX', secure: true },
  smtp: { host: 'smtp.test', port: 587, secure: false },
  require_auth: false,
} as unknown as EmailInstanceConfig;

const config = { contacts: {}, agents: {} } as unknown as AppConfig;

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

async function runAdapterOnce(db: Database.Database): Promise<string[]> {
  const handled: string[] = [];
  const adapter = new EmailAdapter({
    config, db, instanceConfig, queue: {} as MessageQueue, pipeline: {} as PipelineEngine,
  });
  (adapter as unknown as { handleRawMessage: (raw: Buffer) => Promise<void> }).handleRawMessage = async (raw) => {
    handled.push(raw.toString());
  };
  await adapter.start();
  await new Promise((r) => setTimeout(r, 20));
  await adapter.stop();
  await new Promise((r) => setTimeout(r, 10));
  return handled;
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

describe('resolveStartUid', () => {
  it('starts after existing mail when there is no saved cursor (first setup)', () => {
    expect(resolveStartUid(null, '1', 101)).toEqual({ lastUid: 100, catchUp: false });
  });
  it('resumes from a saved cursor with the same UIDVALIDITY and catches up', () => {
    expect(resolveStartUid({ uidValidity: '1', lastUid: 90 }, '1', 101)).toEqual({ lastUid: 90, catchUp: true });
    expect(resolveStartUid({ uidValidity: '1', lastUid: 100 }, '1', 101)).toEqual({ lastUid: 100, catchUp: false });
  });
  it('resets to the mailbox end when UIDVALIDITY changed', () => {
    expect(resolveStartUid({ uidValidity: '1', lastUid: 90 }, '2', 11)).toEqual({ lastUid: 10, catchUp: false });
  });
  it('never resumes past the mailbox end', () => {
    expect(resolveStartUid({ uidValidity: '1', lastUid: 500 }, '1', 101)).toEqual({ lastUid: 100, catchUp: false });
  });
});

describe('IMAP cursor store', () => {
  it('saves and updates per adapter and mailbox', () => {
    const db = makeDb();
    expect(loadImapCursor(db, 'email', 'INBOX')).toBeNull();
    saveImapCursor(db, 'email', 'INBOX', { uidValidity: '7', lastUid: 3 });
    saveImapCursor(db, 'email', 'INBOX', { uidValidity: '7', lastUid: 5 });
    saveImapCursor(db, 'email:other', 'INBOX', { uidValidity: '9', lastUid: 1 });
    expect(loadImapCursor(db, 'email', 'INBOX')).toEqual({ uidValidity: '7', lastUid: 5 });
    expect(loadImapCursor(db, 'email:other', 'INBOX')).toEqual({ uidValidity: '9', lastUid: 1 });
  });
});

// ── Adapter catch-up ─────────────────────────────────────────────────────────

describe('EmailAdapter catch-up on connect', () => {
  beforeEach(() => {
    server.mailbox = { uidValidity: 1n, uids: [1, 2, 3] };
    server.fetchedRanges = [];
    server.clients = [];
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not process mail already in the mailbox on first setup', async () => {
    const db = makeDb();
    expect(await runAdapterOnce(db)).toEqual([]);
    expect(loadImapCursor(db, 'email', 'INBOX')).toEqual({ uidValidity: '1', lastUid: 3 });
  });

  it('processes mail that arrived while the bus was down, exactly once', async () => {
    const db = makeDb();
    await runAdapterOnce(db); // first setup: cursor at uid 3

    server.mailbox.uids.push(4, 5); // arrives while down
    expect(await runAdapterOnce(db)).toEqual(['mail 4', 'mail 5']);
    expect(server.fetchedRanges).toContain('4:*');

    // Reconnecting again with nothing new reprocesses nothing.
    expect(await runAdapterOnce(db)).toEqual([]);
  });

  it('does not replay old mail after a UIDVALIDITY change', async () => {
    const db = makeDb();
    await runAdapterOnce(db);
    server.mailbox = { uidValidity: 2n, uids: [1, 2, 3, 4, 5, 6] };
    expect(await runAdapterOnce(db)).toEqual([]);
    expect(loadImapCursor(db, 'email', 'INBOX')).toEqual({ uidValidity: '2', lastUid: 6 });
  });
});

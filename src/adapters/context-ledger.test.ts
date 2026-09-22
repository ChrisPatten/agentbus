import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';
import {
  hashBlock,
  shouldSendBlock,
  markBlockSent,
  clearLedger,
  detectCompaction,
  COMPACTION_DROP_THRESHOLD,
} from './context-ledger.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

/** Insert a minimal sessions row so context_blocks' FK is satisfiable. */
function insertSession(db: Database.Database, id: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO sessions (id, conversation_id, channel, contact_id, started_at, last_activity)
     VALUES (?, ?, 'telegram', 'alice', ?, ?)`,
  ).run(id, `conv-${id}`, now, now);
}

function insertTurnCost(
  db: Database.Database,
  opts: { sessionId: string; ts: string; inputTokens: number | null },
): void {
  db.prepare(
    `INSERT INTO turn_costs (agent_id, session_id, ts, cost_usd, input_tokens, output_tokens, num_turns)
     VALUES ('agent:peggy', ?, ?, 0.01, ?, 5, 1)`,
  ).run(opts.sessionId, opts.ts, opts.inputTokens);
}

describe('hashBlock', () => {
  it('is deterministic: the same input always hashes the same', () => {
    expect(hashBlock('hello world')).toBe(hashBlock('hello world'));
  });

  it('different input hashes differently', () => {
    expect(hashBlock('hello world')).not.toBe(hashBlock('hello world!'));
  });
});

describe('shouldSendBlock', () => {
  it('is true when no row exists for (sessionId, blockKey)', () => {
    const db = makeDb();
    insertSession(db, 'sess-1');
    expect(shouldSendBlock(db, 'sess-1', 'memory:memory/MEMORY.md', hashBlock('content'))).toBe(true);
  });

  it('is false when the stored hash matches the current content hash', () => {
    const db = makeDb();
    insertSession(db, 'sess-1');
    const hash = hashBlock('content');
    markBlockSent(db, 'sess-1', 'memory:memory/MEMORY.md', hash);
    expect(shouldSendBlock(db, 'sess-1', 'memory:memory/MEMORY.md', hash)).toBe(false);
  });

  it('is true when the stored hash differs from the current content hash', () => {
    const db = makeDb();
    insertSession(db, 'sess-1');
    markBlockSent(db, 'sess-1', 'memory:memory/MEMORY.md', hashBlock('old content'));
    expect(shouldSendBlock(db, 'sess-1', 'memory:memory/MEMORY.md', hashBlock('new content'))).toBe(true);
  });
});

describe('markBlockSent', () => {
  it('inserts a new row for a block never sent before', () => {
    const db = makeDb();
    insertSession(db, 'sess-1');
    markBlockSent(db, 'sess-1', 'memory:memory/MEMORY.md', hashBlock('content'));

    const row = db
      .prepare(`SELECT content_hash, sent_at FROM context_blocks WHERE session_id = ? AND block_key = ?`)
      .get('sess-1', 'memory:memory/MEMORY.md') as { content_hash: string; sent_at: string } | undefined;
    expect(row?.content_hash).toBe(hashBlock('content'));
    expect(row?.sent_at).toBeTruthy();
  });

  it('upserts: a second call for the same block overwrites the hash and sent_at instead of duplicating', () => {
    const db = makeDb();
    insertSession(db, 'sess-1');
    markBlockSent(db, 'sess-1', 'memory:memory/MEMORY.md', hashBlock('v1'));
    markBlockSent(db, 'sess-1', 'memory:memory/MEMORY.md', hashBlock('v2'));

    const rows = db
      .prepare(`SELECT content_hash FROM context_blocks WHERE session_id = ? AND block_key = ?`)
      .all('sess-1', 'memory:memory/MEMORY.md') as Array<{ content_hash: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.content_hash).toBe(hashBlock('v2'));
  });
});

describe('clearLedger', () => {
  it('deletes every row for the given session_id, leaving other sessions untouched', () => {
    const db = makeDb();
    insertSession(db, 'sess-1');
    insertSession(db, 'sess-2');
    markBlockSent(db, 'sess-1', 'memory:memory/MEMORY.md', hashBlock('a'));
    markBlockSent(db, 'sess-1', 'memory:memory/daily/2026-09-20.md', hashBlock('b'));
    markBlockSent(db, 'sess-2', 'memory:memory/MEMORY.md', hashBlock('c'));

    clearLedger(db, 'sess-1');

    expect(db.prepare(`SELECT COUNT(*) AS n FROM context_blocks WHERE session_id = ?`).get('sess-1')).toEqual({
      n: 0,
    });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM context_blocks WHERE session_id = ?`).get('sess-2')).toEqual({
      n: 1,
    });
  });
});

describe('detectCompaction', () => {
  it('is false with fewer than two qualifying turn_costs rows', () => {
    const db = makeDb();
    insertSession(db, 'sess-1');
    insertTurnCost(db, { sessionId: 'sess-1', ts: '2026-09-20T10:00:00.000Z', inputTokens: 1000 });
    expect(detectCompaction(db, 'sess-1')).toBe(false);
  });

  it('is false when no turn_costs rows exist for the session at all', () => {
    const db = makeDb();
    insertSession(db, 'sess-1');
    expect(detectCompaction(db, 'sess-1')).toBe(false);
  });

  it('ignores rows with NULL input_tokens when counting qualifying rows', () => {
    const db = makeDb();
    insertSession(db, 'sess-1');
    insertTurnCost(db, { sessionId: 'sess-1', ts: '2026-09-20T10:00:00.000Z', inputTokens: null });
    insertTurnCost(db, { sessionId: 'sess-1', ts: '2026-09-20T10:05:00.000Z', inputTokens: 1000 });
    // Only one row has non-null input_tokens, so still under the 2-row minimum.
    expect(detectCompaction(db, 'sess-1')).toBe(false);
  });

  it('is true when the most recent input_tokens is below the drop threshold vs. the prior turn', () => {
    const db = makeDb();
    insertSession(db, 'sess-1');
    insertTurnCost(db, { sessionId: 'sess-1', ts: '2026-09-20T10:00:00.000Z', inputTokens: 10000 });
    // Well under COMPACTION_DROP_THRESHOLD (0.6) * 10000.
    insertTurnCost(db, { sessionId: 'sess-1', ts: '2026-09-20T10:05:00.000Z', inputTokens: 2000 });
    expect(detectCompaction(db, 'sess-1')).toBe(true);
  });

  it('is false when the most recent input_tokens stays at or above the drop threshold vs. the prior turn', () => {
    const db = makeDb();
    insertSession(db, 'sess-1');
    insertTurnCost(db, { sessionId: 'sess-1', ts: '2026-09-20T10:00:00.000Z', inputTokens: 10000 });
    // Right at the threshold boundary: 0.6 * 10000 = 6000, and 6000 is not < 6000.
    insertTurnCost(db, {
      sessionId: 'sess-1',
      ts: '2026-09-20T10:05:00.000Z',
      inputTokens: COMPACTION_DROP_THRESHOLD * 10000,
    });
    expect(detectCompaction(db, 'sess-1')).toBe(false);
  });

  it('compares only the two most recent qualifying rows, not the full history', () => {
    const db = makeDb();
    insertSession(db, 'sess-1');
    insertTurnCost(db, { sessionId: 'sess-1', ts: '2026-09-20T10:00:00.000Z', inputTokens: 500 });
    insertTurnCost(db, { sessionId: 'sess-1', ts: '2026-09-20T10:05:00.000Z', inputTokens: 9000 });
    insertTurnCost(db, { sessionId: 'sess-1', ts: '2026-09-20T10:10:00.000Z', inputTokens: 8500 });
    // Most recent (8500) vs. second-most-recent (9000): no sharp drop, even
    // though the oldest row (500) is much smaller than either.
    expect(detectCompaction(db, 'sess-1')).toBe(false);
  });
});

/**
 * Per-session context-block ledger (context_blocks, migration 017).
 *
 * cc-headless re-renders the system prompt every turn, interpolating
 * {{memories}} and {{date}} fresh each time. Because the system prompt sits
 * at the front of the cache prefix (tools -> system -> messages), that
 * per-turn change busts the cache prefix, and worse, resends the same
 * memory-file content into the resumed transcript on every turn even though
 * the transcript already has it from a prior turn.
 *
 * This module tracks, per (session, content block), whether the block's
 * current content has already been sent into that session's transcript.
 * `runClaudeTurn` (cc-headless.ts) uses it to prepend only new-or-changed
 * memory blocks to the user turn instead of the whole memory context every
 * time, leaving the system prompt itself a frozen cache prefix.
 */
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';

/**
 * How far input_tokens must drop turn-over-turn, relative to the prior turn,
 * before `detectCompaction` calls it a compaction. Deliberately biased toward
 * false positives: a false positive costs one redundant resend of the memory
 * blocks (cheap), while a false negative silently leaves the ledger believing
 * content is already in context that auto-compaction actually summarized
 * away (expensive — the agent loses context with no signal). 0.6 means "the
 * next turn's input was under 60% of the previous turn's" is treated as
 * compaction, which auto-compaction summarization reliably produces and an
 * ordinary turn-to-turn fluctuation in a growing conversation should not.
 */
export const COMPACTION_DROP_THRESHOLD = 0.6;

/** sha256 hex digest of `content`. Used to detect when a block's file content has changed since it was last sent. */
export function hashBlock(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

interface ContextBlockRow {
  content_hash: string;
}

/**
 * True if `blockKey` has never been recorded as sent for `sessionId`, or was
 * sent with different content than `contentHash`. False if the exact same
 * content was already sent and nothing has changed since.
 */
export function shouldSendBlock(
  db: Database.Database,
  sessionId: string,
  blockKey: string,
  contentHash: string,
): boolean {
  const row = db
    .prepare(`SELECT content_hash FROM context_blocks WHERE session_id = ? AND block_key = ?`)
    .get(sessionId, blockKey) as ContextBlockRow | undefined;
  return row === undefined || row.content_hash !== contentHash;
}

/**
 * Record that `blockKey`'s content (`contentHash`) has been sent into
 * `sessionId`'s transcript. Upserts on (session_id, block_key), so a later
 * call for the same block with a new hash overwrites the old record rather
 * than accumulating history.
 */
export function markBlockSent(
  db: Database.Database,
  sessionId: string,
  blockKey: string,
  contentHash: string,
): void {
  db.prepare(
    `INSERT INTO context_blocks (session_id, block_key, content_hash, sent_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (session_id, block_key) DO UPDATE SET
       content_hash = excluded.content_hash,
       sent_at = excluded.sent_at`,
  ).run(sessionId, blockKey, contentHash, new Date().toISOString());
}

/** Delete every ledger row for `sessionId`, e.g. after `detectCompaction` finds the transcript was likely summarized. */
export function clearLedger(db: Database.Database, sessionId: string): void {
  db.prepare(`DELETE FROM context_blocks WHERE session_id = ?`).run(sessionId);
}

interface TurnCostTokensRow {
  input_tokens: number;
}

/**
 * Heuristically detects whether Claude Code's auto-compaction likely ran
 * between the two most recent recorded turns for `sessionId`. Reads the two
 * most recent `turn_costs` rows (by `ts`) that have a non-null
 * `input_tokens`, and returns true iff the more recent one's `input_tokens`
 * is under `COMPACTION_DROP_THRESHOLD` times the older one's — auto-
 * compaction replaces most of the transcript with a summary, so input token
 * count drops sharply; ordinary conversation growth does not.
 *
 * Returns false when fewer than two such rows exist (nothing to compare
 * against yet).
 */
export function detectCompaction(db: Database.Database, sessionId: string): boolean {
  const rows = db
    .prepare(
      `SELECT input_tokens FROM turn_costs
       WHERE session_id = ? AND input_tokens IS NOT NULL
       ORDER BY ts DESC LIMIT 2`,
    )
    .all(sessionId) as TurnCostTokensRow[];

  if (rows.length < 2) return false;

  const [recent, older] = rows as [TurnCostTokensRow, TurnCostTokensRow];
  return recent.input_tokens < COMPACTION_DROP_THRESHOLD * older.input_tokens;
}

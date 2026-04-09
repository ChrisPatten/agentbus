import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { PipelineStage } from '../types.js';

/**
 * Stage 30 — Dedup
 *
 * Prevents duplicate messages from reaching downstream stages. A message is a
 * duplicate if an identical (sender, body) pair was seen within the current
 * time bucket (⌊now / windowMs⌋). Returns null (abort) on a duplicate.
 *
 * Key computation
 * ───────────────
 * dedupKey = sha256(sender + body + bucket)
 * where bucket = Math.floor(Date.now() / windowMs). Using a time bucket
 * rather than a wall-clock range means two buckets exist at a time during
 * normal operation (at most ±1 bucket boundary), but a single message is
 * always assigned to exactly one bucket.
 *
 * Two-layer dedup strategy
 * ────────────────────────
 * Layer 1 — in-memory Map (primary):
 *   Map.has() and Map.set() are synchronous operations. Node.js is
 *   single-threaded, so no two async functions can interleave between
 *   Map.has() and Map.set(). This is the fix for the race condition where
 *   two concurrent Fastify requests both passed the old DB-only check before
 *   either had written a transcript row.
 *
 * Layer 2 — transcripts table (fallback):
 *   On a Map miss (e.g. after a process restart), the stage queries
 *   transcripts.metadata->>'$.dedup_key'. If a row is found, the key is
 *   also warmed into the Map so subsequent restarts don't re-hit the DB.
 *
 * TTL: 2 × windowMs ensures keys survive a bucket rollover (the boundary
 * case where a message near the end of bucket N and its retry fall in
 * bucket N+1 would otherwise not be caught).
 *
 * Memory: expired entries are swept synchronously at the start of each
 * invocation. At steady state the Map holds at most one bucket's worth of
 * unique (sender, body) pairs.
 *
 * @param db       better-sqlite3 Database instance (synchronous API)
 * @param windowMs Dedup window in milliseconds (default: 30 000 = 30 s)
 */
export function createDedup(db: Database.Database, windowMs = 30000): PipelineStage {
  // in-memory Map: dedupKey → expiresAt unix ms.
  // Allocated once per factory call so the Map is shared across all messages
  // processed by this stage instance.
  const seen = new Map<string, number>();

  return async (ctx) => {
    const e = ctx.envelope;
    const body = e.payload.body;
    const bucket = Math.floor(Date.now() / windowMs);
    const raw = `${e.sender}${body}${bucket}`;
    const dedupKey = createHash('sha256').update(raw).digest('hex');

    const now = Date.now();

    // Sweep expired entries to prevent unbounded growth
    for (const [k, exp] of seen) {
      if (exp <= now) seen.delete(k);
    }

    // Primary check: in-memory cache (handles concurrent requests)
    if (seen.has(dedupKey)) {
      console.log(`[pipeline:dedup] Duplicate (cache) key=${dedupKey.slice(0, 12)}…`);
      return null;
    }

    // Fallback check: transcripts table (handles process restarts)
    const existing = db
      .prepare(
        `SELECT id FROM transcripts
         WHERE json_extract(metadata, '$.dedup_key') = ?
         LIMIT 1`,
      )
      .get(dedupKey);

    if (existing) {
      console.log(`[pipeline:dedup] Duplicate (db) key=${dedupKey.slice(0, 12)}…`);
      // Warm the in-memory cache so subsequent restarts don't re-hit the DB
      seen.set(dedupKey, now + windowMs * 2);
      return null;
    }

    // Not a duplicate — record immediately before pipeline continues
    seen.set(dedupKey, now + windowMs * 2);

    ctx.dedupKey = dedupKey;
    e.metadata['dedup_key'] = dedupKey;
    return ctx;
  };
}

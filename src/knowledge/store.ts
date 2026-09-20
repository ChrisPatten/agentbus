/**
 * Knowledge store (Phase 1) — agent-managed structured knowledge, backed by
 * the `knowledge` table (migration 018).
 *
 * Unlike the legacy `memories` table (E8/E9, dormant — see
 * docs/MEMORY_MODEL.md), this store has no fixed extraction schema: an agent
 * writes whatever JSON shape it wants under a `kind` it chooses, and this
 * module's job is limited to bookkeeping around that payload — computing a
 * flattened `body_text` for FTS5, hashing it, tracking supersession/expiry,
 * and recall bookkeeping. It does not interpret `payload` beyond confirming
 * it parses as JSON.
 *
 * This module operates on a `Database.Database` passed in directly (it runs
 * in bus-core / the HTTP layer, which has direct DB access) — contrast with
 * the MCP tools in src/mcp/tools/knowledge.ts, which run in a separate
 * process and only reach this store over HTTP (see that file's header).
 *
 * Phase 1 scope: FTS5 keyword search only (see searchKnowledge). Vector /
 * embedding search, a `knowledge_edges` relationship table, and a
 * `knowledge_facets` catalog are all deliberately deferred — see migration
 * 018's header comment.
 */
import { randomUUID, createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

/** A row of the `knowledge` table, as stored (JSON columns are raw text — callers JSON.parse as needed). */
export interface KnowledgeRow {
  id: string;
  agent_id: string;
  kind: string;
  title: string;
  payload: string;
  index_note: string | null;
  body_text: string;
  tags: string;
  facets: string;
  content_hash: string;
  event_at: string | null;
  valid_from: string | null;
  relevant_until: string | null;
  expires_at: string | null;
  importance: number;
  confidence: number;
  source: string;
  session_id: string | null;
  contact_id: string | null;
  channel: string | null;
  created_at: string;
  updated_at: string;
  superseded_by: string | null;
  last_recalled_at: string | null;
  recall_count: number;
}

/**
 * Input to `writeKnowledge`. `payload` is the agent's raw JSON text, stored
 * verbatim in the `payload` column — this module never re-serializes it, so
 * whatever formatting/key-order the caller sent is exactly what's stored and
 * later returned. It is validated only for `JSON.parse`-ability; `flattenPayloadText`
 * uses the parsed structure solely to build `body_text` for FTS.
 */
export interface WriteKnowledgeInput {
  agent_id: string;
  kind: string;
  title: string;
  payload: string;
  index_note?: string;
  tags?: string[];
  facets?: Record<string, string | number | boolean | null>;
  event_at?: string;
  valid_from?: string;
  relevant_until?: string;
  expires_at?: string;
  importance?: number;
  confidence?: number;
  source?: string;
  session_id?: string;
  contact_id?: string;
  channel?: string;
  /** Existing knowledge id this write replaces. That row's `superseded_by` is set to the new row's id, in the same transaction. */
  supersedes?: string;
}

export interface WriteKnowledgeResult {
  id: string;
  contentHash: string;
  supersededId: string | null;
}

/** Query for `searchKnowledge`. See that function's doc for how each field is applied. */
export interface SearchKnowledgeQuery {
  agent_id: string;
  q?: string;
  kind?: string;
  tags?: string[];
  facets?: Record<string, string | number | boolean>;
  event_from?: string;
  event_to?: string;
  limit?: number;
}

export interface SearchKnowledgeResult {
  results: KnowledgeRow[];
  count: number;
}

/**
 * Walk a parsed JSON value and collect every string leaf (object values,
 * array elements, recursively), in traversal order. Numbers, booleans, and
 * null are skipped — they carry no text for FTS to index. Deliberately
 * simple (no key names, no path prefixes) per the Phase 1 spec: this is a
 * flattening pass for search text, not a structured index.
 */
function flattenPayloadText(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) flattenPayloadText(item, out);
  } else if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) flattenPayloadText(v, out);
  }
  // numbers, booleans, null: no string leaf to collect
}

/** sha256 hex digest of `text`. Computed at write time and stored in `content_hash` rather than recomputed on read — see migration 018's header. */
function hashBodyText(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

/**
 * Write a new knowledge row.
 *
 * Validates `input.payload` parses as JSON (throws a clear `Error` if not),
 * flattens its string leaves into `body_text`, and hashes that text into
 * `content_hash`. If `input.supersedes` is given, that existing row's
 * `superseded_by` is set to the new row's id in the same transaction, so a
 * reader never observes both the old and new row as simultaneously "active"
 * (superseded_by IS NULL).
 *
 * @throws {Error} if `input.payload` is not valid JSON.
 */
export function writeKnowledge(db: Database.Database, input: WriteKnowledgeInput): WriteKnowledgeResult {
  let parsedPayload: unknown;
  try {
    parsedPayload = JSON.parse(input.payload);
  } catch (err) {
    throw new Error(`knowledge payload must be valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  const leaves: string[] = [];
  flattenPayloadText(parsedPayload, leaves);
  const bodyText = leaves.join('\n');
  const contentHash = hashBodyText(bodyText);

  const id = randomUUID();
  const now = new Date().toISOString();
  const tagsJson = JSON.stringify(input.tags ?? []);
  const facetsJson = JSON.stringify(input.facets ?? {});

  const run = db.transaction(() => {
    if (input.supersedes) {
      db.prepare(`UPDATE knowledge SET superseded_by = ?, updated_at = ? WHERE id = ?`).run(
        id,
        now,
        input.supersedes,
      );
    }

    db.prepare(
      `INSERT INTO knowledge (
         id, agent_id, kind, title, payload, index_note, body_text, tags, facets,
         content_hash, event_at, valid_from, relevant_until, expires_at,
         importance, confidence, source, session_id, contact_id, channel,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.agent_id,
      input.kind,
      input.title,
      input.payload,
      input.index_note ?? null,
      bodyText,
      tagsJson,
      facetsJson,
      contentHash,
      input.event_at ?? null,
      input.valid_from ?? null,
      input.relevant_until ?? null,
      input.expires_at ?? null,
      input.importance ?? 0.5,
      input.confidence ?? 0.9,
      input.source ?? 'agent',
      input.session_id ?? null,
      input.contact_id ?? null,
      input.channel ?? null,
      now,
      now,
    );
  });
  run();

  return { id, contentHash, supersededId: input.supersedes ?? null };
}

/**
 * Fetch one knowledge row by id and record the recall: bumps `recall_count`
 * and sets `last_recalled_at` to now. This is a real recall (an agent
 * fetching a specific row it intends to use), not the bulk listing
 * `searchKnowledge` does — `searchKnowledge` does not touch recall
 * bookkeeping.
 */
export function getKnowledge(db: Database.Database, id: string): KnowledgeRow | undefined {
  const row = db.prepare(`SELECT * FROM knowledge WHERE id = ?`).get(id) as KnowledgeRow | undefined;
  if (!row) return undefined;

  const now = new Date().toISOString();
  db.prepare(`UPDATE knowledge SET last_recalled_at = ?, recall_count = recall_count + 1 WHERE id = ?`).run(
    now,
    id,
  );

  return { ...row, last_recalled_at: now, recall_count: row.recall_count + 1 };
}

export interface ForgetKnowledgeOpts {
  /** Required when `mode === 'supersede'` — the id of the row that replaces this one. */
  supersededBy?: string;
}

/**
 * Retire a knowledge row.
 *
 * - `'supersede'` — sets `superseded_by` to `opts.supersededBy` (required for this mode).
 * - `'expire'` — sets `expires_at` to now, so it's immediately excluded by the
 *   `expires_at IS NULL OR expires_at > datetime('now')` filter `searchKnowledge` applies.
 * - `'delete'` — hard-deletes the row (and, via the FTS trigger, its `knowledge_fts` entry).
 *
 * @throws {Error} if `mode === 'supersede'` and `opts.supersededBy` is missing.
 */
export function forgetKnowledge(
  db: Database.Database,
  id: string,
  mode: 'supersede' | 'expire' | 'delete',
  opts?: ForgetKnowledgeOpts,
): void {
  const now = new Date().toISOString();

  if (mode === 'supersede') {
    if (!opts?.supersededBy) {
      throw new Error('forgetKnowledge: mode "supersede" requires opts.supersededBy');
    }
    db.prepare(`UPDATE knowledge SET superseded_by = ?, updated_at = ? WHERE id = ?`).run(
      opts.supersededBy,
      now,
      id,
    );
    return;
  }

  if (mode === 'expire') {
    db.prepare(`UPDATE knowledge SET expires_at = ?, updated_at = ? WHERE id = ?`).run(now, now, id);
    return;
  }

  // mode === 'delete'
  db.prepare(`DELETE FROM knowledge WHERE id = ?`).run(id);
}

/**
 * Search active knowledge rows for `query.agent_id`.
 *
 * Always excludes superseded rows (`superseded_by IS NOT NULL`) and expired
 * rows (`expires_at` set and in the past). When `query.q` is given, joins
 * `knowledge_fts` and orders by `bm25(knowledge_fts)` (ascending — bm25 is
 * more negative for a better match); otherwise skips the FTS join entirely
 * and orders by `updated_at DESC`.
 *
 * `query.tags`, when given, requires the row's `tags` JSON array to contain
 * every given tag (`json_each` membership check per tag, ANDed). `query.facets`,
 * when given, requires an exact match on every given key via `json_extract`.
 * `query.event_from` / `query.event_to` filter on `event_at`, keeping rows
 * with a null `event_at` (an event-less row is never excluded by a date
 * range) alongside rows whose `event_at` falls in the given bound(s).
 *
 * `query.limit` defaults to 10 and is clamped to [1, 50].
 */
export function searchKnowledge(db: Database.Database, query: SearchKnowledgeQuery): SearchKnowledgeResult {
  const limit = Math.min(Math.max(1, query.limit ?? 10), 50);
  // Compared against `expires_at` as a JS-computed ISO 8601 string (matching how
  // writeKnowledge/forgetKnowledge write it) rather than SQLite's datetime('now'),
  // whose "YYYY-MM-DD HH:MM:SS" format does not compare correctly against ISO strings.
  const now = new Date().toISOString();
  const conditions: string[] = [
    'k.agent_id = ?',
    'k.superseded_by IS NULL',
    '(k.expires_at IS NULL OR k.expires_at > ?)',
  ];
  const params: unknown[] = [query.agent_id, now];

  if (query.kind) {
    conditions.push('k.kind = ?');
    params.push(query.kind);
  }

  if (query.tags && query.tags.length > 0) {
    for (const tag of query.tags) {
      conditions.push('EXISTS (SELECT 1 FROM json_each(k.tags) je WHERE je.value = ?)');
      params.push(tag);
    }
  }

  if (query.facets) {
    for (const [key, value] of Object.entries(query.facets)) {
      conditions.push('json_extract(k.facets, ?) = ?');
      params.push(`$."${key.replace(/"/g, '')}"`, value);
    }
  }

  if (query.event_from) {
    conditions.push('(k.event_at IS NULL OR k.event_at >= ?)');
    params.push(query.event_from);
  }
  if (query.event_to) {
    conditions.push('(k.event_at IS NULL OR k.event_at <= ?)');
    params.push(query.event_to);
  }

  const where = conditions.join(' AND ');

  let sql: string;
  if (query.q && query.q.trim().length > 0) {
    sql = `
      SELECT k.* FROM knowledge k
      JOIN knowledge_fts ON knowledge_fts.rowid = k.rowid
      WHERE knowledge_fts MATCH ? AND ${where}
      ORDER BY bm25(knowledge_fts) ASC
      LIMIT ?
    `;
    params.unshift(query.q);
    params.push(limit);
  } else {
    sql = `
      SELECT k.* FROM knowledge k
      WHERE ${where}
      ORDER BY k.updated_at DESC
      LIMIT ?
    `;
    params.push(limit);
  }

  const results = db.prepare(sql).all(...params) as KnowledgeRow[];
  return { results, count: results.length };
}

# Knowledge store (Phase 1)

A structured, agent-managed knowledge store: an agent writes arbitrary JSON records under its own `kind`/schema, and can later search them by keyword, kind, tags, facets, or event time. Unlike the legacy `memories` / `session_summaries` tables ([MEMORY.md](MEMORY.md), [MEMORY_MODEL.md](MEMORY_MODEL.md)), this table is **new and always-on** — no config flag gates it, and it is not a revival of that dormant system. It has no fixed extraction pipeline: the bus never writes to it on its own, only the agent does, via the tools below.

## Phase 1 scope

This is Phase 1: **FTS5 keyword search only**. There is no embeddings/vector search — that is a later phase, not built here. Also deliberately deferred:

- A `knowledge_edges` table for relationships between rows beyond the single `superseded_by` column.
- A `knowledge_facets` catalog constraining facet keys/types (facets are currently a free-form JSON object).

## Schema

Table `knowledge` (migration 018), with an FTS5 external-content index `knowledge_fts` over `title`, `index_note`, `body_text`, and `tags`, kept in sync by triggers (same pattern as `memories_fts` in migration 003).

| Column | Notes |
|---|---|
| `id` | UUID, primary key |
| `agent_id` | Which agent this knowledge belongs to |
| `kind` | Agent-chosen category label, e.g. `"contact"`, `"project"`, `"decision"` — no fixed enum |
| `title` | Short human-readable title |
| `payload` | Arbitrary JSON, the agent's own schema — stored verbatim as given |
| `index_note` | Optional agent-authored retrieval cue |
| `body_text` | Flattened string leaves of `payload`, newline-joined — computed at write time, indexed for FTS |
| `tags` | JSON array of free-form string labels |
| `facets` | JSON object of scalar key/value pairs, for exact-match filtering |
| `content_hash` | sha256 hex digest of `body_text`, computed at write time (see [Why `content_hash` is precomputed](#why-content_hash-is-precomputed-on-write)) |
| `event_at` | When the described fact/event occurred (may differ from `created_at`) |
| `valid_from`, `relevant_until` | Window during which a time-scoped row should be considered live |
| `expires_at` | Hard deletion-eligible cutoff, independent of relevance |
| `importance` | 0.0–1.0, default 0.5 |
| `confidence` | 0.0–1.0, default 0.9 |
| `source` | Where this came from, default `"agent"` |
| `session_id`, `contact_id`, `channel` | Optional context this knowledge relates to |
| `created_at`, `updated_at` | ISO 8601 timestamps |
| `superseded_by` | Id of the row that replaced this one; `NULL` = active |
| `last_recalled_at`, `recall_count` | Bumped by `get_knowledge` / `GET /api/v1/knowledge/:id` |

An active row is one with `superseded_by IS NULL` and (`expires_at IS NULL` or `expires_at` in the future) — `searchKnowledge` always filters to these.

## Interfaces

- Module: `src/knowledge/store.ts` — `writeKnowledge`, `getKnowledge`, `forgetKnowledge`, `searchKnowledge`. Runs in bus-core with direct DB access.
- HTTP: `POST /api/v1/knowledge`, `GET /api/v1/knowledge/search`, `GET /api/v1/knowledge/:id`, `POST /api/v1/knowledge/:id/forget` ([HTTP_API.md](HTTP_API.md#knowledge)).
- MCP: `write_knowledge`, `get_knowledge`, `forget_knowledge`, `search_knowledge` ([MCP_TOOLS.md](MCP_TOOLS.md#knowledge-store)) — thin HTTP clients, same shape as the memory tools. Registered on every server (`registerAllTools` and `registerHeadlessTools`), unconditionally.

## Tools

### `write_knowledge`

```json
{
  "agent_id": "peggy",
  "kind": "contact",
  "title": "Chris — coffee preference",
  "payload": "{\"likes\": [\"pour-over\", \"no sugar\"]}",
  "tags": ["preference", "coffee"],
  "facets": { "contact": "chris" }
}
```

Returns `{ "ok": true, "id", "content_hash", "superseded_id": null }`.

To update a fact, write a new row with `supersedes` set to the old row's id — the old row's `superseded_by` is set to the new row's id in the same transaction, so it stops appearing in search:

```json
{
  "agent_id": "peggy",
  "kind": "contact",
  "title": "Chris — coffee preference (updated)",
  "payload": "{\"likes\": [\"espresso\"]}",
  "supersedes": "3e5a...prior-id"
}
```

### `get_knowledge`

```json
{ "id": "3e5a...id" }
```

Fetches one row by id and records the recall (`recall_count` += 1, `last_recalled_at` = now). Use this once you already know the id and intend to use the row — for browsing, use `search_knowledge` instead, which does not touch recall bookkeeping.

### `forget_knowledge`

```json
{ "id": "3e5a...id", "mode": "expire" }
```

`mode` is `"supersede"` (requires `superseded_by`), `"expire"` (sets `expires_at` to now, row kept), or `"delete"` (hard-deletes the row). Prefer `"supersede"` or `"expire"` over `"delete"` unless the row should be gone entirely.

### `search_knowledge`

```json
{ "agent_id": "peggy", "q": "coffee", "tags": ["preference"], "limit": 5 }
```

`q` is an FTS5 match string over `title`/`index_note`/`body_text`/`tags`; omit it to just filter/browse, ordered newest-updated first. `tags` requires the row to contain every given tag. `facets` requires an exact match on every given key. `event_from`/`event_to` bound `event_at`, keeping rows with no `event_at` (never excluded by a date range). Returns `{ "results": [...], "count": n }`.

## Why `content_hash` is precomputed on write

`content_hash` is a sha256 digest of `body_text`, computed once at write time and stored on the row rather than recomputed whenever something needs to check it. This is specifically so a future per-turn context-injection ledger (see `src/adapters/context-ledger.ts`, the `context_blocks` table from migration 017, added in a separate change on this branch) can compare its own tracked hash directly against this stored `content_hash` to decide whether a knowledge row has already been sent into a session's transcript — without re-hashing potentially large payloads on every turn. That ledger integration is not built in this change; `content_hash` is stored now so it is available when it is.

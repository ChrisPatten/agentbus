# E50 — Agent-Managed Knowledge Store (Phase 1: schema + keyword search)

| Field | Value |
|---|---|
| Epic ID | E50 |
| Dependencies | None (E49's ledger is a natural future consumer, not a build dependency — Phase 1 stores `content_hash` on write specifically so E49-style ledger logic can read it directly later, but doesn't call into E49 itself) |
| Story Count | 1 |
| Estimated Complexity | M |

---

## Epic Summary

A SQLite-backed knowledge store the agent fully manages: arbitrary-JSON
payloads, an optional agent-authored index note, agent-supplied tags/facets,
and four temporal fields (`event_at`, `valid_from`, `relevant_until`,
`expires_at`). This is Phase 1 only — schema, CRUD, and FTS5 keyword search.
No embeddings, no vector leg, no hybrid fusion, no per-turn auto-injection —
those are later phases, explicitly deferred, per the phasing table in the
design spike doc.

`content_hash` (sha256 of the flattened payload) is computed and stored on
the row at write time, rather than left for a consumer to compute on read —
so a future per-turn injection path (see E49) can compare against it directly
without re-hashing potentially large payloads on every check.

## Design reference

`_bmad-output/planning-artifacts/design-spike-agent-knowledge-store.md` §4
(schema), §7 (tool surface, trimmed here to the 4 core tools — `recall_timeline`
and `list_facets` deferred to a fast-follow), §8 (embeddings, entirely
deferred to Phase 2), §11 (phasing — this epic is Phase 1).

## Explicitly deferred (not this epic)

- Embeddings / vector search / RRF fusion (Phase 2)
- Per-turn semantic injection into `cc-headless` or `cc-pool` (Phase 3)
- `knowledge_edges`, stale-review surface, `explain` mode (Phase 4)
- `knowledge_facets` catalog table + `list_facets` tool, `recall_timeline` tool (fast-follow — the `facets` column and filtering exist in Phase 1; only the vocabulary-catalog convenience tool is deferred)
- Phase 0's FTS5-vs-hybrid spike (moot until Phase 2 is scoped)

## Stories

### S50.1 — Schema, CRUD, FTS5 search, MCP tools

**Acceptance criteria:**
1. Migration `018_knowledge.sql`: `knowledge` table (full column set incl. `content_hash`) + indexes + `knowledge_fts` FTS5 external-content table with sync triggers, mirroring migration 003's `memories`/`memories_fts` pattern.
2. `src/knowledge/store.ts`: `writeKnowledge` (validates payload JSON, computes `body_text` + `content_hash`, handles `supersedes`), `getKnowledge` (bumps recall bookkeeping), `forgetKnowledge` (supersede/expire/delete), `searchKnowledge` (FTS5 + kind/tags/facets/event-range filters, excludes superseded/expired).
3. HTTP surface: `POST /api/v1/knowledge`, `GET /api/v1/knowledge/:id`, `POST /api/v1/knowledge/:id/forget`, `GET /api/v1/knowledge/search` — ordinary error responses (this is a new always-on feature, not gated behind a legacy/dormant flag, so no `available:false` convention).
4. MCP tools `write_knowledge`/`get_knowledge`/`forget_knowledge`/`search_knowledge`, registered in both `registerAllTools` and `registerHeadlessTools`, mirroring `memory.ts`'s fetch-against-HTTP shape (MCP tools never touch the DB directly).
5. `docs/KNOWLEDGE_STORE.md`, `docs/MCP_TOOLS.md`, `docs/HTTP_API.md`, `docs/README.md`, `docs/MEMORY_MODEL.md` updated — the last with a clarifying note that this is a new store, not a revival of the dormant E8/E9 `memories`/`session_summaries` tables.
6. Tests: `store.test.ts` (write/hash/supersede/recall/forget×3/search×6+), `knowledge.test.ts` (mocked-fetch, all 4 tools + error paths).

**Complexity:** M

---

## Status

Implemented 2026-09-20. Commit `c2ad205` on `claude/agent-knowledge-database-xiqn29`, on top of `0a3f005`. 137/137 scoped tests passing (incl. `api.test.ts`, `mcp/tools/index.test.ts`), `tsc --noEmit` clean. One real bug caught and fixed during implementation: an initial `expires_at` (ISO-8601) vs. SQLite `datetime('now')` format mismatch silently included already-expired rows in search results — fixed by parameterizing `now` from JS, matching the existing `/api/v1/memories/recall` pattern. Not yet merged, not yet pushed to origin (pending explicit push approval on this branch).

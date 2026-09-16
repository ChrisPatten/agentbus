# E47 — Peggy's Memory as a Siri Source (spike-gated)

| Field | Value |
|---|---|
| Epic ID | E47 |
| Dependencies | E46 (index plumbing), E20 (memory files are the source of truth). |
| Story Count | 3 |
| Estimated Complexity | M |
| Planning package | `siri-bridge/architecture.md` §13.2; `research-ios27-siri.md` §3; `PRD.md` FR-34 |

---

## Epic Summary

Peggy's durable knowledge lives in her own files (`MEMORY.md`, daily journals,
topic files — E20). Exposing them read-only from the bus and mirroring them
into the app as indexed note entities would let Siri AI answer "what does
Peggy know about the Mansfield property taxes?" without a live turn. Whether
Siri AI performs *semantic* Q&A over non-Messages entities is unknown
(research §3), so this epic is a spike first and a feature second.

---

## Entry Criteria

- E46 shipped; recall over messages proven.

## Exit Criteria

1. `GET /api/v1/agents/:agent_id/memory` implemented, bearer-scoped, read-only, size-capped, documented.
2. Spike result recorded (`spike-results.md` E47 table): plain `IndexedEntity` vs `.notes.note` schema, five recall questions each.
3. If either passes: notes mirrored and refreshed on sync; Settings toggle "Index Peggy's memory". If neither passes: endpoint kept (useful for the app's own "Peggy's notes" view), indexing shipped as keyword-only Spotlight, epic closed with the finding.

---

## Stories

### S47.1 — Bus: read-only memory export endpoint

**Acceptance criteria:**
1. `GET /api/v1/agents/:agent_id/memory?since=` returns `{ files: [{ path, sha256, updated_at, bytes, content }] }` for the cc-headless instance whose `agent_id` matches, reading `<working_dir>/<memory.dir>` (index file, `daily/*.md` within `journal_lookback_days` × 10, and top-level topic `*.md`); cap 2 MB total, 404 for unknown agent, 403 unless the bearer contact is routed to that agent by `pipeline.routes`.
2. Bearer auth reuses the siri token map; documented in `docs/SIRI_ADAPTER.md` and `HTTP_API.md`.
3. Tests: listing, `since` filtering, cap, auth.

**Complexity:** S

### S47.2 — App spike: note entities and semantic recall

**Acceptance criteria:**
1. `MemoryNoteEntity` (one per H2 section per file) as (A) plain `IndexedEntity` and (B) `@AppEntity(schema: .notes.note)` with the required sibling schema intents stubbed (throw unsupported); both indexed on a test device in turn.
2. Five recall questions per variant; results + Siri transcripts (screenshots) in `spike-results.md`.
3. Written decision.

**Complexity:** M

### S47.3 — If passed: production indexing + refresh

**Acceptance criteria:**
1. Sync of memory files on the E46 sync cadence, hash-based change detection, per-section entities updated/deleted; Settings toggle; "Rebuild index".
2. Privacy note in README (memory is mirrored on-device only).

**Complexity:** S

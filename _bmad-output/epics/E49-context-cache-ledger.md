# E49 — Per-Session Context-Block Ledger (cc-headless)

| Field | Value |
|---|---|
| Epic ID | E49 |
| Dependencies | E20 (memory file assembly, `assembleMemoryContext`), E39 (`turn_costs`, migration 014) |
| Story Count | 1 |
| Estimated Complexity | S |

---

## Epic Summary

`cc-headless` re-renders `--system-prompt-file` on every turn, interpolating
`{{memories}}` (the agent's `MEMORY.md` + recent daily journals, via
`assembleMemoryContext()`) and `{{date}}`. Because the system prompt is the
first segment of the prompt-cache prefix (`tools` → `system` → `messages`),
and both of those change on every render, the cached prefix was busted on
effectively every turn — and the same memory content was resent in full every
turn even though the resumed session's own transcript already had it from
prior turns.

E49 adds a per-session ledger (`context_blocks`) that hashes each memory file
independently and sends a block into the user turn only the first time, or
when its content changes. The system prompt no longer carries `{{memories}}`
for real sessions — it's frozen, restoring cache stability. A heuristic
detects Claude Code's own auto-compaction (a sharp drop in a session's
`turn_costs.input_tokens`) and clears that session's ledger rows, since
compaction invalidates the assumption that prior blocks are still in context.

## Design reference

`_bmad-output/planning-artifacts/design-spike-agent-knowledge-store.md`
(conversational design, not this epic's spec verbatim — this epic implements
the mechanism that doc's later revisions described, scoped to file-based
memory only; knowledge-store record injection is future work, see E50).

## Stories

### S49.1 — Ledger table + cc-headless wiring

**Acceptance criteria:**
1. Migration `017_context_blocks.sql`: `context_blocks(session_id, block_key, content_hash, sent_at)`, PK `(session_id, block_key)`, FK to `sessions(id) ON DELETE CASCADE`.
2. `src/adapters/context-ledger.ts`: `hashBlock`, `shouldSendBlock`, `markBlockSent`, `clearLedger`, `detectCompaction` (biased toward false positives — a missed compaction silently drops context the agent believes it has).
3. `assembleMemoryBlocks()` added to `memory-context.ts` (one block per file); `assembleMemoryContext()` now composed from it, byte-identical output verified by its existing unmodified test suite.
4. `cc-headless.ts`'s `runClaudeTurn`: when `opts.session` is set, the system prompt's `{{memories}}` is `''` (frozen prefix); new/changed memory blocks are prepended to the user-turn prompt instead, marked sent only on a successful turn. The no-session fallback path is unchanged.
5. Tests: `context-ledger.test.ts` (hash/send/mark/clear/compaction-detection), extended `cc-headless.test.ts` (first turn sends a block, second turn on the same session doesn't).
6. `docs/CC_HEADLESS_ADAPTER.md` documents the mechanism, the compaction heuristic and its threshold, and calls out `{{date}}` remaining a once-daily (not once-per-turn) cache invalidation as a known, accepted residual — not addressed here.

**Complexity:** S

---

## Status

Implemented 2026-09-20. Commit `0a3f005` on `claude/agent-knowledge-database-xiqn29`. 43/43 scoped tests passing, `tsc --noEmit` clean. Not yet merged, not yet pushed to origin (pending explicit push approval on this branch).

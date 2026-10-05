# E67 — Native Memory Layout and Read Side

| Field | Value |
|---|---|
| Epic ID | E67 |
| Status | Planned |
| Dependencies | E64 (can run in parallel with E66; `recent.md` regeneration on journal completion hooks into E66) |
| Story Count | 5 |
| Estimated Complexity | M |

Source: pluggable-journaling design discussion, 2026-10-02 (`planning-artifacts/journaling/decisions.md`); Claude Code memory docs (https://code.claude.com/docs/en/memory#auto-memory).

## Epic Summary

Load an agent's memory the same way on every Claude Code runtime by adopting Claude Code's native auto memory, pointed at the agent's own `memory/` directory. Native memory loads the first 200 lines or 25KB of `MEMORY.md` and enforces that limit itself; topic files are read on demand. Recent daily journals, which native memory has no concept of, are loaded through a bus-generated `memory/recent.md` imported from `CLAUDE.md`, plus a `UserPromptSubmit` hook that keeps long-lived live sessions fresh. Today only `cc-headless` gets memory from the bus, through per-turn injection.

Layers:

| Layer | Loaded | Written by |
|---|---|---|
| `CLAUDE.md` + imports (persona, principal, tools) | Every session, in full | Operator, or approved proposals (protected, E68) |
| Pinned memory (for example `memory/vocabulary.md`) imported from `CLAUDE.md` | Every session, in full | Journalers (not protected) |
| `memory/MEMORY.md`: essentials + one-line index | First 200 lines / 25KB (native) | Native auto memory, journalers, consolidation |
| Typed topic files (`user | feedback | project | reference` frontmatter) | On demand | Same |
| `memory/daily/YYYY-MM-DD.md` (not indexed) | Through `recent.md` | Session journalers |
| `memory/archive/` | Never | Consolidation (E68) |

## Entry Criteria

- Native in-turn writes are accepted for explicit "remember X" moments. Agent `CLAUDE.md` steers everything else to the journaling sweep.
- Runtimes without `nativeMemory` (E64) keep bus injection.

## Exit Criteria

1. Memory layout is configured per agent (`dir`, `index_file`, `daily_subdir`, `lookback_days` default 3, `recent_budget_chars` default ~20KB); `cc-headless` memory fields remain deprecated aliases.
2. `recent.md` is regenerated after each successful journal run and at local midnight, newest first, within budget, with a truncation marker and a "generated, do not edit" header.
3. On `nativeMemory` runtimes, the bus no longer injects `MEMORY.md` or daily blocks, and the context ledger stops tracking memory blocks. `CLAUDE_CODE_DISABLE_AUTO_MEMORY` is no longer set for headless. It is verified that a resumed `claude -p` rebuilds its context from current files on disk.
4. The `UserPromptSubmit` hook injects `recent.md` when it changed since that session last saw it.
5. `/journal` status warns when the agent's `CLAUDE.md` does not import `recent.md`, or the agent's `autoMemoryDirectory` is not set to its memory dir.
6. Baxter is migrated (with operator approval, outside this repo).

## Stories

### S67.1 — Per-agent memory layout config

Move `dir`, `index_file`, `daily_subdir` and `journal_lookback_days` from the `cc-headless` instance to the agent level, shared by journaling (E66) and loading. Add `recent_budget_chars`. Keep the old fields as deprecated aliases with a startup warning.

### S67.2 — `recent.md` generator

Generate `memory/recent.md` from the last `lookback_days` of dailies (local dates), newest first, within `recent_budget_chars`, with a truncation marker and a header saying it is generated. Regenerate after each successful journal run (E66 hook point) and on a local-midnight timer. Write atomically (temp file and rename). Journaler prompts and the script contract say not to write it. Unit tests for budget, ordering, missing days and the date rollover.

### S67.3 — Switch Claude Code runtimes to native loading

For runtimes with `nativeMemory`: stop injecting `MEMORY.md` and dailies, drop memory blocks from the context ledger, and stop setting `CLAUDE_CODE_DISABLE_AUTO_MEMORY`. Spike first: confirm that `claude -p --resume` re-reads `CLAUDE.md`, imports and auto memory from disk on each invocation, and that `autoMemoryDirectory` in project settings is honored in `-p` mode (workspace trust). Runtimes without `nativeMemory` keep the existing injection path, reading `recent.md` instead of raw dailies.

### S67.4 — `UserPromptSubmit` freshness hook

`scripts/hooks/agentbus_recent_memory_hook.sh` plus an endpoint, `GET /api/v1/memory/recent?harness_session_id=…`, that returns `recent.md` only when its content hash differs from what that session last received. The hook prints it as additional context. Best effort: on any failure, inject nothing. Resolves the agent from the session id (no per-deployment constants). Document wiring alongside the other pool hooks.

### S67.5 — Agent setup guide, status checks and Baxter migration

`docs/AGENT_MEMORY.md`: the layer model, `autoMemoryDirectory` setup in the agent's `.claude/settings.json`, the `@memory/recent.md` and pinned-memory imports, the native frontmatter format, the `CLAUDE.md` steering line for in-turn writes, and the hook. `/journal` status checks for the import and the memory directory setting. **Baxter migration** (in `~/workspace/baxter_agent`, operator approval required before writing):
- set `autoMemoryDirectory`;
- move the vocabulary glossary out of `MEMORY.md` into `memory/vocabulary.md`, imported from `CLAUDE.md`;
- add the `recent.md` import;
- migrate topic files to native frontmatter, splitting `feedback.md` into per-memory `feedback` files;
- reduce `MEMORY.md` to essentials plus a one-line index;
- remove the now-redundant SessionStart hook that loads `MEMORY.md`.

## Out of Scope

- Consolidation, archiving and pruning behavior (E68).
- Non-Claude harness memory beyond keeping the existing injection path.

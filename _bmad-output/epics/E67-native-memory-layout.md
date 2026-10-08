# E67 — Native Memory Layout and Read Side

| Field | Value |
|---|---|
| Epic ID | E67 |
| Status | In progress (S67.1-S67.4 complete; S67.5 awaits the Baxter migration) |
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

## Implementation Notes

Implemented 2026-10-06 on `feat/e64-e68-journaling` (after merging dev's fix/docs-audit-bugs). Code: `src/memory/` (`layout.ts`, `recent.ts`, `recent-service.ts`, `native.ts`, `recent-freshness.ts`, `setup-check.ts`), migration 027 (`memory_recent_seen`), `scripts/hooks/agentbus_recent_memory_hook.sh`. Docs: `docs/AGENT_MEMORY.md`, `site-docs/features/agent-memory.md`. Where the code differs from the text above, the code wins.

### Spike (S67.3), Claude Code 2.1.287 (`/Users/pattenchris/.local/bin/claude`, the binary `config.yaml` uses)

Temp project with `CLAUDE.md` importing `@notes.md` and a separate `mem/MEMORY.md`; `claude -p --max-turns 1 --model haiku --output-format json`, inherited Claude session variables unset; 5 calls.

| Call | Result |
|---|---|
| Fresh, `--settings '{"autoMemoryDirectory":"<P>/mem"}'` | Saw the import and `MEMORY.md` |
| Edit both files, then `--resume <same id>` with the same `--settings` | Saw the **new** contents: a resumed print-mode session rebuilds `CLAUDE.md`, imports and auto memory from disk on every invocation |
| `.claude/settings.local.json` with `autoMemoryDirectory`, no `--settings` | `MEMORY.md` loaded |
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` | Import loaded, `MEMORY.md` not |
| `--settings` plus `--system-prompt-file` (as cc-headless runs) | Both loaded |

So (a) and (b) both hold in `-p` mode; no fallback to bus injection was needed. The adapter supplies the directory with `--settings` (a CLI-scope layer, so it needs no per-agent file and is not subject to the checked-in-settings restriction).

### Decisions and deviations

- **Layout resolution is per field**: `agents.<id>.memory` → the deprecated `adapters.cc-headless.memory` block → defaults. The validated headless block always carries defaults (identical to the agent defaults), so the deprecation warning scans the raw config (`legacyMemoryBlocks`), like E66's journaling alias. `dir` may be absolute (needed for runtimes without a working dir). Added `native` (default true) as a per-agent escape hatch: `false` keeps bus injection on cc-headless. `recent_budget_chars` has a 500 minimum.
- **Which agents get a layout:** every `agents.<id>.memory` block, every cc-headless instance, every cc-pool pool (pane ids resolve to the pool). `claude-code` and `mcp-polled` agents only get a resolvable memory dir with an absolute `dir`.
- **`recent.md` format:** marker comment + `# Recent journal` + one-line note, then `## YYYY-MM-DD` sections (today marked `(today)`). No timestamps, so unchanged input is byte-identical (no rewrite, stable hash). Budget covers the whole file. A day that doesn't fit keeps its *end* (latest entries) when ≥200 chars of room remain; every day left out is listed with its path. Written only when the memory dir exists (the bus never creates it), only when changed, temp file + rename.
- **Regeneration hook point:** a new `JournalEngineDeps.onJournaled` callback on evaluation status `journaled` (any journaler), rather than inside `runChain`. Midnight: a ticker on the engine tick that regenerates everything when the local date changes. Also at startup and, for the freshness endpoint, before every hash check (so in-turn daily writes count).
- **Journalers told not to write it:** `recentNotice()` in `prompt.ts` (cc-headless and system-message prompts), the script contract in JOURNALING.md, the reference script's prompt. `snapshotMemoryDir` ignores `recent.md` and its temp files.
- **Native loading** (`usesNativeMemory` = layout `native` && runtime `nativeMemory`): cc-headless no longer assembles memory blocks, writes nothing to the ledger (old `memory:*daily*` rows are just never matched), renders `{{memories}}` empty, removes an inherited `CLAUDE_CODE_DISABLE_AUTO_MEMORY` and passes `--settings`. cc-pool: `createPoolManagers` hands `autoMemoryDir` to `PaneLifecycle`; the launch line adds `--settings` (skipped when `launch_args` already contain `--settings`, and `/journal` warns) and unsets `CLAUDE_CODE_DISABLE_AUTO_MEMORY`. The cc-headless journaler's pool fork gets `--settings` when `JournalJob.nativeMemory`; the reference script always passes it.
- **Injection fallback** (`native: false`): index + `recent.md` (no raw dailies). `mcp-polled` keeps no file injection: the bus doesn't run that harness and it has no working dir, so "runtimes without nativeMemory keep injection" applies to cc-headless with `native: false` only.
- **Freshness hook:** keyed by harness session id in `memory_recent_seen` (not the bus session, and not `context_blocks`, whose FK is the bus session). Baseline: `event=session-start` (the same script registered on `SessionStart`) records the hash without returning content; without SessionStart, a session's first prompt check is the baseline. Content is returned with a one-line "this replaces the earlier version" note. Agent resolution: bus session by `claude_session_id`, `journal_state.harness_session_id`, then a pool pane lease; `agent=` (`$AGENTBUS_AGENT_ID`) is a fallback only for configured agents. 30-day sweep. 2 s timeout, prints nothing on any failure.
- **Setup checks** (`checkMemorySetup`) run at startup (logged warnings) and in `/journal` (a `Memory (<dir>):` section), not as advisories. `@` imports are followed outside code up to 4 hops; targets count even before `recent.md` exists.
- **Hook token convention unified during the dev merge:** every hook resolves `AGENTBUS_BUS_TOKEN` → `AGENTBUS_TOKEN` → `AGENTBUS_TOKEN_FILE`, sends it with `curl -K -`, and reads `AGENTBUS_URL`.
- **Baxter migration (S67.5)** is a plan only: `_bmad-output/planning-artifacts/journaling/baxter-migration-plan.md`. Findings that shaped it: Baxter runs on cc-headless with journaling disabled; its SessionStart memory hook script exists but is registered nowhere on this machine (no project `settings.json`); its three latest dailies are ~42KB, so the plan sets `recent_budget_chars: 40000`.

### For E68

- Layout API: `memorySettingsFor(config, agentId)`, `resolveMemoryLayout(config, resolver, agentId)` → `MemoryLayout` with absolute `memoryDir`, `indexPath`, `dailyDir`, `recentPath`, `archiveDir` (`<dir>/archive`, constant `ARCHIVE_SUBDIR`); `dailyPath(layout, date)`; `RecentMemory.layoutFor()` / `layouts()` in-process. `JournalJob.memoryDir` and `nativeMemory` are already on every job.
- Consolidation reads `layout.indexPath`, topic files under `layout.memoryDir`, dailies under `layout.dailyDir`; writes `MEMORY.md`/topic files in the native frontmatter format and moves retired content to `layout.archiveDir` (never deletes); never writes `recent.md` (call `recentMemory.regenerate(agentId, 'manual')` after a pass that archives dailies). A consolidation journal run that ends `done` already triggers `onJournaled` → regeneration.
- `max_memory_lines` should respect native's 200-line / 25KB load limit for `MEMORY.md`.

### Open questions

- Should a missing `@memory/recent.md` import on a native agent raise an advisory (owners notified) instead of only a startup warning and `/journal` line?
- The freshness hook adds a full copy of `recent.md` on each change; a session that sees several journal runs before compacting holds several copies. A diff or "new since" section would be smaller but needs per-session content, not just a hash.

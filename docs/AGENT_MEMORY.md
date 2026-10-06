# Agent memory layout (E67)

How an agent's memory files are laid out, configured and loaded. Code: `src/memory/` (`layout.ts`). User-facing page: `site-docs/features/agent-memory.md`. Journaling, which writes these files, is in [JOURNALING.md](JOURNALING.md).

## Configuration

`agents.<id>.memory` (schema `AgentMemorySchema`, resolver `src/memory/layout.ts`). Every field is optional.

| Field | Default | Meaning |
|---|---|---|
| `dir` | `memory` | Memory directory, relative to the runtime's working dir, or absolute |
| `index_file` | `MEMORY.md` | Index inside `dir` |
| `daily_subdir` | `daily` | Daily journals `YYYY-MM-DD.md` inside `dir` |
| `lookback_days` | `3` | Days of dailies (today and the previous N-1, local dates) in `recent.md`; `0` = none |
| `recent_budget_chars` | `20000` | Character cap for the whole `recent.md` (minimum 500) |
| `native` | `true` | On runtimes with `nativeMemory`, let Claude Code auto memory load `dir`. `false` keeps bus injection (cc-headless only) |

Resolution, per field: `agents.<id>.memory` → the deprecated `adapters.cc-headless[.<name>].memory` block of the agent's headless instance (`journal_lookback_days` maps to `lookback_days`) → the defaults. The loader warns when the raw config sets the deprecated block (`legacyMemoryBlocks`). Agents with a layout: every `agents.<id>.memory` block, every cc-headless instance and every cc-pool pool (keyed by the pool's logical id; a pane id resolves to its pool through `resolveMemoryLayout`).

`memoryLayout(settings, workingDir)` turns settings into absolute paths: `memoryDir`, `indexPath`, `dailyDir`, `recentPath` (`<dir>/recent.md`), `archiveDir` (`<dir>/archive`, for E68). They are `null` when `dir` is relative and the runtime has no working dir (`claude-code`, `mcp-polled`); give such agents an absolute `dir`.

Journaling uses the layout: `JournalJob.memoryDir` is `layout.memoryDir` (`JournalEngine.buildJob`), so the script journaler's `memory_dir` / `AGENTBUS_MEMORY_DIR` and the System Message journaler's memory-dir diff follow `agents.<id>.memory.dir`.

## recent.md

Claude Code's native memory has no notion of daily journals, so the bus keeps `<memory dir>/recent.md`, which the agent's `CLAUDE.md` imports (`@memory/recent.md`). Code: `src/memory/recent.ts` (rendering, atomic write), `src/memory/recent-service.ts` (`RecentMemory`, scheduling).

**Content.** The dailies for the last `lookback_days` local dates (`lookbackDates`), newest first, each under `## YYYY-MM-DD` (today's marked `(today)`). Missing or empty days are skipped. The file starts with `RECENT_MARKER` (an HTML comment saying it is generated and not to be edited) and a one-line note to the agent. With no dailies in range it says so. The output depends only on the dailies and the local date, with no timestamps, so regenerating unchanged input yields identical bytes.

**Budget.** The whole file, header and markers included, stays within `recent_budget_chars`. Days are added whole while they fit. The first day that doesn't fit keeps the end of its journal (its latest entries, cut at a line boundary) behind a "[Earlier entries of this day were cut …]" note, if at least 200 characters of room are left; otherwise it is left out. Every day left out is listed in a final "[N older day(s) left out to fit the … budget: …]" marker with its file path.

**Writes.** `writeRecent` writes only when the content changed, through a temp file in the memory dir (`.recent.md.tmp-<pid>-<rand>`) renamed over `recent.md`. It is skipped (logged once per agent) when the memory dir doesn't exist; the bus never creates an agent's memory dir.

**When.** `RecentMemory.regenerateAll('startup')` at bus start; `regenerate(agentId, 'journaled')` from the journaling engine's `onJournaled` callback (every evaluation whose chain ended `done`, any journaler); `tick()` on the engine's tick regenerates every agent once the local date changes (`midnight`). The freshness endpoint also regenerates before hashing (S67.4).

**Journalers don't write it.** The cc-headless and System Message prompts end with `recentNotice()` (`src/journaling/prompt.ts`): "Do not edit memory/recent.md: AgentBus generates it …". Script journalers get the same rule in the contract ([JOURNALING.md](JOURNALING.md#script-journaler)), and the reference script tells its `claude -p`. `snapshotMemoryDir` ignores `recent.md` and its temp files, so a regeneration during a System Message run never shows up in `files_changed`.

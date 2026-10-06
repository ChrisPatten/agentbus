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

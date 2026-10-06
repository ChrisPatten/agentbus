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

## Loading

Code: `src/memory/native.ts` (`usesNativeMemory`, `autoMemoryArgs`), `src/adapters/cc-headless.ts`, `src/pool/pane.ts`, `src/journaling/journalers/cc-headless.ts`.

**Native (runtimes with `nativeMemory` and `memory.native: true`, the default).** The bus injects no memory. Everything is loaded by Claude Code from disk:

| Layer | How it loads |
|---|---|
| `CLAUDE.md` and its `@` imports (persona, rules, pinned memory such as `@memory/vocabulary.md`, and `@memory/recent.md`) | Claude Code's `CLAUDE.md` hierarchy for the working dir, in full, on every session start and after `/compact` |
| `MEMORY.md` | Auto memory, `autoMemoryDirectory` = the memory dir: the first 200 lines or 25KB |
| Topic files | Auto memory, read on demand |

The bus supplies `autoMemoryDirectory` itself, so no per-agent settings file is needed:

- **cc-headless:** every `claude -p` gets `--settings '{"autoMemoryDirectory":"<memory dir>"}'`; an inherited `CLAUDE_CODE_DISABLE_AUTO_MEMORY` is removed from the child environment. No memory blocks, nothing in the context ledger, `{{memories}}` renders empty.
- **cc-pool:** the pane launch line gets the same `--settings` (unless the operator's `launch_args` already pass `--settings`; then their file must set it) and unsets `CLAUDE_CODE_DISABLE_AUTO_MEMORY`. `PoolManager` gets the dir from `createPoolManagers` (`autoMemoryDir`).
- **Journal runs:** the cc-headless journaler's direct pool fork (`claude -p --resume --fork-session`) passes it when `JournalJob.nativeMemory`; cc-headless sessions journal through the instance, which passes it anyway. The reference script journaler passes `--settings` with `AGENTBUS_MEMORY_DIR`.
- **claude-code** (one shared session the bus doesn't launch): set `autoMemoryDirectory` yourself, in the agent project's `.claude/settings.local.json` or user settings. Claude Code ignores it in a checked-in project `.claude/settings.json`.

**Spike (2026-10-06, Claude Code 2.1.287, `claude -p --max-turns 1 --model haiku` in a temp project).** (a) After editing an `@import`ed file and `MEMORY.md`, `claude -p --resume <id>` answered with the new contents: a resumed print-mode session rebuilds `CLAUDE.md`, imports and auto memory from disk on each invocation. (b) `autoMemoryDirectory` set through `--settings '<json>'` and through `.claude/settings.local.json` both load `MEMORY.md` in `-p` mode, also with `--system-prompt-file` (as cc-headless uses). `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` turns it off (the import still loads). So headless needs no bus injection.

**Bus injection (`memory.native: false`, or a runtime without `nativeMemory`).** cc-headless keeps the E20 path, reading the index and `recent.md` instead of raw dailies (`assembleMemoryBlocks`), through the context ledger, with `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`. `mcp-polled` runtimes have no file-based injection: the bus can't put files into a harness it doesn't run, and they have no working dir. Give such an agent an absolute `memory.dir` so `recent.md` is still generated for its own harness to read.

## Freshness hook

A live session (a cc-pool pane) loads `recent.md` through its `CLAUDE.md` import only when it starts, after `/compact` and after `/clear`. `scripts/hooks/agentbus_recent_memory_hook.sh` keeps it current. Code: `src/memory/recent-freshness.ts` (`RecentFreshness`), route in `src/http/api.ts`, wiring in `src/index.ts`. cc-headless doesn't need it: every turn is a new `claude -p` that reloads the file.

**Wiring** (agent project `.claude/settings.json`; a symlink to the script in the AgentBus repo is the recommended setup):

```json
{
  "hooks": {
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "scripts/hooks/agentbus_recent_memory_hook.sh" }] }],
    "SessionStart":     [{ "hooks": [{ "type": "command", "command": "scripts/hooks/agentbus_recent_memory_hook.sh" }] }]
  }
}
```

**Flow.** The hook sends `GET /api/v1/memory/recent?harness_session_id=<session_id>&event=prompt|session-start` (plus `&agent=$AGENTBUS_AGENT_ID` when that is set, as a fallback for sessions the bus doesn't know, such as a `claude-code` session). The bus resolves the agent from the Claude session id (bus session by `claude_session_id`, `journal_state.harness_session_id`, then a pool pane lease), regenerates `recent.md` (so dailies written in-turn since the last journal run count), hashes it and compares with `memory_recent_seen` (migration 027, keyed by harness session id, swept after 30 days untouched):

| Case | Response | Hook prints |
|---|---|---|
| `session-start`, or the session's first check | `reason: baseline`, hash recorded | nothing |
| Hash unchanged | `reason: unchanged` | nothing |
| Hash changed | `changed: true`, `context`, hash recorded | `context`: "AgentBus: memory/recent.md (your recent daily journals) changed since this session loaded it. This is the current version; …" plus the full file |
| No agent / bus down / error | `404`, or nothing | nothing |

Registering `SessionStart` makes the baseline exact: the session has just loaded the file, so the first prompt doesn't repeat it, and every `/compact`, `/clear` or resume resets it. Without it, a session's first prompt is the baseline (anything that changed between launch and that prompt is missed until the next change). The hook is best-effort: it needs `jq` and `curl`, uses a 2 s timeout, prints nothing on any failure and always exits 0. It follows the common hook convention: `AGENTBUS_URL`, token from `AGENTBUS_BUS_TOKEN` (else `AGENTBUS_TOKEN`, else `AGENTBUS_TOKEN_FILE`) through curl's stdin.

Injected content is never subtracted: a session that received a new `recent.md` holds both versions in its context until it compacts. The note tells the agent the new one replaces the earlier one.

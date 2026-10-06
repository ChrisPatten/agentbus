# Agent learning (E68)

> **Status: in progress (S68.1).** Journaling (E66) records what happened; this page covers what turns it into learning. User-facing guide: `site-docs/features/journaling-and-memory.md`.

Code: `src/journaling/consolidation.ts`, `src/journaling/engine.ts` (`consolidate`), `src/journaling/prompt.ts` (`DEFAULT_CONSOLIDATION_PROMPT`). Design record: `_bmad-output/planning-artifacts/journaling/decisions.md` ("Consolidation").

## Consolidation

A **consolidation pass** is an agent-level journal job (`kind: consolidate`). Session jobs journal one conversation window; a consolidation job works on the agent's memory directory and the journals written since the last pass. It runs through the agent's normal journaler chain, shares the agent's one-run-at-a-time lane with session runs, and records `journal_runs` rows (`kind = 'consolidate'`, no session or conversation).

### Configuration

```yaml
agents:
  "agent:baxter":
    journaling:
      chain: [system-message, cc-headless, script]
      consolidation:
        cron: "0 3 * * *"        # default: nightly at 03:00
        timezone: Europe/London  # default: the bus host's local zone
        max_memory_lines: 200    # MEMORY.md budget, at most 200
        timeout_ms: 600000       # default: journaling.timeout_ms
        prompt: "…"              # default: the built-in consolidation prompt
```

| Option | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Off with `false` (also off when `journaling.enabled` is false) |
| `cron` | `0 3 * * *` | When the pass runs (validated at load) |
| `timezone` | host local | IANA zone for `cron` |
| `max_memory_lines` | `200` | Line budget for `MEMORY.md`, capped at native auto memory's 200-line load limit (it also loads at most 25 KB) |
| `timeout_ms` | `journaling.timeout_ms` | Per-run timeout (cc-headless; System Message uses its own `system-message.timeout_ms`; scripts their `script.timeout_ms`) |
| `prompt` | built-in | Consolidation instruction; the bus appends the job context (paths, budget, dates) |

Agents journaled through the deprecated `adapters.cc-headless.journaling` alias get no consolidation. Configure `agents.<id>.journaling` to turn it on.

### When it runs

- **Timer.** The cron runs on the journaling engine's tick (`ConsolidationScheduler`), not the scheduler. The first fire time is the first occurrence after the last successful pass, so a pass missed while the bus was down runs once on the first tick after start.
- **Skipped when nothing is new.** A `scheduled` pass is skipped (no `journal_runs` row, a log line) when no session journal run ended `done` since the last successful pass (`JournalStore.sessionRunsSince`).
- **Manual.** `/journal consolidate` asks for a `manual` pass, which runs even with nothing new. A request while a pass is queued or running joins it.

### What the pass does (default prompt)

1. Promote patterns that recur across conversations into typed topic files and, for the essentials, `MEMORY.md`.
2. Merge duplicates and resolve contradictions: the newer fact wins, and the surviving memory notes what it replaced.
3. Keep `MEMORY.md` within its budget (`max_memory_lines`, 25 KB): essentials plus a one-line index.
4. Archive, never delete: stale content, and daily journals older than 30 days once promoted, move to `<memory dir>/archive/` (dailies under `archive/daily/`).
5. Write in the native memory format (frontmatter `name`, `description`, `type: user | feedback | project | reference`).
6. Recurring-correction check: flag corrections that keep coming back after a rule was added, and propose strengthening a rule that lives in a protected file.

The job context appended to the prompt (`consolidationContextLines`) names the memory dir, index, daily and archive dirs, the archive cut-off date (30 days before today, local), the `MEMORY.md` budget, the last pass and the number of session journal runs since. It also says not to edit `recent.md`: a pass that ends `done` triggers the usual `recent.md` regeneration.

### Journalers

| Journaler | Consolidation |
|---|---|
| `system-message` | Sent to the agent's default conversation (its first owner's `general` conversation, `SystemMessageJournaler.target()`); the exclusive-run rules (held messages, blocked outbound) apply to that conversation. Needs an owner and a live pane. |
| `cc-headless` | A fresh `claude -p` with no `--resume`, in the agent's working dir. On `cc-headless` it goes through the instance (`HeadlessHandle.consolidate`): the agent's system prompt and MCP tools, delivery tools disallowed, serialized with the instance's journaling turns. On `cc-pool` it runs directly in the pool's working dir with `--settings autoMemoryDirectory` and only the agentbus tools server (delivery tools disallowed). |
| `script` | `kind: "consolidate"` in the payload, with a `consolidation` object (below). `prompt` is the full instruction. The reference script supports it. |

Script payload additions (`ScriptPayloadV1`, still `version: 1`): session fields are empty strings, `messages` is empty, and

```json
"consolidation": {
  "last_pass_at": "2026-10-05T03:00:01.000Z", "session_runs_since": 4,
  "index_path": "/agents/baxter/memory/MEMORY.md", "daily_dir": "/agents/baxter/memory/daily",
  "archive_dir": "/agents/baxter/memory/archive", "archive_before": "2026-09-06",
  "max_memory_lines": 200, "max_memory_bytes": 25600
}
```

### Outcomes and advisories

`done` / `nothing-to-do` end the pass (`done` regenerates `recent.md`). Consolidation has no cursor, so the session bookkeeping (cursor, attempt cap, exhaustion streak) is untouched. When every journaler fails, the bus raises `journaling:consolidation-exhausted` (`warning`); the next successful pass resolves it.

### Observability

`/journal` shows `consolidation: last …, next … UTC` (or `off`). `/journal runs` lists passes as `consolidate(scheduled)` / `consolidate(manual)`. The run log line has `"kind":"consolidate"`.

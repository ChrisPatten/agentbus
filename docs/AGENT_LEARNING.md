# Agent learning (E68)

> **Status: in progress (S68.1–S68.2).** Journaling (E66) records what happened; this page covers what turns it into learning. User-facing guide: `site-docs/features/journaling-and-memory.md`.

Code: `src/journaling/consolidation.ts`, `src/journaling/engine.ts` (`consolidate`), `src/journaling/prompt.ts` (`DEFAULT_CONSOLIDATION_PROMPT`, `feedbackLines`), `src/journaling/feedback.ts`, `src/journaling/feedback-producers.ts`, `src/commands/feedback.ts`. Migration 032. Design record: `_bmad-output/planning-artifacts/journaling/decisions.md` ("Consolidation").

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

## Feedback events

Signals that the agent went wrong, recorded in `feedback_events` (migration 032) and handed to its journalers.

| Kind | Producer | Bypasses `min_human_messages` |
|---|---|---|
| `user-feedback` | `/feedback <text>` in a conversation | yes |
| `denied-approval` | Any approval request answered **Deny** (the E51 resolution path: Telegram taps and `POST /api/v1/approvals/:id/resolve`, through `ResolveApprovalDeps.onResolved`), including denied self-edit proposals | yes |
| `tool-error` | A `tool_result` with `is_error` in a normal cc-headless turn (`HeadlessHooks.onToolError`; journaling turns are excluded), and a message an agent sent that the delivery worker dead-lettered (`DeliveryWorkerDeps.onFailed`) | no (too frequent) |

Not recorded: `/stop` (usually a change of mind), reactions, edits, quick follow-ups.

Each event has the logical agent id (a pool pane maps to its pool), the conversation and session when known, the agent message it most likely refers to (`ref_message_id`: the conversation's latest non-command outbound message), the contact who gave it, the text (truncated to 2000 characters) and a JSON `detail` (tool name, approval id, channel). Events are kept 90 days.

### `/feedback <text>`

The bus records the event and acknowledges at once ("Thanks, noted. …"). The text is never delivered to the agent as a message, and `/feedback` doesn't start a journal run. The agent is the conversation's session agent, else the only journaling agent. See [SLASH_COMMANDS.md](SLASH_COMMANDS.md#feedback-text).

### Session jobs

A session run receives the conversation's **unconsumed** events, oldest first (`JournalJob.feedback`), whatever their time. They are marked consumed when the run ends `done` or `nothing-to-do`; an exhausted run leaves them for the next one.

- **Eligibility.** An unconsumed `user-feedback` or `denied-approval` makes the session eligible at its next evaluation even below `min_human_messages`, or with no new human message at all (the feedback is the content; eligibility reason `feedback`). The tick also considers sessions that were fully journaled when such an event arrives.
- **Pause clock.** A bypass event re-anchors the pause clock like activity, so `/feedback` rides with the journal run one pause threshold later instead of starting one at once.
- **Prompts.** cc-headless and System Message prompts list the events (`feedbackLines`: time, kind, who, which message, the text as a JSON string marked as data). Scripts get `feedback[]` in the payload (`id`, `kind`, `created_at`, `text`, `ref_message_id`, `contact_id`, `detail`). The reference script lists them too.

### Consolidation

Consolidation jobs get cross-conversation counts since the last pass (`ConsolidationContext.feedback`, script `consolidation.feedback`): counts per kind and the 20 most frequent texts (grouped case- and whitespace-insensitively) with how often and in how many conversations they occurred. The prompt points them at the recurring-correction check.

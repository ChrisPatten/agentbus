# Agent learning (E68)

> **Status: E68 complete (S68.1–S68.5).** Journaling (E66) records what happened; this page covers what turns it into learning. User-facing guide: `site-docs/features/journaling-and-memory.md`.

Code: `src/journaling/consolidation.ts`, `src/journaling/engine.ts` (`consolidate`), `src/journaling/prompt.ts` (`DEFAULT_CONSOLIDATION_PROMPT`, `feedbackLines`), `src/journaling/feedback.ts`, `src/journaling/feedback-producers.ts`, `src/commands/feedback.ts`, `src/learning/protected-paths.ts`, `src/learning/monitor.ts`, `src/learning/proposals.ts`, `src/learning/diff.ts`, `src/mcp/tools/proposals.ts`. Migrations 032 (`feedback_events`), 033 (`self_edit_proposals`). Design record: `_bmad-output/planning-artifacts/journaling/decisions.md` ("Consolidation").

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

Signals that the agent went wrong, recorded in `feedback_events` (migration 032; kind `lapsed-proposal` added by 034) and handed to its journalers.

| Kind | Producer | Bypasses `min_human_messages` |
|---|---|---|
| `user-feedback` | `/feedback <text>` in a conversation | yes |
| `denied-approval` | Any approval request answered **Deny** (the E51 resolution path: Telegram taps and `POST /api/v1/approvals/:id/resolve`, through `ResolveApprovalDeps.onResolved`), including denied self-edit proposals | yes |
| `tool-error` | A `tool_result` with `is_error` in a normal cc-headless turn (`HeadlessHooks.onToolError`; journaling turns are excluded), and a message an agent sent that the delivery worker dead-lettered (`DeliveryWorkerDeps.onFailed`) | no (too frequent) |
| `lapsed-proposal` | A self-edit proposal that went `stale` (approved, but the file changed since its base hash) or `expired` (unanswered for 7 days, by `decide` or the sweep), through `ProposalServiceDeps.onLapsed` → `recordLapsedProposal`. Text names the path and says to propose again against the current file if still relevant; `detail` has `proposal_id`, `path`, `reason` (`stale` / `expired`). Conversation: the answering request's, else the proposal's first request's (an owner's default conversation) | no |

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

## Protected paths

Memory files are the agent's to manage; its instructions are the owner's. **Protected paths** are files and directories the agent may not edit itself. It proposes changes to them instead ([Self-edit proposals](#self-edit-proposals)).

```yaml
agents:
  "agent:baxter":
    protected_paths: [CLAUDE.md, prompts/baxter.md, skills/, .claude/, docs/policies/]
```

- Relative to the agent's working dir, or absolute. A trailing `/` marks a directory (everything under it).
- Setting the list replaces the default: `CLAUDE.md`, every file the runtime's `system_prompt` imports with `@path` (cc-headless and cc-pool), `skills/` and `.claude/`.
- **The memory dir is never protected**, even when listed or inside a listed directory. That includes pinned memory imported from `CLAUDE.md` (for example `memory/vocabulary.md`).
- Runtimes without a working dir only get absolute entries.
- `/journal` shows the list (`protected: …`).

### Enforcement

1. **Deny rules (cc-headless).** Session journaling turns (through the instance and the cc-pool fork) and consolidation turns run with `--disallowedTools` rules `Edit(//<abs path>)` (`<dir>/**` for directories), added to the usual delivery-tool denials (`protectedPathDenyRules`). A protected directory that contains the memory dir gets no deny rule (it would block memory writes); hashing still covers it. The reference script adds the same rules from the payload's `protected_paths`.

   Why only `Edit`: Claude Code checks file permissions against `Edit(path)` and `Read(path)` rules only. An `Edit` deny also blocks the Write tool on that path and the targets of Bash redirects (`>`, `>>`), `tee` and file commands it recognizes such as `sed`. A `Write(path)` rule is accepted but never consulted (and warns at startup), so the bus doesn't emit one. `//` marks an absolute path; a single leading `/` would anchor at the working directory instead. See the [Claude Code permissions docs](https://code.claude.com/docs/en/permissions).

   What the deny rules don't stop: a subprocess that opens the file itself (`python3 -c "open('CLAUDE.md','a')…"`, a Node script, `cp` into place). Hashing (below) is the backstop for those. The bus doesn't try to deny shell commands by pattern: Bash rules match command text and are easy to get around, and a broad rule would break legitimate Bash use.

   Spike against Claude Code 2.1.287 (`claude -p --model haiku --permission-mode acceptEdits` with the rules the bus builds): the Edit tool on a protected `CLAUDE.md` was denied (`permission_denials` lists it; the file was unchanged). The other cases in the E68 epic's Implementation Notes come from the permissions docs and still need a live check.
2. **Hashing (every journaler).** The chain runner hashes every file under the protected entries (sha256; memory dir excluded; at most 2000 files; files over 5 MB by size and mtime) before the first attempt and after the outcome (`RunGuard`, `ProtectedPathMonitor`). Files added, changed or deleted in between, minus the ones the bus wrote for an approved proposal, raise `protected-paths:unapproved-change` (`warning`) listing them. It stays open until an owner acknowledges it; another occurrence updates it. The change may come from the run, the agent on another turn, or a person: the advisory asks the owner to review, not to blame.
3. **Prompts.** cc-headless and System Message prompts, and the consolidation prompt, list the protected paths and point at `propose_change`. Scripts get `protected_paths` (absolute; directories end in `/`).

System Message runs (a live agent) and scripts can't be prevented from editing; for them hashing is the check.

## Self-edit proposals

When the agent finds a better way to work that belongs in its instructions, it proposes the change and an owner decides.

### Proposing

- **MCP:** `propose_change({ path, new_content | diff, rationale, evidence?, run_id? })` → `POST /api/v1/proposals` ([MCP_TOOLS.md](MCP_TOOLS.md#propose_change), [HTTP_API.md](HTTP_API.md#proposals)). Available to every agent with the agentbus tools, including cc-headless journaling and consolidation turns; not to cc-pool session journal forks (no MCP servers).
- **Scripts:** `proposals[]` in the stdout JSON, submitted (source `script`, with the run id) when the run succeeds. The reference script lets Claude write them to a file in a private temp dir (`--add-dir`) and returns them.

`ProposalService.submit` checks, in order: the agent has protected paths; `path` (relative to the working dir, or absolute) is protected (memory files are not: edit them directly); exactly one of `new_content` / `diff` and a non-empty rationale; a `diff` applies to the current file (strict context match, hunks may sit up to 50 lines off); the content changes something and is at most 256 KB; an identical pending proposal (same file and content) is returned as a duplicate instead of a new one; **at most 3 proposals per agent per 24 h** (proposals that reached no owner don't count); the agent has owners. Evidence is kept as up to 10 one-line items.

### Approving

The proposal (`self_edit_proposals`, migration 033) stores the base hash of the file (sha256, or `absent` for a new file), the new content, and a compact unified diff. Each owner gets an approval request ([APPROVALS.md](APPROVALS.md#self-edit-proposals-e68)) with the rationale, evidence and diff, **Approve/Deny only**, valid **7 days**. If no owner could be notified (owners need Telegram), the proposal is `failed` and the tool reports it.

| Status | Meaning |
|---|---|
| `pending` | Waiting for an owner |
| `applied` | Approved; the bus wrote the file (temp file + rename, directories created) and told the protected-path monitor its new hash, so the next run's check doesn't flag it |
| `denied` | Denied; the approval path records a `denied-approval` feedback event in the owner's default conversation, so the agent learns from it at its next journal run |
| `stale` | Approved, but the file's hash no longer matched the base (someone changed it), or the write failed: nothing written. The agent may propose again against the current file; a hash mismatch records a `lapsed-proposal` feedback event |
| `expired` | No answer within 7 days (`ProposalService.sweep` on the 60 s maintenance tick; the approval sweep expires the requests). Records a `lapsed-proposal` feedback event |
| `failed` | No owner could be notified, or the write failed |

The first owner to answer decides; the other owners' requests go `stale`.

### Recurring corrections

Consolidation's recurring-correction check is the main source of proposals: when the feedback counts show a correction recurring after a rule already exists, and the rule lives in a protected file, the pass proposes strengthening it.

## Operator setup

1. **Owners.** Proposals need `agents.<id>.owners` reachable on a channel with interactive approvals (Telegram today). Advisories (consolidation failures, unapproved protected-file changes) go to the same owners.
2. **Consolidation** is on by default for `agents.<id>.journaling` agents. Set `consolidation.timezone` if the bus host's zone isn't yours, and make sure the chain has a journaler that can run it (cc-headless on cc-headless/cc-pool agents, a script elsewhere; System Message needs an owner and a live pane).
3. **Protected paths.** Check the default list in `/journal` (`protected:`) and set `protected_paths` if the agent's instructions live elsewhere.
4. **The agent's `CLAUDE.md`.** Tell it about proposals and feedback:

   ```markdown
   ## Improving your instructions
   CLAUDE.md, your skills and your settings are protected: don't edit them. When you find a
   rule that should change, call `propose_change` with the file, the new content or a diff,
   why, and the evidence. Your owner approves or denies it. Memory files are yours to edit.
   A journal run may list feedback signals (corrections, denied approvals, tool errors):
   record the lessons as `feedback` memories.
   ```

5. **Scripts.** A script journaler that should consolidate must handle `kind: "consolidate"` (the reference script does). Return `proposals[]` instead of editing protected files.

## Verification

`src/learning/e2e.test.ts` runs the whole loop on one agent with a fake LLM behind the real script journaler: `/feedback` is recorded and journaled into the daily file below `min_human_messages`, consolidation promotes it into a native `feedback` memory and the `MEMORY.md` index, the same correction in another conversation makes the next consolidation's recurring-correction check return a `CLAUDE.md` proposal, and the owner's approval applies it without a protected-path warning.

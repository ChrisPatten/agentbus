# E68 — Agent Learning: Consolidation, Feedback and Self-Edit Proposals

| Field | Value |
|---|---|
| Epic ID | E68 |
| Status | Complete (2026-10-06, `feat/e64-e68-journaling`, not yet merged) |
| Dependencies | E66, E67 (and E65 for proposals to owners) |
| Story Count | 5 |
| Estimated Complexity | L |

Source: pluggable-journaling design discussion, 2026-10-02 (`planning-artifacts/journaling/decisions.md`).

## Epic Summary

Turn journaling into learning. **Consolidation** periodically turns journals into durable knowledge and keeps memory small. **Feedback signals** tell journalers where the agent went wrong. **Self-edit proposals** let the agent improve its own instructions and skills, with owner approval.

## Entry Criteria

- Consolidation is an agent-level job kind in the E66 journaler framework, not a separate system.
- Memory writes follow the E67 native format.
- No git versioning of agent memory (backlog). Consolidation archives and never deletes.

## Exit Criteria

1. A nightly per-agent consolidation runs through the journaler chain, is skipped when nothing new was journaled, and can be triggered with `/journal consolidate`.
2. Denied approvals, `/feedback` and tool errors are recorded as feedback events and passed to session and consolidation jobs.
3. Agents propose changes to protected paths through `propose_change`; owners approve or deny; the bus applies approved changes with a base-hash check.
4. Protected paths are enforced on headless journaling turns and monitored elsewhere.
5. Tests and docs are complete; full suite and build pass.

## Stories

### S68.1 — Consolidation job

Add the `consolidate` agent job kind (`supportsKinds` per journaler):
- **cc-headless:** a fresh `claude -p`, no `--resume`, in the agent's working dir.
- **System Message:** sent to the agent's default conversation; E66 exclusive-run rules apply.
- **Script:** `kind: "consolidate"` in the payload.

Default prompt duties:
- promote recurring patterns into `MEMORY.md` and typed topic files;
- merge duplicates and resolve contradictions (newer wins, noting what was replaced);
- keep `MEMORY.md` within the native limit;
- archive stale content and dailies older than 30 days (once promoted) to `memory/archive/`, never deleting;
- write in the native frontmatter format;
- **recurring-correction check:** flag corrections that keep recurring after a rule was added, and propose strengthening the rule (S68.3).

Config `journaling.consolidation: { cron, prompt }`. The cron runs independently of the scheduler, defaults to nightly, and is skipped when no session journal completed since the last pass. `/journal consolidate` triggers it manually. Shares the one-run-per-agent lane and records `journal_runs` rows.

### S68.2 — Feedback events

Migration for `feedback_events` (kind, agent, conversation, referenced agent message, text, timestamp). Producers:
- **denied approvals** (E51 resolution path);
- **`/feedback <text>`:** immediate acknowledgment, recorded, never delivered as a normal message, no immediate journal;
- **tool errors:** headless stream tool errors and failed delivery calls.

Session jobs receive `feedback[]` for their window (script payload, system-message summary block, headless prompt). Consolidation receives cross-session counts. Denied approvals and `/feedback` make the session eligible immediately (bypassing `min_human_messages`); tool errors do not. `/stop`, reactions, edits and quick-follow-up heuristics are excluded.

### S68.3 — Self-edit proposals

MCP tool `propose_change({ path, new_content | diff, rationale, evidence })`; scripts return `proposals[]` in stdout JSON. A new request type in the E51 approvals system, sent to owner contacts (E65) with the rationale, a compact diff, and Approve/Deny. **On approve, the bus applies the change** if the file's hash still matches the proposal's base; otherwise the proposal is marked stale and the agent may re-propose. Deny records a denied-approval feedback event. Proposals expire after 7 days; at most 3 per agent per day. Approve/Deny only (no inline edits).

### S68.4 — Protected paths enforcement

Per-agent `protected_paths`, default `CLAUDE.md`, the agent's system-prompt file, `skills/`, `.claude/`. Memory files stay freely writable, including pinned memory imported from `CLAUDE.md`. cc-headless journaling and consolidation turns run with permission rules denying edits to protected paths. For all journalers, hash protected files before and after each run and raise a `warning` advisory listing any changed without an approved proposal.

### S68.5 — Docs and verification

`docs/AGENT_LEARNING.md`: consolidation, feedback events, `/feedback`, proposals, and protected paths. Update `JOURNALING.md`, `APPROVALS.md`, `MCP_TOOLS.md`, `SLASH_COMMANDS.md`. End-to-end check on one agent: a correction via `/feedback` is journaled, consolidated into a `feedback` memory, and a recurring correction yields a proposal.

## Out of Scope

- Daily budget caps, git-versioned memory and rollback, trust tiers.
- Reaction, edit and quick-follow-up signals.

## Implementation Notes

Implemented 2026-10-06 on `feat/e64-e68-journaling`. Code: `src/journaling/consolidation.ts`, `feedback.ts`, `feedback-producers.ts` (plus changes to `engine.ts`, `runner.ts`, `prompt.ts`, `eligibility.ts`, the three journalers and `scripts/journalers/claude-p-journal.sh`), `src/learning/` (`protected-paths.ts`, `monitor.ts`, `proposals.ts`, `diff.ts`), `src/commands/feedback.ts`, `src/mcp/tools/proposals.ts`, the `/api/v1/proposals` routes, migrations **032** (`feedback_events`) and **033** (`self_edit_proposals`); 028–029 stay unused. Docs: `docs/AGENT_LEARNING.md` (new), `JOURNALING.md`, `APPROVALS.md`, `MCP_TOOLS.md`, `SLASH_COMMANDS.md`, `HTTP_API.md`, `ADVISORIES.md`; site-docs `features/journaling-and-memory.md` (Consolidation, Teaching your agent), `slash-commands.md`, `approvals.md`, `owners-and-advisories.md`, `reference/{configuration,mcp-tools,http-api}.md`. Commits: S68.1 `9021d89`, S68.2 `ff3ca4f`, S68.4 `db63c0d`, S68.3 `3b60729` (S68.4 landed first because proposals need the protected-path resolution), S68.5 (this commit). Where the code differs from the text above, the code wins.

### S68.1 Consolidation

- **Config** `journaling.consolidation: { enabled, cron, timezone, prompt, max_memory_lines, timeout_ms }`. `enabled` defaults to true for `agents.<id>.journaling` agents; the deprecated `adapters.cc-headless.journaling` alias gets **no** consolidation (a nightly `claude -p` per legacy agent was judged too surprising). `cron` is validated with croner at load; `timezone` defaults to the bus host's zone; `max_memory_lines` is capped at 200.
- **Timer** (`ConsolidationScheduler`) runs on the journaling engine's tick (60 s), not the scheduler. The first fire time is the first occurrence after the last successful pass, so a pass missed while the bus was down runs once at startup (and is skipped if nothing is new).
- **Skip rule**: a `scheduled` pass is skipped (no `journal_runs` row) when no session run ended **`done`** since the last successful pass (`nothing-to-do` doesn't count). `/journal consolidate` (`manual`) always runs. A new trigger value `scheduled` was added.
- **Engine**: `JournalEngine.consolidate(agentId, reason)` enqueues on the agent lane under the slot key `consolidate:<agent>` (single-flight, merges). The job has empty session fields, `messages: []`, `window.from = last pass`, and a `consolidation` context (index/daily/archive paths, archive cut-off date = 30 days ago local, MEMORY.md budget 200 lines / 25 KB, runs since, feedback summary). `job.prompt` is the full instruction (`consolidationPrompt`).
- **Runner**: consolidation skips all session bookkeeping (cursor, attempt cap, exhaustion streak, chain-exhausted advisory). Exhaustion raises `journaling:consolidation-exhausted` (warning), success resolves it. A `done` pass fires `onJournaled` (recent.md regeneration).
- **cc-headless**: on cc-headless the pass runs through the instance (`HeadlessHandle.consolidate`): fresh `claude -p`, no `--resume`, the agent's system prompt and full MCP config, delivery tools disallowed, journal lane, system turn class, queue key `consolidate:<agent>` (no app activity events). On cc-pool it runs directly in the pool's working dir with `--settings autoMemoryDirectory`, and an MCP config with only the agentbus tools server (`buildMcpConfig`, so `propose_change` works) instead of the session forks' empty one.
- **Reference script** handles `kind: "consolidate"` (pipes the payload prompt, no transcript).

### S68.2 Feedback events

- **Window semantics**: a session job gets the conversation's **unconsumed** events (any time), not a timestamp window; they are consumed when the chain ends `done`/`nothing-to-do`. This avoids losing events that arrive between the window end and the run.
- **Eligibility**: `assessEligibility({ feedback })` → reason `feedback`, even with zero human messages. The tick also selects fully journaled sessions that have unconsumed bypass feedback, and a bypass event **re-anchors the pause clock**, so `/feedback` rides with the run one pause threshold later ("no immediate journal").
- **Producers**: `/feedback` (agent = the conversation's session agent, else the sole journaling agent; `ref_message_id` = the conversation's latest non-command outbound row); denied approvals via a new `ResolveApprovalDeps.onResolved` hook on the shared resolution path (Telegram taps and the HTTP route); tool errors = `tool_result.is_error` in **normal** cc-headless turns (`HeadlessHooks.onToolError`; journaling turns excluded) and dead-lettered agent-sent messages (`DeliveryWorkerDeps.onFailed`). cc-pool panes and `claude-code` expose no stream, so their tool errors are not captured.
- **Prompts**: `feedbackLines` (session) and `feedbackSummaryLines` (consolidation: counts per kind plus the 20 most frequent texts, grouped case/whitespace-insensitively, with conversation counts). Texts are JSON-quoted and marked as data. Script payload: `feedback[]`, `consolidation.feedback`.
- 90-day retention on the engine's retention sweep. No HTTP route for feedback events (not in scope).

### S68.3 Self-edit proposals

- **One approval request per owner** (`adapter_id: 'self-edit'`, `tool_name: 'propose_change'`, logical agent id, the owner's default conversation, 7-day expiry, Approve/Deny only). The first answer wins; the other owners' requests are marked stale and the sweep strips their buttons. A denied proposal's `denied-approval` feedback therefore lands in the owner's default conversation.
- **Resolution** uses a new generic `ResolveApprovalDeps.backends` map (`self-edit` → `ProposalService.decide`). Approve writes via temp file + rename if `hashFile(abs) === base_hash` (`absent` for new files), registers the new hash with the protected-path monitor, else `stale` ("changed since the proposal"). The proposal only accepts the approval ids it raised. `keys_sent` in `raw_context` holds `applied`/`denied`.
- **Validation** (in order): protected paths exist; the path is protected (memory dir never is); one of `new_content`/`diff`; rationale; the diff applies (strict context, hunks may sit ±50 lines off); content changes something; ≤ 256 KB; an identical pending proposal is returned as a duplicate (no new notification); **3 per agent per rolling 24 h** (proposals that reached no owner — status `failed` — don't count); owners exist; at least one owner was notified (else `failed` / `not_delivered`).
- **Rendering**: `renderApprovalPending` shows a generic `raw_context.details` body (proposals: who, file, why, evidence, compact diff cut to fit Telegram) and the deadline's date for requests that live longer than a day. Self-edit requests render as "📝 Proposed change".
- **Script `proposals[]`** (at most 5 read) are submitted by the engine after a successful chain (source `script`, with the run id). The reference script lets Claude write them to a file in a private temp dir (`--add-dir`) and returns them.
- `propose_change` is registered for the polling MCP server, cc-pool panes and cc-headless (so cc-headless journaling and consolidation turns can call it); cc-pool session journal forks have no MCP servers and can't.

### S68.4 Protected paths

- Config at the agent level, `agents.<id>.protected_paths`, not under `journaling`. Setting it replaces the default. `system_prompt` is inline template text in this codebase, so "the system-prompt file" means the files it imports with `@path` (cc-headless and cc-pool).
- The memory dir is excluded everywhere (resolution, hashing, deny rules). A protected directory that contains the memory dir gets no deny rule (it would block memory writes); hashing still covers it.
- Deny rules: `Edit(//abs)` (`/**` for directories) appended to `--disallowedTools` for cc-headless session turns (handle and pool fork) and consolidation turns. Originally `Write(//abs)` was emitted too; the pre-merge spike dropped it (see below). Subprocess writes (python, node, `cp`) aren't covered; hashing is the backstop.
- Hashing is a generic `RunGuard` in `runChain` (`begin` before the first attempt, `end` after the outcome), implemented by `ProtectedPathMonitor` (sha256, ≤ 2000 files, files > 5 MB by size+mtime). The advisory `protected-paths:unapproved-change` (warning) lists files changed during the run window by anyone, minus hashes the bus wrote for approved proposals. It does not auto-resolve (owners acknowledge it).
- `/journal` shows `protected: …`.

### S68.5 Verification

`src/learning/e2e.test.ts` runs the loop on one agent with a fake LLM (a node script) behind the real `ScriptJournaler`: `/feedback` → journaled below `min_human_messages` → consolidated into a native `feedback` memory and the index → the correction recurs in another conversation → the next consolidation returns a `CLAUDE.md` proposal → the owner approves through `resolveApproval` → the bus applies it and the protected-path check stays quiet.

### Pre-merge follow-ups (2026-10-06, operator-approved)

- **`memory:recent-not-imported` advisory** (`src/memory/setup-advisory.ts`): native loading without the `recent.md` import raises a `warning` advisory per agent; every setup check (startup, `/journal`, after journal runs, every 15 min on the engine tick) raises or resolves it.
- **Lapsed proposals become feedback**: a proposal that goes `stale` (hash mismatch on approve) or `expired` records a `lapsed-proposal` feedback event (new kind, migration **034** rebuilds `feedback_events` for the CHECK constraint) with the path and reason. Not a bypass kind. This answers the earlier open question.

### Pre-merge spike: protected-path deny rules (2026-10-06)

Claude Code 2.1.287 (`~/.local/bin/claude`), a temp project with `CLAUDE.md`, `skills/x.md`, `memory/notes.md`, and exactly the cc-pool `runDirect` flags (`-p … --output-format json --permission-mode acceptEdits --mcp-config '{"mcpServers":{}}' --strict-mcp-config --disallowedTools <rules> --model haiku --max-turns 3`).

**Docs** ([permissions](https://code.claude.com/docs/en/permissions)): `//path` is the absolute-path anchor (a single `/` anchors at the settings source / working dir), patterns are gitignore-style (`**` crosses directories). Claude Code checks file permissions against `Edit(path)`/`Read(path)` rules **only**: a `Write(path)` rule is accepted, never consulted, and warns at startup. An `Edit` deny applies to every built-in editing tool (Edit, Write), to Bash redirect targets (`>`, `>>`, `2>`), `tee` targets and recognized file commands (`sed`, …), but not to subprocesses that open files themselves.

| Case | Before (`Edit` + `Write` rules) | After (`Edit` only) | Source |
|---|---|---|---|
| Protected file, Edit tool | **blocked** (live: `permission_denials` = Edit, file unchanged) | blocked (same `Edit` rule) | live + docs |
| Protected file, Write tool | blocked, by the `Edit` rule; the `Write` rule is ignored | blocked | docs |
| File in a protected dir (`skills/**`) | blocked | blocked | docs |
| Memory file (`memory/notes.md`) | allowed (no rule covers it) | allowed | docs + rule list |
| Bash `echo … >> CLAUDE.md` | blocked (redirect target checked against `Edit` denies) | blocked | docs |
| Bash subprocess (`python3 -c "open(…,'a')"`) | **allowed** (bypass) | **allowed** (bypass); hashing advisory is the backstop | docs |

Only the first case ran live: after it, the session's auto-mode classifier refused further runs of the CLI outside the Bash sandbox (needed because the sandbox's TLS-inspecting proxy breaks the CLI's API connection). The other rows are taken from the docs and still need a live check by the operator (see the report for the command).

**Change**: `protectedPathDenyRules` and the reference script now emit `Edit(...)` only. The `//abs` syntax and `/**` directory globs were already correct. No Bash pattern rules were added: Bash rules match command text, are easy to get around, and a broad rule would break legitimate Bash use; redirects are already covered by the `Edit` denies.

### Open questions

- The daily limit is a rolling 24 h window, not a calendar day.
- Tool errors from cc-pool panes and `claude-code` sessions aren't captured (no stream to watch); a PostToolUse hook could report them later.

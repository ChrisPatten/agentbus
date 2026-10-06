# E66 — Pluggable Journaling Core

| Field | Value |
|---|---|
| Epic ID | E66 |
| Status | Complete (2026-10-06) |
| Dependencies | E64, E65 |
| Story Count | 11 |
| Estimated Complexity | L |

Source: pluggable-journaling design discussion, 2026-10-02 (`planning-artifacts/journaling/decisions.md`). Builds on E20/E23/E30 (headless journaling on pause and ceiling) and the cc-pool hooks in `scripts/hooks/`.

## Epic Summary

Separate journaling into **triggers** (when) and **journalers** (who does it), so every agent runtime can journal, not just `cc-headless`. Three journalers ship: **System Message** (instructs the live agent), **cc-headless** (`claude -p --resume`), and **Script** (user-provided, fed the bus transcript). Each agent configures an ordered fallback chain. Triggers come from two layers: optional harness hooks and an always-on bus-side backstop. The Anthropic-API summarizer is retired in favor of a reference script journaler built on `claude -p`.

## Entry Criteria

- A trigger means "evaluate", never "journal now". Journaling happens only when there is eligible content past the session's cursor and nothing is in flight.
- Compatibility is capability-based (E64), not a list of adapters.
- Partial-write rollback and git-versioned memory are out of scope (backlog: "Agent memory repo management").
- No trust tiers. Any human message counts toward eligibility.

## Exit Criteria

1. Journaling is configured per agent: `chain`, per-journaler settings, `threshold_ms`, `ceiling_ms`, `min_human_messages` (default 2), and timeout (default 5 min). Existing `cc-headless` `journaling` config keeps working as a deprecated alias.
2. Bus-side triggers (pause, ceiling, close, `/clear`, pool evict/release, shutdown, manual) and harness events (`turn-ended`, `pre-compact`, `session-end`, `clear`) feed one evaluation path for every runtime type, including `cc-pool`.
3. The chain advances on `unavailable`, `failed-before-start` and `failed-after-start`, and stops on `done` or `nothing-to-do`. The cursor advances only on `done` or `nothing-to-do`. One journal run per agent at a time.
4. An exhausted chain raises a `warning` advisory, escalating to `critical` after 3 consecutive exhaustions or 24 h of unjournaled eligible content.
5. `/journal`, `/journal runs [n]` and `/journal now` work; `journal_runs` keeps 90 days; health includes a journaling summary.
6. `src/memory/summarizer.ts` and the `@anthropic-ai/sdk` dependency are removed.
7. Tests cover every trigger, eligibility rule, chain outcome, and journaler. Full suite and build pass. Docs updated.

## Stories

### S66.1 — Per-agent journaling config

Schema for per-agent `journaling`: `enabled`, `chain: [system-message | cc-headless | script]`, `threshold_ms` (number or per-channel map), `ceiling_ms`, `min_human_messages` (default 2), `timeout_ms` (default 300000), per-journaler `model` (default: the agent's or instance's model), `script: { command, args?, timeout_ms?, env? }`, and `prompt`. Validate the chain against static runtime capabilities (E64). Warn at startup when the chain's last entry is not `script` (raise an E65 advisory). Map the existing `cc-headless` `journaling` block to the new shape as a deprecated alias.

### S66.2 — Journal state, eligibility and run records

- Per-session journal cursor (extend `last_journaled_at`), with pending journal state persisted so it survives restarts.
- **Eligibility:** at least `min_human_messages` human-authored inbound messages since the cursor. Excluded: scheduler-fired inbound (`metadata.scheduled`), slash commands and `command_response`, agent-to-agent messages. Final triggers (close, clear, evict, pre-compact, shutdown) bypass the threshold. Content below the threshold is "pending"; pending content older than 24 h is journaled on the next trigger.
- **Window:** starts at the last agent message before the first eligible human message, so a reply to a scheduled-job message carries that message as context.
- Migration for `journal_runs`: run_id, agent, session, conversation, trigger, journaler, chain position, `fallback_from`, outcome, truncated error, fidelity (`bus-transcript | snapshot | full-session`), window, message count, start, duration, files changed, notes, cost and tokens when known. 90-day retention sweep.

### S66.3 — Bus-side triggers and evaluation engine

Generalize `SessionTracker.dispatchJournaling()` beyond `getCcHeadlessInstances()` to every runtime, using E64 resolution. Triggers: pause (per-channel idle, re-anchored by `turn-ended`), ceiling, session close, `/clear`, pool evict/release, bus shutdown, manual. Single-flight per session and one run per agent at a time across all journalers and sessions (generalize the headless agent-wide journal lane). Backlog age counts only content that meets the threshold.

### S66.4 — Harness event endpoint and generic hook

`POST /api/v1/journal/events { harness_session_id, event, snapshot_path? }` for `turn-ended | pre-compact | session-end | clear`. The bus resolves agent and conversation from the harness session id. A generic hook script, `scripts/hooks/agentbus_journal_hook.sh`, with no per-deployment constants; it follows the approval hook's session-id pattern. Pre-compact and clear use "preserve now, journal later": snapshot the raw transcript (generalizing `agentbus_precompact_snapshot.sh`) and register the snapshot path for the next run's input. **Hook health:** a runtime that declares an event in `hookEvents` but never sends it for an active session is reported in `/journal` status. Update the pool Stop hook to drop its hardcoded `POOL_AGENT_ID`.

### S66.5 — Journaler interface and chain runner

`Journaler { id, requires, supportsKinds, canJournal(job), run(job) }` with outcomes `done | nothing-to-do | unavailable | failed-before-start | failed-after-start`. A common `job` payload: ids, trigger, window, messages, snapshots, harness transcript path, memory dir. The chain runner calls `canJournal` (skip straight to the next journaler on `unavailable`), runs, records a `journal_runs` row per attempt, advances the cursor only on `done` or `nothing-to-do`, and raises or resolves the E65 advisories for exhaustion and escalation.

### S66.6 — cc-headless journaler

Port the existing `runJournalingTurn` path into the interface: `claude -p <prompt> --resume <id>` in the agent's working dir with its MCP config, honoring the journaler `model`. `canJournal` checks that the Claude transcript still exists on disk (Claude Code's `cleanupPeriodDays` deletes old ones) and reports `unavailable` otherwise. Parse cost and tokens from the CLI result. Usable for pool sessions through the stored `claude_session_id`.

### S66.7 — Script journaler and reference script

- Executed directly (no shell), cwd = agent `working_dir`. Timeout sends SIGTERM, then SIGKILL, to the process group.
- **Minimal environment:** `PATH`, `HOME`, `AGENTBUS_RUN_ID`, `AGENTBUS_AGENT_ID`, `AGENTBUS_MEMORY_DIR`, `AGENTBUS_TRIGGER`, `AGENTBUS_MODEL`, plus the configured `env`. The bus environment is not inherited.
- **stdin:** versioned JSON (`version: 1`) as specified in the decisions doc. Attachments by path; `snapshots[]` and `harness_transcript_path` when available.
- **Exit codes:** `0` done, `3` nothing-to-do, `75` unavailable, anything else or timeout → `failed-after-start`. Optional stdout JSON `{ files_changed, notes, cost_usd }`. stderr captured, truncated.
- Ship `scripts/journalers/claude-p-journal.sh`: payload → `claude -p` with a journaling prompt in the agent's working dir. Docs state that inputs are untrusted data.

### S66.8 — System Message journaler

Delivers a journaling instruction with a `run_id` in the E65 spoof-proof system block. Agent jobs with no conversation go to the agent's default conversation. Completion is the MCP tool `journal_complete({ run_id, files_changed, notes, nothing_new? })`; a stale `run_id` is rejected; a timeout yields `failed-after-start`. `canJournal` requires `systemMessages`, `liveAgent` and `exclusiveSession` (live), and an idle agent (`turn-ended` if available, bus activity otherwise). During the run:
- **New user messages for the conversation are held** until completion or timeout, then delivered.
- **Busy notice:** sent once per hold. Use the channel's native queued or status signal where it has one (app activity state, Telegram tool-status line); skip email; generic wording that never mentions journaling.
- **All outbound sends from the agent are blocked**, including proactive `send_message`, except `journal_complete` and `advisory_ack`. Rejected with 409 and a reason.

### S66.9 — cc-pool integration

Replace the pool's no-op journaling runner with real registration. **Pool release waits for the journal** (bounded by the timeout) before `/clear` or kill, including on LRU eviction; the incoming conversation is routed to another pane or parked meanwhile. Pool hard-idle release fires a final `evict` trigger.

### S66.10 — Observability

`/journal` (conversation: cursor age, unjournaled and pending messages, in-flight run; agent: chain, consecutive failures, hook health, open advisories), `/journal runs [n]`, `/journal now` (reason `manual`, bypasses the pause threshold, respects the cursor). `GET /api/v1/journal/runs?agent=…`. `/api/v1/health` includes backlog age, consecutive exhaustions, and last failure. One structured log line per run.

### S66.11 — Retire the summarizer, docs and verification

Remove `src/memory/summarizer.ts`, its tests, `memory.claude_api_model`, `summary_max_tokens` and `structured_extraction` handling, and `@anthropic-ai/sdk`. Decide (and record in the CHANGELOG) what happens to the readers of the dormant `memories` and `session_summaries` tables: memory injection stage 85 and the MCP memory tools. Flag the config and tool removals for the version bump. Add `docs/JOURNALING.md` (triggers, eligibility, journalers, chain, script contract, hooks, `/journal`) and update `CC_HEADLESS_ADAPTER.md`, `CC_POOL_ADAPTER.md`, `MEMORY_MODEL.md`, `SLASH_COMMANDS.md`, `MCP_TOOLS.md`, `HTTP_API.md`. Run the full suite and build.

## Out of Scope

- Consolidation, feedback signals, self-edit proposals (E68).
- Memory loading, `recent.md`, native memory (E67).
- Daily budget caps, trust tiers, git-versioned memory and partial-write rollback.

## Implementation Notes

### Part A (S66.1–S66.5), 2026-10-06, `feat/e64-e68-journaling`

Code: `src/journaling/` (`config.ts`, `eligibility.ts`, `store.ts`, `types.ts`, `registry.ts`, `runner.ts`, `engine.ts`, `events.ts`, `advisories.ts`, `journalers/cc-headless-provisional.ts`), migration 026, `scripts/hooks/agentbus_journal_hook.sh`. Docs: `docs/JOURNALING.md` (started; part B completes it). Where the code differs from the text above, the code wins:

- **Chain validation is "at least one fits", not "every entry fits".** The canonical chain `[system-message, cc-headless, script]` must be valid on `cc-headless`, where `system-message` can never run (`liveAgent: false`). So statically incompatible entries are skipped at run time without a `journal_runs` row, and the load-time error (`collectRuntimeRequirements`) only fires when no entry fits the runtime, listing every entry's missing capabilities. Journaling on an agent with no runtime is also a load error.
- **`chain` default.** When omitted: `[system-message, cc-headless, script]`, with `script` only when `script.command` is set. `script` in the chain without `script.command` is a schema error.
- **"Last entry is not script" advisory** is `journaling:chain-can-exhaust` at severity `info` (a config recommendation, not a failure), raised at startup by `reviewChains()` and resolved when the chain is fixed. It is judged on the last *runnable* entry, so every legacy cc-headless alias agent gets it.
- **Deprecated alias** maps to `chain: [cc-headless]`, keeping `enabled`, `threshold_ms`, `ceiling_ms` and `prompt`. `min_human_messages` and `timeout_ms` take the new defaults (2, 5 min), so existing headless agents now need two human messages before a pause journals (a behavior change, in the CHANGELOG). The deprecation warning comes from the loader scanning the raw config, because the validated cc-headless block always carries defaults.
- **Cursor** is a new `sessions.journal_cursor_at` (created_at of the newest transcript row past the old cursor at run time), backfilled from `last_journaled_at`. `last_journaled_at` stays the time of the last successful run and anchors the ceiling. ISO strings compared with `>`: a row inserted in the same millisecond as the window end, after the window was read, would be skipped. Accepted.
- **Excluded from eligibility**, beyond the epic's list: bus system-only turns (`metadata.system_only`, E65 advisory turns), `system:` senders and reactions. Slash commands are recognized by an inbound body starting with `/` (the same rule stage 40 uses). Command rows are left out of the window, not just the count.
- **`manual` bypasses `min_human_messages` and the attempt cap**, as well as the pause threshold. It still needs one human message past the cursor.
- **Attempt cap.** 3 exhausted runs per window (persisted in `journal_state.attempts`, re-armed when the window end moves), replacing the in-memory pre-E66 cap. `manual` ignores it.
- **Pause anchor** is the latest of last inbound (`last_activity`), last outbound transcript row and last `turn-ended`. The bus doesn't emit a separate turn-ended for cc-headless; the outbound row stands in.
- **Shutdown doesn't run journals.** pm2's kill timeout is far shorter than a `claude -p` run. Shutdown persists a `shutdown` pending trigger for every open session with unjournaled human content, waits up to 5 s for runs in flight, and the next start journals them ("preserve now, journal later"). This means every restart journals sessions with any new human message.
- **Single-flight.** A trigger for a queued session merges (the stronger trigger wins: manual > final > pause/ceiling). One arriving while the evaluation runs schedules a re-evaluation afterwards, so content that arrived during the run (or a `/clear`) isn't lost when the run clears the pending trigger.
- **Runner safety net.** An attempt that doesn't settle within 3× `timeout_ms` is recorded as `failed-after-start` and the agent lane is released. The underlying work (a `claude -p` child) is not killed; journalers own their real timeouts (part B).
- **Close trigger** comes from `SessionTracker` (`onSessionClosed`) for idle closes and mid-flight closes. Mid-flight closes below `session_close_min_messages` are now promoted to `summarize_pending` right away, so each close is reported once. `SessionTracker.dispatchJournaling()`, `registerJournalingRunner()` and the E33 no-op warning are gone. The summarizer is untouched (S66.11).
- **`/clear`** fires the engine's `clear` trigger. `HeadlessControl.journalResumeId` was removed; `HeadlessHandle.journalResumeId` remains (tested, unused by the bus) for part B to drop.
- **Pool release hook.** `PoolManager.setReleaseHook()` is awaited before `paneLauncher.release()` on LRU eviction (`evict`, with the evicted conversation) and hard-idle release (`release`). Part A's hook fires the trigger and returns at once.
- **Harness events.** `POST /api/v1/journal/events` accepts an optional `transcript_path` besides `snapshot_path` (recorded as `harnessTranscriptPath`). Resolution is by `sessions.claude_session_id`, then `journal_state.harness_session_id`; 404 otherwise (a matching pool pane still gets its turn marked ended). `turn-ended` also marks the cc-pool pane's turn ended, so the pool Stop hook now posts here and the hardcoded `POOL_AGENT_ID` is gone; `/api/v1/pool/:agentId/turn-ended` stays. `SessionEnd` with reason `clear` maps to `clear`.
- **Snapshot paths** must be absolute regular files under the agent's working directory or `~/.agentbus/journal-snapshots` (the hook's default `AGENTBUS_SNAPSHOT_DIR`). A rejected path is reported in `snapshot_error` and the trigger still fires. This stops a caller with bus API access from feeding arbitrary files to journalers.
- **Hook health.** Only `turn-ended` can be judged by absence. Statuses: `ok`, `never-seen`, `stopped`, `unverifiable`, `idle`. Only `stopped` (seen before, then quiet for 10 min while the agent keeps answering) raises an advisory (`journaling:hook-stopped:turn-ended`, warning), because hooks are optional. `hookHealth()` is ready for `/journal` (S66.10).
- **Provisional cc-headless journaler** (`journalers/cc-headless-provisional.ts`) wraps the existing journaling turn through a new `HeadlessHandle.journalSession()` (the generalized `runJournalingTurn`, which now delegates to it). It only runs `cc-headless` sessions, ignores the journaler `model`, and is `unavailable` with no Claude session or a missing transcript. A headless session whose agent never replied (no `claude_session_id`) used to be stamped journaled; it now exhausts the chain like any unrunnable job.
- **`fidelity`** is reported by the journaler (`full-session` for the provisional cc-headless one).
- **Migration numbering.** 030 is reserved for another branch (`030_email_imap_state`). Part B uses 027–029, then 031 and up.

### Seams for part B (S66.6–S66.11)

- Register journalers with `JournalerRegistry.register()` in `src/index.ts` (`journalers`). Registering `cc-headless` again replaces the provisional one; then delete `journalers/cc-headless-provisional.ts` and the `headlessJournaler.addHandle` wiring (or keep the handle map if the real one reuses `journalSession`).
- Job: `JournalJob` in `src/journaling/types.ts`. Per-journaler settings are in `job.settings.journalers[...]`. Outcome: `JournalRunResult`.
- Triggers: `JournalEngine.trigger({ reason, sessionId | conversationId })` returns `{ status, done }`. `/journal now` = `reason: 'manual'`. `engine.isAgentBusy()`, `engine.isInFlight()`, `engine.store.listRuns()` and `getAgentState()`, and `hookHealth()` feed `/journal` and health.
- cc-pool release waiting (S66.9): make the hook installed in `src/index.ts` `await Promise.race([handle.done, timeout(settings.timeoutMs)])`.
- Advisory helpers live in `src/journaling/advisories.ts`.

### Part B (S66.6–S66.11), 2026-10-06, `feat/e64-e68-journaling`

Code: `src/journaling/journalers/{cc-headless,script,system-message}.ts`, `process.ts`, `prompt.ts`, `memory-diff.ts`, `delivery.ts`, `status.ts`; `src/commands/journal.ts`; `src/pipeline/stages/journal-hold.ts`; `src/mcp/tools/journal.ts`; `scripts/journalers/claude-p-journal.sh`. No new migrations (027–029 and 031+ are still free). Where the code differs from the text above, the code wins:

- **Journaler interface.** `run(job, ctx?: { signal })`. The runner's settle timeout (3× `timeout_ms`) aborts `signal` before recording `failed-after-start`, and every built-in journaler stops its work on abort (kills its process group, or closes its hold). This closes part A's gap.
- **cc-headless (S66.6).** cc-headless sessions still run through the instance handle (`HeadlessHandle.journalSession`, now with `model`, `timeoutMs`, `signal`), so the agent's system prompt, MCP config and context ledger apply and the turn is serialized with live turns. Journaling turns use `--disallowedTools reply,send_message,send_email` instead of allowing delivery, run `detached` (own process group), and a set journaler model bypasses `resolveModel()` (so `model_overrides` don't apply to journal runs). cc-pool sessions run `claude -p --resume <id> --fork-session --output-format json --permission-mode acceptEdits --strict-mcp-config` with an empty MCP config in the pool's working dir, with `claude_bin` and `pane_env`, and the inherited Claude session variables scrubbed. `--fork-session` keeps the pane's own transcript untouched. A reply ending in `NOTHING_TO_RECORD` maps to `nothing-to-do`. `inputTokens` include cache reads and writes. `canJournal` checks the transcript through `RuntimeResolver.checkLive('sessionResume')` with the session's pane id. Only `session` jobs.
- **Script (S66.7).** Environment adds `AGENTBUS_PAYLOAD_VERSION`, `AGENTBUS_JOB_KIND`, `AGENTBUS_CONVERSATION_ID`, `AGENTBUS_SESSION_ID`, `AGENTBUS_WORKING_DIR` and `AGENTBUS_URL` (not secret) to the decided set. cwd falls back to `$HOME` for runtimes without a working dir. A command that can't be spawned is `failed-before-start`; `canJournal` checks it is an executable file. Fidelity is `snapshot` when the job has snapshots, else `bus-transcript`. Supports `session` and `consolidate` jobs. The reference script handles `session` only (exit 75 otherwise), pipes the prompt on stdin (not argv), and, when `AGENTBUS_URL` answers, adds the notes of the conversation's last successful runs from `GET /api/v1/journal/runs`, sending `X-Bus-Token` from `AGENTBUS_BUS_TOKEN` through curl's stdin (the fix-branch convention). The journal hook and pool Stop hook now read `AGENTBUS_BUS_TOKEN` the same way (`AGENTBUS_TOKEN`/`_FILE` still work).
- **System Message (S66.8).** Instruction delivery is a system-only `processInbound` turn with two new in-process options: `blocks` (attached after the pipeline, so never stored in the transcript) and `metadata` (`journal_run_id`, a new reserved key stripped at ingress). The advisory-inject stage skips journal turns. **Holds are at the pending poll**: `MessageQueue.dequeue(…, skip)` leaves held rows `pending`, so they survive a restart and flow as soon as the run ends; open runs themselves are in memory only (`JournalRunGate`), so a restart drops the hold and a late `journal_complete` is `unknown_run`. A timed-out instruction still `pending` is dead-lettered. Busy notice: stage 87 (`journal-hold`), once per run; app `queued` activity (and `idle` at the end), Telegram tool-status placeholder, plain text from `system:bus` elsewhere (not logged), nothing on email or **Siri** (a notice would answer the ask). Outbound block covers `POST /api/v1/messages` (reply, send_message, send_email) for the run's pane id or logical agent id; reactions carry no sender and aren't blocked. **Idle** = nothing pending/processing for the agent's recipient, and the last human message (excluding slash commands, reactions, system-only turns) answered: by a `turn-ended` (journal_state or pane `last_turn_ended_at`) when one was ever seen, else by a later non-command outbound row. `canJournal` also requires an open session, so `/clear`, close and eviction fall through to `cc-headless`. `system-message.model` is accepted but unused. Completion with `nothing_new` and no diffed file → `nothing-to-do`; diffed memory-dir files (paths relative to the working dir) are merged into `files_changed` even on timeout. `journal_complete` is registered for the polling and pool MCP servers, not headless. Agent jobs with no conversation go to the first owner's `general` conversation.
- **cc-pool (S66.9).** The release hook waits for `handle.done`, bounded by the larger of `timeout_ms` and `system-message.timeout_ms`. **Hard-idle**: after the wait the pane is kept if it was re-leased, a human wrote in the conversation, or messages are queued for it (the journal hold itself queues messages). **Eviction**: `acquire()` has already moved the lease, so `system-message` can't run for the evicted conversation; the journal uses `cc-headless`/`script`. A hook still waiting after `evictJournalGraceMs` (2 s) parks the incoming message and finishes release + launch in the background; `drainParked()` (60 s tick) delivers it through the reuse branch. *Superseded 2026-10-06 (post-E66 decision 1): eviction no longer waits; see below.* **`/clear`** (`PoolManager.clearConversation`, `LeaseStore.detach`): the pane goes `draining` with no conversation at once, then `on_evict` and `release()` in the background. It does **not** wait for the journal: the session is closed, so only journalers reading the transcript on disk can run, and `/clear` or a kill doesn't remove it. `PoolManager.journalingRunner`, the `JournalingRunner` type, `HeadlessHandle.journalResumeId` and `runJournalingTurn` are gone.
- **Observability (S66.10).** `/journal` resolves its agent from the conversation's session, else the only journaling agent. `/journal now` waits up to 1.5 s for a quick answer. `GET /api/v1/journal/runs` also filters by `conversation` and `session` and maps a pane id to its pool. Health adds `journaling { status, agents }`; the top-level `status` is unchanged. Backlog scans up to 200 sessions active in the last 30 days (open, or closed with a pending trigger). The run log line adds `fidelity`, `files_changed`, `cost_usd`.
- **Summarizer (S66.11).** Closed sessions go straight to status `closed`; legacy `summarize_*` rows are left alone. The legacy store is **read-only**: stage 85 and `recall_memory` keep reading, `log_memory` stays registered but errors, `POST /api/v1/memories` returns 410. The expired-memory sweep stays (retention). `claude_api_model`, `summary_max_tokens`, `structured_extraction` are optional schema keys with no defaults, plus a loader warning. `agentbus_precompact_snapshot.sh` is **deprecated, not deleted**: the generic hook replaces its snapshot, but not its pointer line in the daily journal.
- **Bus-originated turns hidden.** Rows flagged `metadata.system_only` (critical advisory turns, journal instructions) are excluded from app history, replay events, titles and session visibility, `GET /api/v1/sessions/:id/transcript`, transcript search, the reply-quote "latest inbound" check, and journal windows. They stay in the DB.

### Seams for E67 and E68

- **Memory injection (E67).** Headless memory blocks: `assembleMemoryBlocks` / `assembleMemoryContext` in `src/adapters/memory-context.ts`, used by `HeadlessInstance.runClaudeTurn` (context ledger, `src/adapters/context-ledger.ts`) and still `CLAUDE_CODE_DISABLE_AUTO_MEMORY` in `invokeClaude`. Pool panes render the system prompt with `memories: ''` (`src/pool/pane.ts`). Legacy stage 85: `src/pipeline/stages/memory-inject.ts`. `JournalJob.memoryDir` is `<workingDir>/<memory.dir>` (headless) or `<workingDir>/memory` (pool) in `JournalEngine.buildJob`; E67 should replace that convention with per-agent config.
- **`recent.md` regeneration (E67).** Hook it where a run succeeds: `runChain()` in `src/journaling/runner.ts`, the `if (winner)` branch (after `advanceCursor`), or as an engine-level callback on `EvaluationResult.status === 'journaled'` in `JournalEngine.evaluate`. `JournalEngine.addTicker()` is the place for the local-midnight regeneration.
- **Job kinds (E68).** `JobKind = 'session' | 'consolidate'` exists; `supportsKinds`: system-message and script take both, cc-headless takes `session` only (E68 adds a fresh `claude -p` without `--resume`). The engine only builds session jobs today (`buildJob`); a consolidation job needs `conversationId: ''` (System Message then targets the default conversation via `SystemMessageJournaler.target()`), its own window semantics, and a lane slot through `JournalEngine.enqueue` (the per-agent lane is keyed by agent id, so consolidation already serializes with session runs if enqueued there). `journal_runs.kind` records it.
- **Feedback in the job payload (E68).** Add `feedback[]` to `JournalJob` (`types.ts`), fill it in `JournalEngine.buildJob` from the window (`job.window.from`–`to`), and pass it through `buildScriptPayload` (`journalers/script.ts`, bump nothing: adding a field is compatible with `version: 1`), `jobContextLines` (`prompt.ts`, used by cc-headless and system-message prompts). Eligibility bypass for denied approvals and `/feedback`: `assessEligibility` in `eligibility.ts`.
- **Protected-path hashing (E68).** Before/after points: around `journaler.run()` in `runChain()` (every journaler), or per journaler where `snapshotMemoryDir`/`diffMemory` already run (`SystemMessageJournaler.run`). The cc-headless permission-rule enforcement belongs in the `claude -p` args (`invokeClaude` journal branch, `CcHeadlessJournaler.runDirect`).

### Open questions

- ~~**Eviction wait.**~~ Resolved 2026-10-06: eviction doesn't wait (post-E66 decision 1).
- **Health top-level status.** `journaling.status` is separate; should `critical` journaling make `/api/v1/health` report `degraded`?
- ~~**`log_memory`/`POST /api/v1/memories`**~~ Resolved 2026-10-06: the whole legacy store was removed (post-E66 decision 2).


### Post-E66 changes (2026-10-06, operator decisions; see decisions.md "Post-E66 decisions")

- **1. Eviction doesn't wait for the journal.** `PoolManager.resolveRoute()` calls the release hook for `evict` without awaiting it and releases + relaunches the pane at once; `evictJournalGraceMs` and the eviction parking path are gone. The bus's hook returns right after firing the `evict` trigger, so the journal runs in the background from the transcript on disk (`cc-headless --fork-session`, `script`). Hard-idle `release` keeps the bounded wait and the keep-the-pane checks.
- **2. Legacy structured memory store removed.** `recall_memory`/`log_memory` (`src/mcp/tools/memory.ts` → `transcripts.ts`, which keeps `search_transcripts`), `GET /api/v1/memories/recall`, `POST /api/v1/memories`, stage 85 `memory-inject` and `metadata.memory_context` rendering in `formatMessagesForSampling` (the `includeMemoryContext` option is gone), the session tracker's expired-memory sweep, the `memories` FTS rebuild, the `MemoryRow`/`SummaryResult` types and the `summary` object on the sessions API and session tools. Migration **031** drops `memories`, `memories_fts` (and its triggers) and `session_summaries`. `memory.context_window_hours` and `memory.memory_inject_exclude` left the schema and joined `RETIRED_MEMORY_KEYS` (warn and ignore), like the summarizer keys, which also left the schema (zod drops unknown keys).

# E66 — Pluggable Journaling Core

| Field | Value |
|---|---|
| Epic ID | E66 |
| Status | Planned |
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

# Pluggable journaling — design decisions (working notes)

Running record of decisions from the design discussion. Becomes the basis for the epic.

Decisions marked 2026-10-02 are confirmed by the user.

## Model

- Journaling is decoupled into **triggers** (when) and **journalers** (who does it).
- Journalers: System Message (any adapter), cc-headless (`claude -p --resume`), Script (any adapter, user-provided).
- Ordered fallback chain when a journaler is unavailable or fails.

## Triggers (decided 2026-10-02)

- **Two layers.**
  - Harness signals (optional, per harness): hook scripts post `turn-ended | pre-compact | session-end | clear` to one generic endpoint `POST /api/v1/journal/events { harness_session_id, event }`. The bus resolves agent and conversation from the session id (no per-deployment constants in hooks). Each harness declares which events it can emit.
  - Bus-side tracking (always on, harness-agnostic backstop): pause, ceiling, session close, bus `/clear`, pool evict/release, shutdown.
- **A trigger means "evaluate", not "journal".** Journal only if there is eligible content past the session's journal cursor and nothing is in flight. Double-fires are harmless; missed hooks are covered by the backstop.
- **`turn-ended` never journals directly.** It only re-anchors the pause timer to the true end of the turn.
- **Lossy events (pre-compact, clear) use "preserve now, journal later".** The hook snapshots the raw transcript and registers the snapshot path with the bus; the next journal run receives it as input.
- **Hook health is observable.** A harness that declares an event but never sends it for an active session is surfaced in `/journal` status.

## Eligibility (decided 2026-10-02)

- A session is eligible only with at least one **human-authored inbound** message since the cursor. Any human counts (not only owner contacts); trust is handled separately.
- Excluded: scheduler-fired inbound (`metadata.scheduled`), slash commands and their responses (`command_response`), agent-to-agent messages.
- The journal window starts at the last agent message preceding the first eligible human message, so a reply to a scheduled-job message is journaled with that message as context.

## Journaler interface (decided 2026-10-02)

- Interface: `id`, `requires: Capability[]`, `canJournal(job)` (cheap, side-effect free), `run(job)` → `done | nothing-to-do | unavailable | failed-before-start | failed-after-start`.
- Compatibility is capability-based, not adapter lists. Static capabilities are validated at config load; live ones are checked by `canJournal` at run time.
- **Chain is configured per agent** (agents may have different scripts).
- A chain that can run out of options raises a bus advisory (see below) rather than failing silently.

## Related work spun out

- **Adapter capability taxonomy** — formalize what agent runtimes support (system messages, schedules, session resume/fork, exclusive sessions, hook events), separate from the existing channel-side `AdapterCapabilities` in `src/core/registry.ts`. Journaler compatibility consumes it.
- **Bus advisories** — the bus raises warnings that reach the user through the agent (injected alongside user messages). Journaling is one producer.

## Sequencing (decided 2026-10-02)

- Capability taxonomy epic first. Assumed order: taxonomy → advisories → journaling (advisories order not yet confirmed).

## Advisories (decided 2026-10-02)

- **Owner contacts are new**: a per-agent config of owner contacts. Advisories go only to owners, only in owner conversations. Also feeds trust levels for memory-poisoning work.
- `info`/`warning`: injected into the next owner conversation alongside user messages; the agent relays.
- `critical`: proactive. Wake the agent with a system-only turn if the runtime supports it; otherwise the **bus messages the owner directly** on the channel (approved).
- Lifecycle `open → delivered → acknowledged → resolved`, keyed by condition (one advisory per condition, auto-resolve, re-raise on recurrence). Agent acks via an MCP tool. Each advisory carries a remediation hint.
- Advisories are delivered in a bus-originated block that inbound message bodies cannot spoof.
- Same direct-to-channel fallback for runtimes without system-message support.

## System Message Journaler (decided 2026-10-02)

- Shares the "system message" runtime capability and spoof-proof block with advisories. On cc-headless it reduces to the cc-headless journaler.
- Completion via MCP `journal_complete({ run_id, files_changed, notes, nothing_new? })`; `run_id` rejects stale completions. Timeout → `failed-after-start`. Memory-dir diff is an independent check.
- **Timeout default 5 min**, configurable per journaler.
- **Exclusive run:** new user messages for the conversation are held until completion or timeout. **The bus tells the user the agent is busy** while their message waits.
- **All outbound sends from the agent are blocked during the run** (including proactive `send_message`), except `journal_complete` / `advisory_ack`; rejected with a 409 and reason.
- `canJournal` requires the agent to be idle (`turn-ended` hook if present, bus activity otherwise).
- **Pool release waits for the journal (bounded by the timeout) before `/clear`, including on LRU eviction.**

## Fallback semantics (decided 2026-10-02)

- `unavailable` / `failed-before-start` / `failed-after-start` → next journaler immediately. `done` / `nothing-to-do` → stop, advance cursor.
- The cursor advances only on `done` or `nothing-to-do`. Exhausted chain → cursor stays, advisory raised, retry on next trigger within the per-window attempt cap.
- **Partial writes are not handled for now.** Git-versioned memory / rollback is out of scope (backlog: "Agent memory repo management").
- **One journal run per agent at a time**, across all journalers and sessions (extends the headless agent-wide journal lane).
- Each run records which journaler ran and its input fidelity.
- Escalation: exhausted chain → `warning` advisory; `critical` after **3 consecutive exhaustions or 24 h of unjournaled eligible content**.
- Busy notice while user messages are held: once per hold, native queued/status signal where the channel has one, skipped for email, generic wording (no mention of journaling).

## Script Journaler contract (decided 2026-10-02)

- Per-agent config `{ command, args?, timeout_ms?, env? }`. Executed directly (no shell), cwd = agent `working_dir`. Timeout (default 5 min) → SIGTERM then SIGKILL to the process group.
- Input: versioned JSON (`version: 1`) on stdin — run/trigger/agent/memory_dir/conversation/session/harness session ids, channel, topic, window, `messages[]` (author with `is_human` / `is_owner`, attachments by path, `scheduled` flag; includes the preceding agent message for context), `snapshots[]`, `harness_transcript_path`. Basics mirrored in `AGENTBUS_RUN_ID`, `AGENTBUS_AGENT_ID`, `AGENTBUS_MEMORY_DIR`, `AGENTBUS_TRIGGER`.
- Exit codes: `0` done, `3` nothing-to-do, `75` unavailable, anything else or timeout → failed-after-start. Optional stdout JSON `{ files_changed, notes }`; stderr captured (truncated) to logs.
- **Minimal environment**: `PATH`, `HOME`, `AGENTBUS_*`, plus the agent's configured `env`. The bus's own environment (secrets) is not inherited.
- Docs state that inputs are untrusted data.
- **Ship a reference script** `scripts/journalers/claude-p-journal.sh` (payload → `claude -p` with a journaling prompt in the agent's working dir).
- **Retire the Anthropic-API summarizer** (`src/memory/summarizer.ts`) and the `@anthropic-ai/sdk` dependency; "LLM over bus transcript" becomes the reference script.

## Memory poisoning / trust tiers (decided 2026-10-02)

- **Out of scope.** Allowed senders are locked down per channel and the agent sees who sent each message; residual risk accepted. No trust tiers, no contact-scoped memory enforcement, no detection advisory. (Owner contacts still exist, for advisories only.)

## Observability (decided 2026-10-02)

- `journal_runs` table, one row per journaler attempt: run/agent/session/conversation ids, trigger, journaler, chain position, `fallback_from`, outcome, error (truncated), fidelity (`bus-transcript | snapshot | full-session`), window, message count, timing, files changed, notes, cost/tokens when known. **90-day retention.**
- `/journal` (status for conversation + agent: cursor age, unjournaled messages, in-flight, chain, consecutive failures, hook health, open advisories), `/journal runs [n]`, `/journal now` (reason `manual`; bypasses pause threshold, **respects the cursor**).
- `GET /api/v1/journal/runs?agent=…`. **`/api/v1/health` includes a journaling summary** (backlog age, consecutive exhaustions, last failure).
- One structured log line per run.

## Cost controls (decided 2026-10-02)

- Per-journaler `model`; **defaults to the agent/instance model**. cc-headless journaler passes `--model`; script journaler gets `AGENTBUS_MODEL`.
- **`min_human_messages` default 2.** Below threshold the cursor stays and content accumulates. Final triggers (close, clear, evict, pre-compact, shutdown) bypass the threshold.
- Daily budget cap: **not now**.
- Backlog age (for the 24 h `critical` escalation) counts only content that meets the threshold; below-threshold content is "pending". Pending content older than 24 h is journaled on the next trigger regardless.

## Consolidation (decided 2026-10-02)

- Formalized in AgentBus (an informal agent-side routine exists today; this replaces/standardizes it).
- **Two job kinds in one framework**: session jobs (conversation window) and agent jobs (`consolidate`: memory dir + journal runs since last pass). Journalers declare which kinds they support.
  - cc-headless: fresh `claude -p` (no `--resume`) in the agent working dir.
  - System Message: delivered to the agent's default conversation (existing behavior when no conversation is specified); the exclusive-run rules (held messages, blocked outbound) apply to that conversation.
  - Script: `kind: "consolidate"` in the payload.
- Pass: promote recurring patterns into `MEMORY.md`/topic files, merge duplicates and resolve contradictions (newer wins, note what was replaced), prune `MEMORY.md` to a size budget, **archive (never delete)** stale content to `memory/archive/`.
- **Nightly per-agent cron** (`journaling.consolidation: { cron, prompt, max_memory_lines }`), independent of the scheduler; **skipped when no session journal completed since the last pass**. Manual: `/journal consolidate`.
- Shares the one-run-per-agent lane; recorded in `journal_runs`.

## Feedback signals (decided 2026-10-02)

- First version records: **denied approvals (E51), `/feedback <text>`, tool errors** (headless stream tool errors, failed delivery calls). Not `/stop` (usually a change of mind, not a correction), not reactions, edits, or quick-follow-up heuristics.
- `feedback_events` table (kind, conversation, referenced agent message, text, timestamp). Session jobs receive `feedback[]` for their window (script payload, system-message summary block, headless prompt); consolidation receives cross-session counts.
- **`/feedback <text>`**: immediate ack, recorded as an event, never delivered as a normal message, does not journal immediately.
- **Denied approvals and `/feedback` make the session eligible immediately** (bypass `min_human_messages`). Tool errors do not (too frequent).

## Approval-gated self-edits (decided 2026-10-02)

- Per-agent `protected_paths`, **default `CLAUDE.md`, the system-prompt file, `skills/`, `.claude/`**. Memory files stay freely writable.
- Journalers/consolidation propose via MCP `propose_change({ path, new_content | diff, rationale, evidence })`; scripts return `proposals[]` in stdout JSON.
- New request type in the E51 approvals system, sent to owner contacts (rationale, compact diff, Approve/Deny).
- **The bus applies approved changes**, guarded by a base-hash check (changed file → stale, agent may re-propose). Deny → denied-approval feedback event.
- **7-day expiry, max 3 proposals per agent per day.** Approve/Deny only in v1.
- **Enforcement:** cc-headless journaling turns run with permission rules denying edits to protected paths; elsewhere, before/after hashing of protected files raises a `warning` advisory on unapproved changes.

## Memory organization (decided 2026-10-02)

- **Adopt Claude Code native auto memory** with `autoMemoryDirectory` pointing at the agent's own `memory/` dir (agent project `.claude/settings.json`). Native loads the first 200 lines / 25KB of `MEMORY.md` on every Claude Code runtime and enforces the size limit itself.
- **In-turn writes accepted (option a):** native auto memory may write during turns for explicit "remember X" moments; `CLAUDE.md` steers everything else to the journaling sweep (soft rule). *Refined 2026-10-06 (Post-E66 decision 4): in-turn capture is proactive and normal; journaling is the safety net plus reflection.*
- Bus no longer injects `MEMORY.md` on Claude Code runtimes; `CLAUDE_CODE_DISABLE_AUTO_MEMORY` dropped for headless; agent SessionStart hook loading `MEMORY.md` becomes redundant. "Native memory" is a runtime capability in the taxonomy; runtimes without it keep bus injection.
- Layers: `CLAUDE.md` + imports (protected) → **pinned memory** (`memory/vocabulary.md` glossary, imported from `CLAUDE.md`, not protected, outside the 200-line cap) → `MEMORY.md` (essentials + one-line index) → typed topic files (native frontmatter `user | feedback | project | reference`, on demand) → `memory/daily/` (not indexed) → `memory/archive/`.
- **Migrate Baxter's topic files to native frontmatter**, splitting `feedback.md` into per-memory `feedback` files. Journaler and consolidation prompts write in the native format.

## Recent dailies (decided 2026-10-02)

- **Bus-generated `memory/recent.md`, imported from `CLAUDE.md`**: last `lookback_days` of dailies, newest first, within a char budget, truncation marker, "generated, do not edit" header; journalers don't write it. Regenerated after each successful journal run and at local midnight.
- **Defaults: 3-day lookback, ~20KB budget.**
- Replaces bus per-turn memory injection and the context ledger's memory blocks on Claude Code runtimes. Verify during implementation that a resumed `claude -p` rebuilds context from current files on disk.
- **`UserPromptSubmit` freshness hook for live panes: in scope now.** Injects `recent.md` when it changed since that session last saw it; falls back to launch/compaction/`/clear` reload when absent.
- Dailies: written by session journalers (serialized per agent), read by consolidation, **archived (never deleted) after 30 days** once promoted.

## Recurring-correction check (decided 2026-10-02)

- The consolidation prompt flags corrections that recur after a rule was added and may turn them into a `propose_change` to strengthen the rule. No new mechanism.

## Post-E66 decisions (2026-10-06)

1. **Pool eviction no longer waits for the journal.** On LRU eviction the pane is released and reused right away; the evicted conversation's journal runs in the background from the on-disk transcript (cc-headless `--fork-session`, script journalers). Hard-idle release keeps the bounded wait (the pane is still leased, so `system-message` can run).

2. **Remove the legacy structured memory feature entirely.** The operator is its only user and it is dead. Remove the `recall_memory`/`log_memory` tools, `/api/v1/memories` routes, the memory-inject stage and its config; retired keys warn and are ignored at load so an old `config.yaml` still starts. Migration 031 drops `memories` and `session_summaries`.

3. **Critical journaling degrades health.** When the journaling summary's status is `critical`, `/api/v1/health` reports top-level status `degraded`.

4. **In-turn capture vs journaling (refines option a).** In real time the agent acts as itself and proactively captures information to best support the user; high-stakes items are saved immediately. In-turn capture is the agent's normal behavior, not only for explicit "remember X" moments. Journaling is the safety net for that capture and the place for reflection and second-order insights. Journaling itself doesn't change: a run sees what the agent already captured and takes no action, or corrects/updates it where appropriate. The default journaling prompt gained one sentence saying so (don't record what's already in memory; skip it or correct/update it); no other prompt change. Steering lines in `docs/AGENT_MEMORY.md`, `site-docs/features/agent-memory.md` and the Baxter plan use this framing.

## Epics

- E64 Runtime capability taxonomy → E65 Owner contacts and bus advisories → E66 Pluggable journaling core; E67 Native memory layout and read side (parallel to E66); E68 Agent learning (after E66, E67).

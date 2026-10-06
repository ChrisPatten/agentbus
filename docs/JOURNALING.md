# Journaling (E66)

> **Status: part A shipped (S66.1–S66.5).** Config, cursor and eligibility, the evaluation engine, harness events, the journaler interface and the chain runner are in place. The `system-message` and `script` journalers, the full `cc-headless` journaler, cc-pool release waiting, `/journal` and the summarizer retirement come in part B (S66.6–S66.11). Sections marked *(part B)* describe what is still to come.

Journaling has two parts. **Triggers** decide *when* the bus looks at a conversation. **Journalers** decide *who* updates the agent's memory. One engine serves every agent runtime (`cc-headless`, `cc-pool`, `claude-code`, polled harnesses).

Code: `src/journaling/` (`config.ts`, `eligibility.ts`, `store.ts`, `engine.ts`, `runner.ts`, `registry.ts`, `events.ts`, `advisories.ts`, `types.ts`, `journalers/`). Migration 026. Design record: `_bmad-output/planning-artifacts/journaling/decisions.md`.

## Configuration

Per agent, under the top-level `agents:` record (keyed like `owners`, bare or `agent:`-prefixed):

```yaml
agents:
  "agent:baxter":
    owners:
      - { channel: telegram, contact_id: chris }
    journaling:
      chain: [system-message, cc-headless, script]
      threshold_ms: { default: 1800000, telegram: 300000 }
      ceiling_ms: 14400000
      min_human_messages: 2
      timeout_ms: 300000
      model: sonnet
      script:
        command: /Users/me/agentbus/scripts/journalers/claude-p-journal.sh
```

| Option | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch |
| `chain` | `[system-message, cc-headless, script]`, with `script` only when `script.command` is set | Journalers to try, in order |
| `threshold_ms` | `{ default: 1800000 }` | Pause trigger: idle gap, a number or a per-channel map with a required `default` |
| `ceiling_ms` | unset | Ceiling trigger: max time since the last journal (or session start) |
| `min_human_messages` | `2` | Human messages needed before a non-final trigger journals |
| `timeout_ms` | `300000` | Per-run timeout for journalers that wait on the agent |
| `model` | the runtime instance's `model` | Model for journal runs |
| `prompt` | built-in journaling prompt | Journaling instruction |
| `system-message.{timeout_ms,model,prompt}` | inherit | Per-journaler overrides |
| `cc-headless.{model,prompt}` | inherit | Per-journaler overrides |
| `script.{command,args,timeout_ms,env,model}` | — | Script journaler (required when `script` is in the chain) |

Validation (`AgentJournalingSchema`, `journalingRequirements`):
- `script` in the chain needs `script.command`; duplicate chain entries are rejected.
- **Static capabilities.** Each journaler declares what it needs (`JOURNALER_REQUIREMENTS`): `system-message` needs `systemMessages`, `liveAgent`, `exclusiveSession`; `cc-headless` needs `sessionResume`; `script` needs nothing. Entries the agent's runtime can never support are skipped at run time without a `journal_runs` row (so `system-message` always falls through on `cc-headless`). A chain with **no** compatible entry, or journaling on an agent with no runtime, fails at load through `collectRuntimeRequirements` (E64).
- **Can run out of options.** When the last runnable entry is not `script`, the bus logs it and raises the `journaling:chain-can-exhaust` advisory (`info`) at startup; it resolves itself once the chain ends with `script`.

### Deprecated alias

`adapters.cc-headless[.<name>].journaling` still works for a headless agent without `agents.<id>.journaling`. It maps to `chain: [cc-headless]` with its `enabled`, `threshold_ms`, `ceiling_ms` and `prompt`; `min_human_messages` and `timeout_ms` take the new defaults (2 and 5 min). The loader logs a deprecation warning when the block is set explicitly. When both blocks exist for one agent, `agents.<id>.journaling` wins.

## Cursor and state

- `sessions.journal_cursor_at`: `created_at` of the newest transcript row a successful run covered. A run only sees rows after it. It advances **only** when the chain ends `done` or `nothing-to-do`. Migration 026 backfills it from `last_journaled_at`.
- `sessions.last_journaled_at`: time of the last successful run (anchors the ceiling).
- `journal_state` (per session): pending final trigger and when it fired, last turn end, harness session id and transcript path, exhausted attempts for the current window.
- `journal_snapshots`: transcript snapshots registered by hooks, consumed by the next successful run.
- `journal_agent_state`: consecutive exhaustions, last success and failure per agent.
- `journal_hook_events`: last sighting of each harness event per agent.
- `journal_runs`: one row per journaler attempt (see [Observability](#observability)). Swept after 90 days.

## Eligibility and window

A human message is an inbound transcript row that is not from an `agent:` or `system:` sender, not scheduler-fired (`metadata.scheduled`), not a bus system-only turn (`metadata.system_only`), not a slash command, and not a reaction. Any human counts, not only owners; owners are flagged `is_owner` in the job for the journaler's benefit.

| Trigger kind | Needs |
|---|---|
| Non-final (`pause`, `ceiling`) | `min_human_messages` since the cursor. Below that the content is **pending**. Pending content whose first message is 24 h old is journaled anyway. |
| Final (`close`, `clear`, `evict`, `release`, `pre-compact`, `session-end`, `shutdown`) | At least one human message |
| `manual` | At least one human message; also ignores the attempt cap |

The **window** starts at the last agent message before the first eligible human message (even if that message is before the cursor), so a reply to a scheduled briefing carries the briefing as context (`context: true`). Slash commands and their `command_response` replies are left out of the window. On success the cursor moves to the newest row past it, including scheduled or command rows.

**Backlog age** (for the 24 h `critical` escalation) counts only content that met the threshold: from the `min_human_messages`-th human message, from 24 h after the first one for pending content, or from when a final trigger fired.

## Triggers and the engine

A trigger means "evaluate", never "journal now". `JournalEngine.trigger({ reason, sessionId | conversationId })` returns a handle at once (`queued`, `merged`, `not-configured`, `disabled`, `unknown-session`) whose `done` promise resolves with the evaluation result.

| Trigger | Source |
|---|---|
| `pause` | Engine tick: idle past the channel threshold. The idle clock starts at the latest of the session's last inbound message, its last agent message, and the last `turn-ended` event. |
| `ceiling` | Engine tick: `ceiling_ms` since `last_journaled_at` (or `started_at`) |
| `close` | `SessionTracker` closing a session (idle close or mid-flight close) |
| `clear` | Bus `/clear`, or the harness `clear` event |
| `evict`, `release` | `PoolManager` LRU eviction and hard-idle release, through `setReleaseHook` |
| `pre-compact`, `session-end` | Harness hook events |
| `shutdown` | Bus shutdown (see below) |
| `manual` | `/journal now` *(part B)* |
| `turn-ended` | Harness hook; only re-anchors the pause clock |

- **Final triggers are persisted** in `journal_state.pending_trigger` when they fire, and the tick re-evaluates pending rows, so a restart doesn't lose a `/clear` or an eviction.
- **Shutdown** persists a `shutdown` trigger for every open session with unjournaled human content and waits up to 5 s for runs in flight. Those sessions are journaled after the restart. (The bus doesn't hold up exit for a full run.)
- **Single-flight per session.** A trigger for a session already queued merges into it (a final or manual trigger upgrades the queued one). One that arrives while the session's evaluation is running re-evaluates the session afterwards.
- **One run per agent at a time**, across all journalers and sessions, through a per-agent lane. Pool pane sessions belong to the pool's logical agent.
- **Attempt cap.** After 3 exhausted runs on the same window, non-manual triggers skip it until new content arrives.
- **Attribution.** A session's agent is `sessions.agent_id` (a pool pane id maps to its pool). Sessions with no `agent_id` fall back to the sole `cc-headless` instance; with several instances they are skipped.

The engine replaced `SessionTracker.dispatchJournaling()`. It ticks every `memory.summarizer_interval_ms` (default 60 s).

## Harness events and hooks

`POST /api/v1/journal/events`:

```json
{ "harness_session_id": "<claude session id>", "event": "pre-compact", "snapshot_path": "/abs/path.jsonl", "transcript_path": "/abs/transcript.jsonl" }
```

The bus finds the session whose `claude_session_id` (or recorded harness session id) matches, open sessions first. `404` when none matches. Events:

- `turn-ended`: re-anchors the pause clock and, for cc-pool, marks the pane's turn ended (what `POST /api/v1/pool/:agentId/turn-ended` does). Never journals.
- `pre-compact`, `clear`: **preserve now, journal later**. The hook copies the transcript to a snapshot file and sends its path; the bus registers it and fires the final trigger of the same name. The next run's job lists it in `snapshots[]`.
- `session-end`: final trigger (snapshot registered when sent).

Snapshot paths must be absolute, exist, be regular files, and resolve inside the agent's working directory or `~/.agentbus/journal-snapshots`. A rejected path is reported in `snapshot_error`; the trigger still fires.

**Hook script.** `scripts/hooks/agentbus_journal_hook.sh` maps Claude Code's `Stop` → `turn-ended`, `PreCompact` → `pre-compact`, `SessionEnd` → `session-end` (reason `clear` → `clear`). It has no per-deployment constants. Environment: `AGENTBUS_URL` (default `http://127.0.0.1:3000`), `AGENTBUS_TOKEN` or `AGENTBUS_TOKEN_FILE` (sent as `X-Bus-Token`), `AGENTBUS_SNAPSHOT_DIR` (default `~/.agentbus/journal-snapshots`), `AGENTBUS_SNAPSHOT_LINES` (default 2000). Needs `jq` and `curl`; always exits 0. Example `.claude/settings.json`:

```json
{
  "hooks": {
    "Stop":       [{ "hooks": [{ "type": "command", "command": "scripts/hooks/agentbus_journal_hook.sh" }] }],
    "PreCompact": [{ "hooks": [{ "type": "command", "command": "scripts/hooks/agentbus_journal_hook.sh" }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "scripts/hooks/agentbus_journal_hook.sh" }] }]
  }
}
```

`agentbus_stop_hook.sh` (cc-pool) now posts `turn-ended` here instead of using a hardcoded `POOL_AGENT_ID`. `agentbus_precompact_snapshot.sh` is superseded by the generic hook.

**Hook health** (`hookHealth()`): for each event the runtime declares in `hookEvents`, `ok`, `never-seen`, `stopped`, `unverifiable` (rare events not seen yet) or `idle`. Only `turn-ended` can be judged by its absence. A `turn-ended` hook that used to report and has been quiet for 10 min while the agent keeps answering raises `journaling:hook-stopped:turn-ended` (`warning`); it resolves when the hook reports again. A hook that was never seen raises nothing, because hooks are optional. `/journal` shows hook health *(part B)*.

## Journalers

```ts
interface Journaler {
  id: 'system-message' | 'cc-headless' | 'script';
  requires: RequiredCapability[];      // static, checked at load and before each attempt
  supportsKinds: ('session' | 'consolidate')[];
  canJournal(job): { ok: true } | { ok: false; reason }; // cheap, side-effect free; live checks
  run(job): Promise<{ outcome, error?, fidelity?, filesChanged?, notes?, costUsd?, inputTokens?, outputTokens? }>;
}
```

Outcomes: `done`, `nothing-to-do`, `unavailable`, `failed-before-start`, `failed-after-start`. Register with `JournalerRegistry.register()`; registering an id again replaces the earlier journaler.

The job (`JournalJob`, `src/journaling/types.ts`) carries ids (run, agent, pane, session, conversation, Claude and harness session), runtime kind, working and memory dirs, channel, contact, topic, trigger, the window (`cursorAt`, `from`, `to`, `advanceTo`), `messages[]` (author with `is_human` / `is_owner` / `is_agent`, attachments by path, `scheduled`, `context`), `snapshots[]`, `harnessTranscriptPath`, prompt, model, timeout and the agent's full settings.

| Journaler | Status |
|---|---|
| `cc-headless` | **Provisional** (`journalers/cc-headless-provisional.ts`): runs the existing headless journaling turn (`HeadlessHandle.journalSession`, `claude -p <prompt> --resume <id>`) for `cc-headless` sessions only; `unavailable` when the instance isn't running, the session has no Claude session yet, or its transcript is gone. Ignores the journaler `model`. S66.6 replaces it. |
| `system-message` | *(part B, S66.8)* |
| `script` | *(part B, S66.7)* |

Until part B registers them, only `cc-headless` sessions can be journaled. A chain on any other runtime reports `unavailable` for every entry and exhausts. Leave `agents.<id>.journaling` unset for those agents until then.

## Chain runner and outcomes

`runChain()` walks the configured chain, skipping statically incompatible entries. Per entry: not registered or wrong kind → `unavailable`; `canJournal` false → `unavailable`; otherwise `run()` (a throw, or not settling within 3× the timeout, is `failed-after-start`). One `journal_runs` row per attempt, with `fallback_from` set to the previous attempt's journaler.

- `done` / `nothing-to-do` stop the chain: the cursor advances, the pending trigger and attempt counter clear, snapshots are marked consumed, the agent's exhaustion streak resets, and `journaling:chain-exhausted` resolves.
- `unavailable` / `failed-before-start` / `failed-after-start` move to the next journaler.
- **Exhausted**: the cursor stays. The window's attempt counter and the agent's streak go up, and `journaling:chain-exhausted` is raised as `warning`, escalating to `critical` after 3 consecutive exhaustions or when the backlog is 24 h old.
- Partial writes from a failed attempt are not rolled back.

## Observability

- One structured log line per run: `[journaling] {"run_id":…,"agent":…,"trigger":…,"outcome":…,"journaler":…,"attempts":[…],…}`.
- `journal_runs` columns: `run_id`, `agent_id`, `session_id`, `conversation_id`, `kind`, `trigger`, `journaler`, `chain_position`, `fallback_from`, `outcome`, `error` (truncated to 500 chars), `fidelity` (`bus-transcript | snapshot | full-session`), `window_from`, `window_to`, `message_count`, `started_at`, `duration_ms`, `files_changed`, `notes`, `cost_usd`, `input_tokens`, `output_tokens`.
- `/journal`, `/journal runs [n]`, `/journal now`, `GET /api/v1/journal/runs` and the health summary *(part B, S66.10)*.

## Advisories

| Condition | Severity | Raised when |
|---|---|---|
| `journaling:chain-can-exhaust` | info | Startup: the last runnable journaler is not `script` |
| `journaling:chain-exhausted` | warning → critical | A run exhausted the chain; critical after 3 in a row or 24 h of backlog |
| `journaling:hook-stopped:turn-ended` | warning | A turn-ended hook that used to report went quiet |

All resolve themselves when the condition clears. See [ADVISORIES.md](ADVISORIES.md).

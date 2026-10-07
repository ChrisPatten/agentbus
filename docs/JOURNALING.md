# Journaling (E66)

> **Status: E66 complete (S66.1–S66.11).** Consolidation, feedback signals and self-edit proposals are E68 ([AGENT_LEARNING.md](AGENT_LEARNING.md)); the native memory layout and `recent.md` are E67. User-facing guide: `site-docs/features/journaling-and-memory.md`.

Journaling has two parts. **Triggers** decide *when* the bus looks at a conversation. **Journalers** decide *who* updates the agent's memory. One engine serves every agent runtime (`cc-headless`, `cc-pool`, `claude-code`, polled harnesses).

Code: `src/journaling/` (`config.ts`, `eligibility.ts`, `store.ts`, `engine.ts`, `runner.ts`, `registry.ts`, `events.ts`, `advisories.ts`, `types.ts`, `status.ts`, `process.ts`, `prompt.ts`, `memory-diff.ts`, `delivery.ts`, `journalers/{cc-headless,script,system-message}.ts`), `src/commands/journal.ts`, `src/pipeline/stages/journal-hold.ts`, `src/mcp/tools/journal.ts`, `scripts/journalers/claude-p-journal.sh`, `scripts/hooks/agentbus_journal_hook.sh`. Migration 026. Design record: `_bmad-output/planning-artifacts/journaling/decisions.md`.

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
| `model` | the runtime instance's `model` | Model for journal runs (`cc-headless` passes `--model`; `script` gets `AGENTBUS_MODEL`). `system-message` uses the live agent's own model |
| `prompt` | built-in journaling prompt | Journaling instruction |
| `system-message.{timeout_ms,prompt}` | inherit | Per-journaler overrides (`model` is accepted but unused: the live agent keeps its model) |
| `cc-headless.{model,prompt}` | inherit | Per-journaler overrides |
| `script.{command,args,timeout_ms,env,model}` | — | Script journaler (required when `script` is in the chain) |
| `consolidation.{enabled,cron,timezone,max_memory_lines,timeout_ms,prompt}` | on, `0 3 * * *` | E68 consolidation pass ([AGENT_LEARNING.md](AGENT_LEARNING.md#consolidation)) |

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

> E68: an unconsumed `/feedback` or denied approval for the conversation makes the session eligible regardless of `min_human_messages` ([AGENT_LEARNING.md](AGENT_LEARNING.md#session-jobs)).

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
| `clear` | Bus `/clear` (on cc-pool it also detaches and clears the pane), or the harness `clear` event |
| `evict`, `release` | `PoolManager` LRU eviction and hard-idle release, through `setReleaseHook`. On `release` the pane is cleared only after the run (bounded by the journaling timeout). On `evict` the pane is released at once and the run proceeds in the background from the on-disk transcript (`cc-headless --fork-session`, `script`); see [CC_POOL_ADAPTER.md](CC_POOL_ADAPTER.md#session-tracker-interaction) |
| `pre-compact`, `session-end` | Harness hook events |
| `shutdown` | Bus shutdown (see below) |
| `manual` | `/journal now` |
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

**Hook script.** `scripts/hooks/agentbus_journal_hook.sh` maps Claude Code's `Stop` → `turn-ended`, `PreCompact` → `pre-compact`, `SessionEnd` → `session-end` (reason `clear` → `clear`). It has no per-deployment constants. Environment: `AGENTBUS_URL` (default `http://127.0.0.1:3000`), `AGENTBUS_BUS_TOKEN` (or the older `AGENTBUS_TOKEN`, or `AGENTBUS_TOKEN_FILE`), sent as `X-Bus-Token` through curl's stdin so it never shows in the process list, `AGENTBUS_SNAPSHOT_DIR` (default `~/.agentbus/journal-snapshots`), `AGENTBUS_SNAPSHOT_LINES` (default 2000). Needs `jq` and `curl`; always exits 0. Example `.claude/settings.json`:

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

**Hook health** (`hookHealth()`): for each event the runtime declares in `hookEvents`, `ok`, `never-seen`, `stopped`, `unverifiable` (rare events not seen yet) or `idle`. Only `turn-ended` can be judged by its absence. A `turn-ended` hook that used to report and has been quiet for 10 min while the agent keeps answering raises `journaling:hook-stopped:turn-ended` (`warning`); it resolves when the hook reports again. A hook that was never seen raises nothing, because hooks are optional. `/journal` shows hook health.

## Journalers

```ts
interface Journaler {
  id: 'system-message' | 'cc-headless' | 'script';
  requires: RequiredCapability[];      // static, checked at load and before each attempt
  supportsKinds: ('session' | 'consolidate')[];
  canJournal(job): { ok: true } | { ok: false; reason }; // cheap, side-effect free; live checks
  run(job, { signal }): Promise<{ outcome, error?, fidelity?, filesChanged?, notes?, costUsd?, inputTokens?, outputTokens? }>;
}
```

Outcomes: `done`, `nothing-to-do`, `unavailable`, `failed-before-start`, `failed-after-start`. `signal` aborts when the chain runner's settle timeout (3× `timeout_ms`) fires; a journaler must then stop its work (the built-in ones kill their process group or close their hold). Register with `JournalerRegistry.register()`; registering an id again replaces the earlier journaler.

The job (`JournalJob`, `src/journaling/types.ts`) carries ids (run, agent, pane, session, conversation, Claude and harness session), runtime kind, working and memory dirs, channel, contact, topic, trigger, the window (`cursorAt`, `from`, `to`, `advanceTo`), `messages[]` (author with `is_human` / `is_owner` / `is_agent`, attachments by path, `scheduled`, `context`), `snapshots[]`, `harnessTranscriptPath`, prompt, model, timeout and the agent's full settings.

| Journaler | Status |
|---|---|
| `cc-headless` | See [cc-headless journaler](#cc-headless-journaler). |
| `system-message` | See [System Message journaler](#system-message-journaler). |
| `script` | See [Script journaler](#script-journaler). |

### System Message journaler

Asks the live agent to journal in its own session, with full context (`fidelity: full-session`). Code: `journalers/system-message.ts`, `delivery.ts`, `pipeline/stages/journal-hold.ts`.

**Instruction.** A system-only turn in the conversation, through the normal pipeline (so a cc-pool conversation reaches its leased pane), fanned out only to the journaled agent, carrying an E65 system block:

```
<agentbus-system kind="journal" run_id="…">
AgentBus journal run … (trigger: pause).
<journaling prompt>
New since the last journal: 3 message(s) from people (…).
Until this run ends, new messages to you are held and your outbound messages are blocked, so do not reply to anyone.
When you are done, call the journal_complete tool with run_id "…", the files you changed and a one-line note. If nothing was worth recording, call it with nothing_new: true.
The run times out after 5 minutes.
</agentbus-system>
```

The turn's body (`[AgentBus journal run …]`) is logged to the transcript with `system_only` and `journal_run_id` and hidden from user-facing views. Advisories are not injected into it (the agent couldn't relay them). Agent jobs with no conversation (E68 consolidation) go to the agent's default conversation, its first owner's `general` conversation.

**`canJournal`.** `systemMessages` (static), `liveAgent` and `exclusiveSession` checked live for the conversation (on cc-pool: a pane is leased to it), an open session (after `/clear` or close the live context is gone, so the chain moves on), no other System Message run for the agent, and an **idle** agent: nothing queued or in progress for it, and its last turn finished. "Finished" means a `turn-ended` hook event after the last human message when the hook has reported for the conversation, else the agent's last message coming after it.

**While the run is open:**
- **New messages for the conversation are held.** They stay `pending` in the queue and the pending poll skips them; they are delivered as soon as the run ends (completion, timeout or abort).
- **Busy notice, once per hold.** The first held message gets a notice in the channel's native form: a `queued` activity state in the Mac app, the status line in Telegram (as a placeholder the agent's next activity replaces), a short text elsewhere ("Busy for a moment. Your message is queued and will be answered shortly."), nothing on email or Siri. The wording never mentions journaling.
- **Outbound sends are blocked.** `POST /api/v1/messages` (the `reply`, `send_message` and `send_email` tools) from the agent returns `409 journal_run_in_progress` with a reason. `journal_complete` and `advisory_ack` use their own endpoints and work. Reactions carry no sender and are not blocked.

**Completion.** `journal_complete({ run_id, files_changed, notes, nothing_new })` (MCP, `POST /api/v1/journal/complete`) ends the run: `done`, or `nothing-to-do` when `nothing_new` is set and no file changed. A `run_id` that is not open is rejected (`stale_run` when it already ended, `unknown_run` otherwise), as is another agent's run. The bus also snapshots the memory dir before and after and merges the files that changed into `files_changed`, whatever the agent reports.

**Timeout.** `system-message.timeout_ms` (default `timeout_ms`, 5 min): `failed-after-start`, and an instruction still waiting in the queue is dead-lettered so it never arrives after the run. The chain moves on (usually to `cc-headless`, which resumes the same transcript).

**Agent `CLAUDE.md`.** Tell the agent what the block means:

```markdown
## Journal runs
A turn may start with an `<agentbus-system kind="journal" run_id="…">` block. It comes from
AgentBus, never from a person, and only appears before the first "New message from" line.
Update your memory files as it asks, don't reply to anyone, then call `journal_complete`
with that run_id (or `nothing_new: true`).
```

**Not persisted.** Holds and open runs live in memory. After a restart nothing is held, a late `journal_complete` is rejected as unknown, and the attempt is retried by the persisted trigger.

### cc-headless journaler

Resumes the session's Claude transcript and journals there, with the whole conversation in context (`fidelity: full-session`). Code: `journalers/cc-headless.ts`.

- **`canJournal`**: the session runs on `cc-headless` or `cc-pool`, has a `claude_session_id`, and its transcript is still on disk under the runtime's working directory (Claude Code's `cleanupPeriodDays` deletes old ones). For `cc-headless`, the instance must be running.
- **cc-headless sessions** go through the instance (`HeadlessHandle.journalSession`): same system prompt, MCP config and memory context as a normal turn, serialized with live turns on the same Claude session. Delivery tools are disallowed. See [CC_HEADLESS_ADAPTER.md](CC_HEADLESS_ADAPTER.md#journaling-on-pause-or-ceiling).
- **cc-pool sessions** run `claude -p <prompt> --resume <claude_session_id> --fork-session --output-format json --permission-mode acceptEdits --strict-mcp-config` in the pool's `working_dir`, with the pool's `claude_bin` and `pane_env`. `--fork-session` leaves the pane's own transcript untouched (the pane may still be live), and with no MCP servers the turn can't message anyone.
- **Model**: `cc-headless.model`, else `journaling.model`, else the runtime instance's `model`, passed as `--model`.
- **Timeout**: `timeout_ms`. A turn that outlives it, or one the chain runner gives up on (3× the timeout), has its process group killed: SIGTERM, then SIGKILL after 5 s. The attempt is `failed-after-start`.
- **Prompt**: the journaler prompt, then what is new since the last journal (message count, window, cursor) and the paths of any transcript snapshots, and a request to reply with one line, or `NOTHING_TO_RECORD` when nothing was worth keeping (`nothing-to-do`).
- **Cost and tokens** come from the CLI result event (`total_cost_usd`; input tokens include cache reads and writes).

### Script journaler

Runs your own executable with the job as JSON on stdin. It needs nothing from the runtime, so it can always run: end every chain with it. Code: `journalers/script.ts`.

```yaml
journaling:
  script:
    command: /Users/me/agentbus/scripts/journalers/claude-p-journal.sh  # absolute, or relative to the agent's working_dir
    args: []
    timeout_ms: 300000          # default: journaling.timeout_ms
    env: { CLAUDE_BIN: /opt/homebrew/bin/claude }
    model: claude-sonnet-4-6    # default: journaling.model, else the runtime model
```

**Execution.** The command runs directly, never through a shell, with the agent's `working_dir` as cwd (your home directory for runtimes without one). It leads its own process group. `canJournal` checks the command is an executable file.

**Environment.** Only `PATH` and `HOME` from the bus, these variables, and your `env` (which wins):

| Variable | Value |
|---|---|
| `AGENTBUS_PAYLOAD_VERSION` | `1` |
| `AGENTBUS_RUN_ID`, `AGENTBUS_AGENT_ID`, `AGENTBUS_TRIGGER`, `AGENTBUS_JOB_KIND` | Run id, prefixed agent id, trigger, `session` or `consolidate` |
| `AGENTBUS_CONVERSATION_ID`, `AGENTBUS_SESSION_ID` | Bus ids |
| `AGENTBUS_MEMORY_DIR`, `AGENTBUS_WORKING_DIR` | Empty when the runtime has none |
| `AGENTBUS_MODEL` | The journaler model, when set |
| `AGENTBUS_URL` | Bus base URL |

The bus's own environment (API keys, `bus.auth_token`) is not passed. If your script calls the bus and `bus.auth_token` is set, add `AGENTBUS_BUS_TOKEN` to `env` and send it as `X-Bus-Token`. If `claude` needs more of your login environment on your machine (for example `USER`), add it to `env` too.

**stdin** (`ScriptPayloadV1`):

```json
{
  "version": 1, "kind": "session",
  "run_id": "…", "trigger": "pause", "agent_id": "agent:baxter", "session_agent_id": "agent:baxter", "runtime": "cc-headless",
  "working_dir": "/agents/baxter", "memory_dir": "/agents/baxter/memory",
  "conversation_id": "…", "session_id": "…", "claude_session_id": "…", "harness_session_id": null, "harness_transcript_path": null,
  "channel": "telegram", "contact_id": "chris", "topic": "general", "session_open": true,
  "window": { "cursor_at": null, "from": "…", "to": "…" }, "human_message_count": 2,
  "messages": [{
    "id": "…", "message_id": "…", "created_at": "…", "direction": "inbound",
    "author": { "id": "chris", "is_human": true, "is_owner": true, "is_agent": false },
    "body": "…", "attachments": [{ "type": "image", "path": "/…/photo.jpg", "mime_type": "image/jpeg" }],
    "scheduled": false, "context": false
  }],
  "snapshots": [{ "id": "…", "event": "pre-compact", "path": "/…/snap.jsonl", "created_at": "…" }],
  "protected_paths": ["/agents/baxter/CLAUDE.md", "/agents/baxter/skills/"],
  "feedback": [{ "id": "…", "kind": "user-feedback", "created_at": "…", "text": "Use 24-hour time.", "ref_message_id": "…", "contact_id": "chris", "detail": { "channel": "telegram" } }],
  "prompt": "…", "model": "claude-sonnet-4-6", "timeout_ms": 300000
}
```

`protected_paths` (E68) lists the agent's protected files and directories (absolute; directories end in `/`): don't edit them; the bus hashes them around the run and warns the owners about unapproved changes ([AGENT_LEARNING.md](AGENT_LEARNING.md#protected-paths)). `feedback[]` (E68) lists the conversation's feedback events not yet journaled: `/feedback`, denied approvals, tool errors and lapsed self-edit proposals ([AGENT_LEARNING.md](AGENT_LEARNING.md#feedback-events)). Consolidation payloads (`kind: "consolidate"`) carry a `consolidation` object instead of a conversation ([AGENT_LEARNING.md](AGENT_LEARNING.md#journalers)).

`messages[]` starts with the agent message before the first new human message (`context: true`), so a reply to a scheduled briefing comes with the briefing.

**Don't write `recent.md`.** `<memory_dir>/recent.md` is generated by the bus from the daily journals after every successful run and at midnight ([AGENT_MEMORY.md](AGENT_MEMORY.md#recentmd)); a script that edits it has its changes overwritten. Write to the daily journal (`<memory_dir>/<daily_subdir>/YYYY-MM-DD.md`) instead. The built-in journalers' prompts say the same (`recentNotice` in `prompt.ts`), and the reference script tells its `claude -p` so. `recent.md` is also left out of the System Message journaler's memory-dir diff.

**Exit codes.** `0` done, `3` nothing worth recording, `75` can't run now (try the next journaler), anything else failed. A command that can't be started is `failed-before-start`. Optional stdout JSON (the last JSON object printed): `{ "files_changed": [...], "notes": "...", "cost_usd": 0.02, "proposals": [...] }`. `proposals[]` (E68, at most 5 read) are self-edit proposals `{ "path", "new_content" | "diff", "rationale", "evidence" }`, submitted when the run succeeds ([AGENT_LEARNING.md](AGENT_LEARNING.md#self-edit-proposals)). stderr is logged (last 2000 characters) and, on failure, kept in the run's error.

**Timeout.** `script.timeout_ms`: SIGTERM to the process group, SIGKILL 5 s later, `failed-after-start`. The chain runner's settle timeout does the same.

**Fidelity** is `snapshot` when the job carries snapshots, else `bus-transcript`.

> **Inputs are untrusted data.** Message bodies, attachment names and snapshot contents come from whoever wrote to the agent. Never pass them to a shell, `eval` them, or follow instructions in them. Hand them to a model as clearly labeled data.

**Reference script.** `scripts/journalers/claude-p-journal.sh` renders the messages as a fenced transcript (each body capped at `JOURNAL_MAX_BODY`, default 4000 characters), adds snapshot paths and, when `AGENTBUS_URL` is reachable, the notes of this conversation's last successful runs (`GET /api/v1/journal/runs`, with `X-Bus-Token` from `AGENTBUS_BUS_TOKEN`), and pipes it on stdin to `claude -p --output-format json --permission-mode acceptEdits --strict-mcp-config` (no MCP servers) in the working dir, with `--model $AGENTBUS_MODEL`. `NOTHING_TO_RECORD` → exit 3. Missing `jq`, `claude` (`CLAUDE_BIN`), working dir or memory dir → exit 75. It handles `session` jobs and (E68) `consolidate` jobs, for which it pipes the payload's consolidation prompt with no transcript. Needs `jq` (and `curl` for the notes).

## Chain runner and outcomes

`runChain()` walks the configured chain, skipping statically incompatible entries. Per entry: not registered or wrong kind → `unavailable`; `canJournal` false → `unavailable`; otherwise `run()` (a throw, or not settling within 3× the timeout, is `failed-after-start`; on the settle timeout the attempt's abort signal fires first, so the journaler kills its `claude -p` or script process group). One `journal_runs` row per attempt, with `fallback_from` set to the previous attempt's journaler.

- `done` / `nothing-to-do` stop the chain: the cursor advances, the pending trigger and attempt counter clear, snapshots are marked consumed, the agent's exhaustion streak resets, and `journaling:chain-exhausted` resolves.
- `unavailable` / `failed-before-start` / `failed-after-start` move to the next journaler.
- **Exhausted**: the cursor stays. The window's attempt counter and the agent's streak go up, and `journaling:chain-exhausted` is raised as `warning`, escalating to `critical` after 3 consecutive exhaustions or when the backlog is 24 h old.
- Partial writes from a failed attempt are not rolled back.

## Observability

- **`/journal`** shows, for the conversation it is sent from: last journaled, messages from people waiting (and whether that is below `min_human_messages`), a pending final trigger, a run in progress or holding the conversation. For its agent: the chain (and entries its runtime can't run), last success, failed runs in a row, last failure, backlog, hook health (`ok`, `never-seen`, `stopped`, `unverifiable`, `idle`) and open journaling advisories. Then a `Memory (<dir>):` section (E67): how memory loads, whether `CLAUDE.md` imports `recent.md`, and memory setup warnings ([AGENT_MEMORY.md](AGENT_MEMORY.md#setup-checks)).
- **`/journal runs [n]`**: the agent's last `n` attempts (default 5, max 20), with trigger, journaler, `fallback_from`, outcome, fidelity, cost and the error or note.
- **`/journal consolidate`** (E68): a manual consolidation pass for the conversation's agent ([AGENT_LEARNING.md](AGENT_LEARNING.md#consolidation)). `/journal` also shows the last and next pass.
- **`/journal now`**: trigger `manual` for the conversation's session. Bypasses the pause threshold, `min_human_messages` and the attempt cap; respects the cursor (nothing new → "Nothing new to journal").
- **`GET /api/v1/journal/runs?agent=…&conversation=…&session=…&limit=…`** returns `journal_runs` rows (see [HTTP_API.md](HTTP_API.md#get-apiv1journalruns)).
- **`/api/v1/health`** has a `journaling` object: per agent backlog age (oldest unjournaled eligible content), backlog sessions, consecutive exhaustions, last success and failure, in-flight; overall `status` `ok`, `warning` (an exhausted run) or `critical` (3 in a row, or 24 h of backlog). `critical` makes the top-level health `status` `degraded` (post-E66 decision); `warning` doesn't.
- **One structured log line per run**: `[journaling] {"run_id":…,"agent":…,"session":…,"conversation":…,"trigger":…,"outcome":"done|nothing-to-do|exhausted","journaler":…,"attempts":["system-message:unavailable","cc-headless:done"],"window":[…],"messages":…,"human":…,"snapshots":…,"duration_ms":…,"fidelity":…,"files_changed":…,"cost_usd":…}`. Script stderr is logged on its own line.
- **`journal_runs`** columns: `run_id`, `agent_id`, `session_id`, `conversation_id`, `kind`, `trigger`, `journaler`, `chain_position`, `fallback_from`, `outcome`, `error` (truncated to 500 chars), `fidelity` (`bus-transcript | snapshot | full-session`), `window_from`, `window_to`, `message_count`, `started_at`, `duration_ms`, `files_changed`, `notes`, `cost_usd`, `input_tokens`, `output_tokens`. Swept after 90 days.

## Advisories

| Condition | Severity | Raised when |
|---|---|---|
| `journaling:chain-can-exhaust` | info | Startup: the last runnable journaler is not `script` |
| `journaling:chain-exhausted` | warning → critical | A run exhausted the chain; critical after 3 in a row or 24 h of backlog |
| `journaling:hook-stopped:turn-ended` | warning | A turn-ended hook that used to report went quiet |
| `journaling:consolidation-exhausted` | warning | A consolidation pass (E68) exhausted the chain |

All resolve themselves when the condition clears. See [ADVISORIES.md](ADVISORIES.md).

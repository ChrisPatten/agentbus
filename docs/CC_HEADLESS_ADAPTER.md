# Headless Claude Code adapter

`src/adapters/cc-headless.ts` runs the agent as on-demand `claude -p` invocations instead of a persistent Claude Code session. It is an in-process adapter: it runs inside bus-core, has direct database access, and drives `claude -p` subprocesses itself. Each inbound message batch spawns a fresh invocation. Continuity comes from `--resume` and from the agent's own memory files.

```
bus-core
  └── cc-headless instance (one per configured agent)
        ├── polls GET /api/v1/messages/pending?agent=<agent_id>
        ├── serializes work per contact
        ├── spawns: claude -p <prompt> --output-format stream-json --verbose
        │           --allowedTools all --mcp-config <tmp> --system-prompt-file <tmp>
        │           [--model <model>] [--resume <claude_session_id>]
        │     └── MCP subprocess: src/adapters/cc.ts with AGENTBUS_TOOLS_ONLY=true
        └── watches the stream for reply/send_message tool calls; falls back to stdout
```

Compared with a persistent session, headless gives per-contact isolation (each contact has its own Claude conversation), no session to keep alive by hand, and memory injection that the bus controls. The trade-off is that the agent cannot see another contact's conversation. See [Cross-contact isolation](#cross-contact-isolation).

## Session continuity (long-lived sessions)

`sessions.claude_session_id` (migration 008) stores the session ID that `claude -p` reports in its stream-json events. Later turns pass `--resume <id>`.

Resume is keyed on `conversation_id`. The adapter resolves the batch's `conversation_id` from the first message's transcript row, falling back to `sha256(sorted([contact_id, channel, topic]))` if the row is missing, and looks up the open session for that conversation. Each email thread or Telegram forum topic therefore resumes its own session, and a plain Telegram conversation resumes the same one every time.

Headless sessions are never closed on idle. `claude_session_id` is set only by this adapter, so it also marks a session as headless-managed: the transcript-log stage and the `SessionTracker` extend such sessions across any gap instead of closing them. Sessions from the polling MCP adapter (`claude_session_id IS NULL`) still close on idle and fire `on_session_close`. If you want this same per-conversation session model backed by a real interactive session instead of `claude -p` batches, see [CC_POOL_ADAPTER.md](CC_POOL_ADAPTER.md).

Nothing in AgentBus bounds a long-lived transcript; Claude Code's auto-compaction does, and it is on by default in `-p` mode. Do not set `DISABLE_AUTO_COMPACT=1`.

## `claude -p` invocation

- `--output-format stream-json --verbose`: the CLI requires `--verbose` with stream-json in print mode. It does not change the event stream.
- `--allowedTools all`.
- `--mcp-config <tmp>`: a temporary file that launches `src/adapters/cc.ts` in tools-only mode with the same `AGENTBUS_CONFIG`.
- `--system-prompt-file <tmp>`: replaces the default coding-agent prompt. `CLAUDE.md` auto-loading is unaffected.
- `--model <model>`: only when a model resolves. See [Runtime model overrides](#runtime-model-overrides).
- `--resume <id>`: when the session has a `claude_session_id`.

Temp files are written immediately before the spawn and deleted after the result is captured. The process runs with `cwd` set to `working_dir` and with `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, because the adapter already injects the agent's memory files through `{{memories}}` and the CLI's own auto-memory would load `MEMORY.md` a second time.

### Runtime model overrides

The `headless_model_overrides` table (migration 015) lets an agent change the model without editing `config.yaml` or restarting. `resolveModelOverride()` (`src/adapters/model-override-loader.ts`) runs on every spawn and returns the first match in this order:

1. `schedule_id` and `agent_id`
2. `agent_id` only
3. `schedule_id` only
4. Global (both `NULL`)

Ties within a scope break on `priority` (higher wins), then `updated_at` (newest wins). A match overrides `adapters.cc-headless.model`. No match falls through to it, and then to the CLI's own default or a `model` key in `working_dir/.claude/settings.json`.

`agent_id` is the full recipient ID, for example `agent:claude`, not the bare `agent_id` config value. `schedule_id` is not passed from scheduled turns yet, so schedule-scoped overrides never match. Manage overrides through `POST`, `GET`, and `DELETE /api/v1/model-overrides` ([HTTP_API.md](HTTP_API.md#model-overrides)) or the `set_headless_model`, `get_headless_model`, `list_headless_model`, and `delete_headless_model` tools ([MCP_TOOLS.md](MCP_TOOLS.md#model-overrides)). The `POST` route has a known bug that makes every write fail; see `_bmad-output/maintenance-backlog.md`.

### MCP config file

```json
{
  "mcpServers": {
    "agentbus": {
      "type": "stdio",
      "command": "npx",
      "args": ["tsx", "/abs/path/to/agentbus/src/adapters/cc.js"],
      "env": { "AGENTBUS_TOOLS_ONLY": "true", "AGENTBUS_CONFIG": "/path/to/config.yaml" }
    }
  }
}
```

The path is resolved from the bus-core working directory; `tsx` maps the `.js` extension to the `.ts` source. Tools-only mode skips the polling loop and only serves tool calls. See [CC_ADAPTER.md](CC_ADAPTER.md).

## Tools available to Claude

Every tool except `get_adapter_status`, which has no meaning without a poll loop. See [MCP_TOOLS.md](MCP_TOOLS.md) for inputs and outputs.

| Tool | Notes |
|---|---|
| `reply`, `send_message` | The agent's delivery path. The adapter watches the stream for these calls |
| `send_email` | When an email adapter is configured |
| `react_to_message` | Fires mid-stream, so an emoji can land before the reply |
| `create_telegram_topic` | When a Telegram adapter is configured |
| `list_channels`, `get_session`, `list_sessions`, `get_transcript`, `search_transcripts`, `fetch_attachment` | Discovery and history |
| `schedule_message`, `list_schedules`, `cancel_schedule` | Scheduling |
| `set_headless_model`, `get_headless_model`, `list_headless_model`, `delete_headless_model` | Model overrides |
| `recall_memory`, `log_memory` | Legacy. Read and write your memory files instead |

## Response delivery

The agent owns delivery through `reply` and `send_message`. This lets it reason privately, send interim updates, and send several messages. The adapter watches `assistant` events for `tool_use` blocks named `mcp__agentbus__reply` or `mcp__agentbus__send_message`; each call posts its own outbound envelope as it executes.

If the turn ends and no delivery tool was called, the adapter posts the final `result` text as one outbound message to the original sender on the original channel and topic. The `system_prompt` must still tell the agent to reply through the tool: once any delivery tool call is seen, later stdout text is not delivered.

Each turn's `total_cost_usd`, token usage, and turn count from the terminal `result` event are written to `turn_costs` for the `/cost` command.

## Typing indicator and tool-call status

When a batch starts, the adapter calls `POST /api/v1/adapters/<channel>/typing` with the contact and topic, so the platform shows activity while `claude -p` starts. Each non-delivery tool call in the stream is summarized (`src/adapters/tool-call-summary.ts`) and sent to `POST /api/v1/adapters/<channel>/tool-status` until the first delivery call. Both are fire-and-forget, no-op on channels without the capability, and skipped for email. See [TELEGRAM_ADAPTER.md](TELEGRAM_ADAPTER.md#live-tool-call-status-stream).

## Failure handling

If the invocation errors, exits non-zero with no result, or yields no text, and the agent delivered nothing through a tool, the adapter sends `error_reply` to the contact. The underlying error is logged. If the agent already delivered, the error is only logged.

`error_passthrough: true` appends the raw detail (exit code, stderr tail, or the CLI's error text) to `error_reply`, truncated to 500 characters. Leave it off in production; raw errors can expose file paths and internals.

A turn killed by `/stop` sends nothing. See [SLASH_COMMANDS.md](SLASH_COMMANDS.md#stop).

## System prompt

`adapters.cc-headless.system_prompt` is a template. Available variables:

| Variable | Value |
|---|---|
| `{{contact_id}}` | For example `contact:alice` |
| `{{channel}}` | For example `telegram:peggy` |
| `{{date}}` | Local date, `YYYY-MM-DD` |
| `{{memories}}` | Empty for a turn with a real, resumable session — memory blocks go into the user turn instead. Falls back to the assembled memory files when there's no session to track. See [Context assembly](#context-assembly-memory-files) |
| `{{agent_id}}` | For example `agent:claude` |
| `{{session_summary}}` | Deprecated. Always empty |

After variable substitution, `@<path>` tokens are replaced with the referenced file's contents, resolved relative to `working_dir` (`expandFileReferences` in `src/adapters/prompt-renderer.ts`). Unknown variables and unreadable paths are left verbatim so mistakes are visible. Expansion runs only on this operator-authored template, never on user messages.

The user message is formatted by `formatMessagesForSampling` (`src/adapters/cc.ts`) with `includeMemoryContext: false`, so the legacy `<memory>` block is not also prepended.

## Context loading (`CLAUDE.md` and file references)

`claude -p` loads the `CLAUDE.md` hierarchy for its working directory (project, parents, and `~/.claude`) and expands their `@import`s. Set `working_dir` to the agent's home directory and keep its persona there. The default, the bus-core working directory, is usually not what you want. `@path` references in `system_prompt` resolve against the same directory.

## Context assembly (memory files)

The agent's memory files are read fresh on every turn by `assembleMemoryBlocks` (`src/adapters/memory-context.ts`):

1. `<working_dir>/<memory.dir>/<memory.index_file>` (default `memory/MEMORY.md`).
2. Daily journal files for today and the previous `journal_lookback_days - 1` days at `<memory.dir>/<memory.daily_subdir>/YYYY-MM-DD.md`, newest first.

Each file becomes a block wrapped in a `=== <relative path> ===` marker. Missing files are skipped. `journal_lookback_days: 0` loads the index only. Daily file names use the local date. `assembleMemoryContext` joins all blocks into one string and remains for callers (and the no-session fallback below) that want that; it is no longer what fills the system prompt on a resumed session. Because the blocks are read fresh every turn, a journaling update is visible on the next turn.

### Per-session context-block ledger

`{{memories}}` used to be re-interpolated into the system prompt on every turn, which sits at the front of the cache prefix (tools → system → messages). Because `{{memories}}` (and `{{date}}`) changed every render, the cached prefix was busted on effectively every turn, and the same memory-file content was resent in full every turn even though the resumed session's own transcript already had it from a prior turn.

`context_blocks` (migration 017) and `src/adapters/context-ledger.ts` fix the resend problem for real, resumable sessions:

- Each memory file from `assembleMemoryBlocks` is hashed (`hashBlock`, sha256) and keyed as `memory:<dir>/<index_file>` or `memory:<dir>/<daily_subdir>/<YYYY-MM-DD>.md`.
- `runClaudeTurn` (`cc-headless.ts`) only prepends a block to the **user turn** (not the system prompt) when `shouldSendBlock` says its hash is new or has changed for that session — so each block's content is sent at most once per session, not once per turn.
- Once the turn completes successfully, `markBlockSent` records the hash for every block that was sent, in the same success path as `persistSessionId`/`recordCost`.
- The system prompt no longer carries `{{memories}}` for a session with a real, resumable session row (`opts.session !== null`): it renders with `memories: ''`, the same way `src/pool/pane.ts`'s `renderAndWriteSystemPrompt` already does for pool sessions (for a different reason — pool sessions rely on native `CLAUDE.md` auto-loading). The system prompt is now a frozen cache prefix instead of changing every turn.
- **No-session fallback.** When there's no session row to track a ledger against (`opts.session === null`, e.g. `/clear`'s `journalResumeId`), the adapter falls back to the pre-ledger behavior: the full `assembleMemoryContext` string goes into `{{memories}}` on the system prompt, every turn, same as before this change.

**Compaction detection.** `--resume` transcripts are subject to Claude Code's own auto-compaction (see [Session continuity](#session-continuity-long-lived-sessions)), which can summarize away content the ledger believes is already in context. `detectCompaction` reads the two most recent `turn_costs` rows for the session (`input_tokens IS NOT NULL`, most recent first) and calls it a compaction when the more recent row's `input_tokens` is under `COMPACTION_DROP_THRESHOLD` (0.6) times the older row's — auto-compaction summarization produces a sharp drop that ordinary conversation growth does not. When true, `runClaudeTurn` calls `clearLedger` before assembling blocks for that turn, so everything is resent from scratch. The threshold is deliberately biased toward false positives: a false positive just costs one redundant resend, while a false negative would silently leave the ledger believing content is in context that compaction actually removed.

**`{{date}}` still busts the cache once a day — intentionally.** `{{date}}` remains in the system prompt and still changes the rendered text once per calendar day, which invalidates the cache prefix at that point. This is a known, accepted trade-off: once-a-day cache invalidation is a small, fixed cost, unlike the old once-per-turn invalidation this change eliminates. Making `{{date}}` itself cache-stable is out of scope here.

## Journaling on pause or ceiling

When a conversation goes idle past a per-channel threshold, or too long has passed since its last sweep, the bus fires a silent journaling turn: the agent reviews the conversation and updates its memory files. Nothing is delivered to the user, and the session stays open.

- **Dispatcher.** `SessionTracker.dispatchJournaling()` runs on the tracker tick. It selects open headless sessions not journaled since their last activity (`last_journaled_at IS NULL OR last_journaled_at < last_activity`) and fires when either leg trips:
  - **Idle debounce.** `last_activity` is older than `journaling.threshold_ms` for the session's channel. A short value (3 to 5 minutes) catches a real pause without journaling after every reply.
  - **Hard ceiling.** Time since `last_journaled_at` (or `started_at`) exceeds `journaling.ceiling_ms`, regardless of idle state, so a continuously active conversation still flushes. Unset disables this leg.
- **Overlap suppression.** A conversation with a journaling turn in flight is skipped on later ticks.
- **Turn.** `runJournalingTurn(conversationId)` spawns `claude -p <journaling.prompt> --resume <id>` with the same working directory, MCP config, and memory context as a normal turn, serialized through the same per-contact queue so it never races a live reply. A session with no `claude_session_id` yet is skipped and stamped as journaled.
- **Failure.** A failed turn leaves `last_journaled_at` unchanged so a later tick retries, bounded by an in-memory attempt cap that new activity resets.
- **Ownership.** Each session is routed to the instance recorded in `sessions.agent_id`. See [Multi-instance deployments](#multi-instance-deployments).

The silent turn appends an assistant turn to the resumed transcript; auto-compaction absorbs the cost. If the journaling agent crashes mid-write, the transcript in the bus is unaffected and the next trigger retries.

If no `cc-headless` instance is configured or registered, the dispatcher is a no-op for every session and logs a one-time warning. Set `journaling.enabled: false` to disable it deliberately.

`/clear` forces the same journaling turn immediately after closing the active session. See [SLASH_COMMANDS.md](SLASH_COMMANDS.md#clear).

## Memory logging

Memory-logging work (daily journal, `MEMORY.md`, topic files) belongs to the journaling sweep, not to the turn that answers the user.

1. **The reply-producing turn does not journal.** Do not instruct the agent to update memory files after calling `reply`. The process exits sooner once it stops calling tools.
2. **The debounced sweep journals.** This is the [journaling mechanism](#journaling-on-pause-or-ceiling) above.
3. **Why this is safe.** `--resume` keeps the full conversation, so a delayed sweep risks brief staleness in the files, never data loss. The raw conversation is always recoverable with `get_transcript` and `search_transcripts`.
4. **Queue responsiveness follows.** Because the turn stops at delivery, the per-contact queue advances as soon as the reply is sent. See [Per-contact serialization](#per-contact-serialization).

### High-stakes immediate-logging exception

Some content should never wait on a debounce window. If the turn involves any of the following, the agent should log it immediately, in the same turn:

- Financial decisions or obligations: payments, transfers, new bills, rate or loan decisions.
- Health or medical facts: diagnoses, medication changes, appointment outcomes.
- Scheduling commitments the user has just made.
- Safety- or security-relevant account events: credential changes, suspicious activity, access grants or revocations.

State this directly in the `system_prompt`. See the example in [Configuration schema](#configuration-schema).

## Per-contact serialization

An in-memory `Map<contactId, Promise<void>>` chains each new batch after the previous one for that contact. Different contacts run concurrently; the same contact's messages run in order.

The queue advances at delivery, not at process exit. `processBatch()` resolves as soon as the turn calls `reply` or `send_message`; stdout fallback, error handling, and final session-ID persistence continue in the background. Two consequences:

- A turn that never calls a delivery tool (stdout fallback, spawn error, `/stop`) holds the queue until the whole run settles.
- `claude_session_id` is persisted as soon as it first appears in the stream, so a rapid second message on a brand-new conversation can `--resume` the session the first turn just created.

Two `claude -p` processes for the same `claude_session_id` can overlap briefly if the first keeps calling tools after delivering. This is why the system prompt must stop the agent at delivery.

## Configuration schema

```yaml
adapters:
  cc-headless:
    agent_id: claude          # dequeues agent:claude
    poll_interval_ms: 1000
    claude_bin: claude
    model: sonnet             # optional; unset defers to the CLI default
    working_dir: /home/agent  # cwd for claude -p
    error_reply: "Sorry — I hit an error processing that. Please try again."
    error_passthrough: false
    system_prompt: |
      You are a helpful assistant for {{contact_id}} on {{channel}}.
      Today is {{date}}.

      Deliver every user-facing message by calling the `reply` tool with the
      message id shown as [id:<id>]. Use it for quick "working on it" updates
      and for your final answer. Do not put your answer only in plain text.

      Once you have replied, stop. Do not keep working to update memory files;
      a separate process handles that later. Exception: if what just happened
      is a financial decision or obligation, a health or medical fact, a
      scheduling commitment, or a safety- or security-relevant account event,
      log it to your memory files immediately, in this turn, before you stop.

      @persona.md

      {{memories}}
    memory:
      dir: memory
      index_file: MEMORY.md
      daily_subdir: daily
      journal_lookback_days: 3
    journaling:
      enabled: true
      threshold_ms:
        telegram: 300000        # 5 min
        email: 86400000         # 24 h; threads are slow
        default: 300000
      ceiling_ms: 1800000       # 30 min
      prompt: |
        Our conversation has paused, or it has been a while since the last
        sweep. Review it and update your memory files (today's daily journal,
        MEMORY.md, and any relevant topic files) with anything durable worth
        remembering. Do NOT message the user; this is an internal journaling
        turn, not a reply.
```

| Key | Default | Purpose |
|---|---|---|
| `agent_id` | `claude` | Which `agent:<id>` queue to dequeue |
| `poll_interval_ms` | `1000` | Bus poll cadence |
| `system_prompt` | required | Persona template with `{{vars}}` and `@path` references |
| `claude_bin` | `claude` | Path to the `claude` binary |
| `model` | unset | `--model` for `claude -p`; unset defers to the CLI or `.claude/settings.json` |
| `working_dir` | bus cwd | `cwd` for `claude -p`; selects the `CLAUDE.md` hierarchy and the `@path` base |
| `error_reply` | see above | Sent to the user on invocation failure |
| `error_passthrough` | `false` | Append the raw failure detail (500 characters max) to `error_reply` |
| `memory.dir` | `memory` | Memory directory, relative to `working_dir` |
| `memory.index_file` | `MEMORY.md` | Loaded into every turn |
| `memory.daily_subdir` | `daily` | Daily journal files `YYYY-MM-DD.md` |
| `memory.journal_lookback_days` | `3` | Days of journal to load (today plus N-1) |
| `journaling.enabled` | `true` | Master switch |
| `journaling.threshold_ms` | `{ default: 1800000 }` | Per-channel idle debounce; a number, or a map with a required `default` |
| `journaling.ceiling_ms` | unset | Hard ceiling since the last sweep, regardless of idle state |
| `journaling.prompt` | see schema | Prompt for the silent journaling turn |

## Multi-instance deployments

`adapters.cc-headless` accepts either a single object (one implicit instance) or a named record with one entry per headless agent:

```yaml
adapters:
  cc-headless:
    peggy:
      agent_id: peggy
      working_dir: /home/peggy
      system_prompt: |
        You are Peggy...
    pokeclaude:
      agent_id: pokeclaude
      working_dir: /home/pokeclaude
      system_prompt: |
        You are pokeclaude...
```

Instance names must match `^[a-z0-9_-]+$` and `agent_id` must be unique. `getCcHeadlessInstances()` (`src/config/schema.ts`) rejects duplicates at startup and normalizes both forms into one list.

**Runtime isolation.** Each entry is its own `HeadlessInstance` with a private poll timer, per-contact queue, working directory, and config. `startHeadless(db)` starts one poller per instance and returns a `Map<string, HeadlessHandle>` keyed by `agent:<agent_id>`; `stopHeadless()` stops them all.

**Session ownership.** Migration 011 adds `sessions.agent_id`, set by the transcript-log stage from the route that created the session. The journaling dispatcher, `/clear`, `/stop`, and `/cost` use it to find the owning instance. Sessions with `agent_id IS NULL` (created before migration 011, or by a single-instance deployment) fall back to the sole configured instance when there is exactly one. With several instances, such a session is skipped rather than guessed.

## Cross-contact isolation

Each contact gets an isolated Claude conversation, because `--resume` is keyed to that contact's session. The headless agent cannot reference another contact's conversation; continuity across contacts comes only from the shared memory files. This is a deliberate trade-off:

- **Headless**: stronger per-user isolation. Good for multi-tenant or privacy-sensitive use.
- **Persistent session** ([CC_ADAPTER.md](CC_ADAPTER.md), polling mode): one context window sees every contact's messages. Good when one operator wants the agent to reason across all their conversations.

## What does not change

- Platform adapters are unaffected.
- Sessions from the polling MCP adapter (`claude_session_id IS NULL`) keep their idle teardown, the `on_session_close` hook, and, with `memory.structured_extraction: true`, the summarizer.
- Every MCP tool stays registered. The structured memory tools are marked legacy, not removed.

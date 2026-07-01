# Headless Claude Code Adapter (E19, refined in E19.1, E20)

Reference for the per-request Claude Code adapter that replaces long-lived tmux sessions with on-demand `claude -p` invocations.

> **E19.1 changes:** the agent now delivers via the `reply`/`send_message` tools (with a stdout fallback) instead of the adapter routing raw stdout; the double memory injection on new sessions is fixed; a typing indicator is sent while `claude -p` runs; spawn/parse failures deliver a configurable `error_reply` instead of silence; and `claude -p` runs in a configurable `working_dir` so the agent's own `CLAUDE.md` (and its `@import`s / `@path` references) auto-load into context.

> **E20 changes (this revision):** headless sessions are now **long-lived** — idle never tears them down, and resume is keyed on `conversation_id`. Context is assembled from the agent's **own memory files** (`MEMORY.md` + recent daily journals) instead of the DB memory/summary store, which is now dormant. When a conversation pauses, the bus fires a **silent journaling turn** that asks the agent to update its files (it messages nobody). See [Long-lived sessions](#session-continuity-long-lived-sessions-e20), [Context assembly](#context-assembly-memory-files-e20), and [Journaling on pause](#journaling-on-pause-e20). The conceptual model lives in [MEMORY_MODEL.md](./MEMORY_MODEL.md).

## Motivation

The current `cc` adapter runs as a persistent MCP server inside a long-lived Claude Code session (typically in a tmux pane). This requires:
- A running Claude Code desktop/CLI session at all times
- Manual session management (restarting crashed sessions, etc.)
- Memory/context injection via `CLAUDE.md` / `MEMORY.md` conventions we don't fully control

The headless adapter eliminates the persistent session. Each inbound message batch spawns a fresh `claude -p` invocation, with session continuity maintained via `--resume`. The agent appears identical to users — same tools, same memory, same response quality.

## Architecture

`src/adapters/cc-headless.ts` is an **in-process adapter** (same pattern as `telegram.ts`, not an MCP server). It runs alongside bus-core, has direct DB access, and drives `claude -p` subprocesses itself.

```
bus-core
  └── cc-headless adapter (in-process)
        ├── polls HTTP API for pending messages
        ├── per-contact serialization queue
        ├── spawns: claude -p <prompt> --output-format stream-json --verbose --resume <id> --mcp-config ... --system-prompt-file ...
        │     └── MCP subprocess: cc.ts (AGENTBUS_TOOLS_ONLY=true)
        │           └── tools: react_to_message, recall_memory, log_memory, ...
        └── captures result text → POSTs outbound envelope to bus
```

## Session Continuity (long-lived sessions, E20)

Sessions store the Claude session ID for `--resume`:

**Migration 008**: `ALTER TABLE sessions ADD COLUMN claude_session_id TEXT`

This column stores the Claude session ID returned by `claude -p` (present in the `stream-json` init and result events). On subsequent turns the adapter passes `--resume <claude_session_id>` to continue the Claude conversation in context.

**Resume is keyed on `conversation_id`.** The adapter resolves the batch's `conversation_id` from the first message's transcript row (`SELECT conversation_id FROM transcripts WHERE message_id = ?` — the authoritative value Stage 70 computed, falling back to deriving `sha256(sorted([contact_id, channel, topic]))` if the row is missing) and looks up the open session for that conversation. So each email thread resumes its own session, and a long-lived Telegram conversation resumes the same one.

**Sessions are long-lived — idle never tears them down.** The `claude_session_id` column is set **only** by this adapter, so it also marks a session as headless-managed. Stage 80 (`transcript-log`) and the `SessionTracker` both treat `claude_session_id IS NOT NULL` as long-lived: a gap past the idle threshold **extends** the session (same `claude_session_id`, `ended_at` stays `NULL`) instead of closing it. The legacy MCP path (`claude_session_id IS NULL`, e.g. the `cc.ts` adapter) is unaffected and still tears down on idle and fires `on_session_close`.

With teardown gone, nothing in AgentBus bounds a long-lived `--resume` transcript — **Claude Code's auto-compaction** (`autoCompactEnabled`, on by default in `-p` mode) does. If an operator sets `DISABLE_AUTO_COMPACT=1`, a never-idle conversation will eventually overflow its context window; leave auto-compaction on.

Continuity comes from two places: the resumed Claude session (recent conversation, in context) and the agent's own memory files (durable knowledge, re-assembled every turn — see below).

## `claude -p` Invocation

```
claude -p "<formatted_prompt>" \
  --output-format stream-json \
  --verbose \
  --allowedTools all \
  --mcp-config /tmp/agentbus-mcp-<uuid>.json \
  --system-prompt-file /tmp/agentbus-sp-<uuid>.txt \
  [--model <model>] \
  [--resume <claude_session_id>]
```

`--model` is only passed when `adapters.cc-headless.model` is set. Without it, the invocation falls back to whatever the `claude` CLI resolves on its own — its built-in default, or a `"model"` key in `working_dir`'s `.claude/settings.json`. Setting `model` in `config.yaml` is the explicit, per-agent way to pin it.

`--verbose` is required by the Claude CLI whenever `--print`/`-p` is combined with `--output-format stream-json`; without it the invocation fails fast with `When using --print, --output-format=stream-json requires --verbose`. It does not change the emitted JSONL event stream the adapter parses.

Temp files are written immediately before spawn and deleted after the result is captured. The process is spawned with `cwd` set to `working_dir` (see [Context loading](#context-loading-claudemd--file-references)).

`--system-prompt-file` **replaces** the default system prompt (the chat persona does not inherit Claude Code's coding-agent default). This does **not** suppress `CLAUDE.md` auto-loading — `CLAUDE.md` is injected as separate project context. (`--bare` would disable that and is intentionally not used.)

The child is spawned with `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`. The adapter already assembles the agent's memory files into the system prompt via `{{memories}}` (see [Context assembly](#context-assembly-memory-files-e20)), so the CLI's native auto-memory feature — which independently loads `MEMORY.md` from the per-project memory directory — would inject the same file a second time. Disabling it at the spawn keeps memory injection under the adapter's control for every headless agent without per-agent settings. (Equivalent to `autoMemoryEnabled: false` in settings, scoped to these invocations only.)

### MCP config file

```json
{
  "mcpServers": {
    "agentbus": {
      "type": "stdio",
      "command": "npx",
      "args": ["tsx", "/abs/path/to/src/adapters/cc.ts"],
      "env": {
        "AGENTBUS_TOOLS_ONLY": "true",
        "AGENTBUS_CONFIG": "/path/to/config.yaml"
      }
    }
  }
}
```

`AGENTBUS_TOOLS_ONLY=true` is a new flag added to `cc.ts` that skips the polling loop and just registers tools and serves MCP requests. The tools still hit the bus HTTP API as before.

## Tools Available to Claude

Claude has access to all tools **except `get_adapter_status`**. The agent delivers user-facing messages with `reply`/`send_message` (see [Response Delivery](#response-delivery)); `registerHeadlessTools` in `src/mcp/tools/index.ts` defines the set.

| Tool | Available | Notes |
|------|-----------|-------|
| `reply` | ✓ | Agent's primary delivery path — interim updates + final answer |
| `send_message` | ✓ | Proactive / cross-channel sends |
| `react_to_message` | ✓ | Proactive emoji ack before long work — fires mid-stream |
| `recall_memory` | ✓ | Legacy — structured store is dormant (E20); read your own files instead |
| `log_memory` | ✓ | Legacy — write durable facts to your own files instead (E20) |
| `search_transcripts` | ✓ | |
| `get_session` | ✓ | |
| `list_sessions` | ✓ | |
| `list_channels` | ✓ | |
| `schedule_message` | ✓ | |
| `list_schedules` | ✓ | |
| `cancel_schedule` | ✓ | |
| `get_adapter_status` | ✗ | Not meaningful in per-request context |

### Reaction behavior

Reactions work exactly as in the persistent adapter. `react_to_message` is a tool call — in `stream-json` mode, Claude calls it mid-stream (before generating the full response), the MCP subprocess executes it, and the emoji appears in Telegram before the reply lands. The adapter reads the stream to completion and captures the final result text.

## Response Delivery

The agent **owns delivery** via the `reply`/`send_message` tools. This lets it reason privately, send interim "working on it" updates, send multiple messages, and (in future) vary replies per channel — none of which is possible when raw stdout becomes the message.

The adapter reads the `stream-json` output and watches `assistant` turns for `tool_use` blocks named `mcp__agentbus__reply` or `mcp__agentbus__send_message`. Each such call POSTs its own outbound envelope through the bus as the call executes (interim updates arrive immediately).

**Stdout fallback:** if the agent finishes having called **no** delivery tool, the adapter falls back to POSTing the final `result` text as one outbound envelope — so a system prompt that forgets to mention the reply tool still gets a response to the user (no silence):

```
POST /api/v1/messages
{
  channel: <original channel>,
  topic: <original topic>,
  sender: "agent:claude",
  recipient: <original sender>,
  reply_to: <inbound message id>,
  payload: { type: "text", body: <result text | error_reply> }
}
```

> **System prompt requirement:** the `system_prompt` template **must** instruct the agent to send its answer via the `reply` tool (the inbound message text carries `[id:<id>]` for this). The stdout fallback exists only for the "agent emitted prose but called no delivery tool" case — if the agent calls `reply` for an interim update and then puts the final answer only in stdout, that final stdout is **not** delivered (a delivery tool was seen). Always deliver the final answer via the tool.

## Typing Indicator

When a batch starts processing — before the (cold-start) `claude -p` spawn — the adapter fires a fire-and-forget `POST /api/v1/adapters/<channel>/typing` with `{ contact_id }`, mirroring the persistent adapter. The endpoint no-ops for channels without typing capability; on Telegram the indicator is kept alive on the adapter's 4s loop and cleared when the reply is sent. This covers the visible latency of spawning a fresh `claude` process.

## Failure Handling

If the `claude -p` invocation errors, exits non-zero with no result, or yields no result text — **and** the agent delivered nothing via a tool — the adapter POSTs the configured `error_reply` to the contact instead of leaving them with silence. The underlying error is still logged to stderr. If the agent already delivered via a tool, the error is logged but no extra message is sent.

Config key: `adapters.cc-headless.error_reply` (default: `"Sorry — I hit an error processing that. Please try again."`).

Set `adapters.cc-headless.error_passthrough: true` to append the raw failure detail (exit code, stderr tail, or `claude reported error: ...`) to `error_reply` before delivery, truncated to 500 characters. Off by default — raw errors can surface internal detail (stderr, file paths) not meant for end users — but useful while iterating on a new agent's config.

## System Prompt

The system prompt is a **config-driven template** with interpolation variables. Written to a temp file per invocation.

Config key: `adapters.cc-headless.system_prompt` (string with `{{variable}}` placeholders).

Available variables:

| Variable | Value |
|----------|-------|
| `{{contact_id}}` | e.g. `contact:alice` |
| `{{channel}}` | e.g. `telegram` |
| `{{date}}` | Current local date (`YYYY-MM-DD`) |
| `{{memories}}` | **Assembled memory file block** (E20): `MEMORY.md` + recent daily journals — see below |
| `{{session_summary}}` | **Deprecated (E20)** — always empty; the DB summary store is dormant |
| `{{agent_id}}` | e.g. `agent:claude` |

The headless adapter injects context directly into the system prompt (not via the E9 `memory_context` envelope metadata). The user-message formatter is called with `includeMemoryContext: false` so the Stage-85 `<memory>` block is **not** also prepended to the user message.

After `{{variable}}` interpolation, the rendered template is run through `@path` expansion (`expandFileReferences` in `prompt-renderer.ts`): any `@<path>` token is replaced with the contents of that file, resolved relative to `working_dir`. Unresolvable tokens are left verbatim so typos are visible. This expansion runs **only** on the operator-authored template — never on inbound user messages — to avoid arbitrary file reads from user input.

## Context loading (CLAUDE.md / @ file references)

The headless adapter mirrors Claude Code's normal context loading:

- **`CLAUDE.md` auto-loading** — `claude -p` (without `--bare`) loads the `CLAUDE.md` hierarchy (project + parents + `~/.claude`) and expands its `@import`s at launch. The adapter spawns with `cwd` = `working_dir`, so set `working_dir` to the **agent's** home directory and put the agent's persona/context in a `CLAUDE.md` there. (Default `working_dir` is the bus-core cwd, i.e. the agentbus repo — usually not what you want for a chat persona.)
- **`@path` in the system prompt** — the `system_prompt` template may reference files with `@relative/path`, expanded against `working_dir` (see above). Use this to pull operator-controlled files into the persona without editing the template inline.

Config key: `adapters.cc-headless.working_dir` (default: bus-core process cwd).

## Context assembly (memory files, E20)

The `{{memories}}` template variable is filled by **`assembleMemoryContext`** (`src/adapters/memory-context.ts`), which reads the agent's own files — the source of truth for durable knowledge — fresh on every turn:

1. `<working_dir>/<memory.dir>/<memory.index_file>` (e.g. `memory/MEMORY.md`) — the always-loaded index.
2. The daily journal files for today and the previous `journal_lookback_days - 1` days, at `<working_dir>/<memory.dir>/<memory.daily_subdir>/YYYY-MM-DD.md` (newest first).

Each file is wrapped in a `=== <relative path> ===` boundary marker. Missing files (or a missing memory directory) are skipped silently — an agent with no journal yet still works. `journal_lookback_days: 0` loads the index only. Daily file names use the **local** date, consistent with how the agent names them.

Because the block is rebuilt every turn, an in-session journaling update (below) is reflected on the very next turn. This **replaces** the E8/E9 DB memory/summary injection (`recall_memory`/`session_summaries`), which is dormant — see [MEMORY_MODEL.md](./MEMORY_MODEL.md).

## Journaling on pause (E20)

When a conversation goes idle past a per-channel threshold, the bus fires a **silent journaling turn**: the agent reviews the conversation and updates its own memory files. **Nothing is delivered to the user** — no reply, no typing indicator. The conversation is not ended; the same `claude_session_id` keeps resuming.

- **Dispatcher** — `SessionTracker.dispatchJournaling()` runs on the tracker tick. It selects open, headless-managed sessions (`claude_session_id IS NOT NULL`) whose `last_activity` is older than `journaling.threshold_ms` for their channel and that have not been journaled since (`last_journaled_at IS NULL OR last_journaled_at < last_activity`). One journaling turn per pause; new activity advances `last_activity` past `last_journaled_at` and re-arms it. Migration 009 adds `last_journaled_at`.
- **Turn** — the adapter's `runJournalingTurn(conversationId)` looks up the session's `claude_session_id` and spawns `claude -p <journaling.prompt> --resume <id>` with the same `working_dir`, MCP config, and assembled memory context as a normal turn — but in **no-deliver mode**: `deliverResponse` is never called and the stdout fallback is bypassed. It is serialized through the same per-contact queue so it never races a live reply. A session with no `claude_session_id` yet (the agent never spoke) is skipped and stamped as journaled.
- **Failure / cadence** — a failed journaling turn leaves `last_journaled_at` unchanged so a later tick retries, bounded by a small in-memory attempt cap (re-armed by new activity). Journaling is **pause-triggered, not periodic**: a never-idle conversation does not journal until it pauses.
- **The journaling turn adds to the transcript.** The silent `--resume` turn appends an assistant turn, so the next user turn sees both the prior conversation and the journaling exchange. Auto-compaction absorbs the minor token cost.

Set `journaling.enabled: false` to disable it entirely (the dispatcher becomes a no-op).

**Manual reset (`/clear`).** Pause-triggered journaling is automatic, but you can also force a fresh context window with the [`/clear`](./SLASH_COMMANDS.md#clear) slash command. It closes the active session for your contact on that channel immediately (next message starts fresh, no `--resume`), then fires the same silent journaling turn in the background — except it resumes the captured `claude_session_id` directly (via `HeadlessHandle.journalResumeId`), since the DB session row is already closed. Uses `journaling.prompt`, so disabling journaling does not disable `/clear`'s close; it just skips the memory pass.

## Per-Contact Serialization

An in-memory `Map<contact_id, Promise<void>>` where each new task chains off the previous one for that contact. Messages from different contacts run concurrently; messages from the same contact are serialized.

```typescript
const queues = new Map<string, Promise<void>>();

function enqueue(contactId: string, task: () => Promise<void>): void {
  const prev = queues.get(contactId) ?? Promise.resolve();
  const next = prev.then(task).catch(err => console.error(...));
  queues.set(contactId, next);
}
```

## Configuration Schema

```yaml
adapters:
  cc-headless:
    agent_id: claude          # Which agent to dequeue for
    poll_interval_ms: 1000
    claude_bin: claude        # Path to claude binary (default: "claude")
    model: sonnet             # --model passed to claude -p (default: unset → CLI/settings.json default)
    working_dir: /home/agent  # cwd for claude -p → which CLAUDE.md loads (default: bus cwd)
    error_reply: "Sorry — I hit an error processing that. Please try again."
    error_passthrough: false # append raw failure detail to error_reply
    system_prompt: |
      You are a helpful assistant for {{contact_id}} on {{channel}}.
      Today is {{date}}.

      Deliver every user-facing message by calling the `reply` tool with the
      message id shown as [id:<id>]. Use it for quick "working on it" updates and
      for your final answer. Do not put your answer only in plain text.

      @persona.md

      {{memories}}
    # ── E20: memory file assembly (paths relative to working_dir) ──────────────
    memory:
      dir: memory               # memory directory
      index_file: MEMORY.md     # always loaded into every turn
      daily_subdir: daily       # daily/YYYY-MM-DD.md
      journal_lookback_days: 3  # today + previous 2 days of journal (0 = index only)
    # ── E20: journaling on pause ───────────────────────────────────────────────
    journaling:
      enabled: true
      # Per-channel idle gap (ms) that marks a conversation "paused" → journal.
      # number | { <channel>: number, default: number }
      threshold_ms:
        telegram: 1800000       # 30 min
        email: 86400000         # 24 h
        default: 1800000
      prompt: |
        Our conversation has paused. Review it and update your memory files
        (today's daily journal, MEMORY.md, and any relevant topic files) with
        anything durable worth remembering. Do NOT message the user — this is
        an internal journaling turn, not a reply.
```

| Key | Default | Purpose |
|-----|---------|---------|
| `agent_id` | `claude` | Which `agent:<id>` queue to dequeue |
| `poll_interval_ms` | `1000` | Bus poll cadence |
| `system_prompt` | *(required)* | Persona template — `{{vars}}` + `@path` references |
| `claude_bin` | `claude` | Path to the `claude` binary |
| `model` | unset | `--model` passed to `claude -p` (e.g. `sonnet`, `opus`); unset defers to the CLI/`.claude/settings.json` default |
| `working_dir` | bus cwd | `cwd` for `claude -p`; selects the `CLAUDE.md` hierarchy and `@path` base |
| `error_reply` | see above | Message delivered to the user on invocation failure |
| `error_passthrough` | `false` | Append the raw failure detail (truncated to 500 chars) to `error_reply` |
| `memory.dir` | `memory` | Memory directory (relative to `working_dir`) |
| `memory.index_file` | `MEMORY.md` | Index file loaded into every turn |
| `memory.daily_subdir` | `daily` | Subdir of daily journal files `YYYY-MM-DD.md` |
| `memory.journal_lookback_days` | `3` | Days of daily journal to load (today + previous N-1) |
| `journaling.enabled` | `true` | Master switch for journaling-on-pause |
| `journaling.threshold_ms` | `{ default: 1800000 }` | Per-channel idle gap before a paused conversation journals |
| `journaling.prompt` | see schema | Prompt sent on the silent journaling turn |

## Cross-contact isolation (design tradeoff)

Each contact gets an **isolated** Claude conversation (`--resume` is keyed to that contact's AgentBus session). Unlike the persistent MCP adapter — where one Claude context window sees every contact's messages interleaved and can choose what to share between trusted users — the headless agent **cannot reference another contact's conversation**. Continuity for a contact comes from injected memories/summary, not from cross-contact context.

This is an accepted tradeoff, not a bug. Pick the adapter accordingly:
- **Headless** — stronger per-user isolation; good for multi-tenant / privacy-sensitive use.
- **Persistent MCP (`cc.ts`)** — shared context; good when one operator wants the agent to reason across all their conversations.

## What Does NOT Change

- Telegram adapter is unchanged
- The existing `cc.ts` MCP adapter (`claude_session_id IS NULL`) is unaffected: idle teardown, `on_session_close`, and — with `memory.structured_extraction: true` — the summarizer all behave as before
- All existing MCP tools remain registered (the structured memory tools are marked legacy, not removed)

> **E20 bus-side changes (scoped to headless sessions):** Stage 80 and the `SessionTracker` no longer tear down headless sessions on idle, and the summarizer's structured extraction is off by default (`memory.structured_extraction`). These are gated on `claude_session_id IS NOT NULL` so the MCP path is untouched.

# Headless Claude Code Adapter (E19, refined in E19.1)

Reference for the per-request Claude Code adapter that replaces long-lived tmux sessions with on-demand `claude -p` invocations.

> **E19.1 changes (this revision):** the agent now delivers via the `reply`/`send_message` tools (with a stdout fallback) instead of the adapter routing raw stdout; the double memory injection on new sessions is fixed; a typing indicator is sent while `claude -p` runs; spawn/parse failures deliver a configurable `error_reply` instead of silence; and `claude -p` runs in a configurable `working_dir` so the agent's own `CLAUDE.md` (and its `@import`s / `@path` references) auto-load into context. See the relevant sections below.

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
        ├── spawns: claude -p <prompt> --output-format stream-json --resume <id> --mcp-config ... --system-prompt-file ...
        │     └── MCP subprocess: cc.ts (AGENTBUS_TOOLS_ONLY=true)
        │           └── tools: react_to_message, recall_memory, log_memory, ...
        └── captures result text → POSTs outbound envelope to bus
```

## Session Continuity

Sessions are tracked one-per-contact using the existing AgentBus session system with one new field:

**Migration 008**: `ALTER TABLE sessions ADD COLUMN claude_session_id TEXT`

This column stores the Claude session ID returned by `claude -p` (present in the `stream-json` init and result events). On subsequent messages from the same contact while the AgentBus session is still active, the adapter passes `--resume <claude_session_id>` to continue the Claude conversation in context.

**Session lifecycle:**
- New AgentBus session → no `--resume` flag → Claude starts fresh
- Active AgentBus session with `claude_session_id` → `--resume <id>` passed
- AgentBus session closes (idle timeout → summarizer) → `claude_session_id` is abandoned; next contact message starts a new session

Continuity *across* AgentBus sessions comes from injected memories in the system prompt (same as E9), not from Claude session resumption.

## `claude -p` Invocation

```
claude -p "<formatted_prompt>" \
  --output-format stream-json \
  --allowedTools all \
  --mcp-config /tmp/agentbus-mcp-<uuid>.json \
  --system-prompt-file /tmp/agentbus-sp-<uuid>.txt \
  [--resume <claude_session_id>]
```

Temp files are written immediately before spawn and deleted after the result is captured. The process is spawned with `cwd` set to `working_dir` (see [Context loading](#context-loading-claudemd--file-references)).

`--system-prompt-file` **replaces** the default system prompt (the chat persona does not inherit Claude Code's coding-agent default). This does **not** suppress `CLAUDE.md` auto-loading — `CLAUDE.md` is injected as separate project context. (`--bare` would disable that and is intentionally not used.)

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
| `recall_memory` | ✓ | |
| `log_memory` | ✓ | |
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

## System Prompt

The system prompt is a **config-driven template** with interpolation variables. Written to a temp file per invocation.

Config key: `adapters.cc-headless.system_prompt` (string with `{{variable}}` placeholders).

Available variables:

| Variable | Value |
|----------|-------|
| `{{contact_id}}` | e.g. `contact:alice` |
| `{{channel}}` | e.g. `telegram` |
| `{{date}}` | Current date (ISO) |
| `{{memories}}` | Formatted recalled memories for this contact, or empty string |
| `{{session_summary}}` | Most recent session summary for this contact, or empty string |
| `{{agent_id}}` | e.g. `agent:claude` |

This replaces the E9 `memory_context` injection into envelope metadata. The headless adapter injects context directly into the system prompt instead. Because of this, the user-message formatter is called with `includeMemoryContext: false` so the Stage-85 `<memory>` block is **not** also prepended to the user message — otherwise a new session would inject memory twice, in two formats.

After `{{variable}}` interpolation, the rendered template is run through `@path` expansion (`expandFileReferences` in `prompt-renderer.ts`): any `@<path>` token is replaced with the contents of that file, resolved relative to `working_dir`. Unresolvable tokens are left verbatim so typos are visible. This expansion runs **only** on the operator-authored template — never on inbound user messages — to avoid arbitrary file reads from user input.

## Context loading (CLAUDE.md / @ file references)

The headless adapter mirrors Claude Code's normal context loading:

- **`CLAUDE.md` auto-loading** — `claude -p` (without `--bare`) loads the `CLAUDE.md` hierarchy (project + parents + `~/.claude`) and expands its `@import`s at launch. The adapter spawns with `cwd` = `working_dir`, so set `working_dir` to the **agent's** home directory and put the agent's persona/context in a `CLAUDE.md` there. (Default `working_dir` is the bus-core cwd, i.e. the agentbus repo — usually not what you want for a chat persona.)
- **`@path` in the system prompt** — the `system_prompt` template may reference files with `@relative/path`, expanded against `working_dir` (see above). Use this to pull operator-controlled files into the persona without editing the template inline.

Config key: `adapters.cc-headless.working_dir` (default: bus-core process cwd).

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
    working_dir: /home/agent  # cwd for claude -p → which CLAUDE.md loads (default: bus cwd)
    error_reply: "Sorry — I hit an error processing that. Please try again."
    system_prompt: |
      You are a helpful assistant for {{contact_id}} on {{channel}}.
      Today is {{date}}.

      Deliver every user-facing message by calling the `reply` tool with the
      message id shown as [id:<id>]. Use it for quick "working on it" updates and
      for your final answer. Do not put your answer only in plain text.

      @persona.md

      {{memories}}

      {{session_summary}}
```

| Key | Default | Purpose |
|-----|---------|---------|
| `agent_id` | `claude` | Which `agent:<id>` queue to dequeue |
| `poll_interval_ms` | `1000` | Bus poll cadence |
| `system_prompt` | *(required)* | Persona template — `{{vars}}` + `@path` references |
| `claude_bin` | `claude` | Path to the `claude` binary |
| `working_dir` | bus cwd | `cwd` for `claude -p`; selects the `CLAUDE.md` hierarchy and `@path` base |
| `error_reply` | see above | Message delivered to the user on invocation failure |

## Cross-contact isolation (design tradeoff)

Each contact gets an **isolated** Claude conversation (`--resume` is keyed to that contact's AgentBus session). Unlike the persistent MCP adapter — where one Claude context window sees every contact's messages interleaved and can choose what to share between trusted users — the headless agent **cannot reference another contact's conversation**. Continuity for a contact comes from injected memories/summary, not from cross-contact context.

This is an accepted tradeoff, not a bug. Pick the adapter accordingly:
- **Headless** — stronger per-user isolation; good for multi-tenant / privacy-sensitive use.
- **Persistent MCP (`cc.ts`)** — shared context; good when one operator wants the agent to reason across all their conversations.

## What Does NOT Change

- Telegram adapter is unchanged
- Bus-core pipeline, session tracking, summarizer are unchanged
- Existing `cc.ts` MCP adapter continues to work for users who prefer persistent sessions
- All existing MCP tools are unchanged (only availability to this adapter is restricted)

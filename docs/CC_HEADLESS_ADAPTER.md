# Headless Claude Code Adapter (E19)

Design document for the per-request Claude Code adapter that replaces long-lived tmux sessions with on-demand `claude -p` invocations.

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

Temp files are written immediately before spawn and deleted after the result is captured.

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

Claude has access to all tools **except `reply` and `send_message`**. Response delivery is the adapter's job — Claude generates text, the adapter routes it.

| Tool | Available | Notes |
|------|-----------|-------|
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
| `reply` | ✗ | Adapter owns delivery |
| `send_message` | ✗ | Adapter owns delivery |
| `get_adapter_status` | ✗ | Not meaningful in per-request context |

### Reaction behavior

Reactions work exactly as in the persistent adapter. `react_to_message` is a tool call — in `stream-json` mode, Claude calls it mid-stream (before generating the full response), the MCP subprocess executes it, and the emoji appears in Telegram before the reply lands. The adapter reads the stream to completion and captures the final result text.

## Response Delivery

The adapter captures the `result` field from the final `stream-json` event and POSTs it directly to the bus as an outbound envelope:

```
POST /api/v1/messages
{
  channel: <original channel>,
  topic: <original topic>,
  sender: "agent:claude",
  recipient: <original sender>,
  reply_to: <last inbound message id>,
  payload: { type: "text", body: <result text> }
}
```

Claude is not instructed to send replies. The system prompt says nothing about reply mechanics. One response per invocation.

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

This replaces the E9 `memory_context` injection into envelope metadata. The headless adapter injects context directly into the system prompt instead.

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
    system_prompt: |
      You are a helpful assistant...
      Contact: {{contact_id}} on {{channel}}
      Date: {{date}}

      {{memories}}

      {{session_summary}}
    claude_bin: claude         # Path to claude binary (default: "claude")
```

## What Needs Building

| # | Work item |
|---|-----------|
| 1 | **Migration 008** — `ADD COLUMN claude_session_id TEXT` to sessions table |
| 2 | **`AGENTBUS_TOOLS_ONLY` mode in `cc.ts`** — skip polling loop, serve tools only |
| 3 | **`cc-headless.ts`** — in-process adapter: poll, serialize, spawn, capture, deliver |
| 4 | **Config schema** — add `cc-headless` adapter config with `system_prompt` template |
| 5 | **System prompt rendering** — template interpolation (memories, session summary, etc.) |
| 6 | **docs update** — this file + CC_ADAPTER.md note pointing here |

## What Does NOT Change

- Telegram adapter is unchanged
- Bus-core pipeline, session tracking, summarizer are unchanged
- Existing `cc.ts` MCP adapter continues to work for users who prefer persistent sessions
- All existing MCP tools are unchanged (only availability to this adapter is restricted)

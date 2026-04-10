# Claude Code Adapter

The `cc` adapter (`src/adapters/cc.ts`) is an MCP server that runs as a subprocess of Claude Code. It bridges the AgentBus message pipeline to Claude Code (Peggy) using the MCP protocol over stdio.

## How It Works

1. Claude Code launches the adapter as an MCP server (configured in `.mcp.json`).
2. The adapter polls the bus HTTP API for messages addressed to `agent:peggy`.
3. When messages arrive, the adapter wakes Claude Code using `sampling/createMessage`, delivering the message content as a new user turn.
4. Claude Code processes the message and calls the `reply` MCP tool to send a response back through the bus.

## Proactive Delivery

The adapter uses the `claude/channel` MCP extension to initiate new Claude Code turns autonomously — no human prompt required.

### Mechanism

The server declares `experimental: { 'claude/channel': {} }` in its capabilities. When inbound messages arrive, the adapter emits a `notifications/claude/channel` notification with the formatted message as `content`. Claude Code automatically wraps it in a `<channel>` tag (source set from the server name) and injects it as a new turn:

```
<channel source="agentbus-claude-code" ts="2026-04-10T12:00:00.000Z">
New message from contact:chris via telegram [id:msg-abc123]:
Hey Peggy!
</channel>
```

No capability negotiation is needed — the notification fires unconditionally on every inbound message batch.

### Required flag

During the research preview, custom channels must be declared via `--dangerously-load-development-channels`. Start Claude Code with:

```bash
claude --permission-mode auto --dangerously-load-development-channels server:agentbus
```

where `server:agentbus` matches the key name in `.mcp.json`.

### Message Format

Each `createMessage` call delivers a user turn with this format:

```
New message from {sender} via {channel} [id:{message_id}]:
{body}
```

Multiple messages in a single poll batch are concatenated as separate paragraphs (separated by a blank line) in one user turn.

### Serialization Queue

Only one `createMessage` call is in-flight at a time. If messages arrive while a call is pending, they are queued and delivered sequentially after the current call completes. The queue has no maximum depth — no messages are ever dropped.

Queue state is logged at every enqueue and drain step for observability.

### Error Handling

If `createMessage` fails (client rejection, timeout, network error), the error is logged at `error` level and the queue continues draining. Messages are **not** removed from `messageBuffer` on failure — they remain retrievable via the `get_pending_messages` tool for manual recovery.

## Configuring Your Agent

This section describes what the agent (e.g., Claude Code running as Peggy) needs to know to participate in the AgentBus message loop.

### How Messages Arrive

When a message is delivered to the agent, the adapter emits a `notifications/claude/channel` event, which Claude Code injects as a new turn — no human input required. The turn delivered to the agent looks like this:

```
<channel source="agentbus" ts="2026-04-10T12:00:00.000Z">
New message from contact:chris via telegram [id:msg-abc123]:
Hey Peggy, what's the weather like?
</channel>
```

For a batch of messages arriving in the same poll cycle, each message is separated by a blank line inside the `<channel>` wrapper:

```
New message from contact:chris via telegram [id:msg-001]:
First message here.

New message from contact:alice via bluebubbles [id:msg-002]:
Second message here.
```

### Responding to a Message

Extract the `id` value from the bracketed `[id:...]` tag and pass it to the `reply` MCP tool:

```
reply(message_id="msg-abc123", body="The weather is sunny and 72°F.")
```

The `reply` tool routes the response back through the originating channel automatically. You do not need to specify the channel explicitly.

### Token Budget

The `maxTokens` for the turn is set by `sampling_max_tokens` in `config.yaml` (default: 8192). Keep responses within this budget. For long responses, consider summarizing rather than exhausting the limit.

### Adding This to Your Agent's Instructions

Add a note to your agent's system prompt or `CLAUDE.md` describing the AgentBus message format so it recognizes messages reliably. Example:

> Messages from AgentBus arrive as a new user turn. Each message includes a sender, channel, and bracketed message ID (e.g., `[id:msg-abc123]`). Always call `reply` with that message ID to send a response.

### Fallback: Manual Polling

If the client does not declare the `sampling` capability (older Claude Code version), messages accumulate in the buffer and are **not** pushed automatically. In this case:

- The adapter logs: `sampling capability not declared by client — falling back to sendLoggingMessage`
- Messages must be retrieved manually by calling the `get_pending_messages` tool
- A `/loop` skill or human trigger can be used to poll periodically as a stopgap

## Configuration

In `config.yaml` under `adapters.claude-code`:

| Field | Default | Description |
|-------|---------|-------------|
| `poll_interval_ms` | `1000` | How often to poll the bus for pending messages (milliseconds) |
| `sampling_max_tokens` | `8192` | `maxTokens` value passed to `sampling/createMessage` |
| `plugin` | — | Optional plugin script path |

## Registered MCP Tools

| Tool | Description |
|------|-------------|
| `reply` | Send a reply back to the originating channel |
| `get_pending_messages` | Retrieve buffered messages manually (fallback path) |
| `get_adapter_status` | Check adapter health and bus connectivity |

## Fallback Path

When sampling is unavailable (older Claude Code version or capability not declared), a human or a `/loop` skill can trigger `get_pending_messages` manually to retrieve and process buffered messages.

## Running

```bash
AGENTBUS_CONFIG=/path/to/config.yaml npx tsx src/adapters/cc.ts
```

In production, Claude Code launches this automatically via the `.mcp.json` server definition.

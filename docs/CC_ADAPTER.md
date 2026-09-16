# Claude Code MCP adapter

`src/adapters/cc.ts` is an MCP server that Claude Code spawns over stdio. It registers the AgentBus tool set (see [MCP_TOOLS.md](MCP_TOOLS.md)) and talks to bus-core only through the HTTP API. It runs in one of two modes.

| Mode | When | What it does |
|---|---|---|
| Tools only (`AGENTBUS_TOOLS_ONLY=true`) | Spawned by the headless adapter for every `claude -p` turn | Registers the headless tool subset and serves tool calls. No polling |
| Polling (default) | A persistent, interactive Claude Code session lists the adapter in `.mcp.json` | Polls bus-core for messages addressed to the agent and injects them into the session as channel notifications |

The headless adapter ([CC_HEADLESS_ADAPTER.md](CC_HEADLESS_ADAPTER.md)) is the primary agent runtime. Polling mode remains for operators who keep a long-lived Claude Code session open. Sessions on that path close on idle and can fire the `on_session_close` hook (see [MEMORY.md](MEMORY.md)).

All logging goes to stderr. stdout is the MCP protocol stream.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `AGENTBUS_CONFIG` | `./config.yaml` | Config file. The `.env` next to it is loaded too |
| `AGENTBUS_AGENT_ID` | `claude` | Recipient to poll for (`agent:<id>`). Polling mode only |
| `AGENTBUS_TOOLS_ONLY` | unset | `true` selects tools-only mode |

The only config field this process reads is `adapters.claude-code.poll_interval_ms` (default `1000`). The schema also accepts `sampling_max_tokens` and `plugin`, but nothing reads them.

## Polling mode

Each poll calls `GET /api/v1/messages/pending?agent=<id>&limit=10`, acknowledges every message with `POST /api/v1/messages/:id/ack`, formats the acknowledged batch into one text block, and emits a `notifications/claude/channel` notification. Claude Code wraps the text in a `<channel source="...">` tag and starts a new turn; no human prompt is needed. The adapter then calls `POST /api/v1/adapters/<channel>/typing` for each message so the source platform shows activity. Email channels are skipped.

After three consecutive poll failures the interval backs off to 5 seconds and `get_adapter_status` reports `degraded`; after ten it reports `disconnected`. A successful poll resets both.

### Message format

```
New message from contact:alice via telegram:peggy at 2026-09-14T10:00 [id:msg-abc123]:
What's the weather like?

New message from contact:bob via email at 10:02 [id:msg-def456]:
[Replying to Alice: "see attached"]
Here is the document
[File: /tmp/agentbus/claude/3f1a.pdf — report.pdf]
```

- Messages in one poll are separated by a blank line. The first carries a full timestamp, later ones the time only.
- A reaction renders as `[reacted 👍 to message 555:42]` or `[removed reaction 👍 to message 555:42]`.
- A quoted reply renders as a `[Replying to <name>: "<text>"]` line before the body.
- Attachments append `[Image: <path>]` and `[File: <path> — <name>]` lines; inline email images append a `fetch_attachment` hint. See [ATTACHMENTS.md](ATTACHMENTS.md).
- One-shot context from `create_telegram_topic` is prepended to a topic's first message.
- In polling mode only, the legacy `<memory>` block from the memory-inject stage is prepended when a new session starts and summaries exist.

The agent replies with `reply(message_id="<id>", body="...")`. The tool resolves channel and recipient from the original message.

### Setup

Add the server to the Claude Code project's `.mcp.json`:

```json
{
  "mcpServers": {
    "agentbus": {
      "command": "npx",
      "args": ["tsx", "/abs/path/to/agentbus/src/adapters/cc.ts"],
      "env": { "AGENTBUS_CONFIG": "/abs/path/to/config.yaml", "AGENTBUS_AGENT_ID": "claude" }
    }
  }
}
```

Channel notifications are a Claude Code preview feature and must be enabled when the session starts:

```bash
claude --permission-mode auto --dangerously-load-development-channels server:agentbus
```

`server:agentbus` matches the key in `.mcp.json`. Add a note to the agent's `CLAUDE.md` describing the message format and the `reply` tool so it responds reliably.

## Tools-only mode

The headless adapter writes a temporary MCP config that launches this file with `AGENTBUS_TOOLS_ONLY=true` and passes it to `claude -p --mcp-config`. `registerHeadlessTools()` in `src/mcp/tools/index.ts` registers every tool except `get_adapter_status`, which has no meaning without a poll loop. The process exits when the `claude -p` turn ends.

## Running by hand

```bash
AGENTBUS_CONFIG=/path/to/config.yaml npx tsx src/adapters/cc.ts
```

Useful for checking that the server starts. In normal operation Claude Code or the headless adapter spawns it.

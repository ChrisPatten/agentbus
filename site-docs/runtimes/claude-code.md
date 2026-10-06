# claude-code

The `claude-code` runtime connects one Claude Code session that you start yourself to the bus. Every message routed to it arrives in that one session, from every channel and every conversation, and the agent answers with the same `reply` tool as the other runtimes.

Choose it when you want a single agent that sees everything in one context window and that you can drive by hand at the same time. For anything busier, [`cc-headless`](/runtimes/cc-headless) or [`cc-pool`](/runtimes/cc-pool) is a better fit.

## How it works

You add AgentBus as an MCP server in your agent's folder and start Claude Code there. AgentBus then:

1. checks the bus for new messages addressed to your agent, every second by default;
2. passes each batch into your Claude Code session, which starts a turn on its own, with no typing needed;
3. shows "typing…" on the channel the message came from.

Your agent answers with `reply`, and can use every other [AgentBus tool](/reference/mcp-tools).

## Set it up

### 1. Add a route

Route messages to `adapterId: claude-code`, with an agent name of your choice:

```yaml
pipeline:
  routes:
    - match: { channel: telegram }
      target: { adapterId: claude-code, recipientId: agent:claude }
```

Optionally, set how often the session checks for messages:

```yaml
adapters:
  claude-code:
    poll_interval_ms: 1000
```

Restart the bus after changing the config.

### 2. Add AgentBus to your agent's `.mcp.json`

In your agent's folder, create or edit `.mcp.json`. Replace both paths with your own: the first is the AgentBus folder, the second its `config.yaml`. `AGENTBUS_AGENT_ID` is the name after `agent:` in your route.

```json
{
  "mcpServers": {
    "agentbus": {
      "command": "npx",
      "args": ["tsx", "/Users/you/agentbus/src/adapters/cc.ts"],
      "env": {
        "AGENTBUS_CONFIG": "/Users/you/agentbus/config.yaml",
        "AGENTBUS_AGENT_ID": "claude"
      }
    }
  }
}
```

### 3. Start Claude Code

In a terminal, go to your agent's folder:

```bash
cd ~/agents/claude
```

Start Claude Code with AgentBus allowed to deliver messages into the session:

```bash
claude --dangerously-load-development-channels server:agentbus
```

Claude Code shows a warning about loading development channels. Confirm it. Messages now arrive in the session as they're sent.

Keep this terminal open. The agent only receives messages while the session is running. To keep it running when you close the terminal, start it inside tmux; that's what [`cc-pool`](/runtimes/cc-pool) does for you.

## Things to know

- **One context for everything.** Every routed conversation shares the session, so the agent can reason across them, and also sees each person's messages alongside everyone else's. Use `cc-headless` if conversations must stay private from each other.
- **Messages are marked delivered as soon as the session receives them.** If the session crashes mid-turn, those messages aren't sent again.
- **Sessions end after 30 minutes of quiet.** For this runtime, the bus closes a conversation's session after `memory.session_idle_threshold_ms` (default 30 minutes) without messages. The Claude Code session itself keeps running.
- **No phone approvals.** Permission prompts must be answered in the terminal. [Approvals](/features/approvals) only work with `cc-pool`.
- **Typing indicators go to the main chat.** In Telegram forum topics, "typing…" appears in the group's General topic.
- **No live tool list** in Telegram, unless you install the `agentbus_tool_status_hook.sh` hook described under [cc-pool](/runtimes/cc-pool#optional-hooks).
- `/stop` and `/cost` don't apply to this runtime.

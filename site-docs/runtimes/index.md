# Choosing a runtime

A runtime is how AgentBus runs your agent. All three use Claude Code, read the same `CLAUDE.md` from the agent's folder and give the agent the same tools. They differ in how a conversation gets a Claude session, and whether you can watch it.

## At a glance

| | [cc-headless](/runtimes/cc-headless) | [cc-pool](/runtimes/cc-pool) | [claude-code](/runtimes/claude-code) |
|---|---|---|---|
| **Claude session** | One per conversation, resumed for each batch of messages | One per conversation, running in a leased tmux pane | One, shared by every conversation |
| **Started by** | The bus, on demand | The bus, on demand | You |
| **Can you watch or type into it?** | No | Yes, attach to the pane | Yes, it's your terminal |
| **Conversations at once** | Up to `max_concurrent_turns` (5) | One per pane | One at a time |
| **Start-up delay** | A few seconds per turn | Only when a conversation gets a pane | None |
| **Conversations kept apart** | Yes | Yes | No, one shared context |
| **Phone approvals** | No (prompts are refused) | Yes, from Telegram | No |
| **Live tool list in Telegram** | Built in | With a hook | With a hook |
| **`/stop`** | Yes | No | No |
| **`/cost`** | Yes | No | No |
| **Extra software** | None | tmux | None |

## Which should I use?

- **Start with `cc-headless`.** It needs nothing beyond Claude Code, keeps every conversation private and in context, handles several conversations at once, and never needs restarting by hand.
- **Use `cc-pool`** when you want to see what your agent is doing, take over a session, or approve permission prompts from your phone instead of having them refused.
- **Use `claude-code`** when you want one agent that sees all your messages together, and you're happy to keep a terminal open for it.

You can mix them. Each agent has its own runtime, and [routes](/concepts/contacts-and-routing) decide which messages go where. For example, route Telegram to a `cc-pool` agent you can watch, and email to a `cc-headless` agent.

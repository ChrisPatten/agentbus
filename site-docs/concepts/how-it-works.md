# How AgentBus works

AgentBus is one background program, the **bus**, that sits between your chat channels and your agents. Every message goes through it in both directions, so your agent can be reached the same way from Telegram, email or the Mac app, and you can see and control everything from one place.

This page explains the moving parts in plain terms. You don't need to know them to get started, but they make the configuration easier to read.

## Channels and adapters

A **channel** is a place messages come from: Telegram, email, the Mac app, Siri, a Pebble Ring. Inside the bus, each channel has an **adapter** that knows how to talk to it: it collects incoming messages and delivers replies.

| Channel | What the adapter does | Channel name in config |
|---|---|---|
| [Telegram](/channels/telegram) | Polls your bot for messages; replies, reacts, shows typing and tool progress | `telegram`, or `telegram:<bot>` for several bots |
| [Email](/channels/email) | Watches a mailbox over IMAP; replies over SMTP in the same thread | `email`, or `email:<account>` |
| [Mac app](/channels/mac-app) | Serves the native Mac app over a live connection | `app` |
| [Siri](/channels/siri) | Answers questions from the Peggy iPhone app while Siri waits | `siri` |
| [Pebble](/channels/pebble) | Receives voice memos from a Pebble Ring (receive-only) | `pebble` |

All adapters run inside the bus. You turn one on by adding its block under `adapters:` in `config.yaml`.

## Agents and runtimes

An **agent** is a Claude Code session with a name, a working folder and instructions. In routes and tools, agents are written as `agent:<name>`, for example `agent:assistant`.

A **runtime** is how the bus runs that agent. There are three:

| Runtime | In short |
|---|---|
| [`cc-headless`](/runtimes/cc-headless) | Runs `claude -p` for each batch of messages and resumes the conversation's own Claude session. The default choice. |
| [`cc-pool`](/runtimes/cc-pool) | Keeps several interactive Claude Code sessions open in tmux and lends one to each active conversation. You can watch and attach to them. |
| [`claude-code`](/runtimes/claude-code) | One Claude Code session that you start yourself, shared by every conversation routed to it. |

See [Choosing a runtime](/runtimes/) for a comparison.

## What happens to a message

When you send your agent a message, the bus takes it through the same steps every time:

1. **Receive.** The channel's adapter picks up the message.
2. **Identify the sender.** The bus looks the sender up in your `contacts`. Telegram and email drop messages from anyone not listed. Siri, Pebble and the Mac app identify you by a token instead.
3. **Relay (optional).** If a [relay rule](/features/channel-relay) matches, the message is re-sent as if it had arrived on another channel.
4. **Ignore duplicates.** An identical message from the same sender on the same channel within a short window (30 seconds by default) is dropped.
5. **Handle slash commands.** A message starting with `/` is treated as a [command](/features/slash-commands) for the bus, not the agent.
6. **Pick a topic and priority.** The bus decides which conversation the message belongs to (see [Conversations and sessions](/concepts/conversations-and-sessions)) and how urgent it is.
7. **Route.** Your [routes](/concepts/contacts-and-routing) decide which agent gets it.
8. **Record.** The message is written to the conversation's transcript.
9. **Queue.** The message waits in the agent's queue until the agent picks it up. More urgent messages are picked up first.

The agent then reads the message and answers with its `reply` tool. The reply goes into the queue, and the bus hands it to the right adapter, which delivers it to you on the channel the message came from.

**Messages survive restarts.** The queue, transcripts and sessions are kept in a single SQLite database (`bus.db_path`), so a message that arrives while the agent is busy, or just before a restart, is still delivered.

## What the agent can do

Your agent talks to the bus through a set of tools that the bus provides to Claude Code over MCP (the standard way Claude Code connects to outside tools). The important ones:

- `reply` answers a message on the channel and in the conversation it came from.
- `send_message` sends a new message to a contact on any channel, for example a Telegram note while you're chatting by email.
- `schedule_message` sets up a reminder or recurring job.
- `search_transcripts` and `get_transcript` look back through past conversations.

The full list is in [MCP tools](/reference/mcp-tools).

## What lives where

| Thing | Where |
|---|---|
| Settings | `config.yaml` in the AgentBus folder, or the file named by the `AGENTBUS_CONFIG` environment variable |
| Secrets (tokens, passwords) | `.env` next to `config.yaml`, referenced from the config as `${NAME}` |
| Messages, transcripts, sessions, schedules | The SQLite database at `bus.db_path` |
| The agent's instructions and files | The agent's working folder (`working_dir`), including its `CLAUDE.md` |
| Downloaded attachments | The folder you set in `agents.<agent>.media.download_path` |

The bus listens for its own components on a local web address, `http://127.0.0.1:3000` by default. That's the [HTTP API](/reference/http-api). It's only reachable from your own computer unless you change `bus.host`.

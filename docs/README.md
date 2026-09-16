# AgentBus documentation

Technical reference for operators and contributors. The public landing page lives in `site/`; planning material (epics, PRD, backlogs) lives in `_bmad-output/`.

## Run and operate

| Guide | Covers |
|---|---|
| [DEPLOYMENT.md](DEPLOYMENT.md) | Install, configure, run under pm2, recover, rotate secrets, runbook |
| [VERSIONING.md](VERSIONING.md) | Semantic versioning and the release procedure |
| [GITHUB_PAGES.md](GITHUB_PAGES.md) | The static homepage and its deploy workflow |

## Agent runtime

| Guide | Covers |
|---|---|
| [CC_HEADLESS_ADAPTER.md](CC_HEADLESS_ADAPTER.md) | `claude -p` per batch, session resume, system prompt, memory files, journaling, multi-instance |
| [CC_ADAPTER.md](CC_ADAPTER.md) | The MCP server process: tools-only mode for headless turns, polling mode for a persistent session |
| [MEMORY_MODEL.md](MEMORY_MODEL.md) | Why the agent's own files are the memory system |
| [MEMORY.md](MEMORY.md) | The legacy structured memory store (dormant by default) |

## Channels

| Guide | Covers |
|---|---|
| [TELEGRAM_ADAPTER.md](TELEGRAM_ADAPTER.md) | Bots, groups and forum topics, reactions, live tool-call status, command menus |
| [EMAIL_ADAPTER.md](EMAIL_ADAPTER.md) | IMAP IDLE, SMTP replies, anti-spoofing, threading, Markdown rendering |
| [PEBBLE_ADAPTER.md](PEBBLE_ADAPTER.md) | Pebble Ring voice-memo webhook |
| [SIRI_ADAPTER.md](SIRI_ADAPTER.md) | Siri channel: the Peggy iOS app's ask endpoint, prompt contract, tailnet exposure, latency probe |
| [ATTACHMENTS.md](ATTACHMENTS.md) | Inbound images and files, per-agent media config, TTL sweep |
| [THREADING.md](THREADING.md) | Thread-scoped sessions shared by email and Telegram topics |
| [CHANNEL_RELAY.md](CHANNEL_RELAY.md) | Re-submit a message on another channel with a templated body |
| [PLUGIN_AUTHORING.md](PLUGIN_AUTHORING.md) | Write a new adapter |

## Interfaces

| Guide | Covers |
|---|---|
| [HTTP_API.md](HTTP_API.md) | Every bus-core route |
| [MCP_TOOLS.md](MCP_TOOLS.md) | Every tool the agent can call |
| [SLASH_COMMANDS.md](SLASH_COMMANDS.md) | Built-in commands and the command registry |
| [SCHEDULING.md](SCHEDULING.md) | Cron and one-shot scheduled messages |

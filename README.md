# AgentBus

AgentBus is a TypeScript message bus that connects messaging channels to an AI agent. It gives the agent one inbox and one outbox across Telegram, email, and webhook sources, and drives the agent with Claude Code.

## How it works

One process, `bus-core`, owns the SQLite database, the message queue, and the inbound pipeline. Platform adapters run inside that process. The only separate process is the MCP server that Claude Code spawns, and it talks to bus-core over a local HTTP API.

| Component | Runs | Purpose |
|---|---|---|
| bus-core | In process | Config, SQLite, queue, 10-stage inbound pipeline, HTTP API, scheduler, delivery worker |
| Telegram adapter | In process | Bot API long polling; groups and forum topics, reactions, attachments, live tool-call status |
| Email adapter | In process | IMAP IDLE inbound, SMTP outbound, one session per thread |
| Pebble webhook | In process | Receive-only ingress for Pebble Ring voice memos |
| Headless Claude Code adapter (`cc-headless`) | In process | Spawns `claude -p` per message batch with session resume. The primary agent runtime |
| Claude Code MCP adapter (`src/adapters/cc.ts`) | Separate process | MCP server that serves the tool set to `claude -p`, or polls the bus for a persistent Claude Code session |

Inbound: adapter → pipeline (normalize, contact resolve, relay, dedup, slash command, topic, priority, route, transcript log, memory inject) → queue → agent.
Outbound: agent calls the `reply` tool → `POST /api/v1/messages` → queue → delivery worker → adapter.

## Quick start

Requirements: Node.js 20 or later, and the `claude` CLI on `PATH` for `cc-headless`.

```bash
npm install
cp config.yaml.example config.yaml   # edit contacts, adapters, and routes
cp .env.example .env                 # edit tokens and passwords
npx tsx src/index.ts                 # run bus-core in the foreground
```

Secrets live in `.env` and are referenced from `config.yaml` as `${VAR_NAME}`. `config.yaml.example` documents every option.

For a managed deployment (pm2, log files, restart on reboot), see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Development

```bash
npx tsc --noEmit     # type-check
npx vitest run       # run all tests
make dev             # run bus-core with AGENTBUS_CONFIG
make help            # list Makefile targets
```

Imports between `.ts` files must use the `.js` extension (`"module": "NodeNext"`). Every change under `src/` needs a matching update in `docs/` and a bullet under `[Unreleased]` in `CHANGELOG.md`. See [CLAUDE.md](CLAUDE.md) for the contributor rules and [docs/VERSIONING.md](docs/VERSIONING.md) for releases.

## Documentation

[docs/README.md](docs/README.md) indexes every guide. Start with:

- [DEPLOYMENT.md](docs/DEPLOYMENT.md): install, run, and operate bus-core.
- [CC_HEADLESS_ADAPTER.md](docs/CC_HEADLESS_ADAPTER.md): the agent runtime, system prompt, memory files, and journaling.
- [TELEGRAM_ADAPTER.md](docs/TELEGRAM_ADAPTER.md), [EMAIL_ADAPTER.md](docs/EMAIL_ADAPTER.md), [PEBBLE_ADAPTER.md](docs/PEBBLE_ADAPTER.md), [SIRI_ADAPTER.md](docs/SIRI_ADAPTER.md): the channels.
- [HTTP_API.md](docs/HTTP_API.md) and [MCP_TOOLS.md](docs/MCP_TOOLS.md): the API surface.

## Project layout

```
src/
├── index.ts              # bus-core entry point and wiring
├── config/               # Zod schema and loader (config.yaml + .env)
├── db/                   # SQLite client, migration runner, migrations/
├── core/                 # MessageQueue, AdapterRegistry, DeliveryWorker
├── pipeline/             # PipelineEngine, stages/, thread store, outbound transcript
├── adapters/             # telegram, email, cc-headless, cc (MCP server), helpers
├── http/                 # Fastify API, processInbound(), webhook logging
├── mcp/                  # MCP server factory and tools/
├── commands/             # Slash command registry and built-in handlers
├── memory/               # SessionTracker and the legacy Summarizer
├── scheduler/            # Cron and one-shot scheduled messages
├── media/                # Attachment persistence and TTL sweeper
└── types/envelope.ts     # MessageEnvelope, the canonical message type
```

## License

MIT. See [LICENSE](LICENSE).

# AgentBus

TypeScript message bus for AI agents. Unifies Claude Code (via MCP), Telegram, and BlueBubbles (iMessage) into a single ambient inbox/outbox for an AI agent.

## Architecture

Four independent processes communicate over a local HTTP API:

- **bus-core** — central orchestrator; owns SQLite, the message queue, and the inbound pipeline
- **telegram-adapter** — Telegram Bot API gateway (long-poll)
- **bluebubbles-adapter** — BlueBubbles/iMessage gateway (webhooks)
- **claude-code-adapter** — MCP server spawned by Claude Code over stdio

All inter-process communication is HTTP to `localhost:3000`. Adapters never import bus-core directly.

## Tech Stack

- TypeScript (ESM, NodeNext)
- SQLite via `better-sqlite3` (WAL mode, FTS5)
- MCP SDK (`@modelcontextprotocol/sdk`)
- Fastify HTTP API
- Zod config validation
- js-yaml + dotenv config loading

## Getting Started

```bash
# Install dependencies
npm install

# Copy and fill in config
cp config.yaml.example config.yaml
cp .env.example .env
# Edit config.yaml and .env with your credentials

# Run bus-core
npx tsx src/index.ts

# Run Claude Code adapter (spawned automatically by Claude Code via MCP)
npx tsx src/adapters/cc.ts
```

## Configuration

Configuration lives in `config.yaml`. Secrets are referenced as `${ENV_VAR}` and resolved from `.env` at startup.

See `config.yaml.example` for a fully annotated reference.

## Project Structure

```
src/
├── index.ts                  # bus-core entry point
├── types/envelope.ts         # MessageEnvelope — canonical message type
├── core/
│   ├── queue.ts              # MessageQueue (enqueue/dequeue/ack/dead-letter)
│   └── registry.ts           # AdapterRegistry
├── config/
│   ├── loader.ts             # loadConfig()
│   └── schema.ts             # Zod AppConfig schema
├── db/
│   ├── client.ts             # SQLite client singleton
│   ├── schema.ts             # Migration runner
│   └── migrations/           # Versioned SQL migrations
├── adapters/                 # Adapter implementations (E2–E4)
├── mcp/                      # MCP server + tool definitions (E7)
├── memory/                   # Transcript logger, summarizer, context injector (E8–E9)
├── pipeline/                 # 8-stage inbound pipeline middleware (E5)
├── commands/                 # Slash command registry (E6)
└── http/                     # Fastify HTTP API (E12)
```

## License

MIT — see [LICENSE](LICENSE)

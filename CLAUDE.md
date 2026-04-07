# AgentBus

TypeScript MCP message bus for AI agents (primarily Peggy). Runs persistently on a Mac mini.

## Project Structure

- `src/core/` — Bus core: pipeline engine, adapter registry, message queue
- `src/adapters/` — Adapter implementations (claude-code, telegram, bluebubbles)
- `src/mcp/` — MCP server and tool definitions
- `src/memory/` — Transcript logger, summarizer, context injector
- `src/pipeline/` — Inbound/outbound pipeline middleware
- `src/commands/` — Slash command registry and built-in handlers
- `src/config/` — Config loader and Zod schema
- `src/db/` — SQLite client and schema
- `src/http/` — Fastify HTTP API
- `_bmad-output/` — BMAD planning artifacts (PRD, architecture, epics)

## Tech Stack

- TypeScript (ESM, NodeNext)
- SQLite (better-sqlite3) with WAL mode and FTS5
- MCP SDK (@modelcontextprotocol/sdk)
- Fastify for HTTP API
- Zod for config validation
- js-yaml + dotenv for config loading

## Development

```bash
npx tsx src/index.ts          # Run bus core
npx tsx src/adapters/cc.ts    # Run Claude Code adapter
```

## BMAD Status

See sprint-status.yaml for current phase and epic progress.

# AgentBus Deployment Guide

Deploying AgentBus. The system runs as a single pm2-managed process (`bus-core`) with platform adapters (Telegram, BlueBubbles) running in-process. Agent connectors (Claude Code) are separate processes spawned by their respective runtimes. Most operational tasks can be done via `make` targets or pm2 directly.

---

## Prerequisites

- Node.js 20+ and npm installed
- pm2 (installed as a dev dependency — no global install needed)
- A Telegram bot token (from @BotFather)
- BlueBubbles server running and accessible on the local network
- `config.yaml` and `.env` populated (see below)

---

## First-Time Setup

### 1. Install dependencies

```bash
cd /path/to/agentbus
npm install
```

### 2. Configure secrets

Copy the example files and fill in your credentials:

```bash
cp .env.example .env
cp config.yaml.example config.yaml
```

**`.env`** — secrets only, never committed:
```
TELEGRAM_BOT_TOKEN=your-telegram-bot-token
BLUEBUBBLES_PASSWORD=your-bluebubbles-server-password
CLAUDE_API_KEY=your-anthropic-api-key
```

**`config.yaml`** — references secrets via `${VAR_NAME}` substitution:
```yaml
bus:
  http_port: 3000
  db_path: /Users/you/.agentbus/agentbus.db
  log_level: info

adapters:
  telegram:
    token: ${TELEGRAM_BOT_TOKEN}
    poll_timeout: 30
  bluebubbles:
    server_url: http://192.168.1.x:1234
    webhook_port: 3002
  claude-code:
    poll_interval_ms: 1000

contacts:
  chris:
    id: chris
    displayName: Chris
    platforms:
      telegram:
        userId: 123456789
      bluebubbles:
        handle: "+15551234567"

memory:
  summarizer_interval_ms: 60000
  session_idle_threshold_ms: 1800000   # 30 minutes
  context_window_hours: 48
  claude_api_model: claude-opus-4-6
```

### 3. Create log and data directories

```bash
mkdir -p ~/.agentbus/logs
mkdir -p ~/.agentbus/data   # or wherever db_path points
```

### 4. Initialize the database

Run bus-core once to create the SQLite file and run migrations:

```bash
npx tsx src/index.ts
# Ctrl+C once you see "bus-core ready"
```

### 5. Start with pm2

```bash
make start     # starts both processes and saves the process list
```

To survive reboots, run pm2's startup hook once:

```bash
./node_modules/.bin/pm2 startup
# run the printed command (e.g. sudo env PATH=... pm2 startup systemd)
```

After that, processes auto-restart after a reboot with no manual intervention.

---

## Daily Operations

Makefile targets cover the common cases:

| Command | What it does |
|---------|-------------|
| `make start` | Start (or restart) all processes, save process list |
| `make stop` | Stop and remove all processes from pm2 |
| `make restart` | Restart all processes (use after config changes) |
| `make status` | Overview of all process states |
| `make logs` | Tail all process logs |

For lower-level pm2 operations, use `./node_modules/.bin/pm2` directly:

```bash
./node_modules/.bin/pm2 show bus-core          # detailed info for one process
./node_modules/.bin/pm2 logs bus-core          # tail one process
./node_modules/.bin/pm2 logs --lines 200 bus-core
./node_modules/.bin/pm2 restart bus-core       # restart one process
```

Log files: `~/.agentbus/logs/{name}-out.log` and `~/.agentbus/logs/{name}-error.log`

---

## Startup Order

pm2 starts bus-core, which in turn starts all platform adapters in-process. The Telegram adapter's inbound loop begins polling immediately after the HTTP server is ready. If the Telegram API is unreachable, the inbound loop backs off exponentially and retries automatically.

---

## Configuration Changes

After editing `config.yaml` or `.env`:

```bash
make restart
```

Changes take effect on the next restart. No reload mechanism exists yet.

---

## FTS Index Recovery

If the FTS search index becomes out of sync (e.g., after restoring from backup):

```bash
./node_modules/.bin/pm2 stop bus-core
AGENTBUS_CONFIG=/path/to/config.yaml npx tsx src/index.ts --rebuild-fts
./node_modules/.bin/pm2 start bus-core
```

The `--rebuild-fts` flag rebuilds all FTS5 indices from source tables and then exits. The process should not stay running — let pm2 start it normally afterward.

---

## Rotating Secrets

### Telegram bot token

1. Get new token from @BotFather
2. Update `.env`: `TELEGRAM_BOT_TOKEN=new-token`
3. `make restart` (Telegram adapter runs in-process with bus-core)

The adapter reads the token at startup; no db changes needed.

### Claude API key

1. Rotate at console.anthropic.com
2. Update `.env`: `CLAUDE_API_KEY=new-key`
3. `./node_modules/.bin/pm2 restart bus-core` (the summarizer uses it)

---

## Dead Letter Management

Dead-lettered messages are messages that could not be delivered after all retries. They accumulate in the `dead_letter` table and expire automatically after 24 hours.

**Via slash command** (from Telegram or iMessage):
```
/dead-letter          # list recent dead-lettered messages
/dead-letter retry <message_id>   # re-enqueue a specific message
```

**Via REST API** (see `docs/HTTP_API.md`):
```bash
curl http://localhost:3000/api/v1/dead-letter
curl -X POST http://localhost:3000/api/v1/dead-letter/<id>/retry
```

---

## Mac Mini Reboot Recovery

After a hard reboot (power loss, OS update):

1. pm2 auto-restarts all processes if `pm2 startup` was run during setup
2. Verify with `make status` — all processes should be `online` within ~30s
3. If any process is `errored`, check `./node_modules/.bin/pm2 logs <name>` for the cause

If pm2 startup was never set up, processes won't auto-start. Fix:
```bash
make start
./node_modules/.bin/pm2 startup   # run the printed command as root
```

---

## Incident Runbook

### Dead letter spike

**Symptom:** `/status` reports many dead-lettered messages, or delivery is silently failing.

1. `make logs` — look for repeated errors in the delivery worker or adapter
2. Check adapter health: `curl http://localhost:3000/api/v1/health`
3. If Telegram is rate-limiting, wait and restart: `make restart`
4. Inspect dead letters: `/dead-letter` from any channel
5. Retry recoverable messages: `/dead-letter retry <id>`
6. Messages that fail 3 retries require manual investigation

### Summarizer not running

**Symptom:** `memory.last_summarizer_run` is stale in the health response, or context injection at session start returns no summaries.

1. `./node_modules/.bin/pm2 logs bus-core` — look for errors in the summarizer loop
2. Most common cause: invalid or expired Claude API key
3. Verify: `curl https://api.anthropic.com/v1/models -H "x-api-key: $CLAUDE_API_KEY"`
4. Rotate the key if needed (see above), then `pm2 restart bus-core`

### Bus-core won't start

**Symptom:** `pm2 status` shows bus-core `errored` and it keeps restarting.

1. `./node_modules/.bin/pm2 logs bus-core --lines 50` — most likely a config validation error
2. Common causes:
   - `config.yaml` references an env var not set in `.env`
   - `db_path` directory doesn't exist
   - Port 3000 already in use (`lsof -i :3000`)
3. Run manually for full error output: `AGENTBUS_CONFIG=./config.yaml npx tsx src/index.ts`

### Claude Code adapter not connecting

The claude-code-adapter is **not managed by pm2** — it's spawned by Claude Code via MCP. If tools aren't working in a Claude Code session:

1. Check Claude Code's MCP server config (`~/.claude/mcp.json` or equivalent)
2. Verify bus-core is running: `curl http://localhost:3000/api/v1/health`
3. Start a new Claude Code session (the adapter process is per-session)

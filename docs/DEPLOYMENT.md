# Deployment

bus-core runs as one pm2-managed process. Platform adapters (Telegram, email, the Pebble webhook) and the headless Claude Code adapter run inside it. The only separate process is the MCP server that `claude -p`, or an interactive Claude Code session, spawns.

## Prerequisites

- Node.js 20 or later and npm.
- The `claude` CLI on `PATH`, if you use the `cc-headless` adapter.
- Credentials for the channels you enable: a Telegram bot token from @BotFather, an IMAP/SMTP app-specific password for email.
- pm2 is a dev dependency. No global install is needed.

## First-time setup

1. Install dependencies:

   ```bash
   cd /path/to/agentbus
   npm install
   ```

2. Create the config files:

   ```bash
   cp .env.example .env
   cp config.yaml.example config.yaml
   ```

   `.env` holds secrets only and is never committed:

   ```
   TELEGRAM_BOT_TOKEN=...
   ICLOUD_APP_PW=...          # only if you enable the email adapter
   ANTHROPIC_API_KEY=...      # only if memory.structured_extraction is true
   ```

   `config.yaml` references them as `${VAR_NAME}`. A minimal headless deployment:

   ```yaml
   bus:
     http_port: 3000
     db_path: ~/.agentbus/agentbus.db

   adapters:
     telegram:
       token: ${TELEGRAM_BOT_TOKEN}
     cc-headless:
       agent_id: claude
       working_dir: /home/you/agent      # where the agent's CLAUDE.md and memory/ live
       system_prompt: |
         You are a helpful assistant for {{contact_id}} on {{channel}}. Today is {{date}}.
         Deliver every user-facing message with the `reply` tool, using the [id:<id>] shown.
         {{memories}}

   contacts:
     chris:
       id: chris
       displayName: Chris
       platforms:
         telegram:
           userId: 123456789

   pipeline:
     routes:
       - match: { channel: telegram }
         target: { adapterId: cc-headless, recipientId: agent:claude }
   ```

   `config.yaml.example` documents every option. A leading `~` in any path value expands to your home directory.

3. Run once in the foreground to create the database and apply migrations, then stop it with Ctrl+C:

   ```bash
   npx tsx src/index.ts
   ```

4. Start under pm2 and save the process list:

   ```bash
   make start
   ```

5. To restart after a reboot, run pm2's startup hook once and execute the command it prints:

   ```bash
   ./node_modules/.bin/pm2 startup
   ```

## Daily operations

| Target | What it does |
|---|---|
| `make start` | Start or restart `bus-core` under pm2 and save the process list |
| `make stop` | Stop and remove `bus-core` from pm2 |
| `make restart` | Restart `bus-core`. Use after config changes |
| `make status` | `pm2 describe bus-core` |
| `make logs` | Tail the `bus-core` log |
| `make dev` | Run in the foreground with `AGENTBUS_CONFIG` |
| `make debug-payloads` | Run in the foreground and log raw Telegram updates without forwarding them |
| `make kill` | Kill a foreground `src/index.ts` process |
| `make help` | List targets |

`AGENTBUS_CONFIG=/path/to/config.yaml` overrides the config location for every target.

`pm2 describe` scopes output to this process; the pm2 daemon is shared across every project on the machine. Its "Divergent env variables" table can print secrets to your terminal.

Log files: `~/.agentbus/logs/bus-core-out.log` and `~/.agentbus/logs/bus-core-error.log`.

### Safe restart

`scripts/safe_restart.sh [--notify-channel <channel>] [--notify-topic <topic>]` restarts bus-core from a detached process, waits for `/api/v1/health` to report healthy, and rolls back to `main` if it does not. Before restarting it creates a one-shot schedule with a 45-minute staleness ceiling, so the agent reports back in the conversation that asked for the restart even if the script itself is killed. Logs go to `logs/safe_restart/<timestamp>.log`. The script header describes the full sequence.

## Configuration changes

Edit `config.yaml` or `.env`, then `make restart`. There is no live reload.

## Startup order

bus-core loads config, opens SQLite and runs migrations, starts the HTTP server, then starts adapters, the delivery worker, headless instances, the session tracker, the attachment sweeper, and the scheduler. If Telegram or IMAP is unreachable, the adapter backs off and retries; startup does not fail.

## Exposing bus-core to a reverse proxy

By default bus-core binds `127.0.0.1`, reachable only from processes on the same machine. A webhook sender on another device (for example a Pebble Ring proxy) cannot reach a loopback-only port.

If your reverse proxy (nginx, Caddy, Nginx Proxy Manager) runs:

- **On this machine**, including a Docker Desktop for Mac container reaching host ports through `host.docker.internal`: no change is needed.
- **On another machine on your LAN**: set `bus.host: 0.0.0.0` in `config.yaml` and `make restart`. Loopback callers keep working.

Before widening `bus.host`, note that every route becomes reachable from the LAN, and most routes have no auth of their own (the Pebble webhook's bearer token is the exception). Set `bus.auth_token` as well, and point the proxy at only the paths you mean to expose, such as `/api/v1/webhooks/pebble`.

## FTS index recovery

If transcript search returns stale results, for example after restoring the database from a backup, rebuild the FTS5 indexes:

```bash
./node_modules/.bin/pm2 stop bus-core
AGENTBUS_CONFIG=/path/to/config.yaml npx tsx src/index.ts --rebuild-fts
# wait for "bus-core ready", then press Ctrl+C
./node_modules/.bin/pm2 start bus-core
```

The flag rebuilds the indexes during startup and then continues into normal operation. It does not exit on its own.

## Rotating secrets

1. Update the value in `.env`.
2. `make restart`. Adapters read tokens at startup only.

## Dead letters

Messages that cannot be delivered move from `message_queue` to the `dead_letter` table with a `reason`. There is no retry endpoint or slash command. Inspect and requeue by hand:

```bash
sqlite3 ~/.agentbus/agentbus.db \
  "SELECT created_at, reason, substr(payload,1,120) FROM dead_letter ORDER BY created_at DESC LIMIT 20"
```

`GET /api/v1/messages/:id` still returns a dead-lettered message by its original ID. Rows are kept indefinitely.

## Reboot recovery

If `pm2 startup` was configured, bus-core restarts automatically. Verify with `make status`. If it did not come back, run `make start`, then run the `pm2 startup` command again.

## Incident runbook

### Delivery failures

Symptom: replies stop arriving, or the `dead_letter` table grows.

1. `make logs` and look for `[delivery]`, `[telegram]`, or `[email]` errors.
2. `curl http://localhost:3000/api/v1/health` to check adapter status.
3. If Telegram is rate limiting, wait, then `make restart`.
4. Inspect the `dead_letter` table (above) for the failure reason.

### Headless turns fail or hang

Symptom: users receive the `error_reply` text, or nothing.

1. `make logs` and look for `[cc-headless]` lines. Set `error_passthrough: true` temporarily to see the raw failure in the reply.
2. Confirm `claude` runs from a shell as the pm2 user and that `working_dir` exists.
3. Send `/stop` from the affected chat to kill a stuck turn, or `/clear` to start a fresh session.

### bus-core won't start

Symptom: pm2 shows `errored` and keeps restarting.

1. `./node_modules/.bin/pm2 logs bus-core --lines 50`. The cause is usually config validation.
2. Common causes: a `${VAR}` in `config.yaml` missing from `.env`, port 3000 in use (`lsof -i :3000`), an invalid instance name, or a duplicate token.
3. Run in the foreground for the full error: `AGENTBUS_CONFIG=./config.yaml npx tsx src/index.ts`.

### Journaling never runs

Symptom: `last_journaled_at` on headless sessions stays stale while `last_activity` advances.

Look for `[session-tracker] Journaling sweep is a no-op bus-wide` in the logs. It means no `cc-headless` instance is configured or registered. See [MEMORY_MODEL.md](MEMORY_MODEL.md).

### Summarizer not running

Only relevant when `memory.structured_extraction: true`. Check for `[summarizer]` errors in the logs. The usual cause is a missing or invalid `ANTHROPIC_API_KEY`.

### Claude Code MCP adapter not connecting

The MCP server is spawned by Claude Code, not pm2. Check the project's `.mcp.json`, confirm bus-core is healthy, and start a new Claude Code session. See [CC_ADAPTER.md](CC_ADAPTER.md).

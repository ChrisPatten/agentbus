# E12 — Operational (Health, Daemon Management, Deployment)

| Field | Value |
|---|---|
| Epic ID | E12 |
| Build Order Position | 12 of 12 (last — depends on all adapters existing) |
| Dependencies | E3 (Telegram), E4 (BlueBubbles), E2 (Claude Code adapter), E1 (bus-core, MessageQueue) |
| Story Count | 3 |
| Estimated Complexity | S |

---

## Epic Summary

E12 makes AgentBus production-ready on the Mac mini: a health API that surfaces system state, a pm2 ecosystem file that manages all four daemon processes with correct restart policies, and a dead-letter management system for inspecting and recovering from message delivery failures. After E12, AgentBus can be started with a single `pm2 start ecosystem.config.js` command, monitored with `pm2 status`, and operated day-to-day without SSH debugging.

---

## Entry Criteria

- All adapter epics complete (E2, E3, E4) — processes are defined and start correctly in isolation
- E1 complete: `MessageQueue` has `dead_letter` table; E6's `/status` command is ready to consume health API
- pm2 is installed globally on the Mac mini (`npm install -g pm2`)
- Log directory exists or is created by pm2 config (e.g., `~/.agentbus/logs/`)
- `AppConfig` includes `http.port` for bus-core's API server

---

## Exit Criteria

- `GET /api/v1/health` returns a valid JSON response with all fields populated within 500ms
- `/status` slash command (E6) correctly uses the health API response to format its reply
- `pm2 start ecosystem.config.js` starts all 4 processes without errors
- `pm2 status` shows all 4 processes as `online`; `pm2 logs` shows output from all processes
- If bus-core crashes and restarts, all adapters reconnect automatically without manual intervention
- Dead-lettered messages are listed by `/dead-letter` command and auto-expired after 24 hours
- `pm2 save` + `pm2 startup` ensures all processes restart after Mac mini reboot

---

## Stories

### S12.1 — Health API

**User story:** As a system operator, I want a `/api/v1/health` endpoint that returns the current status of all bus components so that I can monitor AgentBus health from the command line or a dashboard without SSH-ing into the Mac mini.

**Acceptance criteria:**
- `GET /api/v1/health` returns HTTP 200 with JSON body: `{ status: "healthy"|"degraded"|"unhealthy", uptime_seconds: number, started_at: string, adapters: [{ id, status: "online"|"degraded"|"offline", last_seen_at: string, capabilities: AdapterCapabilities }], queue: { pending: number, processing: number, dead_letter: number }, memory: { last_summarizer_run: string|null, sessions_pending_summary: number }, version: string }`
- Overall `status` is `"healthy"` if all registered adapters are `"online"`; `"degraded"` if at least one is `"degraded"` or `"offline"`; `"unhealthy"` if bus-core itself has internal errors
- Queue counts are retrieved from SQLite with a single `SELECT status, COUNT(*) FROM message_queue GROUP BY status` query
- Adapter status is retrieved by calling `adapter.getStatus?.()` on each registered adapter (optional method); defaults to `"online"` if method is absent and adapter is registered
- `last_summarizer_run` is the `created_at` of the most recent `session_summaries` row
- `/status` slash command (E6) calls this endpoint and formats the response as a human-readable multi-line string

**Complexity:** S

---

### S12.2 — pm2 Ecosystem File

**User story:** As a system operator, I want a pm2 ecosystem configuration that starts all four AgentBus processes with correct environment variables, restart policies, and log paths so that I can manage the entire system with standard pm2 commands.

**Acceptance criteria:**
- `ecosystem.config.js` in the repo root defines 4 apps: `bus-core`, `telegram-adapter`, `bluebubbles-adapter`, `claude-code-adapter`
- Each app specifies: `script: "tsx"`, `args: "src/<path>/index.ts"`, `name`, `env_file: ".env"`, `log_file`, `error_file`, `max_memory_restart: "200M"`, `restart_delay: 3000`, `max_restarts: 10`, `autorestart: true`
- `claude-code-adapter` is set to `exec_mode: "fork"` and `autorestart: false` (it is spawned by Claude Code on demand, not kept alive by pm2); or alternatively, it is excluded from the ecosystem file with a note
- Log paths use `~/.agentbus/logs/{name}-out.log` and `~/.agentbus/logs/{name}-error.log`; a `scripts/setup.sh` creates these directories if absent
- `README.md` updated with: `pm2 start ecosystem.config.js`, `pm2 save`, `pm2 startup` instructions
- Integration check: run `pm2 start ecosystem.config.js --env production` on the Mac mini → verify all processes start and `pm2 status` shows `online`

**Complexity:** S

---

### S12.3 — Dead Letter Management

**User story:** As a system operator, I want to inspect and manage dead-lettered messages so that I can understand why deliveries failed, retry them if appropriate, and ensure the dead-letter queue doesn't grow unbounded.

**Acceptance criteria:**
- `/dead-letter` slash command (registered in E6, implemented here): queries `dead_letter` table for the 20 most recent rows, formats as a table with `message_id`, `channel`, `recipient_id`, `reason`, `dead_lettered_at`, `original_body` (truncated to 80 chars)
- `GET /api/v1/dead-letter` REST endpoint: returns paginated dead-letter entries (query params: `limit`, `offset`, `channel`, `since`); used by `/dead-letter` command and future tooling
- `POST /api/v1/dead-letter/{messageId}/retry` re-enqueues a dead-lettered message into `message_queue` with `status: "pending"` and removes it from `dead_letter`; returns `{ success: true, new_message_id }`
- Auto-expiry: the background sweep task (from E8 S8.2) also deletes `dead_letter` rows where `dead_lettered_at < now() - 24h`; returns count of deleted rows in sweep log
- Dead-letter table includes `retry_count` column; `retry` endpoint increments it; if `retry_count >= 3`, retry is rejected with `{ success: false, reason: "Max retries exceeded. Manual intervention required." }`
- Unit test: insert 5 dead-letter rows → run sweep with 24h+ age → verify 5 rows deleted; insert row → retry → verify in `message_queue`; retry 3 times → verify rejection

**Complexity:** S

---

## Notes

- **`claude-code-adapter` in pm2:** The Claude Code adapter is fundamentally different from the other three processes — it's spawned by Claude Code on demand, not kept alive independently. Including it in the pm2 ecosystem as `autorestart: false` is misleading. The recommended approach is to exclude it from pm2 entirely and document that it runs via Claude Code's MCP server config (`mcpServers` in Claude Code's settings). Clarify this in the README.
- **`max_memory_restart`:** 200MB per process is conservative for a TypeScript + SQLite application. Monitor actual usage after launch and increase if needed. `bus-core` is the most memory-intensive (SQLite cache, Fastify, all adapters registered). Consider 512MB for bus-core.
- **pm2 startup command:** `pm2 startup` generates a platform-specific init script command that must be run as root. Document this step explicitly in the README — it's commonly forgotten and the system won't restart after a reboot without it.
- **Health API adapter status:** The `adapter.getStatus?.()` optional method is new — it doesn't exist in E11's interface. Either add it as an optional method to `AdapterInstance` in a final interface patch, or have the health API derive status from `last_seen_at` timestamps that adapters update via a heartbeat ping to bus-core every 30s. The heartbeat approach is simpler and doesn't require interface changes.
- **Dead-letter retention:** 24 hours is the default auto-expiry. Make it configurable via `AppConfig.queue.dead_letter_ttl_hours`. Operators debugging persistent failures will want longer retention.
- **`/dead-letter retry` via slash command:** Consider adding a `/dead-letter retry <message_id>` sub-command in E6 for convenience. The REST endpoint exists for programmatic access; the slash command is for operator convenience from any channel.
- **Operational documentation:** E12 is a good forcing function to write the ops runbook. At minimum, document: how to start/stop the system, how to read logs, how to handle a dead-letter spike, how to force a session re-summarization, and how to rotate the Telegram bot token.

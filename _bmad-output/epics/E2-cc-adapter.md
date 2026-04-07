# E2 — Claude Code Channel Adapter

| Field | Value |
|---|---|
| Epic ID | E2 |
| Build Order Position | 2 of 12 |
| Dependencies | E1 (AppConfig, HTTP API base, AdapterRegistry) |
| Story Count | 4 |
| Estimated Complexity | M |

---

## Epic Summary

E2 delivers the first working end-to-end communication path: after this epic, Chris can send a message to Peggy via Claude Code and receive a reply routed back through the bus. The Claude Code adapter runs as an MCP server over stdio, spawned directly by Claude Code. It polls the bus HTTP API for pending inbound messages, exposes a `reply` tool for Peggy to respond, and emits structured channel events that Claude Code can observe as conversation context.

---

## Entry Criteria

- E1 complete: `AppConfig`, SQLite client, `MessageQueue`, and `AdapterRegistry` are implemented and tested
- Bus-core HTTP API surface is minimally available (POST `/api/v1/message/inbound`, GET `/api/v1/messages/pending/:recipientId`) — can be a stub/mock for early development
- `@modelcontextprotocol/sdk` installed and stdio transport is understood
- Agreed MCP tool schema for `reply` and `receive_messages` is documented

---

## Exit Criteria

- Running `npx tsx src/adapters/claude-code/index.ts` starts an MCP server that Claude Code can connect to over stdio
- Claude Code receives pending messages as MCP tool responses / channel events within 1–2 seconds of delivery
- Peggy (Claude) can call `reply` with a `message_id` and `body` and the message is delivered to the bus
- Health check endpoint or status tool reports adapter up/down and bus connectivity
- Adapter reconnects automatically if bus becomes unavailable without requiring a process restart
- All MCP tool schemas are validated with Zod; malformed arguments are rejected with a clear error message

---

## Stories

### S2.1 — MCP Server Scaffold

**User story:** As Claude Code, I want to connect to an MCP server over stdio that declares the `claude/channel` capability so that I have a stable, standards-compliant integration point for sending and receiving messages through AgentBus.

**Acceptance criteria:**
- Adapter entry point imports `@modelcontextprotocol/sdk` and initializes a `Server` with `stdio` transport
- Server declares capability: `{ capabilities: { tools: {}, channel: { id: "claude-code", version: "1.0" } } }`
- Startup sequence: load `AppConfig` → register with `AdapterRegistry` → initialize MCP server → begin polling loop
- Graceful shutdown on `SIGTERM`/`SIGINT`: stop polling, close MCP transport, deregister from `AdapterRegistry`
- Startup log line includes adapter ID, bus base URL, and MCP protocol version
- Process exits with code 1 and a clear error message if `AppConfig` fails to load

**Complexity:** S

---

### S2.2 — Bus Polling Loop

**User story:** As Claude Code, I want the adapter to continuously poll the bus for messages addressed to Peggy so that incoming messages appear in Claude Code's context within seconds of being enqueued, without requiring a persistent WebSocket connection.

**Acceptance criteria:**
- Polling loop calls `GET /api/v1/messages/pending/peggy?channel=claude-code` every 1000ms (interval configurable via `AppConfig`)
- Each pending message is emitted as an MCP `channel` event with the full `Envelope` payload serialized as JSON
- Successfully fetched messages are immediately acknowledged via `POST /api/v1/messages/ack` to prevent re-delivery
- If the HTTP request fails (network error, 5xx), the loop logs a warning and retries after the next interval; it does not crash
- Polling interval backs off to 5s after 3 consecutive failures; resets to 1s on success (configurable thresholds)
- Unit/integration test: enqueue a message → poll → verify event emitted and message acknowledged

**Complexity:** M

---

### S2.3 — `reply` Tool

**User story:** As Peggy (Claude), I want to call a `reply` MCP tool with a message ID and body so that my responses are routed back through the bus to the correct contact and channel without me needing to know the underlying transport.

**Acceptance criteria:**
- `reply` tool is registered with Zod-validated schema: `{ message_id: z.string(), body: z.string().min(1).max(4000) }`
- On call, adapter looks up the original message in the bus to retrieve `sender_id`, `channel`, and `conversation_id`
- POSTs a new outbound `Envelope` to `POST /api/v1/message/outbound` with `recipient_id`, `channel`, `body`, and `reply_to_message_id` set
- Returns `{ success: true, outbound_message_id: string }` on success
- Returns structured MCP error (`isError: true`, descriptive `content`) if `message_id` is unknown, body is empty, or bus POST fails
- Reply is delivered to the originating adapter (determined by `channel` field on the original message)

**Complexity:** M

---

### S2.4 — Health Check

**User story:** As a system operator, I want the Claude Code adapter to report its health status and automatically recover from bus unavailability so that temporary restarts of bus-core don't require manually restarting the adapter.

**Acceptance criteria:**
- A `get_adapter_status` MCP tool returns `{ status: "healthy"|"degraded"|"disconnected", bus_reachable: boolean, last_poll_at: string, consecutive_failures: number }`
- Adapter enters `degraded` state after 3 consecutive poll failures; enters `disconnected` after 10
- In `disconnected` state, adapter attempts a full re-registration with `AdapterRegistry` every 30s
- On successful reconnect, state returns to `healthy` and polling resumes at normal interval
- Adapter logs all state transitions at `warn` level with timestamp and failure reason
- Health state is exposed as an internal singleton so polling loop and tool handlers share the same state object

**Complexity:** S

---

## Notes

- **Stdio transport means one instance per Claude Code session.** Claude Code spawns the adapter as a child process; there is no "persistent adapter" for CC. Each Claude Code session gets its own adapter process. The bus uses `channel=claude-code` + `session_id` to route correctly.
- **Message acknowledgment timing:** Ack immediately on receipt from the poll response, not after emitting the MCP event. If the event emission fails, the message is already acked — this is an acceptable trade-off to prevent duplicate deliveries. Log a warning if event emission fails.
- **`reply` tool vs. `send_message` tool:** `reply` is the simple version for E2. The full `send_message` tool (with routing metadata, channel selection, etc.) belongs to E7. For E2, `reply` is sufficient for the hello-world path.
- **MCP `channel` event format:** At time of writing, the MCP spec's channel/event capability is evolving. Use `server.sendLoggingMessage()` or a custom notification if the channel event type isn't stable. Document the chosen approach clearly so E7 can align.
- **Bus HTTP API stub for early development:** E2 can be developed against a simple Fastify stub (3 routes) before bus-core's full HTTP layer is done. Write the stub as a dev fixture, not a production component.
- **Polling vs. SSE:** Long-polling or SSE would be more efficient, but polling keeps the adapter stateless and the bus simple. Revisit in a future epic if latency becomes a problem.

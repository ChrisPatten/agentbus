# E4 — BlueBubbles Adapter

| Field | Value |
|---|---|
| Epic ID | E4 |
| Build Order Position | 9 of 12 |
| Dependencies | E1 (AppConfig, AdapterRegistry, Envelope type), E5 (inbound pipeline endpoint) |
| Story Count | 3 |
| Estimated Complexity | M |

---

## Epic Summary

E4 delivers the iMessage channel via BlueBubbles: a Fastify webhook receiver that accepts incoming message events from the BlueBubbles server running, plus an HTTP client that delivers outbound messages and reactions back through BlueBubbles. After E4, users can message the agent via iMessage and receive replies with heart/thumbs reactions supported. Unlike the Telegram adapter's pull model, BlueBubbles pushes events to the adapter via webhooks.

---

## Entry Criteria

- E1 complete: `AppConfig` (including `adapters.bluebubbles.*` section with `server_url`, `password`, `webhook_port`), `AdapterRegistry`, and `Envelope` type are available
- E5 complete: `POST /api/v1/message/inbound` pipeline endpoint is live
- BlueBubbles server is running and configured to send webhooks to `http://localhost:{webhook_port}`
- E11 `AdapterInstance` interface is stable (or working draft exists)
- BlueBubbles API authentication (password) is set in `.env` (`BLUEBUBBLES_PASSWORD`)

---

## Exit Criteria

- Fastify webhook server starts on configured `webhook_port` and responds to BlueBubbles events
- New iMessage messages from allowed senders are wrapped and submitted to the bus pipeline
- Bus-initiated outbound messages are delivered to the correct iMessage chat via BlueBubbles API
- `markRead` and `react` capabilities work correctly with the tapback integer mapping
- Adapter starts cleanly even if BlueBubbles server is temporarily unavailable (health check warns, does not crash)
- Integration test: simulate BlueBubbles webhook POST → verify envelope POSTed to pipeline; enqueue outbound message → verify BlueBubbles API called

---

## Stories

### S4.1 — Webhook Receiver

**User story:** As the bus, I want a Fastify webhook server that receives BlueBubbles `new-message` events and submits them to the inbound pipeline so that iMessages appear in the agent's queue within seconds of being received.

**Acceptance criteria:**
- Adapter entry point: loads `AppConfig` → registers self with `AdapterRegistry` (id: `"bluebubbles"`, channels: `["imessage"]`) → starts Fastify on `AppConfig.adapters.bluebubbles.webhook_port` → starts outbound delivery loop
- Fastify route: `POST /webhook` — validates `Content-Type: application/json`; parses body; checks `type` field equals `"new-message"` (ignores other event types with `200 OK` and no action)
- Extracts from BlueBubbles payload: `handle.address` (sender phone/email), `chats[0].guid` (chat GUID), `text` (message body), `dateCreated` (Unix ms timestamp)
- Checks sender against `AppConfig.adapters.bluebubbles.allowed_senders[]`; if not in list, returns `200 OK` and drops (logs at `debug`)
- Constructs `Envelope` with `source_adapter_id: "bluebubbles"`, `channel: "imessage"`, `sender_id: handle.address`, `body: text`, `metadata: { chat_guid: chats[0].guid }`, `received_at: new Date(dateCreated).toISOString()`
- POSTs `Envelope` to bus inbound pipeline; responds `200 OK` to BlueBubbles regardless of pipeline POST result (to prevent BlueBubbles retrying)

**Complexity:** M

---

### S4.2 — Outbound Message Delivery

**User story:** As the bus, I want to deliver outbound messages to iMessage by calling the BlueBubbles REST API so that the agent's replies reach Chris in his iMessage conversation.

**Acceptance criteria:**
- Outbound delivery loop polls `GET /api/v1/messages/pending/bluebubbles` on bus-core every 1s
- For each pending message, calls `POST {server_url}/api/v1/message/text` with body: `{ chatGuid: envelope.metadata.chat_guid, message: envelope.body, tempGuid: envelope.message_id }`
- Authentication: adds `Authorization: Basic {base64(username:password)}` header or BlueBubbles-specific auth header format per their API spec
- On success (2xx), calls `MessageQueue.ack(message_id)` via bus API
- On failure (4xx/5xx/network error): logs at `error` with full response body; calls `MessageQueue.deadLetter(message_id, reason)` after 3 retries with 2s backoff
- Splits messages longer than 10,000 characters (BlueBubbles/iMessage practical limit) with a clear `[1/2]` prefix pattern; sends in sequence with 500ms delay

**Complexity:** S

---

### S4.3 — Adapter Capabilities: `markRead` and `react`

**User story:** As the bus, I want the BlueBubbles adapter to support iMessage tapback reactions and read receipts so that the agent can respond expressively to messages and Chris can see when his messages have been seen.

**Acceptance criteria:**
- `markRead(messageId: string, chatGuid: string): Promise<void>` — calls `POST {server_url}/api/v1/chat/{chatGuid}/read`; logs `warn` on failure but does not throw (fire-and-forget)
- `react(messageId: string, emoji: string): Promise<void>` — maps emoji to BlueBubbles tapback integer using the canonical mapping: `{ "❤️": 0, "👍": 1, "👎": 2, "😂": 3, "‼️": 4, "❓": 5 }`; calls `POST {server_url}/api/v1/message/{messageId}/react` with `{ tapback: integer }`; throws with descriptive error on unmapped emoji
- `registerCommands()` — logs `info: "BlueBubbles does not support native command registration"` and returns immediately (no-op)
- `capabilities` object declares: `{ canReact: true, canMarkRead: true, canTypingIndicator: false, canRegisterCommands: false, channels: ["imessage"] }`
- `markRead` is called by the bus post-delivery worker (E10) after successful outbound delivery; the `chat_guid` is retrieved from the original message's `metadata` field
- Unit tests: mock BlueBubbles API → call `react("👍")` → verify `tapback: 1` in request body; call `react("🤷")` → verify throws "Unmapped emoji"

**Complexity:** S

---

## Notes

- **BlueBubbles API authentication:** BlueBubbles uses a password-based HTTP Basic Auth or a query-parameter token depending on the server version. Check the running version's API docs (`GET {server_url}/api/v1/ping`) at startup and adapt. Store the auth strategy in the adapter config.
- **`chat_guid` is essential for outbound delivery.** Every outbound message to iMessage requires the BlueBubbles `chatGuid` (format: `iMessage;-;+1XXXXXXXXXX` or `iMessage;-;chat{hash}`). This must be captured from the inbound webhook and stored in `Envelope.metadata.chat_guid`. The pipeline's Stage 80 transcript logger must persist `metadata` to the `transcripts` table. Route-resolve (Stage 70) must pull `chat_guid` from the contact's stored metadata when initiating new conversations.
- **Webhook security:** BlueBubbles webhook POST has no built-in HMAC signature. The webhook listener is on `localhost` only — do not bind to `0.0.0.0`. This is the primary security boundary. Add a shared-secret header check if BlueBubbles supports it in the configured version.
- **BlueBubbles server availability:** BlueBubbles requires macOS with Messages.app. If BlueBubbles is not running, the adapter should start anyway (Fastify still listens for webhooks) and log a warning. Outbound delivery failures are handled by the retry/dead-letter mechanism.
- **iMessage `handle.address` format:** Addresses can be phone numbers (`+1XXXXXXXXXX`) or emails (Apple IDs). Normalize all phone numbers to E.164 format when constructing `sender_id`. Store the original BlueBubbles format in `metadata.raw_handle` for API calls.
- **`tempGuid` in outbound calls:** BlueBubbles uses `tempGuid` to deduplicate sends. Using `envelope.message_id` (a UUID) as `tempGuid` is correct and avoids double-sends on retry.
- **Tapback mapping is fixed:** The 6 tapback values (0–5) are defined by Apple's protocol and surfaced through BlueBubbles. Do not add custom values. The emoji↔integer mapping in S4.3 is the canonical map used throughout the system (E7's `react_to_message` schema derives from this).

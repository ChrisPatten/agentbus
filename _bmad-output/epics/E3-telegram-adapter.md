# E3 — Telegram Adapter

| Field | Value |
|---|---|
| Epic ID | E3 |
| Build Order Position | 8 of 12 |
| Dependencies | E1 (AppConfig, AdapterRegistry, Envelope type), E5 (inbound pipeline HTTP endpoint) |
| Story Count | 4 |
| Estimated Complexity | M |

---

## Epic Summary

E3 delivers the Telegram channel: a persistent daemon process that long-polls the Telegram Bot API for new messages, wraps them in `Envelope` objects, submits them to the bus inbound pipeline, and sends replies back to Telegram when the bus delivers outbound messages. After E3, Chris can message Peggy via Telegram and receive replies, with full typing indicators, read receipts, and native slash command autocomplete.

---

## Entry Criteria

- E1 complete: `AppConfig` (including `adapters.telegram.*` section), `AdapterRegistry`, and `Envelope` type are available
- E5 complete: `POST /api/v1/message/inbound` pipeline endpoint is live and accepting `Envelope` payloads
- Telegram Bot token is provisioned and set in `.env` (`TELEGRAM_BOT_TOKEN`)
- `allowed_sender_ids` list is configured in `AppConfig.adapters.telegram.allowed_sender_ids[]`
- E11 `AdapterInstance` interface is stable (or at minimum a working draft exists)

---

## Exit Criteria

- Telegram adapter process starts, registers with `AdapterRegistry`, and begins long-polling without errors
- Messages from allowed senders are received, wrapped, and POST'd to the bus pipeline within 2 seconds
- Messages from disallowed senders are silently dropped (logged at `debug`, no response sent)
- Bus-initiated outbound messages are delivered to Telegram successfully
- Typing indicator is sent before replies; read receipts are updated after delivery
- Adapter reconnects with exponential backoff after Telegram API failures
- Slash commands registered via `setMyCommands` appear in Telegram's command menu

---

## Stories

### S3.1 — Telegram Adapter Scaffold + Long-Poll Loop

**User story:** As bus-core, I want the Telegram adapter to run as a persistent process that long-polls the Telegram Bot API for updates so that new messages are received in near-real-time without requiring a public webhook endpoint.

**Acceptance criteria:**
- Adapter entry point: loads `AppConfig` → registers self with `AdapterRegistry` (id: `"telegram"`, channels: `["telegram"]`) → starts long-poll loop
- Long-poll loop calls `GET https://api.telegram.org/bot{TOKEN}/getUpdates?offset={next_offset}&timeout=30` in a continuous `while(true)` loop
- `next_offset` is updated to `last_update_id + 1` after each successful batch; persists in-memory (resets to 0 on process restart — Telegram Bot API handles re-delivery)
- On Telegram API error (non-2xx or network failure): logs at `warn` level with status code and message, waits for backoff interval, retries
- Backoff strategy: 1s → 2s → 4s → 8s → 16s → 30s (max); resets to 1s after a successful poll
- Graceful shutdown on `SIGTERM`/`SIGINT`: sets a `stopping` flag, allows current poll to complete (up to 30s), deregisters from `AdapterRegistry`

**Complexity:** S

---

### S3.2 — Inbound Message Processing

**User story:** As the bus, I want the Telegram adapter to transform incoming Telegram updates into canonical `Envelope` objects and submit them to the inbound pipeline so that all processing (dedup, routing, transcript) applies uniformly regardless of source channel.

**Acceptance criteria:**
- For each `Message` object in a `getUpdates` response, adapter checks `from.id` against `AppConfig.adapters.telegram.allowed_sender_ids`; drops (logs at `debug`) if not in the allowlist
- Constructs `Envelope` with: `source_adapter_id: "telegram"`, `channel: "telegram"`, `sender_id: String(from.id)`, `sender_display_name: from.first_name + last_name`, `body: message.text`, `raw_payload: JSON.stringify(update)`, `received_at: new Date(message.date * 1000).toISOString()`
- POSTs `Envelope` to `POST /api/v1/message/inbound` on bus-core; handles 2xx as success
- On bus POST failure (4xx/5xx/network): logs at `error` level with the failed envelope; does not retry (relies on Telegram re-delivery via `offset` not advancing if POST throws before `next_offset` update)
- Handles `caption` field for photo/document messages (uses `caption` as `body` if `text` is absent); other non-text updates (stickers, location) are logged at `debug` and skipped

**Complexity:** S

---

### S3.3 — Outbound Message Delivery

**User story:** As the bus, I want to deliver outbound messages to Telegram by calling `sendMessage` so that Peggy's replies reach Chris in his Telegram chat.

**Acceptance criteria:**
- Adapter exposes `sendMessage(envelope: Envelope): Promise<void>` on its `AdapterInstance` interface implementation
- Calls `POST https://api.telegram.org/bot{TOKEN}/sendMessage` with `{ chat_id: envelope.recipient_id, text: envelope.body, parse_mode: "Markdown" }`
- Splits messages longer than 4096 characters into sequential sends (Telegram's hard limit); each part is sent with a 200ms delay between sends
- On Telegram API error (non-2xx), throws with a descriptive error; bus-core is responsible for dead-lettering or retrying
- `sendMessage` is called by the bus delivery worker, which polls `MessageQueue.dequeue("telegram")` and dispatches
- Bus delivery worker for Telegram runs inside the Telegram adapter process (not bus-core); it polls `GET /api/v1/messages/pending/telegram` every 1s

**Complexity:** S

---

### S3.4 — Adapter Capabilities

**User story:** As the bus, I want the Telegram adapter to support read receipts, typing indicators, and slash command registration so that Telegram conversations feel native and responsive.

**Acceptance criteria:**
- `markRead(messageId: string): Promise<void>` — for Telegram, "read" is tracked by advancing the `offset` in the long-poll loop (which happens automatically); this method is a no-op that logs `debug: "markRead: Telegram uses offset advancement"` — returns immediately without error
- `sendTyping(chatId: string): Promise<void>` — calls `POST /sendChatAction` with `{ chat_id: chatId, action: "typing" }`; called by the delivery worker before sending a reply; Telegram shows typing for 5s so this is a best-effort fire-and-forget
- `registerCommands(commands: CommandManifest[]): Promise<void>` — calls `POST /setMyCommands` with the `commands` array mapped to `{ command: name.replace(/^\//, ''), description }`; command names must be lowercase letters, digits, underscores only (sanitize before sending)
- `capabilities` object on the adapter instance declares: `{ canReact: false, canMarkRead: false, canTypingIndicator: true, canRegisterCommands: true, channels: ["telegram"] }`
- Unit test: mock Telegram API → call `registerCommands([{ name: "/status", description: "..." }])` → verify `setMyCommands` called with correct payload

**Complexity:** S

---

## Notes

- **Long-polling vs. webhooks:** Long-polling is the right choice here since the Mac mini is behind a NAT/router and doesn't have a public IP. Telegram supports long-polling indefinitely; it's not a "fallback" — it's a fully supported mode.
- **`offset` persistence:** The current design resets `offset` on restart, relying on Telegram to re-deliver unprocessed updates (messages received while the adapter was down). Telegram keeps updates for 24 hours. For a personal assistant, this is acceptable. If at-most-once delivery is needed, persist `offset` to SQLite.
- **Rate limiting:** Telegram Bot API allows 30 messages/second to different chats, 1 message/second to the same chat. For a personal assistant with one primary user, this is never a concern. Don't add rate limiting logic in E3.
- **Group chat messages:** The allowlist check uses `from.id` (the user), not `chat.id`. If the bot is added to a group, messages from the allowed sender in that group would pass the filter. Consider adding a `allowed_chat_ids` config alongside `allowed_sender_ids` for tighter control.
- **Markdown parsing:** Using `parse_mode: "Markdown"` means Peggy can use `*bold*`, `_italic_`, and `` `code` `` in replies. However, unescaped special characters in her replies could cause Telegram API errors. Consider switching to `MarkdownV2` with proper escaping or using `HTML` mode. Document the choice.
- **Delivery worker architecture:** The Telegram adapter hosts its own outbound delivery loop (polling the bus queue). This is a deliberate architectural choice: each adapter is responsible for its own delivery timing, retry policy, and formatting. Bus-core enqueues; adapters dequeue and deliver.

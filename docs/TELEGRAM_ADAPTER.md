# Telegram Adapter

The Telegram adapter (`src/adapters/telegram.ts`) is a platform adapter that bridges Telegram and the AgentBus bus-core. It runs in-process with bus-core and is registered in the `AdapterRegistry` at startup.

---

## Architecture

```
Telegram Bot API  <──long-poll──>  TelegramAdapter (in bus-core)  <──direct──>  pipeline / queue
```

The adapter class implements `AdapterInstance` and provides:

- **Inbound loop** — long-polls `getUpdates` from Telegram, submits messages directly to the pipeline via `processInbound()` (no HTTP hop)
- **`send(envelope)`** — called by the delivery worker to deliver outbound messages via Telegram's `sendMessage` API

The adapter does not communicate with bus-core over HTTP. It receives infrastructure dependencies (config, pipeline, queue, db) via constructor injection.

---

## Running

The Telegram adapter starts automatically when bus-core starts, provided `adapters.telegram` is present in `config.yaml`:

```bash
AGENTBUS_CONFIG=/path/to/config.yaml npx tsx src/index.ts
```

Or via pm2: `make start`

---

## Configuration

The adapter requires an `adapters.telegram` section in `config.yaml`:

```yaml
adapters:
  telegram:
    token: ${TELEGRAM_BOT_TOKEN}   # from .env
    poll_timeout: 30               # Telegram long-poll timeout in seconds
```

**Allowed senders** are derived automatically from the contacts map — any contact with a `platforms.telegram.userId` is permitted:

```yaml
contacts:
  alice:
    id: alice
    displayName: Alice
    platforms:
      telegram:
        userId: 123456789
```

There is no separate `allowed_sender_ids` config — the contacts map is the source of truth.

**Validation:** At construction, each contact's `platforms.telegram.userId` is validated to be a positive integer. An invalid value throws an error that prevents bus-core from starting.

---

## Inbound Flow

1. `getUpdates` returns new messages from Telegram
2. For each `message` update:
   - Sender `from.id` is checked against the allowed-sender set (derived from contacts); unknown senders are silently dropped
   - Body is taken from `message.text` or `message.caption`; non-text updates (stickers, etc.) are skipped
   - Message is submitted directly to `processInbound()` with:
     - `channel: "telegram"`
     - `sender: "{from.id}"` (raw Telegram user ID)
     - `metadata.telegram_chat_id`, `metadata.telegram_message_id`, and `metadata.platform_message_id` (encoded as `"{chat_id}:{message_id}"` for use by `react()`)
3. The inbound pipeline's contact-resolve stage maps the raw user ID to `contact:{id}`
4. Route-resolve routes the message to the CC adapter

**Offset management:** The Telegram update offset is only advanced after a successful pipeline submission. If processing fails, the offset stays at the failed update, causing Telegram to redeliver on the next poll.

**Backoff:** On Telegram API errors, the inbound loop backs off exponentially: 1s -> 2s -> 4s -> 8s -> 16s -> 30s (max), resetting to 1s on success.

**Loop supervision:** The inbound loop runs under a `supervise()` wrapper. If the loop throws unexpectedly, the crash is logged and the loop is restarted after 5 seconds. The adapter's `stop()` method interrupts sleeping loops immediately via `AbortController`.

**Typing indicator:** After each inbound message is accepted, a per-chat typing loop starts and resends `sendChatAction('typing')` every 4 seconds. The loop runs until the agent calls `reply`/`send_message` (which triggers `send()`, stopping the loop), or until a 2-minute safety timeout expires. Only one loop runs per chat at a time.

**Reactions:** Inbound messages include `platform_message_id` in metadata, encoded as `"{chat_id}:{message_id}"`. The `react()` method parses this string and calls `sendReaction` with the emoji. Input emoji are normalised by stripping variation selectors (U+FE0F) before the API call. If the emoji is not in Telegram's supported reaction set, it is sent as a plain text message to the chat instead — reactions never fail silently or throw for an unsupported emoji.

---

## Outbound Flow

Outbound delivery is handled by the bus-core delivery worker, which calls `adapter.send(envelope)` directly:

1. Delivery worker dequeues messages with `contact:*` recipients from the message queue
2. Resolves the target adapter from `metadata.adapter_id` or by channel lookup
3. Calls `TelegramAdapter.send(envelope)` which:
   - Resolves the chat ID from the contact's `platforms.telegram.userId` in config
   - Stops the persistent typing indicator loop for this chat (if one is running)
   - Splits the body into chunks <=4096 chars (Telegram's hard limit), splitting on newlines where possible
   - Sends each chunk via `sendMessage` with `parse_mode: "Markdown"`
   - If Telegram returns HTTP 400 (malformed markdown), retries without `parse_mode`
   - Returns `DeliveryResult` with success/failure status
4. Delivery worker ACKs or dead-letters the message based on the result

---

## Slash Commands

At startup, the adapter calls `setMyCommands` to register a menu of slash commands in Telegram:

| Command | Description |
|---|---|
| `/status` | Check AgentBus status |
| `/help` | Show available commands |

This causes Telegram to display autocomplete suggestions when users type `/` in the bot chat.

---

## Capabilities

| Capability | Supported |
|---|---|
| Typing indicator | Yes — persistent loop, stays active while agent works |
| Read receipts | No |
| Slash command registration | Yes (`setMyCommands`) |
| Reactions | Yes (`sendReaction` with emoji) |
| Message splitting | Yes (chunks <=4096 chars) |
| Markdown formatting | Yes (`parse_mode: "Markdown"`) |

---

## Troubleshooting

**Messages not being received:**
- Verify `TELEGRAM_BOT_TOKEN` is set in `.env` and that the token is valid
- Check that your Telegram user ID is in `config.contacts` under `platforms.telegram.userId`
- Confirm bus-core is running: `curl http://localhost:3000/api/v1/health`
- Check `make logs` for `[telegram]` errors

**Replies not being delivered:**
- Check that `pipeline.routes` in `config.yaml` routes inbound messages correctly
- Check `make logs` for `[delivery]` or `[telegram]` errors
- Confirm the health endpoint shows the Telegram adapter: `curl http://localhost:3000/api/v1/health`

**Markdown rendering issues:**
- The adapter retries failed sends without `parse_mode` when Telegram returns HTTP 400
- If replies contain unescaped special characters frequently, consider updating the agent's system prompt to avoid them

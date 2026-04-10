# Telegram Adapter

The Telegram adapter (`src/adapters/telegram.ts`) is a persistent daemon process that bridges Telegram and the AgentBus bus-core. It runs as a separate process alongside bus-core, communicating with it exclusively over the bus HTTP API.

---

## Architecture

```
Telegram Bot API  <──long-poll──>  telegram adapter  <──HTTP──>  bus-core
```

Two concurrent loops run inside the process:

- **Inbound loop** — long-polls `getUpdates` from Telegram, submits messages to `POST /api/v1/inbound`
- **Outbound loop** — polls `GET /api/v1/messages/pending?recipient=contact:{id}` for each Telegram-enabled contact, delivers replies via `sendMessage`

The adapter does not import bus-core internals. It shares only `src/config/loader.ts` and `src/types/envelope.ts`.

---

## Running

```bash
AGENTBUS_CONFIG=/path/to/config.yaml npx tsx src/adapters/telegram.ts
```

Or via pm2 (see `docs/DEPLOYMENT.md`).

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

**Validation:** At startup, each contact's `platforms.telegram.userId` is validated to be a positive integer. An invalid value causes the adapter to exit immediately with an error.

---

## Inbound Flow

1. `getUpdates` returns new messages from Telegram
2. For each `message` update:
   - Sender `from.id` is checked against the allowed-sender set (derived from contacts); unknown senders are silently dropped
   - Body is taken from `message.text` or `message.caption`; non-text updates (stickers, etc.) are skipped
   - Envelope is POSTed to `POST /api/v1/inbound` with:
     - `channel: "telegram"`
     - `sender: "{from.id}"` (raw Telegram user ID)
     - `metadata.telegram_chat_id` and `metadata.telegram_message_id`
3. The inbound pipeline's contact-resolve stage maps the raw user ID to `contact:{id}`
4. Route-resolve routes the message to the CC adapter

**Offset management:** The Telegram update offset is only advanced after a successful POST to the bus. If the POST fails, the offset stays at the failed update, causing Telegram to redeliver on the next poll.

**Backoff:** On Telegram API errors, the inbound loop backs off exponentially: 1s → 2s → 4s → 8s → 16s → 30s (max), resetting to 1s on success.

**Loop supervision:** Both loops run under a `supervise()` wrapper. If a loop throws unexpectedly, the crash is logged and the loop is restarted after 5 seconds. Shutdown signals (`SIGTERM`/`SIGINT`) interrupt sleeping loops immediately via `AbortController`.

---

## Outbound Flow

1. At startup, the adapter derives the list of Telegram-reachable recipients from `config.contacts`
2. Every 2 seconds, for each recipient (e.g. `contact:alice`), it polls `GET /api/v1/messages/pending?recipient=contact:{id}&limit=10`
3. For each pending message:
   - Sends a typing indicator (`sendChatAction`) as fire-and-forget (failures are logged as warnings, not silently swallowed)
   - Splits the body into chunks ≤4096 chars (Telegram's hard limit), splitting on newlines where possible
   - Sends each chunk via `sendMessage` with `parse_mode: "Markdown"`
   - If Telegram returns HTTP 400 (malformed markdown), retries without `parse_mode` (text is delivered as plain text)
   - If delivery fails mid-way through a multi-part message, the error is enriched with partial delivery context (`Partial delivery (N/M parts sent): ...`) before dead-lettering
   - ACKs the message via `POST /api/v1/messages/:id/ack { status: "delivered" }` with up to 3 retries on transient failures
   - On unrecoverable delivery failure, dead-letters via `{ status: "failed", error: ... }` (also retried up to 3 times)

The chat ID for outbound messages is resolved from `contact.platforms.telegram.userId` in the config (correct for DM conversations; Telegram DM `chat.id === user.id`).

---

## Slash Commands

At startup, the adapter calls `setMyCommands` to register a menu of slash commands in Telegram:

| Command | Description |
|---|---|
| `/status` | Check AgentBus status |
| `/help` | Show available commands |

This causes Telegram to display autocomplete suggestions when users type `/` in the bot chat.

---

## Auth

If `config.bus.auth_token` is set, the adapter injects it as an `X-Bus-Token` header on all requests to bus-core. This matches the auth middleware in `src/http/api.ts`.

---

## Capabilities

| Capability | Supported |
|---|---|
| Typing indicator | Yes (`sendChatAction: "typing"`) |
| Read receipts | No (offset advancement is implicit) |
| Slash command registration | Yes (`setMyCommands`) |
| Reactions | No |
| Message splitting | Yes (chunks ≤4096 chars) |
| Markdown formatting | Yes (`parse_mode: "Markdown"`) |

---

## Troubleshooting

**Messages not being received:**
- Verify `TELEGRAM_BOT_TOKEN` is set in `.env` and that the token is valid
- Check that your Telegram user ID is in `config.contacts` under `platforms.telegram.userId`
- Confirm bus-core is running: `curl http://localhost:3000/api/v1/health`

**Replies not being delivered:**
- Check that `pipeline.routes` in `config.yaml` routes inbound messages to `{ adapterId: "claude-code", recipientId: "agent:claude" }`
- Check `pm2 logs telegram-adapter` for delivery errors
- Inspect the dead-letter queue via `GET /api/v1/dead-letter`

**Markdown rendering issues:**
- The adapter retries failed sends without `parse_mode` when Telegram returns HTTP 400
- If replies contain unescaped special characters frequently, consider updating the agent's system prompt to avoid them

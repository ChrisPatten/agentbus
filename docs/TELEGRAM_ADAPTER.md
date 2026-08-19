# Telegram Adapter

The Telegram adapter (`src/adapters/telegram.ts`) is a platform adapter that bridges Telegram and the AgentBus bus-core. It runs in-process with bus-core and is registered in the `AdapterRegistry` at startup.

---

## Architecture

```
Telegram Bot API  <──long-poll──>  TelegramAdapter (in bus-core)  <──direct──>  pipeline / queue
```

The adapter class implements `AdapterInstance` and provides:

- **Inbound loop** — long-polls `getUpdates` from Telegram, submits messages directly to the pipeline via `processInbound()` (no HTTP hop). Photos and documents of any MIME type are downloaded to the target agent's `media.download_path` — see [ATTACHMENTS.md](./ATTACHMENTS.md).
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

### Single bot (default)

```yaml
adapters:
  telegram:
    token: ${TELEGRAM_BOT_TOKEN}   # from .env
    poll_timeout: 30               # Telegram long-poll timeout in seconds
```

The adapter id is `telegram` and inbound messages use channel `telegram`.

### Multiple bots

Use a named record under `adapters.telegram`. Each key becomes the bot's name, which is appended to the adapter id and channel:

```yaml
adapters:
  telegram:
    peggy:
      token: ${TELEGRAM_BOT_TOKEN_PEGGY}
      poll_timeout: 30
    jarvis:
      token: ${TELEGRAM_BOT_TOKEN_JARVIS}
      poll_timeout: 30
```

This registers two adapters: `telegram:peggy` and `telegram:jarvis`, with channels `telegram:peggy` and `telegram:jarvis` respectively.

Route inbound messages to the correct agent with `pipeline.routes`:

```yaml
pipeline:
  routes:
    - match:
        channel: telegram:peggy
      target:
        adapterId: claude-code
        recipientId: agent:peggy

    - match:
        channel: telegram:jarvis
      target:
        adapterId: claude-code
        recipientId: agent:jarvis
```

Each bot/agent pair gets an independent conversation_id so their histories never collide. The same contact can message both bots — Telegram user IDs are global and the contact lookup works on any `telegram:*` channel.

**Validation:** Duplicate tokens across instances cause a startup error. Instance names must match `^[a-z0-9_-]+$` (lowercase letters, digits, hyphens, underscores) — names containing colons, slashes, or uppercase letters are rejected at startup.

**Migrating from single-bot:** Switching an existing deployment to named bots requires updating routing rules. The legacy `channel: telegram` route rule uses exact matching and will **not** match traffic from `telegram:peggy` or `telegram:jarvis`. Replace the old rule with per-instance rules as shown above.

**Per-channel config (on_session_close, session_close_min_messages):** These memory settings use exact channel-name matching. A config key of `telegram` does not match `telegram:peggy` sessions. When using named instances, configure each channel explicitly:

```yaml
memory:
  on_session_close:
    telegram:peggy: "tmux send-keys -t peggy '/clear' Enter"
    telegram:jarvis: "tmux send-keys -t jarvis '/clear' Enter"
  session_close_min_messages:
    telegram:peggy: 1
    telegram:jarvis: 3
```

---

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

**Contact access is instance-global:** All contacts with a `platforms.telegram.userId` are permitted to message every Telegram bot instance. There is no per-bot allowlist — the contacts map is the single source of truth for all instances. If you need to restrict which contacts can reach which agent, enforce that at the routing layer (e.g. `match: { channel: telegram:peggy, sender: contact:alice }`).

---

## Inbound Flow

1. `getUpdates` subscribes to `message` and `message_reaction_updated` updates from Telegram
2. For each `message` update:
   - Sender `from.id` is checked against the allowed-sender set (derived from contacts); unknown senders are silently dropped
   - Body is taken from `message.text` or `message.caption`; non-text, non-file updates (stickers, voice messages, etc.) are skipped
   - Message is submitted directly to `processInbound()` with:
     - `channel: "telegram"` (single-bot) or `channel: "telegram:{name}"` (named instance, e.g. `"telegram:peggy"`)
     - `sender: "{from.id}"` (raw Telegram user ID)
     - `metadata.telegram_chat_id`, `metadata.telegram_message_id`, and `metadata.platform_message_id` (encoded as `"{chat_id}:{message_id}"` for use by `react()`)
3. For each `message_reaction_updated` update:
   - Anonymous admin reactions (no `user` field) are silently skipped
   - Sender is checked against the allowed-sender set; unknown senders are dropped
   - The net emoji change is computed: added emojis (in `new_reaction` but not `old_reaction`) take precedence over removed ones; custom-emoji-only changes are dropped
   - A `reaction` payload is submitted to `processInbound()`:
     - `payload.type: "reaction"`, `payload.emoji: "<emoji>"`, `payload.removed: false/true`
     - `payload.target_message_id`: `"{chat_id}:{message_id}"` of the reacted-to message
     - Same metadata fields as regular messages (`telegram_chat_id`, `telegram_message_id`, `platform_message_id`)
4. The inbound pipeline's contact-resolve stage maps the raw user ID to `contact:{id}`
5. Route-resolve routes the message to the CC adapter

The CC adapter renders reaction payloads as:
- Added: `[reacted 👍 to message {chat_id}:{msg_id}]`
- Removed: `[removed reaction 👍 to message {chat_id}:{msg_id}]`

**Offset management:** The Telegram update offset is only advanced after a successful pipeline submission. If processing fails, the offset stays at the failed update, causing Telegram to redeliver on the next poll.

**Backoff:** On Telegram API errors, the inbound loop backs off exponentially: 1s -> 2s -> 4s -> 8s -> 16s -> 30s (max), resetting to 1s on success.

**Loop supervision:** The inbound loop runs under a `supervise()` wrapper. If the loop throws unexpectedly, the crash is logged and the loop is restarted after 5 seconds. The adapter's `stop()` method interrupts sleeping loops immediately via `AbortController`.

**Typing indicator:** The typing loop does not start when the message is received — it starts when the CC adapter confirms the message was delivered to the agent (via `POST /api/v1/adapters/telegram/typing`). This prevents the indicator from firing for messages that are queued but never reach an active Claude Code session. Once started, the loop resends `sendChatAction('typing')` every 4 seconds until `send()` is called for that chat, or the 2-minute safety timeout expires. Only one loop runs per chat at a time.

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

## Live Tool-Call Status Stream (E29)

While a headless agent works on a turn, `TelegramAdapter` surfaces its tool
calls live as a single evolving message, replaced by the final answer once
delivered — instead of just a typing indicator.

1. `cc-headless.ts` already runs `claude -p --output-format stream-json` and
   parses the resulting JSONL stream. For every `tool_use` block that isn't
   the `reply`/`send_message` delivery tools, it formats a short summary
   (`formatToolCallSummary`, `src/adapters/tool-call-summary.ts`) and POSTs it
   to `POST /api/v1/adapters/:id/tool-status` — the same HTTP-bridge pattern
   the existing typing indicator uses (`POST /api/v1/adapters/:id/typing`).
2. **Summary derivation:** `Bash` and `Agent` (subagent launch) tool calls
   carry their own required `description` field, used verbatim (`🐚 {description}`,
   `🤖 {description}`) — zero synthesis. `Read`, `Edit`, `Write`, `Grep`,
   `WebFetch`, and `WebSearch` render via a small fixed per-tool template
   (e.g. `Read` → `📖 Reading {file_path}`). Any other tool name, or a covered
   tool missing its expected field, falls back to the identical generic line:
   `⚙️ Running {name}`.
3. **Subagent internals are never shown.** An `Agent` tool call renders as one
   collapsed line — nothing about what the subagent does internally reaches
   the trail.
4. **Draft-message lifecycle:** the first tool-call line sends a new message
   (`sendMessage`) and records its `message_id`; every subsequent line is
   appended and the message is updated via `editMessageText`. Edits are
   batched to roughly one per second per chat — rapid-fire tool calls
   accumulate into a single edit rather than one API call each.
5. **Length cap:** if the accumulated trail would exceed a configured
   character budget (comfortably under Telegram's 4096-char limit), the
   oldest whole lines are dropped from the visible text (never mid-line),
   prefixed with `… (earlier steps omitted)`.
6. **Overwrite on delivery:** when the agent's answer is ready, `send()`
   overwrites the same message with the final text via `editMessageText`
   instead of sending a new one — no separate draft/final messages. If the
   overwrite edit fails (e.g. the draft was deleted), it falls back to a
   fresh `sendMessage` so the answer is never lost. A turn with no
   qualifying tool calls behaves exactly as before: one message sent once,
   no draft, no edits.
7. **Non-goals:** token-level text streaming (`--include-partial-messages`)
   and surfacing thinking-trace content are both explicitly deferred — see
   the E29 epic's Notes (`_bmad-output/epics/E29-telegram-tool-call-status-stream.md`)
   for why (Telegram's own edit-rate limits already approximate this
   feature's batching cadence, and the main agent's own thinking-block shape
   is unverified against this pipeline).
8. This feature is Telegram-only: the `onToolCall` callback added to
   `invokeClaude()` is generic, but only a Telegram-backed adapter registers
   `capabilities.toolStatus` — other channels see no behavior change.
9. **`/stop` finalizes an open draft instead of abandoning it.** Cancelling
   a turn (see [SLASH_COMMANDS.md](./SLASH_COMMANDS.md#stop)) calls
   `TelegramAdapter.finalizeDraft(contactId, note)`: any pending batch timer
   is cancelled, `note` (e.g. "Stopped by user") is appended as a final line,
   and the message is edited one last time before being dropped from the
   draft map — it persists in the chat exactly as left, and is never touched
   by a later edit or overwrite. `finalizeDraft` returns `true` when it found
   and finalized a draft, `false` when there was nothing open — `/stop`'s
   command handler uses this to skip sending its own generic confirmation
   reply when the finalized draft already told the user, so cancelling a
   turn never produces two separate "stopped" messages. `finalizeDraft` also
   unconditionally stops the persistent typing indicator for the chat
   (whether or not a draft was open) — otherwise it would keep blinking for
   up to its 2-minute safety timeout after the turn was already killed.

**Known limitation:** if bus-core crashes mid-turn, a draft message can be
left showing a stale tool-call trail on Telegram forever (the same exposure
the persistent typing indicator already has, just visually stickier). No
crash-recovery/orphan-cleanup exists for this today.

---

## Slash Commands

At startup, the adapter calls `setMyCommands` to register a menu of slash commands in Telegram:

| Command | Description |
|---|---|
| `/status` | Check AgentBus status |
| `/help` | Show available commands |

This causes Telegram to display autocomplete suggestions when users type `/` in the bot chat. The full bus-scope command list comes from the `CommandRegistry`, not the abbreviated table above.

**Command scopes.** Telegram resolves a chat's command menu by scope precedence — `chat` (a specific chat) > `all_private_chats` > `all_group_chats` > `default`. The adapter writes the command list to **both** the `default` scope and the `all_private_chats` scope. Writing only `default` is a known footgun: a stale `all_private_chats` set (commonly left behind by BotFather, e.g. `/start`, `/help`, `/status`) **shadows** the default list in 1:1 chats, so newly registered commands never appear in autocomplete. Setting `all_private_chats` explicitly on every startup keeps the private-chat menu in sync with the live registry. The startup log confirms the list Telegram returns for the `all_private_chats` scope — i.e. what you will actually see.

---

## Capabilities

| Capability | Supported |
|---|---|
| Typing indicator | Yes — persistent loop, stays active while agent works |
| Live tool-call status stream | Yes — see [Live Tool-Call Status Stream](#live-tool-call-status-stream-e29) |
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

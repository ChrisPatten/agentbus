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

## Group Topics & Replies (E28)

A topic-enabled Telegram **group** (a supergroup with Forum Topics turned on)
becomes its own channel, distinct from any member's DM — and each forum topic
within it becomes its own long-lived session, the group analogue of an email
thread. This builds entirely on the generic thread store from E27; see
[THREADING.md](./THREADING.md) for the shared mechanism. DM Threaded Mode
(a separate, private-chat-only Telegram feature) was evaluated for this epic
and retired before shipping — see the E28 epic's pivot note
(`_bmad-output/epics/E28-telegram-threaded-mode.md`) for why. It never shipped
and there is nothing to configure for it.

### Group prerequisites (operator setup, outside the codebase)

1. **The chat must be an actual supergroup with Topics enabled**
   (`is_forum: true`) — a client-side group setting (Group → Edit → Topics),
   not a BotFather toggle. A small basic group auto-upgrades to a supergroup
   when this is turned on.
2. **Group Privacy Mode must be disabled** for the bot via BotFather
   (`/mybots` → pick the bot → Bot Settings → Group Privacy → Disable). By
   default a bot in a group only receives messages that @-mention it, reply
   to it, or are slash commands — without disabling Privacy Mode, ordinary
   group messages never reach AgentBus at all (not even a rejected/dropped
   log line; Telegram never delivers the update).
3. **After toggling Privacy Mode, remove the bot from the group and re-add
   it** — flipping the BotFather setting alone does not take effect for
   groups the bot is already in.
4. **"Manage Topics" admin rights** are required only if the agent should
   create topics itself (`create_telegram_topic`, below) — not for the group
   to work at all.
5. **A member with "Remain Anonymous" enabled posts as `@GroupAnonymousBot`**
   (fixed Telegram user id `1087968824`), not their own account — their real
   messages are dropped as an unknown sender until they turn that off
   personally.

### Channel identity: auto-routing, no per-group config

`processUpdate` derives the channel per-message from `msg.chat.type`: a
private chat keeps today's channel (`telegram`, or `telegram:{name}` for a
named instance) unchanged; a `group`/`supergroup` chat gets
`telegram:group:{chat_id}` — computed on the fly, with no static per-group
registration and no operator step beyond the prerequisites above. One bot
instance still means one agent; this does not route different groups to
different underlying bots/agents.

Because a dynamically-derived channel is never in the adapter's static
`capabilities.channels` list, `AdapterRegistry.lookupByChannel`/
`lookupPrimaryByChannel` also consult an adapter's optional `ownsChannel(channel)`
predicate — `TelegramAdapter.ownsChannel` returns true for its own DM channel
and any `telegram:group:*` channel it derives. This is what lets outbound
delivery, `react_to_message`, slash-command replies, pause checks, and the
typing/tool-call-status HTTP endpoints all resolve a group channel to the
right bot instance with no additional registration.

**`config.yaml`'s `pipeline.routes`/`pipeline.relays` need no changes either.**
A `match.channel` rule written against a bot's DM channel (e.g. `telegram:peggy`)
automatically also matches any group derived from it
(`telegram:peggy:group:<chatId>`) — `route-resolve` and `channel-relay` both
compare channels with the shared `channelMatches()` helper
(`src/pipeline/types.ts`), not raw string equality, specifically so an
existing `{ match: { channel: 'telegram:peggy' }, target: { adapterId:
'cc-headless', recipientId: 'agent:peggy' } }` rule keeps routing a group's
messages to the same agent as the DM's — matching the "one bot instance, one
agent" design — with no separate per-group rule to add. A rule that names the
group's exact derived channel still works too and takes priority if it
appears earlier in the list (first match wins, as always).

### Forum topics → sessions

Each topic (including "General", which carries no `message_thread_id`) is
its own long-lived session. A message with `is_topic_message` and
`message_thread_id` derives `threadKey = "{chat_id}:{message_thread_id}"`,
hashes it into `topic = thread:<hash>` via `topicForThreadKey` (E27,
channel-agnostic), and upserts `{ chatId, messageThreadId }` into the shared
`threads` table under `(channel, topic)`. A message with no
`message_thread_id` (posted in General) needs no thread row — its own session
falls out of the group channel alone, exactly as a DM's main conversation
needs no thread row today.

Outbound `send()` resolves where a reply lands the same way it resolves a
DM, generalized: a `thread:`-prefixed topic looks up `{ chatId,
messageThreadId }` from the thread store and includes `message_thread_id` on
the Telegram API call; a group channel with no thread topic ("General")
resolves `chat_id` from the channel string itself; a DM resolves `chat_id`
from `contactChatIdMap` exactly as before this epic.

**Typing indicator and live tool-call status stream in a group.**
`startTyping`/`reportToolCall`/`finalizeDraft` accept an optional `channel`
*and* `topic` alongside `contactId`, so a group turn's status lands in the
specific forum topic being discussed, not just the right group. `topic` is
resolved against E27's generic thread store exactly as a real `send()`
would — `getThread(db, channel, topic)` yields the topic's
`message_thread_id`, included on the `sendChatAction`/`sendMessage` calls
that create the typing loop and the live-status draft. Per-(chat, topic)
state is keyed independently (`draftKey(chatId, messageThreadId)`), so two
topics active in the same group at once never collide on the same typing
loop or draft message. `cc-headless.ts` threads the inbound envelope's
`topic` through automatically — no per-call wiring needed elsewhere.

### `create_telegram_topic` tool (group-only)

The agent can start a new topic on its own initiative and reference it later
(e.g. from `schedule_message`) via the `thread:<hash>` topic it returns. This
always starts a **brand-new session** — a forum topic's `message_thread_id`
is freshly issued by Telegram, so the `thread:<hash>` topic (and therefore
`conversation_id`) it hashes into has never existed before; there is no prior
history for the new topic to inherit.

- Params: `channel` (the group's channel id, e.g. `telegram:group:-100123`),
  `name` (the topic's display name), and optional `context` (free text to
  seed the new session with).
- Rejects a DM channel outright — DM Threaded Mode is retired.
- Verifies the bot has "Manage Topics" admin rights (via `getChatMember` on
  the bot's own id, cached from `getMe` at `start()`) **before** calling
  `createForumTopic`, returning a clear, actionable error (naming the exact
  Telegram admin-rights step) rather than an opaque API rejection.
- On success, upserts the thread row immediately — `send()` can resolve it
  before any inbound message ever arrives on the new topic — and returns
  `{ topic, message_thread_id, name }`.
- **`context` injection:** when given, `context` is stashed as
  `pendingContext` on the thread row's metadata and consumed exactly once —
  the moment the *first* message actually lands on the topic (a skipped
  update, e.g. a sticker with no text, does not consume it; the check happens
  after the same skip logic that gates normal message processing).
  `processUpdate` reads and clears it (a full metadata replace omitting
  `pendingContext` is what clears it — no separate delete needed), then
  attaches `metadata.injected_topic_context` to that one `InboundMessage`.
  `formatMessagesForSampling` (`src/adapters/cc.ts`) renders it as
  `[Context for this new topic, provided when it was created]\n<context>`
  before the first message body — applied unconditionally (unlike
  `memory_context`, which cc-headless suppresses in favor of system-prompt
  injection; there's no equivalent alternate path for agent-supplied topic
  context, so it always flows through here for both the polling and headless
  adapters).
- Implemented as a thin MCP tool (`src/mcp/tools/telegram.ts`) over
  `POST /api/v1/adapters/:id/topics`; only registered when a Telegram adapter
  is configured.

### Reply-to-message: context, not routing

A user quote-replying to a message — DM or group, topic or not — is a
conversational gesture, not a request to fork a session. It's handled
entirely separately from thread routing above and never touches the
`threads` table:

- **Inbound:** a `reply_to_message` on the update becomes
  `metadata.quoted_message = { platform_message_id, sender_name, text }`
  (text truncated to ~200 chars) on the envelope. The CC adapter renders it
  as a context line before the body — `[Replying to <sender>: "<text>"]` —
  the same placement/style as the existing `[reacted 👍 to message 555:42]`
  reaction line.
- **Outbound:** `reply_to` (a bus message ID, already accepted by
  `send_message`/`reply`) is resolved server-side (`POST /api/v1/messages`)
  to the referenced transcript's `platform_message_id` — the same lookup
  `react_to_message` already does — and stashed as
  `metadata.reply_to_platform_message_id`. **Except when the referenced
  message is the *latest* inbound message in its conversation** — quoting
  the message a reply is obviously responding to is visually redundant, so
  that case is deliberately sent as a plain message instead (bus-core checks
  `SELECT message_id FROM transcripts WHERE conversation_id = ? AND
  direction = 'inbound' ORDER BY created_at DESC LIMIT 1` and skips setting
  the platform id when it matches `reply_to`). `send()` only turns a resolved
  `reply_to_platform_message_id` into a native `reply_parameters` quote when
  the parsed chat_id matches the send's actual target chat (a stale reply
  target from a different chat/topic is dropped, never sent to the wrong
  place); `allow_sending_without_reply: true` means a since-deleted target
  message never blocks delivery. Only the first part of a multi-part reply
  carries the quote.

### Authorization: no new mechanism

Group messages are gated by the same sender allowlist (`allowedSenderIds`,
built from `contacts[*].platforms.telegram.userId`) that already gates DMs —
it's sender-based, not chat-based, so a message from someone not on the
allowlist is dropped in a group exactly as it is in a DM, with no
group-specific authorization code.

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
   `⚙️ Running {name}`. Every one of these dynamic values (`description`,
   `file_path`, `pattern`, `url`, `query`, and `name` in the fallback) is
   wrapped in a backtick code span before it's embedded in the line, since
   these values routinely contain a bare `_` that Telegram's Markdown dialect
   would otherwise parse as an emphasis delimiter — a code span is exempt
   from further Markdown parsing. A backtick inside the value itself is
   substituted with `´` so it can't terminate the span early (E34).
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
| Group forum topics | Yes — see [Group Topics & Replies](#group-topics--replies-e28) |
| Reply-to-message (native quote) | Yes — see [Group Topics & Replies](#group-topics--replies-e28) |

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

**Group messages never arrive:**
- Confirm Group Privacy Mode is disabled for the bot (BotFather → Bot Settings → Group Privacy)
- After disabling it, remove the bot from the group and re-add it — the setting does not take effect for existing memberships
- Confirm the group is a supergroup with Topics enabled (Group → Edit → Topics), not a basic group
- A sender with "Remain Anonymous" enabled posts as `@GroupAnonymousBot` and is dropped as an unknown sender — have them disable it personally

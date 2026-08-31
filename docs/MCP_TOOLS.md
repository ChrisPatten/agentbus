# AgentBus MCP Tool Surface

Tools registered on the MCP server by the Claude Code adapter (`src/adapters/cc.ts`). These are the verbs the agent uses to interact with AgentBus.

All tools are registered via `registerAllTools()` in `src/mcp/tools/index.ts`.

---

## Tool Index

| Tool | Epic | Description |
|------|------|-------------|
| `reply` | E2 | Reply to a message by its bus ID |
| `get_adapter_status` | E2 | Inspect CC adapter health |
| `list_channels` | S7.1 | Discover available channels and adapter capabilities |
| `send_message` | S7.2 | Send a message to any contact on any channel |
| `send_email` | E21 | Start a new email thread to an allowlisted address |
| `recall_memory` | S7.3/E8 | Search the memory store for facts about contacts |
| `log_memory` | S7.3/E8 | Record a fact explicitly |
| `search_transcripts` | S7.3 | Full-text search across conversation transcripts |
| `get_session` | S7.4 | Get session metadata and summary |
| `list_sessions` | S7.4 | Browse recent sessions |
| `get_transcript` | E35 | Get the full ordered message history for a session |
| `react_to_message` | S7.5 | Send an emoji reaction to a message |
| `create_telegram_topic` | E28 | Create a new forum topic in a Telegram group |

---

## Core Tools (E2)

### `reply`

Reply to a message. Looks up the original by message ID, swaps sender/recipient, and posts to AgentBus.

**Input:**
```json
{ "message_id": "uuid", "body": "Your reply text" }
```

**Output:**
```json
{ "success": true, "outbound_message_id": "uuid" }
```

---

### `get_adapter_status`

Return the health state of the CC adapter itself (bus connectivity, poll state).

**Input:** none

**Output:**
```json
{
  "status": "healthy",
  "bus_reachable": true,
  "last_poll_at": "2026-04-12T10:00:00.000Z",
  "consecutive_failures": 0
}
```

---

## S7.1 — Channel Discovery

### `list_channels`

List all adapters registered with bus-core and their capabilities. Use this before calling `send_message` to confirm a channel exists.

**Input:** none

**Output:**
```json
[
  {
    "id": "telegram",
    "name": "telegram",
    "channels": ["telegram"],
    "capabilities": { "send": true, "react": true, "typing": true, "channels": ["telegram"] }
  }
]
```

---

## S7.2 — Outbound Messaging

### `send_message`

Send a message to any contact on any channel. Validates the channel exists (resolved the same way real delivery is — `GET /api/v1/adapters/resolve`, which also recognizes a dynamically-derived channel like a Telegram group, E28).

**Input:**
```json
{
  "to": "contact:chris",
  "channel": "telegram",
  "body": "Your message text",
  "topic": "general",
  "reply_to": "optional-msg-uuid",
  "priority": "normal",
  "metadata": {}
}
```

Priority values: `normal`, `high`, `urgent`.

**`topic` (default `"general"`, E28):** to land a message in a specific Telegram forum topic instead of the group's General topic, pass the `topic` value returned by `create_telegram_topic` (a `"thread:<hash>"` id) — not the channel, and not a plain topic name. `schedule_message` accepts the same `topic` param for the same purpose. A `topic` with no matching thread record on that channel is rejected server-side rather than silently falling back to General.

For a proactive send (not a reply to a message you just received), call `get_session` or `list_sessions` first and use the `topic` field it returns (E32) rather than guessing — it reflects where that conversation is actually threaded.

**`reply_to` (E28):** when set, bus-core resolves it server-side to the referenced transcript's platform message ID and, on Telegram, turns it into a native reply quote (`reply_parameters`) — the agent never needs to know platform-specific ID formats. An unknown or foreign-chat `reply_to` is a silent no-op: the message still sends, just without a quote. **Replying to the latest inbound message in the conversation is also a no-op** — quoting the message a reply is obviously responding to would be visually redundant, so that case always sends as a plain message. Non-Telegram channels ignore it today.

**Output:**
```json
{ "success": true, "message_id": "uuid", "queued_at": "2026-04-12T10:00:00.000Z" }
```

---

### `send_email`

Start a **new** email thread to the user (as opposed to `reply`, which threads into a
message the agent received). Use it to reach out proactively over email.

The tool is registered only when an email adapter is configured (see
[EMAIL_ADAPTER.md](EMAIL_ADAPTER.md)). It sends on the first configured email channel
(`email`, or `email:<name>` for a named instance).

**Recipient allowlist.** `to` is optional and defaults to the **first** allowlisted
address — the addresses under `contacts[*].platforms.email.address`, in config order.
An explicit `to` is accepted only if it is on that allowlist (matched
case-insensitively); any other address is rejected and **nothing is sent**. This is the
same allowlist the inbound adapter enforces, so the agent can never email an arbitrary
recipient. The adapter re-checks the allowlist on send as defense in depth.

**Subject.** `subject` is optional and sets the email's subject line; it defaults to
*Message from your assistant*.

**Markdown.** `body` is Markdown — it renders as formatted HTML (headings, tables,
lists, links, code blocks), with the raw Markdown kept as the plain-text fallback.
Plain prose works too. See [EMAIL_ADAPTER.md](EMAIL_ADAPTER.md#rich-text-rendering).

**Input:**
```json
{
  "body": "Your message text",
  "to": "chris@example.com",
  "subject": "Weekly status"
}
```

**Output:**
```json
{ "success": true, "message_id": "uuid", "to": "chris@example.com" }
```

**Rejected recipient:**
```json
{ "error": "Refusing to send: \"evil@attacker.com\" is not on the email allowlist. Allowed addresses: chris@example.com" }
```

---

## S7.3/E8 — Memory Tools

### `recall_memory`

Full-text search over the active memory store. Returns memories ordered by confidence DESC.
Memories that are expired or superseded are excluded automatically.

**Input:**
```json
{
  "query": "search text",
  "contact_id": "contact:chris",
  "category": "preference",
  "limit": 10
}
```

`category` values: `preference`, `fact`, `plan`, `relationship`, `work`, `health`, `general`

**Output:**
```json
{
  "memories": [
    {
      "id": "uuid",
      "contact_id": "contact:chris",
      "category": "preference",
      "content": "Prefers tea over coffee",
      "confidence": 0.95,
      "source": "summarizer",
      "created_at": "2026-04-12T10:00:00Z",
      "expires_at": null
    }
  ],
  "count": 1
}
```

Returns `{ available: false }` if the memory system is not initialized.

---

### `log_memory`

Record a fact explicitly to the memory store. Supersedes any existing active memory
for the same `(contact_id, category)` pair.

**Input:**
```json
{
  "contact_id": "contact:chris",
  "content": "Prefers tea over coffee",
  "category": "preference",
  "confidence": 0.9,
  "source": "manual",
  "expires_at": "2026-12-31T00:00:00Z"
}
```

`category` and `expires_at` are optional (defaults: `general`, no expiry).

**Output:**
```json
{
  "ok": true,
  "id": "new-memory-uuid",
  "superseded": "old-memory-uuid-or-null"
}
```

Returns `{ available: false }` if the memory system is not initialized.

---

### `search_transcripts`

Full-text search across conversation transcripts using FTS5. Fully functional.

**Input:**
```json
{ "query": "calendar appointment", "channel": "telegram", "since": "2026-04-01T00:00:00Z", "limit": 10 }
```

**Output:**
```json
{
  "results": [
    {
      "message_id": "uuid",
      "session_id": "uuid",
      "channel": "telegram",
      "contact_id": "contact:chris",
      "direction": "inbound",
      "body": "What's on my calendar today?",
      "created_at": "2026-04-12T10:05:00.000Z"
    }
  ],
  "count": 1
}
```

Returns `{ available: false }` if the FTS5 table is not initialized.

---

## S7.4 — Session Tools

### `get_session`

Get details for a session — metadata plus any available AI summary. If no `session_id` is provided, returns the most recent session.

**Input:**
```json
{ "session_id": "optional-uuid" }
```

**Output:**
```json
{
  "session_id": "uuid",
  "id": "uuid",
  "conversation_id": "hash",
  "channel": "telegram",
  "contact_id": "contact:chris",
  "started_at": "2026-04-12T10:00:00Z",
  "last_activity": "2026-04-12T10:30:00Z",
  "ended_at": null,
  "message_count": 15,
  "topic": "general",
  "summary": {
    "summary": "Discussed weekend plans.",
    "model": "claude-opus-4-6",
    "token_count": 320,
    "created_at": "2026-04-12T10:45:00Z"
  }
}
```

`topic` (E32) is the conversation's topic (e.g. `"general"` or a Telegram forum `"thread:<hash>"`, E28), resolved via `conversation_registry`. Use it to target a proactive `send_message`/`schedule_message` at the same place this conversation is happening, instead of guessing — pass it as `send_message`'s `topic` param. `null` if the session's conversation has no matching `conversation_registry` row (shouldn't happen in practice).

Returns `{ available: false }` if no session is found.

---

### `list_sessions`

Browse recent sessions with their summaries.

**Input:**
```json
{ "channel": "telegram", "contact_id": "contact:chris", "since": "2026-04-01T00:00:00Z", "limit": 20 }
```

**Output:**
```json
{
  "sessions": [ /* array of session objects (same shape as get_session) */ ],
  "count": 5
}
```

---

## E35 — Full Transcript Lookup

### `get_transcript`

Get the full, ordered message-by-message transcript for a specific session — every inbound and outbound message, oldest first. Complements `search_transcripts` (keyword-driven, cross-session snippets, no surrounding context) and `get_session` (metadata + summary only, no message content) — use this when you already have a `session_id` (from `list_sessions`, `get_session`, or a memory file reference) and want the actual conversation.

**Input:**
```json
{ "session_id": "uuid", "limit": 200, "since": "2026-04-01T00:00:00Z", "before": "2026-04-02T00:00:00Z" }
```

`limit` defaults to 200, max 1000 (higher than `list_sessions`'/`search_transcripts`' 100 — a single session's full transcript, not a fan-out across sessions, is the unit here). `since`/`before` are `created_at` cursors for paging through a long-running session.

**Output:**
```json
{
  "transcript": [
    {
      "message_id": "uuid",
      "session_id": "uuid",
      "channel": "telegram",
      "contact_id": "contact:chris",
      "direction": "inbound",
      "body": "What's on my calendar today?",
      "created_at": "2026-04-12T10:05:00.000Z"
    }
  ],
  "count": 1
}
```

A session with zero transcript rows returns `{ "transcript": [], "count": 0 }`, not an error. Returns `{ available: false }` if the `session_id` doesn't exist.

---

## S7.5 — Reactions

### `react_to_message`

Send an emoji reaction to a message. Only works on channels that support reactions (`react: true` in adapter capabilities). Returns a graceful `success: false` (not an error) for unsupported channels.

**Telegram emoji handling:** Telegram supports a specific set of ~74 reaction emoji. Any emoji not in that set is sent as a plain text message to the chat instead of a reaction bubble — the intent still lands, just in a different form. Variation selectors (U+FE0F) are stripped automatically before sending.

**Input:**
```json
{ "message_id": "bus-msg-uuid", "emoji": "👍" }
```

**Output (success):**
```json
{ "success": true, "emoji": "👍", "message_id": "bus-msg-uuid" }
```

**Output (unsupported channel — not an error):**
```json
{ "success": false, "reason": "Reactions not supported on channel: claude-code-channels" }
```

---

## E28 — Telegram Group Topics

### `create_telegram_topic`

Create a new forum topic in a Telegram group the bot has been added to. Group-only — not available for a contact's DM channel (DM Threaded Mode is retired, see [TELEGRAM_ADAPTER.md](./TELEGRAM_ADAPTER.md#group-topics--replies-e28)). Only registered when a Telegram adapter is configured.

This always starts a **brand-new session** for the topic — a fresh forum topic has no prior conversation to inherit.

Requires the bot to have "Manage Topics" admin rights in the target group — verified before creating the topic, so a missing right returns a clear, actionable error naming the exact fix instead of an opaque API rejection.

**Input:**
```json
{ "channel": "telegram:group:-100123456789", "name": "Wanda prep", "context": "Track Wanda birthday planning here" }
```

`channel` is the group's channel id, as seen on `channel`/`metadata` of any inbound message from that group. `context` is optional — when given, it's injected into the agent's *first* turn on this topic only (consumed once, the moment the first real message lands on it), letting the agent explain why the topic exists or what it should track.

**Output (success):**
```json
{ "topic": "thread:ab12cd34ef56ab12", "message_thread_id": 42, "name": "Wanda prep" }
```

Pass the returned `topic` value as `topic` on a later `send_message`/`schedule_message` call to target this thread specifically.

**Output (missing admin rights — an error, not a graceful `success: false`):**
```
Error: This bot lacks "Manage Topics" admin rights in this group. In Telegram: open the group, go to the member list, select this bot, "Edit Admin Rights", and enable "Manage Topics".
```

---

## Error Response Shape

All tools return errors as:
```json
{
  "content": [{ "type": "text", "text": "Error: description of problem" }],
  "isError": true
}
```

Capability errors (channel doesn't support reactions) return `success: false` without `isError: true` — they are expected outcomes, not failures.

---

## Implementation Notes

- Tools are thin HTTP clients — all complex logic (DB queries, capability checks, adapter calls) lives in bus-core HTTP endpoints
- `recall_memory` and `log_memory` are fully functional (E8) — they call bus-core HTTP endpoints backed by FTS5
- `search_transcripts` is fully functional — `transcripts_fts` FTS5 table exists in the E1 schema
- Platform message IDs for `react_to_message` are stored in `transcripts.metadata.platform_message_id` by adapters during inbound processing
- `create_telegram_topic` follows the same pattern — `src/mcp/tools/telegram.ts` is a thin fetch wrapper; the admin-rights check, `createForumTopic` call, and thread-store upsert all live in `TelegramAdapter.createTopic()`, reached via `POST /api/v1/adapters/:id/topics`

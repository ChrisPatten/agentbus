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
| `recall_memory` | S7.3 | Search the memory store (stub — live after E8/E9) |
| `log_memory` | S7.3 | Record a fact explicitly (stub — live after E8/E9) |
| `search_transcripts` | S7.3 | Full-text search across conversation transcripts |
| `get_session` | S7.4 | Get session metadata and summary |
| `list_sessions` | S7.4 | Browse recent sessions |
| `react_to_message` | S7.5 | Send an emoji reaction to a message |

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

Send a message to any contact on any channel. Validates the channel exists and (if `reply_to` is provided) that the referenced message exists.

**Input:**
```json
{
  "to": "contact:chris",
  "channel": "telegram",
  "body": "Your message text",
  "reply_to": "optional-msg-uuid",
  "priority": "normal",
  "metadata": {}
}
```

Priority values: `low`, `normal`, `high`. `low` maps to `normal` in the envelope.

**Output:**
```json
{ "success": true, "message_id": "uuid", "queued_at": "2026-04-12T10:00:00.000Z" }
```

---

## S7.3 — Memory Tools

### `recall_memory`

Search the memory store. **Currently returns `{ available: false }` — memory system initializes in E8/E9.**

**Input:**
```json
{ "query": "search text", "contact_id": "contact:chris", "limit": 10 }
```

**Output (pre-E8/E9):**
```json
{ "available": false, "reason": "Memory system not yet initialized" }
```

---

### `log_memory`

Record a fact explicitly. **Currently returns `{ available: false }` — memory system initializes in E8/E9.**

**Input:**
```json
{ "contact_id": "contact:chris", "content": "Prefers tea over coffee", "confidence": 0.9, "source": "manual" }
```

**Output (pre-E8/E9):**
```json
{ "available": false, "reason": "Memory system not yet initialized" }
```

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
  "summary": {
    "summary": "Discussed weekend plans.",
    "model": "claude-opus-4-6",
    "token_count": 320,
    "created_at": "2026-04-12T10:45:00Z"
  }
}
```

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
- `recall_memory` and `log_memory` are registered now (visible in tool list) but return `{ available: false }` until E8/E9
- `search_transcripts` is fully functional — `transcripts_fts` FTS5 table exists in the E1 schema
- Platform message IDs for `react_to_message` are stored in `transcripts.metadata.platform_message_id` by adapters during inbound processing

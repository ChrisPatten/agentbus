# MCP tools

The tools an agent can call. They are registered on the MCP server in `src/adapters/cc.ts` by `registerAllTools()` (polling mode) or `registerHeadlessTools()` (tools-only mode for `claude -p`); the only difference is that headless mode omits `get_adapter_status`. Every tool is a thin HTTP client for bus-core. The logic lives in the routes listed in [HTTP_API.md](HTTP_API.md).

Errors come back as `{ "content": [{ "type": "text", "text": "Error: ..." }], "isError": true }`. Expected non-success outcomes (a channel that cannot react, a missing session) return `success: false` or `available: false` without `isError`.

## Tool index

| Tool | Purpose | Registered when |
|---|---|---|
| `reply` | Reply to a message by its bus ID | Always |
| `send_message` | Send to any contact on any channel | Always |
| `send_email` | Start a new email thread to an allowlisted address | An email adapter is configured |
| `react_to_message` | Emoji reaction on a message | Always |
| `create_telegram_topic` | Create a forum topic in a Telegram group | A Telegram adapter is configured |
| `list_channels` | Adapters and their capabilities | Always |
| `get_session`, `list_sessions` | Session metadata and topic | Always |
| `get_transcript` | Full ordered transcript for one session | Always |
| `search_transcripts` | Full-text search across transcripts | Always |
| `fetch_attachment` | Resolve an attachment ID to a file path | Always |
| `schedule_message`, `list_schedules`, `cancel_schedule` | Scheduled messages | Always |
| `set_model_override`, `get_model_override`, `list_model_overrides`, `delete_model_override` | Runtime model overrides (agent or global) | Always |
| `recall_memory`, `log_memory` | Legacy structured memory store | Always; dormant unless `memory.structured_extraction` |
| `write_knowledge`, `get_knowledge`, `forget_knowledge`, `search_knowledge` | Agent-managed structured knowledge store (Phase 1) | Always |
| `get_adapter_status` | Health of the polling MCP adapter | Polling mode only |

## Messaging

### `reply`

Fetches the original message, swaps sender and recipient, and posts the reply on the same channel and topic.

Input: `{ "message_id": "<bus id from [id:...]>", "body": "..." }`
Output: `{ "success": true, "outbound_message_id": "<uuid>" }`

### `send_message`

Sends to any contact on any channel. Validates the channel through `GET /api/v1/adapters/resolve`, so a dynamically derived channel such as a Telegram group resolves correctly.

| Field | Required | Notes |
|---|---|---|
| `to` | yes | `contact:<id>` |
| `channel` | yes | For example `telegram:peggy` or `telegram:peggy:group:-100123` |
| `body` | yes | |
| `topic` | no | Default `general`. To target a Telegram forum topic, pass the `thread:<hash>` value from `create_telegram_topic` or from the session's `topic` field. A thread topic with no stored thread record fails at delivery |
| `reply_to` | no | Bus message ID. On Telegram this becomes a native quote unless it is the latest inbound message in the conversation |
| `priority` | no | `normal`, `high`, or `urgent` |
| `metadata` | no | Free-form object |

For a proactive send, call `get_session` or `list_sessions` first and use the `topic` it returns rather than guessing.

Output: `{ "success": true, "message_id": "<uuid>" }`

### `send_email`

Starts a new email thread, as opposed to `reply`, which threads into a received message. Sends on the first configured email channel. `to` defaults to the first allowlisted address in `contacts[*].platforms.email.address`; any other `to` must also be on that allowlist or nothing is sent. `body` is Markdown and renders as HTML. See [EMAIL_ADAPTER.md](EMAIL_ADAPTER.md#agent-initiated-email-send_email-tool).

Input: `{ "body": "...", "to"?: "chris@example.com", "subject"?: "Weekly status" }`
Output: `{ "success": true, "message_id": "<uuid>", "to": "chris@example.com" }`

### `react_to_message`

Input: `{ "message_id": "<bus id>", "emoji": "👍" }`
Output: `{ "success": true, "emoji": "👍", "message_id": "..." }`, or `{ "success": false, "reason": "Reactions not supported on channel: email" }` on a channel without reactions.

Telegram accepts a fixed set of about 74 reaction emoji. Anything else is sent as a plain text message instead. Variation selectors are stripped automatically.

### `create_telegram_topic`

Creates a forum topic in a Telegram group the bot belongs to and starts a brand-new session for it. Requires the bot to have "Manage Topics" admin rights; the tool checks first and returns an error naming the fix. See [TELEGRAM_ADAPTER.md](TELEGRAM_ADAPTER.md#group-topics-and-replies).

Input: `{ "channel": "telegram:peggy:group:-100123", "name": "Trip planning", "context"?: "Track the May trip here" }`
Output: `{ "topic": "thread:ab12cd34ef56ab12", "message_thread_id": 42, "name": "Trip planning" }`

`context`, when given, is injected once into the agent's first turn on the topic. Pass the returned `topic` to `send_message` or `schedule_message` to target the thread.

## Discovery and history

### `list_channels`

Output: the array from `GET /api/v1/adapters`: `[{ "id", "name", "channels", "capabilities" }]`.

### `get_session`

Input: `{ "session_id"?: "<uuid>" }`. Without an ID, returns the most recently started session.

Output: `{ "session_id", "id", "conversation_id", "channel", "contact_id", "started_at", "last_activity", "ended_at", "message_count", "topic", "summary" }`. `contact_id` is the bare ID (`chris`). `topic` is where the conversation is threaded (`general` or `thread:<hash>`). `summary` is `null` unless the legacy summarizer ran. An unknown ID returns `{ "available": false, "reason": "..." }`.

### `list_sessions`

Input: `{ "channel"?, "contact_id"?: "chris", "since"?: "<ISO 8601>", "limit"?: 20 }` (max 100).
Output: `{ "sessions": [...], "count": n }`, newest first.

### `get_transcript`

Every message in one session, oldest first. Use it when a session ID from `list_sessions` or a memory file needs the actual conversation.

Input: `{ "session_id": "<uuid>", "limit"?: 200, "since"?, "before"? }` (`limit` max 1000).
Output: `{ "transcript": [{ "message_id", "session_id", "channel", "contact_id", "direction", "body", "created_at" }], "count": n }`. An empty session returns an empty array. An unknown ID returns `{ "available": false }`.

### `search_transcripts`

FTS5 keyword search across every session, newest first.

Input: `{ "query": "calendar appointment", "channel"?, "since"?, "limit"?: 10 }` (max 100).
Output: `{ "results": [<same row shape as get_transcript>], "count": n }`.

### `fetch_attachment`

Resolves an attachment ID (from an `[Inline image available … fetch_attachment(id="…")]` hint) to its path. See [ATTACHMENTS.md](ATTACHMENTS.md).

Input: `{ "id": "<uuid>" }`
Output: `{ "id", "local_path", "mime_type", "original_filename" }`, or an error if the attachment is unknown or expired.

## Scheduling

See [SCHEDULING.md](SCHEDULING.md) for semantics and the cron format.

### `schedule_message`

| Field | Required | Notes |
|---|---|---|
| `type` | yes | `once` or `cron` |
| `prompt` | yes | Text delivered as if `sender` typed it |
| `channel`, `sender` | yes | For example `telegram:peggy` and `contact:chris` |
| `fire_at` | if `once` | ISO 8601, in the future |
| `cron_expr` | if `cron` | For example `0 8 * * 1-5` |
| `timezone` | no | IANA name, default `UTC` |
| `topic`, `priority`, `label`, `max_fires` | no | |
| `stale_after_ms` | no | `once` only. Dead-letter instead of firing if overdue by more than this |

Output: `{ "ok": true, "id", "fire_at", "label" }`. Schedules created here have `created_by: agent`.

### `list_schedules`

Input: `{ "status"?: "active", "channel"?, "created_by"?, "limit"?: 20 }`. `status` is one of `active`, `paused`, `cancelled`, or `completed`; `limit` max 200.
Output: `{ "schedules": [...], "count": n }`.

### `cancel_schedule`

Input: `{ "id": "<uuid>" }`. Output: `{ "ok": true, "id" }`.

## Model overrides

Agent-wide and global runtime model overrides, shared by `cc-headless` and `cc-pool`. `agent_id` is the full recipient ID, for example `agent:claude`. A job's own model lives on its schedule (`model` field), not here — use the scheduling tools. See [CC_HEADLESS_ADAPTER.md](CC_HEADLESS_ADAPTER.md#runtime-model-overrides).

`set_headless_model`, `get_headless_model`, `list_headless_model`, and `delete_headless_model` are deprecated aliases for the tools below, kept for one minor release. Passing them `schedule_id` returns an error pointing at the schedule's `model` field.

### `set_model_override`

Input: `{ "model": "sonnet", "agent_id"?: "agent:claude" }`. Omit `agent_id` for a global override.
Output: `{ "ok": true, "id", "model", "scope": "agent=agent:claude" | "global", "message" }`

### `get_model_override`

Input: `{ "agent_id"? }`
Output: `{ "ok": true, "model": "sonnet", "scope": "agent" | "global" }`, or `{ "ok": true, "model": null, "message": "No override found; using the configured default model" }`.

### `list_model_overrides`

Output: `{ "ok": true, "overrides": [{ "id", "scope", "model", "created_at", "updated_at" }], "count": n }`, agent-scoped rows first.

### `delete_model_override`

Input: `{ "agent_id"? }` deletes that agent's override; `{ "scope": "global" }` deletes the global one; `{ "all": true }` deletes every override.
Output: `{ "ok": true, "deleted_count": n, "message" }`.

## Legacy memory store

Dormant unless `memory.structured_extraction` is true. The file-based memory model replaces it. See [MEMORY.md](MEMORY.md).

### `recall_memory`

Input: `{ "query": "...", "contact_id"?, "category"?, "limit"?: 10 }`. `limit` max 50; categories are `preference`, `fact`, `plan`, `relationship`, `work`, `health`, and `general`.
Output: `{ "memories": [...], "count": n }`.

### `log_memory`

Input: `{ "contact_id": "chris", "content": "...", "category"?: "general", "confidence"?: 0.9, "source"?: "manual", "expires_at"? }`
Output: `{ "ok": true, "id", "superseded": "<old id>" | null }`.

## Knowledge store

Agent-managed structured knowledge (Phase 1: FTS5 keyword search, no embeddings yet). New and always-on, independent of the legacy memory store above. See [KNOWLEDGE_STORE.md](KNOWLEDGE_STORE.md).

### `write_knowledge`

Input: `{ "agent_id", "kind", "title", "payload", "index_note"?, "tags"?, "facets"?, "event_at"?, "valid_from"?, "relevant_until"?, "expires_at"?, "importance"?: 0.5, "confidence"?: 0.9, "source"?: "agent", "session_id"?, "contact_id"?, "channel"?, "supersedes"? }`. `payload` is a JSON-encoded string in the agent's own schema. Pass `supersedes` (an existing knowledge id) to mark that row replaced.
Output: `{ "ok": true, "id", "content_hash", "superseded_id": "<old id>" | null }`.

### `get_knowledge`

Input: `{ "id" }`. Bumps `recall_count` / `last_recalled_at`.
Output: `{ "knowledge": {...} }`.

### `forget_knowledge`

Input: `{ "id", "mode": "supersede" | "expire" | "delete", "superseded_by"? }`. `superseded_by` is required when `mode` is `"supersede"`.
Output: `{ "ok": true }`.

### `search_knowledge`

Input: `{ "agent_id", "q"?, "kind"?, "tags"?, "facets"?, "event_from"?, "event_to"?, "limit"?: 10 }`. `limit` max 50. Omit `q` to filter/browse, newest-updated first. Always excludes superseded and expired rows.
Output: `{ "results": [...], "count": n }`.

## Polling adapter only

### `get_adapter_status`

Output: `{ "status": "healthy" | "degraded" | "disconnected", "bus_reachable", "last_poll_at", "consecutive_failures" }`. See [CC_ADAPTER.md](CC_ADAPTER.md).

# HTTP API

bus-core serves a JSON API on `bus.host:bus.http_port` (default `127.0.0.1:3000`). The MCP tools and agent connectors use it; in-process adapters call the pipeline directly. It is not designed for the public internet.

## Conventions

- Request and response bodies are JSON. Success responses include `"ok": true`; error responses include `"ok": false` and an `"error"` string.
- A message that is valid but not queued (duplicate, paused adapter, slash command handled inline) returns `200` with `"queued": false` and a `"reason"`, not a 4xx.
- Every request except `GET /api/v1/health` and `GET /api/v1/messages/pending` is logged to stdout as `[http] METHOD /path from ip`.

### Authentication

If `bus.auth_token` is set, every request except `GET /api/v1/health` must send a matching `X-Bus-Token` header or it receives `401`. The Pebble webhook additionally requires its own per-contact bearer token; the two checks are layered. The comparison is not constant time; the token is a shared secret between local processes, not a user password.

### Binding to the LAN

Set `bus.host: 0.0.0.0` to accept connections from other hosts, for example a reverse proxy on another machine. This exposes every route. Set `bus.auth_token` and restrict the proxy to the paths you intend to expose. See [DEPLOYMENT.md](DEPLOYMENT.md#exposing-bus-core-to-a-reverse-proxy).

## Route index

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/health` | Liveness, adapter health, queue counts |
| POST | `/api/v1/inbound` | Submit an inbound message to the pipeline |
| POST | `/api/v1/webhooks/pebble` | Pebble Ring voice-memo ingress (when configured) |
| POST | `/api/v1/siri/ask` | Siri ask: submit a question and wait for the agent's reply (when configured) |
| GET | `/api/v1/siri/health` | Siri channel reachability and routing check (when configured) |
| GET | `/api/v1/messages/pending` | Dequeue messages for a recipient |
| POST | `/api/v1/messages/:id/ack` | Acknowledge or dead-letter a dequeued message |
| POST | `/api/v1/messages` | Enqueue an outbound message |
| GET | `/api/v1/messages/:id` | Fetch a message by ID |
| POST | `/api/v1/messages/:id/react` | React to a message on its platform |
| GET | `/api/v1/adapters` | List adapters and capabilities |
| GET | `/api/v1/adapters/resolve` | Check whether a channel has an adapter |
| POST | `/api/v1/adapters/:channel/typing` | Start a typing indicator |
| POST | `/api/v1/adapters/:channel/tool-status` | Append a live tool-call status line |
| POST | `/api/v1/adapters/:channel/topics` | Create a Telegram forum topic |
| GET | `/api/v1/sessions` | List sessions |
| GET | `/api/v1/sessions/:id` | Fetch a session |
| GET | `/api/v1/sessions/:id/transcript` | Ordered transcript for a session |
| GET | `/api/v1/transcripts/search` | Full-text search across transcripts |
| GET | `/api/v1/attachments/:id` | Resolve a stored attachment |
| GET | `/api/v1/memories/recall` | Search the legacy memory store |
| POST | `/api/v1/memories` | Insert into the legacy memory store |
| POST | `/api/v1/schedules` | Create a schedule |
| GET | `/api/v1/schedules` | List schedules |
| GET | `/api/v1/schedules/:id` | Fetch a schedule |
| PATCH | `/api/v1/schedules/:id` | Update label, max fires, or pause state |
| DELETE | `/api/v1/schedules/:id` | Cancel a schedule |
| POST | `/api/v1/model-overrides` | Set a headless model override |
| GET | `/api/v1/model-overrides` | List model overrides |
| DELETE | `/api/v1/model-overrides` | Delete model overrides |

## Health

### `GET /api/v1/health`

Always returns `200`. `status` is `healthy` when every adapter reports `online`, otherwise `degraded`. Each adapter entry carries a `status` of `online`, `degraded`, or `unhealthy`, its capabilities, and any `lastActivity`, `latencyMs`, or `details` fields the adapter reports.

```json
{
  "ok": true,
  "status": "healthy",
  "version": "0.11.0",
  "adapters": {
    "telegram:peggy": {
      "status": "online",
      "capabilities": { "send": true, "react": true, "typing": true, "toolStatus": true, "registerCommands": true, "channels": ["telegram:peggy"] },
      "lastActivity": "2026-09-14T10:00:00.000Z"
    }
  },
  "queue": { "pending": 0, "processing": 1, "delivered": 142, "dead_letter": 0 }
}
```

`queue` counts rows in `message_queue` by status. Dead-lettered messages are moved to a separate `dead_letter` table, so `dead_letter` is always `0` here; query the table directly to inspect them.

## Inbound

### `POST /api/v1/inbound`

Runs a raw inbound message through the pipeline and enqueues one copy per route target. In-process adapters call the same `processInbound()` function directly.

| Field | Required | Notes |
|---|---|---|
| `channel` | yes | Adapter channel, for example `telegram:peggy` |
| `sender` | yes | Platform sender ID. The contact-resolve stage rewrites a known sender to `contact:<id>` |
| `payload` | yes | `{ "type": "text", "body": "..." }` or `{ "type": "reaction", "emoji": "👍", "removed": false, "target_message_id": "..." }` |
| `attachments` | no | Array of `{ type: "image" \| "file", local_path, mime_type?, original_filename? }`. Allows an empty `body` |
| `topic`, `priority`, `recipient`, `reply_to`, `metadata`, `id`, `timestamp` | no | Defaults come from the normalize stage |

`payload.type` cannot be `slash_command`; the slash-command stage derives that from a leading `/` in the body.

Responses (both `200`):

```json
{ "ok": true, "queued": true, "id": "<message-uuid>", "enqueued_count": 1 }
```

```json
{ "ok": true, "queued": false, "reason": "command_handled" }
```

`reason` is one of `invalid_payload`, `command_handled`, `adapter_paused`, `Aborted at stage "<name>"` (for example `dedup`), or `Stage "<name>" error: ...`. A body that fails validation returns `400`.

### `POST /api/v1/webhooks/pebble`

Registered only when `adapters.pebble.enabled` is true. See [PEBBLE_ADAPTER.md](PEBBLE_ADAPTER.md) for the contract and error table.

### `POST /api/v1/siri/ask` and `GET /api/v1/siri/health`

Registered only when `adapters.siri.enabled` is true. The ask route submits a question through the pipeline and holds the request open until the agent's reply is delivered to the `siri` adapter, or the wait elapses. Both routes authenticate with a per-contact bearer token. See [SIRI_ADAPTER.md](SIRI_ADAPTER.md) for the contract and error table.

## Messages

### `GET /api/v1/messages/pending`

Dequeues up to `limit` pending messages for one recipient and marks them `processing`. The caller must acknowledge each one. Messages left in `processing` for more than 5 minutes are reset to `pending` by the maintenance sweep.

| Param | Notes |
|---|---|
| `agent` or `recipient` | One is required. `agent=peggy` is shorthand for `recipient=agent:peggy` |
| `limit` | 1 to 100, default 10 |
| `topic` | Optional topic filter |

Returns `{ "ok": true, "messages": [<MessageEnvelope>], "count": n }`, ordered urgent, high, normal, then oldest first.

### `POST /api/v1/messages/:id/ack`

Body `{ "status": "delivered" }` marks the message delivered. Body `{ "status": "failed", "error": "..." }` moves it to the dead-letter table. Returns `404` if the message is not in `processing` state (for `delivered`) or does not exist (for `failed`).

### `POST /api/v1/messages`

Enqueues an outbound message for the delivery worker. The `reply`, `send_message`, and `send_email` tools call this route.

| Field | Required | Notes |
|---|---|---|
| `channel`, `sender`, `recipient` | yes | `recipient` must be `contact:<id>` for the delivery worker to pick it up |
| `payload` | yes | `{ "type": "text", "body": "..." }` with a non-empty body |
| `topic` | no | Default `general`. Use a `thread:<hash>` value to target a thread |
| `reply_to` | no | Bus message ID. Resolved to the platform message ID so Telegram can quote it, unless it is the latest inbound message in the conversation |
| `priority` | no | `normal` (default), `high`, or `urgent` |
| `metadata` | no | Free-form object |
| `expires_at` | no | ISO 8601, in the future. Expired pending messages are dead-lettered by the sweep |

Returns `201 { "ok": true, "id": "<uuid>", "queued": true }`.

### `GET /api/v1/messages/:id`

Returns `{ "ok": true, "message": <MessageEnvelope> }` from the queue, falling back to the dead-letter table. `404` if unknown.

### `POST /api/v1/messages/:id/react`

Body `{ "emoji": "👍" }`. `:id` is a bus message ID. The route finds its transcript, resolves the adapter by channel, and calls `adapter.react()` with `transcripts.metadata.platform_message_id`.

| Status | Body |
|---|---|
| 200 | `{ "ok": true, "success": true, "emoji", "message_id" }` |
| 400 | `{ "ok": false, "success": false, "reason": "Reactions not supported on channel: ..." }` |
| 404 | Message not in transcripts, or no adapter for its channel |
| 502 | `adapter.react()` threw; `error` holds the message |

## Adapters

### `GET /api/v1/adapters`

Returns `{ "ok": true, "adapters": [ { "id", "name", "channels", "capabilities" } ] }`.

### `GET /api/v1/adapters/resolve?channel=<channel>`

Returns `{ "ok": true, "exists": boolean }` using the same lookup the delivery worker uses, so a dynamically derived channel such as `telegram:peggy:group:-100123` resolves correctly. `400` without `channel`.

### `POST /api/v1/adapters/:channel/typing`

Body `{ "contact_id"?: string, "topic"?: string }`. Starts the adapter's typing indicator for that contact's chat, and for the forum topic if `topic` is a thread topic. Always returns `{ "ok": true }`, including when the channel has no adapter or no typing support.

### `POST /api/v1/adapters/:channel/tool-status`

Body `{ "contact_id"?: string, "text": string, "topic"?: string }`. Appends a line to the live tool-call status message on adapters that declare `toolStatus`. Always returns `{ "ok": true }`. See [TELEGRAM_ADAPTER.md](TELEGRAM_ADAPTER.md#live-tool-call-status-stream).

### `POST /api/v1/adapters/:channel/topics`

Body `{ "name": string, "context"?: string }`. Creates a Telegram forum topic in the group identified by `:channel` and returns `{ "ok": true, "topic": "thread:<hash>", "message_thread_id": n, "name" }`, or `{ "ok": false, "error" }` when the adapter refuses (for example, missing admin rights). `400` without `name` or on a channel that cannot create topics; `404` when no adapter owns the channel. See [TELEGRAM_ADAPTER.md](TELEGRAM_ADAPTER.md#group-topics-and-replies).

## Sessions and transcripts

Session objects have this shape. `contact_id` is the bare contact ID (`chris`, not `contact:chris`). `topic` comes from `conversation_registry`. `summary` is `null` unless the legacy summarizer wrote one.

```json
{
  "id": "sess-uuid",
  "conversation_id": "sha256-hex",
  "channel": "telegram:peggy",
  "contact_id": "chris",
  "started_at": "2026-09-14T10:00:00.000Z",
  "last_activity": "2026-09-14T10:30:00.000Z",
  "ended_at": null,
  "message_count": 15,
  "topic": "general",
  "summary": null
}
```

### `GET /api/v1/sessions`

| Param | Notes |
|---|---|
| `channel` | Exact channel match |
| `contact_id` | Bare contact ID |
| `since` | ISO 8601; sessions started after this time |
| `limit` | 1 to 100, default 20 |

Returns `{ "ok": true, "sessions": [...], "count": n }`, newest first.

### `GET /api/v1/sessions/:id`

Returns `{ "ok": true, "session": {...} }` or `404`.

### `GET /api/v1/sessions/:id/transcript`

Every transcript row for the session, oldest first: `{ message_id, session_id, channel, contact_id, direction, body, created_at }`. `direction` is `inbound` or `outbound`.

| Param | Notes |
|---|---|
| `limit` | 1 to 1000, default 200 |
| `since`, `before` | ISO 8601 cursors on `created_at` |

Returns `{ "ok": true, "transcript": [...], "count": n }`, or `404` for an unknown session.

### `GET /api/v1/transcripts/search`

FTS5 search over transcript bodies.

| Param | Notes |
|---|---|
| `q` | Required. FTS5 `MATCH` syntax |
| `channel` | Exact channel match |
| `since` | ISO 8601 |
| `limit` | 1 to 100, default 10 |

Returns `{ "ok": true, "results": [<same row shape as a transcript>], "count": n }`, newest first. A malformed FTS query returns `400`.

## Attachments

### `GET /api/v1/attachments/:id`

Returns `{ "ok": true, "attachment": { "id", "local_path", "mime_type", "original_filename" } }`. `404` if the ID is unknown or the attachment has expired. See [ATTACHMENTS.md](ATTACHMENTS.md).

## Memories (legacy)

The structured memory store is dormant unless `memory.structured_extraction` is true. See [MEMORY.md](MEMORY.md).

### `GET /api/v1/memories/recall`

| Param | Notes |
|---|---|
| `q` | Required. FTS5 query |
| `contact_id`, `category` | Optional filters |
| `limit` | 1 to 50, default 10 |

Returns active memories (not superseded, not expired) ordered by confidence, then recency: `{ "ok": true, "memories": [...], "count": n }`.

### `POST /api/v1/memories`

Body `{ "contact_id", "content", "category"?, "confidence"?, "source"?, "expires_at"?, "channel"? }`. Supersedes the existing active memory for the same contact, category, and channel. Returns `201 { "ok": true, "id", "superseded": "<old-id>" | null }`.

## Schedules

See [SCHEDULING.md](SCHEDULING.md) for semantics.

### `POST /api/v1/schedules`

| Field | Required | Notes |
|---|---|---|
| `type` | yes | `once` or `cron` |
| `fire_at` | if `once` | ISO 8601, in the future |
| `cron_expr` | if `cron` | 5-part cron. `400` if invalid or with no future occurrence |
| `channel`, `sender`, `payload_body` | yes | Where the message appears to come from, and its text |
| `timezone` | no | IANA name, default `UTC` |
| `topic`, `priority`, `label`, `max_fires` | no | |
| `stale_after_ms` | no | `once` only; `400` on `cron` |
| `created_by` | no | Default `http` |

Returns `201 { "ok": true, "id", "fire_at" }`.

### `GET /api/v1/schedules`

Filters: `status`, `channel`, `created_by`, `limit` (1 to 200, default 50). Returns `{ "ok": true, "schedules": [<scheduled_items row>], "count": n }` ordered by `fire_at`.

### `GET /api/v1/schedules/:id`

Returns `{ "ok": true, "schedule": {...} }` or `404`.

### `PATCH /api/v1/schedules/:id`

Body may include `label`, `max_fires` (integer or `null`), and `status` (`active` or `paused`). Setting `max_fires` at or below the current `fire_count` completes the schedule. `400` for a completed or cancelled schedule or an empty body. Returns the updated row.

### `DELETE /api/v1/schedules/:id`

Marks the schedule `cancelled`. `404` if unknown, completed, or already cancelled.

## Model overrides

Runtime model selection for `cc-headless` spawns. See [CC_HEADLESS_ADAPTER.md](CC_HEADLESS_ADAPTER.md#runtime-model-overrides) for resolution order. `agent_id` values are the full recipient ID, for example `agent:claude`.

### `POST /api/v1/model-overrides`

Body `{ "model": string, "schedule_id"?: string, "agent_id"?: string, "priority"?: number }`. Omit both IDs for a global override. Returns `201 { "ok": true, "id", "override": {...} }`; `400` without `model`.

Known issue: this route returns `500` for every request because its upsert does not match the table's partial unique index. It is tracked as P0 in `_bmad-output/maintenance-backlog.md`.

### `GET /api/v1/model-overrides`

Returns `{ "ok": true, "overrides": [...], "count": n }` ordered by specificity (schedule and agent, agent only, schedule only, global), then `priority` descending, then `updated_at` descending.

### `DELETE /api/v1/model-overrides`

Query `schedule_id` and/or `agent_id` deletes that exact scope; `all=true` deletes everything. `400` when neither is given. Returns `{ "ok": true, "deleted_count": n, "message" }`.

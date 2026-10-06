# HTTP API

The bus runs a small web API on your computer. AgentBus's own parts use it to talk to each other, and you can use it to check on the bus, look things up and manage schedules from scripts or a terminal.

## Basics

- **Address.** `http://127.0.0.1:3000` by default (`bus.host` and `bus.http_port`). It's only reachable from the same computer unless you change `bus.host`.
- **Format.** Requests and responses are JSON. Successful responses include `"ok": true`; errors include `"ok": false` and an `error` message.
- **Authentication.** None by default. The Mac app, Siri and Pebble routes check their own per-contact token. If you set [`bus.auth_token`](/reference/configuration#bus), every request except `GET /api/v1/health` must also send `X-Bus-Token`; AgentBus's own agents and hooks do this for you.

Try it from a terminal:

```bash
curl http://127.0.0.1:3000/api/v1/health
```

The tables below list the routes that are useful to you. Other routes exist for the agents, hooks and apps; they're not meant to be called by hand.

## Health and status

| Method and path | Returns |
|---|---|
| `GET /api/v1/health` | Overall `status` (`healthy` or `degraded`), the bus `version`, each channel's status and capabilities, message counts in the queue (`pending`, `processing`, `delivered`, `dead_letter`), and a `journaling` summary |
| `GET /api/v1/adapters` | The channels running on the bus |
| `GET /api/v1/pool` | Each `cc-pool` pane's state, conversation, model and last activity, plus parked messages. `?pool=agent:<id>` for one pool. |

`/api/v1/health` always answers `200` while the bus is running, so it's suitable for uptime monitors. See [Health and logs](/operations/monitoring).

The `journaling` summary has its own `status`: `critical` when an agent's journal runs have failed 3 times in a row or a conversation has waited a day to be journaled, `warning` after a failed run, otherwise `ok`. For each agent it gives the age of the oldest unjournaled conversation (`backlog_age_ms`), failed runs in a row, and the last success and failure. When it's `critical`, the overall `status` is `degraded` too; a `warning` doesn't change it.

## Sessions and transcripts

| Method and path | Returns |
|---|---|
| `GET /api/v1/sessions` | Recent sessions, newest first. Filters: `channel`, `contact_id` (bare ID, such as `me`), `since` (a date-time), `limit` (default 20, up to 100). |
| `GET /api/v1/sessions/<id>` | One session, with its channel, topic, title, message count and times |
| `GET /api/v1/sessions/<id>/transcript` | The session's messages, oldest first. `limit` (default 200, up to 1,000), `since`, `before`. |
| `GET /api/v1/transcripts/search?q=<words>` | Messages matching a keyword search, across all sessions. Filters: `channel`, `since`, `limit` (default 10, up to 100). |
| `GET /api/v1/messages/<id>` | One message by ID, including messages that failed delivery |

## Schedules

| Method and path | Does |
|---|---|
| `GET /api/v1/schedules` | Lists schedules. Filters: `status` (`active`, `paused`, `completed`, `cancelled`, `dead_letter`), `channel`, `created_by`, `limit` (default 50, up to 200). |
| `GET /api/v1/schedules/<id>` | One schedule |
| `POST /api/v1/schedules` | Creates a schedule (see below) |
| `PATCH /api/v1/schedules/<id>` | Changes `label`, `topic`, `model`, `max_fires`, or `status` (`active` or `paused`) |
| `DELETE /api/v1/schedules/<id>` | Cancels a schedule |

To create one, send:

```json
{
  "type": "cron",
  "cron_expr": "0 17 * * 5",
  "timezone": "Europe/London",
  "channel": "telegram",
  "sender": "contact:me",
  "payload_body": "Ask me what went well this week.",
  "label": "Weekly review",
  "max_fires": 10
}
```

For a one-off, use `"type": "once"` with `"fire_at"` (a future date-time) instead of `cron_expr`, and optionally `"stale_after_ms"`. Other optional fields: `topic`, `priority`, `model`. A bad cron expression, or a `fire_at` in the past, is refused with `400`. See [Scheduling](/features/scheduling).

## Model overrides

| Method and path | Does |
|---|---|
| `GET /api/v1/model-overrides` | Lists overrides |
| `POST /api/v1/model-overrides` | Sets one: `{"model": "opus", "agent_id": "agent:sam"}`, or without `agent_id` for every agent |
| `DELETE /api/v1/model-overrides?agent_id=agent:sam` | Removes one agent's override. `?scope=global` removes the global one; `?all=true` removes all. |

See [Choosing models](/features/models).

## Approvals

| Method and path | Does |
|---|---|
| `GET /api/v1/approvals?status=pending` | Lists approval requests by status: `pending`, `approved`, `denied`, `expired` or `stale` |
| `GET /api/v1/approvals/<id>` | One request |
| `POST /api/v1/approvals/<id>/resolve` | Answers a request: `{"decision": "approve"}` or `{"decision": "deny"}` |

Answering through the API skips the check that only the addressed contact may answer. See [Approvals](/features/approvals).

## Journaling

| Method and path | Returns |
|---|---|
| `GET /api/v1/journal/runs` | Journal runs, newest first: which journaler ran, the trigger, the outcome, what it could see, files changed, notes and cost. Filters: `agent` (for example `agent:assistant`), `conversation`, `session`, `limit` (default 50, up to 500). Kept for 90 days. |

| `GET /api/v1/memory/recent` | Used by the recent-memory hook: the agent's `recent.md` for one Claude session (`harness_session_id`), but only when it changed since that session last saw it. |

See [Journaling and memory](/features/journaling-and-memory).

## Advisories

| Method and path | Returns |
|---|---|
| `GET /api/v1/advisories` | Advisories, most severe first. Filters: `agent`, `state` (`active`, the default, or `all`, `open`, `delivered`, `acknowledged`, `resolved`). |
| `GET /api/v1/advisories/<id>` | One advisory |

There's no route to raise an advisory; only the bus raises them. See [Owners and advisories](/features/owners-and-advisories).

## Knowledge store

| Method and path | Does |
|---|---|
| `GET /api/v1/knowledge/search?agent_id=agent:sam&q=<words>` | Searches an agent's records. Filters: `kind`, `tags` (comma-separated, all must match), `facets` (JSON), `event_from`, `event_to`, `limit` (default 10, up to 50). |
| `GET /api/v1/knowledge/<id>` | One record |
| `POST /api/v1/knowledge` | Writes a record |
| `POST /api/v1/knowledge/<id>/forget` | Retires a record: `{"mode": "supersede", "superseded_by": "<id>"}`, `{"mode": "expire"}` or `{"mode": "delete"}` |

See [Knowledge store](/features/knowledge-store).

## Sending a message in

`POST /api/v1/inbound` puts a message into the bus as if it had arrived on a channel. It's how you'd connect a channel of your own:

```json
{
  "channel": "telegram",
  "sender": "contact:me",
  "recipient": "agent:assistant",
  "topic": "general",
  "payload": { "type": "text", "body": "Hello from a script" }
}
```

The message goes through the full pipeline: deduplication, slash commands, routing and so on. The agent's reply is delivered on `channel` to `sender`.

## Channel endpoints

These are used by devices and apps, each with its own token. They're described on each channel's page.

| Path | Used by |
|---|---|
| `/api/v1/app/…` | The [Mac app](/channels/mac-app) |
| `/api/v1/siri/ask`, `/api/v1/siri/health` | The [Siri](/channels/siri) shortcut |
| `/api/v1/webhooks/pebble` | The [Pebble](/channels/pebble) ring, through your proxy |

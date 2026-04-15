# Scheduling

E18 adds time-based message delivery to AgentBus. A scheduled item fires a message into the inbound pipeline at a specific time or on a recurring cron schedule. The agent sees the message as if the configured contact sent it on the configured channel and responds normally. The platform adapter (e.g. Telegram) delivers the agent's reply proactively — the user never typed anything.

## Config-defined schedules

Define standing schedules in `config.yaml` under the `schedules` key:

```yaml
schedules:
  - id: morning_briefing          # stable ID — must be unique; used for idempotent upsert
    cron: "0 8 * * 1-5"           # fire at 08:00 Mon–Fri
    timezone: America/New_York    # IANA timezone (default: UTC)
    channel: telegram
    sender: contact:chris         # must resolve to a known contact
    prompt: |
      Run the weather skill for San Francisco and summarize anything
      notable on my agenda today. Keep it under 3 sentences.
    label: Morning briefing       # optional; shown in /schedule list
    topic: general                # optional; default: general
    priority: normal              # optional; normal | high | urgent

  - id: weekly_review
    cron: "0 17 * * 5"            # every Friday at 17:00
    timezone: America/New_York
    channel: telegram
    sender: contact:chris
    prompt: "Give me a brief summary of what we worked on this week."
    label: Weekly review
    max_fires: 52                 # optional; stop after 52 fires (one year)

  - id: onboarding_reminder
    fire_at: "2026-05-01T09:00:00-05:00"   # one-shot; converted to UTC on load
    channel: telegram
    sender: contact:chris
    prompt: "Remind me about the onboarding meeting with the new team member today."
    label: Onboarding reminder
```

Config schedules are upserted by `id` on every startup — safe to restart with. Removing an entry from config.yaml cancels the schedule on the next startup.

### Scheduler config

```yaml
scheduler:
  tick_interval_ms: 30000   # how often to check for due items (default: 30s)
  enabled: true             # set false to disable all scheduled firing
```

## How firing works

When a scheduled item is due:

1. The Scheduler calls `processInbound()` with the item's `channel`, `sender`, and `prompt`.
2. The full inbound pipeline runs — contact resolution, memory injection, routing.
3. The message is enqueued for the agent (identical to a real user message).
4. The agent processes it and replies.
5. The DeliveryWorker sends the reply to the platform adapter.
6. The user sees only the agent's reply — there is no visible "inbound" message in the chat.

Scheduled messages are logged to transcripts with `metadata.scheduled = true` and `metadata.schedule_id` for auditability.

## HTTP API

All endpoints require the `X-Bus-Token` header when `bus.auth_token` is configured.

### Create a schedule

```
POST /api/v1/schedules
Content-Type: application/json

{
  "type": "cron",
  "cron_expr": "0 8 * * 1-5",
  "timezone": "America/New_York",
  "channel": "telegram",
  "sender": "contact:chris",
  "payload_body": "What's on my agenda today?",
  "label": "Morning briefing"
}
```

For a one-shot:

```json
{
  "type": "once",
  "fire_at": "2026-05-01T14:30:00Z",
  "channel": "telegram",
  "sender": "contact:chris",
  "payload_body": "Remind me to review the proposal."
}
```

Response: `201 { "ok": true, "id": "<uuid>", "fire_at": "<ISO UTC>" }`

### List schedules

```
GET /api/v1/schedules?status=active&channel=telegram&limit=50
```

Query params: `status` (active|paused|cancelled|completed), `channel`, `created_by`, `limit` (default 50, max 200).

### Get one schedule

```
GET /api/v1/schedules/:id
```

### Cancel a schedule

```
DELETE /api/v1/schedules/:id
```

### Update a schedule

```
PATCH /api/v1/schedules/:id
Content-Type: application/json

{
  "label": "New label",
  "max_fires": 10,
  "status": "paused"
}
```

Updatable fields: `label`, `max_fires`, `status` (active ↔ paused only). Cannot update completed or cancelled schedules.

## MCP tools

Three tools are available to the agent:

### `schedule_message`

Create a one-shot or recurring schedule.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `type` | `"once"` \| `"cron"` | yes | Schedule type |
| `prompt` | string | yes | Message text to deliver |
| `channel` | string | yes | Target channel (e.g. `"telegram"`) |
| `sender` | string | yes | Sender identity (e.g. `"contact:chris"`) |
| `cron_expr` | string | if cron | Cron expression (e.g. `"0 8 * * 1-5"`) |
| `fire_at` | string | if once | ISO 8601 future timestamp |
| `timezone` | string | no | IANA tz (default: `"UTC"`) |
| `topic` | string | no | Topic (default: `"general"`) |
| `priority` | string | no | `"normal"` \| `"high"` \| `"urgent"` |
| `label` | string | no | Human-readable name |
| `max_fires` | integer | no | Cap on cron fires (null = unlimited) |

### `list_schedules`

| Parameter | Type | Default | Description |
|---|---|---|---|
| `status` | string | `"active"` | Filter by status |
| `channel` | string | — | Filter by channel |
| `limit` | integer | 20 | Max results |

### `cancel_schedule`

| Parameter | Type | Description |
|---|---|---|
| `id` | string | Schedule ID to cancel |

## Slash commands

### `/schedule list`

List active schedules for the current channel:

```
/schedule list
```

```
Active schedules for telegram (2):

  a1b2c3d4  Morning briefing  next: 2026-04-17 12:00 UTC  (3 fired)
  e5f6g7h8  Weekly review     next: 2026-04-18 21:00 UTC  (0 fired)

Use /schedule cancel <id> to cancel a schedule.
```

### `/schedule cancel <id>`

Cancel a schedule by ID (prefix match supported):

```
/schedule cancel a1b2c3d4
```

Scoped to the current channel — you cannot cancel schedules from a different channel via slash commands.

## Cron expression format

Standard 5-part cron: `minute hour day-of-month month day-of-week`

```
0 8 * * 1-5     08:00 Mon–Fri
0 */4 * * *     Every 4 hours
30 9 1 * *      9:30 AM on the 1st of each month
0 17 * * 5      17:00 every Friday
```

Uses the [croner](https://github.com/Hexagon/croner) library. Seconds and years fields are supported as optional 6th/7th parts.

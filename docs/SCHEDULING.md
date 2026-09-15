# Scheduling

A scheduled item fires a message into the inbound pipeline at a specific time or on a recurring cron schedule. The agent sees the message as if the configured contact sent it on the configured channel and responds normally. The platform adapter (e.g. Telegram) delivers the agent's reply proactively — the user never typed anything.

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

> **Cancelling a config schedule manually** (via `/schedule cancel` or `DELETE /api/v1/schedules/:id`) marks it cancelled permanently. Subsequent restarts will **not** revive it, even if the entry is still present in config.yaml. To reset it, change its `id` in config.yaml so a fresh row is inserted, then remove the old id.

### Scheduler config

```yaml
scheduler:
  tick_interval_ms: 30000   # how often to check for due items (default: 30s)
  enabled: true             # set false to disable all scheduled firing
```

> **Note on `enabled: false`** — Config schedules are still upserted into the database even when the scheduler is disabled. Only the tick loop (firing) is stopped. This means schedules are visible and manageable via the HTTP API and MCP tools even when firing is paused.

## How firing works

When a scheduled item is due:

1. The Scheduler calls `processInbound()` with the item's `channel`, `sender`, and `prompt`.
2. The full inbound pipeline runs — contact resolution, memory injection, routing.
3. The message is enqueued for the agent (identical to a real user message).
4. The agent processes it and replies.
5. The DeliveryWorker sends the reply to the platform adapter.
6. The user sees only the agent's reply — there is no visible "inbound" message in the chat.

Scheduled messages are logged to transcripts with `metadata.scheduled = true` and `metadata.schedule_id` for auditability.

### Delivery semantics

The scheduler uses **at-least-once** delivery. `processInbound()` is called before the database is updated. If the process is killed between those two steps, the item retains its old `fire_at` and will fire again on the next restart.

- **Once schedules** (`type: once`): best-effort-once. A crash during firing may cause a duplicate. If exact-once semantics are critical, design prompts to be idempotent.
- **Cron schedules** (`type: cron`): intended to be periodic; the occasional duplicate is benign for most use cases.

### Staleness and dead-lettering

Because the scheduler's due-item query is simply `fire_at <= now`, a one-shot schedule fires on the very first tick after the process comes back up — even if it was overdue by hours or days. That's exactly what makes the scheduler useful as a durable post-restart wake-up (see below), but it also means an overdue item fires no matter how stale, unless bounded.

Set an optional `stale_after_ms` (milliseconds) on a `type: once` schedule to cap that: if the item is still unfired more than `stale_after_ms` after its `fire_at`, the scheduler marks it `status: dead_letter` instead of firing it, and logs a `console.warn` with the schedule id and how overdue it was. `dead_letter` items are terminal, like `completed` — they never fire.

- Omitted (the default): no staleness limit — every existing schedule and use case is completely unaffected.
- Only valid on `type: once`. A recurring `type: cron` schedule re-arms its own `fire_at` every cycle, so "staleness since fire_at" doesn't map onto it — setting it on a cron schedule is rejected with `400`.

#### Worked example: durable post-restart wake-up

`scripts/safe_restart.sh` uses this to guarantee Chris hears back after a `bus-core` restart, even if the restart script itself dies immediately after kicking off the restart (the exact failure mode that motivated this): right before calling `pm2 restart`, while `bus-core` is still confirmed healthy, it creates a one-shot schedule targeting the channel/topic that triggered the restart:

```json
{
  "type": "once",
  "fire_at": "2026-09-01T13:05:10Z",
  "channel": "telegram",
  "topic": "general",
  "sender": "contact:chris",
  "payload_body": "Restarting bus-core to pick up a config/code change. I'll follow up here once it's back.",
  "stale_after_ms": 2700000
}
```

Because `scheduled_items` is a DB row, it survives the restart trivially. If `bus-core` comes back up within 45 minutes (`2700000` ms), this fires as a genuine inbound turn in the exact conversation that triggered the restart on the very next tick. If `bus-core` never comes back (or takes longer than the ceiling), the item dead-letters instead of sending a confusingly late "I'll follow up" message whenever it eventually does restart.

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
  "payload_body": "Remind me to review the proposal.",
  "stale_after_ms": 2700000
}
```

`stale_after_ms` (optional, positive integer milliseconds) is only valid on `type: once` — see [Staleness and dead-lettering](#staleness-and-dead-lettering) above. Sending it alongside `type: cron` returns `400`.

Response: `201 { "ok": true, "id": "<uuid>", "fire_at": "<ISO UTC>" }`

### List schedules

```
GET /api/v1/schedules?status=active&channel=telegram&limit=50
```

Query params: `status` (active|paused|cancelled|completed|dead_letter), `channel`, `created_by`, `limit` (default 50, max 200).

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
| `stale_after_ms` | integer | no | Once-only staleness ceiling (ms); dead-letters instead of firing if exceeded |

### `list_schedules`

| Parameter | Type | Default | Description |
|---|---|---|---|
| `status` | string | `"active"` | Filter by status |
| `channel` | string | — | Filter by channel |
| `created_by` | string | — | Filter by creator: `agent`, `config`, `http`, or a custom value |
| `limit` | integer | 20 | Max results (max 200) |

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

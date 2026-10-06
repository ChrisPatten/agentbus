# Scheduling

Scheduling lets your agent do things without being asked: a briefing every weekday morning, a weekly review on Friday afternoon, a reminder at 5 pm today. At the scheduled time, the bus sends your agent a prompt as if you had sent it, and the agent's answer reaches you on the channel you chose.

## How it works

A schedule is a prompt, a time, and who it's "from". When it's due, the bus sends the prompt into the normal message flow, on the schedule's `channel` and from its `sender`. Your [routes](/concepts/contacts-and-routing) pick the agent, the agent runs, and its reply goes to that contact on that channel.

- **Recurring schedules** use a cron expression, such as `0 8 * * 1-5` for 8:00 every weekday.
- **One-off schedules** fire once at a set time.
- **Each recurring job has its own conversation**, in a topic named after its label (for a label "Morning briefing", the topic is `sched:morning-briefing`). The job keeps its own history and doesn't interrupt your chat. If you reply to the agent's message, your reply continues your normal conversation, not the job's. One-off schedules go to the `general` topic, so they appear in your usual conversation.
- **Scheduled turns have reserved capacity.** With `cc-headless`, one turn slot is kept free for scheduled work by default, so a busy chat can't hold up your briefing.

There are three ways to create a schedule: in `config.yaml`, by asking your agent, or through the [HTTP API](/reference/http-api#schedules).

## Schedules in config.yaml

Use the config file for the fixed routine you always want:

```yaml
schedules:
  - id: morning_briefing
    label: Morning briefing
    cron: "0 8 * * 1-5"
    timezone: America/New_York
    channel: telegram
    sender: contact:me
    prompt: |
      Give me a short briefing for today: my calendar, anything urgent in
      my inbox, and the weather.
    model: haiku

  - id: tax_reminder
    fire_at: "2027-04-01T13:00:00Z"
    channel: email
    sender: contact:me
    prompt: Remind me that taxes are due in two weeks.
```

| Field | Default | What it does |
|---|---|---|
| `id` | required | A unique name for the schedule |
| `cron` | | When a recurring schedule runs: minute, hour, day of month, month, day of week |
| `fire_at` | | When a one-off schedule runs, as a date and time. Use UTC, ending in `Z`. |
| `timezone` | `UTC` | The time zone `cron` is read in, for example `Europe/London` |
| `channel` | required | The channel the prompt arrives on, and the reply goes to |
| `sender` | required | Who the prompt is from, usually `contact:<you>` |
| `prompt` | required | What to ask the agent |
| `label` | | A readable name, shown in lists, and used for the job's topic |
| `topic` | see above | Put the job in a specific topic instead |
| `priority` | `normal` | `normal`, `high` or `urgent` |
| `model` | | The model for this job, for example `haiku` for a cheap daily check. See [Choosing models](/features/models). |
| `max_fires` | | Stop a recurring schedule after this many runs, for example `52` for a year of weekly runs |

Give each schedule either `cron` or `fire_at`.

**Write `fire_at` in UTC, ending in `Z`.** A time with an offset, such as `-05:00`, is currently read as if it were UTC, so the schedule fires early.

### Changing config schedules

The bus reads `schedules` each time it starts:

- **New entries** are added.
- **Changed entries** pick up the new prompt, cron, time zone, label, topic, priority, model and `max_fires`. A new cron time takes effect after the next run under the old one.
- **Removed entries** are cancelled.
- **A config schedule you cancel stays cancelled**, even if it's still in the file. To bring it back, give it a new `id`.

A schedule that reaches its `max_fires` is marked completed and stops running.

## Asking your agent

Your agent has scheduling tools, so you can just ask:

> Remind me to call the garage at 4 pm.
>
> Every Friday at 5 pm, ask me what went well this week.

The agent creates the schedule with `schedule_message`, and can list, change, pause and cancel schedules with `list_schedules`, `update_schedule` and `cancel_schedule`. It can also set:

- **a limit on runs** (`max_fires`), for example "every day for the next week";
- **a staleness limit** for one-off schedules (`stale_after_ms`): if the bus was down at the scheduled time and it's now later than this, the schedule is dropped instead of firing late.

See [MCP tools](/reference/mcp-tools#scheduling).

## Managing schedules

| To | Do this |
|---|---|
| See what's scheduled on this channel | Send `/schedule`. Next run times are shown in UTC. |
| Cancel a schedule | `/schedule cancel <id>`, using the first characters of the ID from the list |
| Pause or resume, rename, or change a schedule's model or topic | Ask your agent, or use `PATCH /api/v1/schedules/<id>` |
| Change a schedule's time or prompt | Cancel it and create a new one, or edit `config.yaml` for config schedules |

## When the bus was down

- **A recurring schedule that missed runs** fires once when the bus starts, then carries on as normal. It doesn't catch up every missed run.
- **A one-off schedule that was missed** fires when the bus starts, unless it has a staleness limit and is now too late.
- **A paused recurring schedule** that's overdue fires once when you resume it.

**Schedules can occasionally fire twice.** If the bus stops at the exact moment a schedule fires, it may fire again on restart. It never silently skips.

The bus checks for due schedules every 30 seconds, so a schedule can fire up to half a minute after its time. Change this with `scheduler.tick_interval_ms`, or turn scheduling off with `scheduler.enabled: false`.

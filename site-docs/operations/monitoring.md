# Health and logs

When your agent goes quiet, these are the places to look. The health report tells you whether each channel is connected, `/status` answers the same question from your phone, and the logs say what happened to each message.

## Health report

From a terminal in the AgentBus folder:

```bash
make health
```

Or from anywhere on the same computer:

```bash
curl http://127.0.0.1:3000/api/v1/health
```

The report includes:

| Field | Meaning |
|---|---|
| `status` | `healthy` when every channel is online, otherwise `degraded` |
| `version` | The AgentBus version running |
| `adapters` | Each channel with its status: `online`, `degraded` or `unhealthy` |
| `queue` | Messages `pending` (waiting for an agent), `processing`, `delivered`, and in `dead_letter` (couldn't be delivered) |

A channel becomes `degraded` after a few failed attempts to reach its service (3 for Telegram, 2 for email) and `unhealthy` after more (10 and 5). It recovers by itself once the service is reachable again.

The health address never needs a password and always answers while the bus runs, so you can point an uptime monitor at it.

## From your phone

Send `/status` in any chat with your agent. You get the same channel and queue summary, plus:

- for `cc-headless` agents, how many turns are running and waiting;
- for `cc-pool` agents, how many panes are leased and how many messages are parked.

## Logs

`make logs` shows the bus's output as it happens. Each line starts with the part of the bus that wrote it:

| Prefix | From |
|---|---|
| `[telegram]`, `[email]` | A channel. Named instances add their name. |
| `[cc-headless…]` | The `cc-headless` runtime: turns starting, the model used, failures |
| `[pool:…]` | The `cc-pool` runtime: pane launches, leases, parking |
| `[pipeline:…]` | Message processing: duplicates dropped, routing decisions |
| `[scheduler]` | Schedules loaded and fired |
| `[delivery]` | Replies being delivered to channels |
| `[http]` | Requests to the bus's HTTP API |

Logs are written to `~/.agentbus/logs/` when the bus runs in the background. They aren't rotated, so they grow over time; delete old logs while the bus is stopped if they get large.

## Messages that couldn't be delivered

When a reply can't be delivered, for example because Telegram rejected it, it's moved to the **dead-letter** list instead of being retried. The health report counts them. To see the latest, with the reason for each, you can query the database with the `sqlite3` program, which comes with macOS:

```bash
sqlite3 ~/.agentbus/agentbus.db "SELECT created_at, reason, substr(payload,1,120) FROM dead_letter ORDER BY created_at DESC LIMIT 20"
```

There's no command to resend them. If something important is there, ask your agent to send it again.

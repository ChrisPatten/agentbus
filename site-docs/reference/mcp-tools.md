# MCP tools

These are the tools AgentBus gives your agent. Claude Code loads them automatically for every runtime, under the server name `agentbus` (so in Claude Code they appear as `mcp__agentbus__reply` and so on). You don't call them yourself. This page tells you what your agent can do, so you can ask for it or describe it in the agent's instructions.

## Messaging

| Tool | What it does |
|---|---|
| `reply` | Answers a message. Takes the `message_id` shown in the incoming message as `[id:…]`, and a `body`. The answer goes back on the same channel, in the same thread or topic. |
| `send_message` | Starts a message to a contact on any channel. See below. |
| `send_email` | Starts a new email. See below. |
| `react_to_message` | Adds an emoji reaction to a message, by `message_id`. On channels without reactions, it reports that instead of failing. |
| `create_telegram_topic` | Opens a forum topic in a Telegram group. See below. |
| `list_channels` | Lists the channels running on the bus and what each can do |
| `fetch_attachment` | Looks up a saved attachment by its ID and returns its file path. Mostly used for images embedded in emails. |

### `send_message`

| Parameter | Required | Meaning |
|---|---|---|
| `to` | yes | The contact, such as `contact:me` |
| `channel` | yes | Where to send it, such as `telegram`, `email:work` or `app` |
| `body` | yes | The message |
| `topic` | no | A thread or topic to post into, such as `thread:9cfaf60aed4358c6`. Default `general`; for the Mac app, that's Main. |
| `reply_to` | no | A message ID to reply to |
| `priority` | no | `normal` (default), `high` or `urgent` |

See [Proactive messages](/features/proactive-messages).

### `send_email`

| Parameter | Required | Meaning |
|---|---|---|
| `body` | yes | The email, in Markdown. It's sent formatted. |
| `subject` | no | Default "Message from your assistant" |
| `to` | no | Must be an address listed under your contacts. Default: the first listed address. |

Available when an email channel is configured and at least one contact has an email address. Sends from the first configured mailbox.

### `create_telegram_topic`

| Parameter | Required | Meaning |
|---|---|---|
| `channel` | yes | The group's channel, such as `telegram:group:-1001234567890` |
| `name` | yes | The topic's name |
| `context` | no | A note the agent sees with the first message in the new topic |

Returns the new topic's `thread:` name, for use with `send_message`. Available when a Telegram channel is configured. The bot needs the **Manage Topics** admin right in that group.

## Sessions and history

| Tool | What it does |
|---|---|
| `list_sessions` | Recent sessions, newest first. Filters: `channel`, `contact_id` (bare ID, such as `me`), `since`, `limit` (default 20, up to 100). |
| `get_session` | One session's details: channel, topic, title, message count and times. With no `session_id`, the most recent session. |
| `get_transcript` | A session's messages, oldest first. `session_id`, `limit` (default 200, up to 1,000), `since`, `before`. |
| `search_transcripts` | Keyword search across all transcripts. `query`, `channel`, `since`, `limit` (default 10, up to 100). |

## Scheduling

| Tool | What it does |
|---|---|
| `schedule_message` | Creates a schedule. See below. |
| `list_schedules` | Lists schedules. `status` (default `active`; also `paused`, `cancelled`, `completed`), `channel`, `created_by`, `limit` (default 20, up to 200). |
| `update_schedule` | Changes a schedule's `label`, `topic`, `model` or `max_fires`, or pauses (`status: paused`) and resumes (`status: active`) it |
| `cancel_schedule` | Cancels a schedule by `id` |

`schedule_message` parameters:

| Parameter | Required | Meaning |
|---|---|---|
| `type` | yes | `cron` (recurring) or `once` |
| `prompt` | yes | What the agent will be asked |
| `channel` | yes | Where the prompt arrives and the reply goes |
| `sender` | yes | Who the prompt is from, such as `contact:me` |
| `cron_expr` | for `cron` | Such as `0 8 * * 1-5` |
| `fire_at` | for `once` | A future date and time |
| `timezone` | no | Default `UTC` |
| `label` | no | A readable name; also names a recurring job's topic |
| `topic` | no | Put the job in a specific topic |
| `priority` | no | `normal`, `high` or `urgent` |
| `max_fires` | no | Stop after this many runs |
| `stale_after_ms` | no | For `once`: skip it if it's this late |
| `model` | no | The model for this job |

See [Scheduling](/features/scheduling).

## Models

| Tool | What it does |
|---|---|
| `set_model_override` | Sets the model for one agent (`agent_id`) or every agent |
| `get_model_override` | The override that applies to an agent |
| `list_model_overrides` | Every override |
| `delete_model_override` | Removes one agent's override, the global one (`scope: global`), or all (`all: true`) |

`set_headless_model`, `get_headless_model`, `list_headless_model` and `delete_headless_model` are older names for the same tools, kept for compatibility. See [Choosing models](/features/models).

## Knowledge store

| Tool | What it does |
|---|---|
| `write_knowledge` | Saves a record: `agent_id`, `kind`, `title`, and `payload` (JSON), plus optional tags, facets, dates, importance, confidence and the ID of a record it `supersedes` |
| `search_knowledge` | Finds an agent's records by keywords (`q`), `kind`, `tags`, `facets`, or event date range |
| `get_knowledge` | Reads one record by `id` |
| `forget_knowledge` | Retires a record: `mode` is `supersede`, `expire` or `delete` |

See [Knowledge store](/features/knowledge-store).

## Advisories and journaling

| Tool | What it does |
|---|---|
| `advisory_ack` | Confirms the agent has told its owner about an advisory: `id` from the advisory block. See [Owners and advisories](/features/owners-and-advisories). |
| `journal_complete` | Finishes a journal run: `run_id` from the journal block, plus `files_changed`, a one-line `notes`, or `nothing_new: true`. Until it's called, messages to the agent wait and its own messages are refused. Not available to `cc-headless`. See [Journaling and memory](/features/journaling-and-memory#while-the-agent-is-journaling). |

## Runtime-specific

`get_adapter_status` reports whether the session's connection to the bus is healthy. It's available to `claude-code` and `cc-pool` sessions, which keep a live connection, and not to `cc-headless`.

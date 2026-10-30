# MCP tools

These are the tools AgentBus gives your agent. Claude Code loads them automatically for every runtime, under the server name `agentbus` (so in Claude Code they appear as `mcp__agentbus__reply` and so on). You don't call them yourself. This page tells you what your agent can do, so you can ask for it or describe it in the agent's instructions.

## Messaging

| Tool | What it does |
|---|---|
| `reply` | Answers a message. Takes the `message_id` shown in the incoming message as `[id:…]`, and a `body`. The answer goes back on the same channel, in the same thread or topic. Also takes `choices`, `silent`, `no_preview` and `pin`, as `send_message` does. |
| `send_message` | Starts a message to a contact on any channel. See below. |
| `share_context` | Hands a note to Main without showing you a message. See below. |
| `send_email` | Starts a new email. See below. |
| `react_to_message` | Adds an emoji reaction to a message, by `message_id`. On channels without reactions, it reports that instead of failing. |
| `status` | Sets the short status line you see while the agent works. See below. |
| `create_telegram_topic` | Opens a forum topic in a Telegram group. See below. |
| `list_channels` | Lists the channels running on the bus and what each can do |
| `fetch_attachment` | Looks up a saved attachment by its ID and returns its file path. Mostly used for images embedded in emails. |

`reply` and `send_message` return the new message's ID, which `edit_message` and `pin_message` take.

### `send_message`

| Parameter | Required | Meaning |
|---|---|---|
| `to` | yes | The contact, such as `contact:me` |
| `channel` | yes | Where to send it, such as `telegram`, `email:work` or `app` |
| `body` | yes | The message |
| `topic` | no | A thread or topic to post into, such as `thread:9cfaf60aed4358c6`. Default `general`; for the Mac app, that's Main. |
| `reply_to` | no | A message ID to reply to |
| `priority` | no | `normal` (default), `high` or `urgent` |
| `source` | no | A short name for what's sending the message, such as `Ambient scan`. When the message lands in a conversation the sender isn't part of, such as the Mac app's Main, the agent there sees it with this name. |
| `choices` | no | 1 to 8 answers to offer as buttons. See [Choices](#choices). |
| `silent` | no | `true` delivers on Telegram without a notification sound |
| `no_preview` | no | `true` stops Telegram from showing a preview card for links |
| `pin` | no | `true` pins the message on Telegram after it's sent |

Other channels ignore `silent`, `no_preview` and `pin`.

Without `source`, a message sent during a scheduled job's turn uses the schedule's `label` (or its `id` if it has no label). Any other message uses the `AGENTBUS_SOURCE_LABEL` environment variable of the agentbus MCP server that sent it, if you set one, and otherwise "another agent session". Set the variable in the server's `env`, for example in a project's `.mcp.json`. It labels every session that uses that file, so prefer `source` when one project runs several kinds of sessions.

The bus records where every message from `send_message`, `reply` and `send_email` came from. You can't set this yourself; it's what lets the agent in Main tell its own replies apart from messages sent by other sessions.

See [Proactive messages](/features/proactive-messages).

### Choices

Each item in `choices` is a label of up to 64 characters, or an object for a special button:

| Field | Meaning |
|---|---|
| `label` | The button text (required) |
| `style` | `primary`, `success` or `danger`, to color the button |
| `copy_text` | Text the button copies to your clipboard, up to 256 characters. Sends nothing back. |
| `url` | A link the button opens (`https://`, `http://` or `tg://`). Sends nothing back. |

A button can't have both `copy_text` and `url`. Plain labels and objects can be mixed. On Telegram and in the Mac app, a tap on an ordinary button reaches the agent as `[tapped] <label>`. On other channels the choices are added to the message as a numbered list. See [Telegram buttons](/channels/telegram#buttons) and [Mac app buttons](/channels/mac-app#buttons).

```json
{ "choices": ["Book it", { "label": "Cancel", "style": "danger" }, { "label": "Open the booking", "url": "https://example.com/b/123" }] }
```

### `share_context`

Gives the agent in the Mac app's Main a note about work you finished in another Claude Code session. You see nothing: no message, notification or unread badge, and Main isn't woken. Main reads the note on its next turn.

| Parameter | Required | Meaning |
|---|---|---|
| `to` | yes | The contact, such as `contact:me` |
| `body` | yes | The note: what happened, where the result is, what's still open |
| `source` | yes | Where it comes from, such as `Claude Code: my-project`. Main sees this label. |
| `channel` | no | `app` (default) is Main in the Mac app. Pass a listed private-chat channel such as `telegram:assistant` to brief an agent through its Telegram chat. |

Notes older than 24 hours are skipped, a note too long for the context budget is refused (shorten it and try again), and it can't be called from Main itself. To tell you something or ask a question, use `send_message`. See [Proactive messages](/features/proactive-messages#letting-main-know-without-a-message).

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

### `status`

| Parameter | Required | Meaning |
|---|---|---|
| `text` | yes | 1 to 5 plain words, at most 40 characters, such as `Comparing the quotes` |

Replaces the automatic status line for the rest of the turn, or until the next `status` call. Markdown and symbols are removed. Nothing is shown once the agent has replied, or on email. See [Watching your agent work](/channels/telegram#watching-your-agent-work).

## Telegram extras

These tools are available when a Telegram channel is configured. The send tools take the same `to`, `channel`, `topic` and `reply_to` as `send_message`, plus `silent` and `pin`, and return a message ID.

| Tool | What it does | On other channels |
|---|---|---|
| `send_location` | A map card: `latitude`, `longitude` | Coordinates and a map link |
| `send_venue` | A venue card: `latitude`, `longitude`, `title`, `address` | Name, address and a map link |
| `send_contact` | A contact card: `phone_number`, `first_name`, optional `last_name` and `vcard` | Name and number |
| `send_document` | Uploads a file: `path` (full path), optional `caption` (up to 1,024 characters) and `as` (`document`, the default, up to 50 MB; or `photo`, up to 10 MB). The file must be inside one of the Telegram channel's [`send_paths`](/channels/telegram#set-it-up). | Not supported; returns an error |
| `send_rich` | A rich message with headings, tables, expandable sections and link buttons: `markdown` or `html`, optional `choices`. Up to 32,768 characters; longer content is split into parts. | Plain text, with tables as lists |
| `ask_input` | Asks you for something: `kind` (`location`, `contact`, `person` or `text`), `prompt`, optional `placeholder` for `text`. Your answer arrives as a message linked to the prompt. Share buttons only appear in private chats. | The prompt as plain text |
| `edit_message` | Changes the text of a message the agent sent in the last 30 days: `message_id`, `body`, optional `choices` (leave it out to remove the buttons). Messages that were split into parts, files and cards can't be edited. | Not supported |
| `pin_message` | Pins a message the agent sent: `message_id`, `silent` (default `true`) | Not supported |
| `unpin_message` | Unpins it: `message_id`, or `unpin_all: true` to unpin everything in that topic or chat | Not supported |

Pinning in a group needs the bot's **Pin Messages** admin right. See [Telegram](/channels/telegram#cards-files-and-rich-messages).

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

## Advisories, journaling and learning

| Tool | What it does |
|---|---|
| `advisory_ack` | Confirms the agent has told its owner about an advisory: `id` from the advisory block. See [Owners and advisories](/features/owners-and-advisories). |
| `journal_complete` | Finishes a journal run: `run_id` from the journal block, plus `files_changed`, a one-line `notes`, or `nothing_new: true`. Until it's called, messages to the agent wait and its own messages are refused. Not available to `cc-headless`. See [Journaling and memory](/features/journaling-and-memory#while-the-agent-is-journaling). |
| `propose_change` | Proposes a change to one of the agent's protected files, such as `CLAUDE.md` or a skill, for its owners to approve: `path`, either `new_content` or a unified `diff`, a `rationale`, and optional `evidence`. Approved changes are applied by the bus. At most three a day. See [Journaling and memory](/features/journaling-and-memory#approve-improvements-to-the-agent-s-instructions). |

## Runtime-specific

`get_adapter_status` reports whether the session's connection to the bus is healthy. It's available to `claude-code` and `cc-pool` sessions, which keep a live connection, and not to `cc-headless`.

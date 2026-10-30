# MCP tools

The tools an agent can call. They are registered on the MCP server in `src/adapters/cc.ts` by `registerAllTools()` (polling mode) or `registerHeadlessTools()` (tools-only mode for `claude -p`); the only difference is that headless mode omits `get_adapter_status`. Every tool is a thin HTTP client for bus-core. The logic lives in the routes listed in [HTTP_API.md](HTTP_API.md).

Errors come back as `{ "content": [{ "type": "text", "text": "Error: ..." }], "isError": true }`. Expected non-success outcomes (a channel that cannot react, a missing session) return `success: false` or `available: false` without `isError`.

## Tool index

| Tool | Purpose | Registered when |
|---|---|---|
| `reply` | Reply to a message by its bus ID | Always |
| `send_message` | Send to any contact on any channel | Always |
| `share_context` | Hand a Claude Code session's outcome to Main as hidden context (no message) | Always |
| `send_email` | Start a new email thread to an allowlisted address | An email adapter is configured |
| `react_to_message` | Emoji reaction on a message | Always |
| `create_telegram_topic` | Create a forum topic in a Telegram group | A Telegram adapter is configured |
| `send_location`, `send_venue`, `send_contact` | Map card, venue card or contact card (E81) | A Telegram adapter is configured |
| `send_document` | Upload an allow-listed local file as a document or photo (E81) | A Telegram adapter is configured |
| `ask_input` | Ask for a location, contact, person or free text (E81) | A Telegram adapter is configured |
| `send_rich` | Rich message: tables, collapsible sections, buttons (E81) | A Telegram adapter is configured |
| `edit_message` | Edit a message you sent, in place (E81) | A Telegram adapter is configured |
| `pin_message`, `unpin_message` | Pin or unpin a message you sent (E81) | A Telegram adapter is configured |
| `list_channels` | Adapters and their capabilities | Always |
| `get_session`, `list_sessions` | Session metadata and topic | Always |
| `get_transcript` | Full ordered transcript for one session | Always |
| `search_transcripts` | Full-text search across transcripts | Always |
| `fetch_attachment` | Resolve an attachment ID to a file path | Always |
| `schedule_message`, `list_schedules`, `cancel_schedule`, `update_schedule` | Scheduled messages | Always |
| `set_model_override`, `get_model_override`, `list_model_overrides`, `delete_model_override` | Runtime model overrides (agent or global) | Always |
| `write_knowledge`, `get_knowledge`, `forget_knowledge`, `search_knowledge` | Agent-managed structured knowledge store (Phase 1) | Always |
| `advisory_ack` | Acknowledge a bus advisory after relaying it to the owner | Always |
| `journal_complete` | Finish a System Message journal run | Polling adapter and cc-pool panes (not cc-headless) |
| `status` | Set your own short live status line for the current turn | Always |
| `propose_change` | Propose a change to a protected file (CLAUDE.md, skills, …) for an owner to approve | Always |
| `get_adapter_status` | Health of the polling MCP adapter | Polling mode only |

## Messaging

### `reply`

Fetches the original message, swaps sender and recipient, and posts the reply on the same channel and topic.

Input: `{ "message_id": "<bus id from [id:...]>", "body": "...", "choices": ["A", "B"] }` (`choices` optional; see [Choice buttons](#choice-buttons))
Output: `{ "success": true, "outbound_message_id": "<uuid>" }`

The reply carries `metadata.origin` (see [Origin metadata](#origin-metadata)).

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
| `metadata` | no | Free-form object. A caller-supplied `origin` key is replaced (see below) |
| `choices` | no | 1-8 single-choice labels, each non-empty and at most 64 characters. See [Choice buttons](#choice-buttons) |
| `silent`, `no_preview`, `pin` | no | Telegram delivery options, see [Send options](#send-options) |
| `source` | no | Short label naming what is sending, for example `Ambient scan`. Stamped as `metadata.origin.label`; when the message lands in a conversation this session isn't running in, that conversation's agent sees it with this label as context (E69) |

For a proactive send, call `get_session` or `list_sessions` first and use the `topic` it returns rather than guessing.

Output: `{ "success": true, "message_id": "<uuid>" }`

### `share_context`

Hands a note to the contact's Main in the Mac app (E82), or to an agent's Telegram DM (E83), without sending a message. Use it from an interactive Claude Code session to pass on an outcome (a finished artifact, a decision) so Main knows about it on its next turn, the way it already learns what a scheduled routine sent. Nothing appears in the app: no message, no unread badge, no sidebar movement, no notification, and Main is not woken. It is a separate tool from `send_message` because it has different delivery semantics: no channel, topic, queue or adapter. It calls [`POST /api/v1/context`](HTTP_API.md#post-apiv1context).

| Field | Required | Notes |
|---|---|---|
| `to` | yes | `contact:<id>`, as for `send_message` |
| `body` | yes | The note. Self-contained and concise; one note per finished piece of work |
| `source` | yes | Label shown to the agent, for example `Claude Code: baxter` |
| `channel` | no | `app` (default): Main in the Mac app. E83: a primary channel such as `telegram:peggy`, the agent's Telegram DM; it must be listed in `agents.<id>.pending_context.channels` ([CC_POOL_ADAPTER.md](CC_POOL_ADAPTER.md#primary-conversations-pending-context-and-shared-context-e83)) |

Output: `{ "success": true, "message_id": "<uuid>" }`

The tool description tells the model what it is for (handing a session's outcome to Main) and what it is not for (notifying the operator or asking a question; use `send_message` for those). Rules:

- **Primary conversations only.** The target is the `general` conversation of `channel`: Main for `app`, or a listed channel's DM. Named app topics, groups, forum threads and unlisted channels are rejected. Only `cc-headless` and `cc-pool` read shared context (cc-headless in `runBatch`, cc-pool through the pending-context stage), so the bus also rejects the call with a clear error when the route that serves the conversation targets another adapter (the polling `claude-code` adapter).
- **Not from the conversation itself.** A call whose origin is a turn in the target conversation is rejected, since an agent should not hand itself context. That covers a cc-headless Main turn and, because the bus stamps a pane's origin from its lease, the pane leased to the DM. A call from a turn in another conversation (a scheduled routine, a pane leased elsewhere) is allowed and stamps that turn's origin.
- **A quiet DM is fine.** If the DM has no session yet the bus creates a message-less placeholder session; the first real message still launches a fresh pane session.
- **Too long is an error.** A note that doesn't fit `adapters.app.pending_context.max_chars` (default 4000, counting the label and timestamp Main sees) is rejected with a message asking the caller to summarize, so nothing is truncated silently.
- **Expires.** The agent ignores a note older than `context_ttl_ms` (default 24 hours) when its next turn starts: `adapters.app.pending_context.context_ttl_ms` for Main, and for a listed DM the owning agent's `agents.<id>.pending_context.context_ttl_ms` when set, else the app's.
- **Not in journal runs.** The headless journaling turns disallow it along with `reply`, `send_message` and `send_email`, and the bus rejects it while a System Message journal run is open for the sender.
- **Search.** The note is hidden from `search_transcripts` and `get_transcript` like other hidden rows; it stays in the database and in journaling windows.

Suggested wording for an agent's `CLAUDE.md` (for example Baxter's, in the project the Claude Code sessions run in; the bus does not edit it):

```markdown
### Handing context to Main

When you finish a meaningful piece of work in this session (an artifact, a decision, a result Main
should build on), call `share_context` once with `to="contact:chris"` and `source="Claude Code: <project>"`.
Main reads it on its next turn; Chris does not see it and is not notified.

- One note per finished piece of work, not a running log.
- Write it so Main can act on it cold: what you did, where the result lives (file path or link),
  what was decided, what is still open. Keep it to a few sentences; long notes are rejected.
- Do not use it to ask Chris something or to get his attention. Use `send_message` for that.
- Do not call it from Main. If you are Main, you already have the context.
```

For Peggy's Telegram DM (E83), in the `CLAUDE.md` of the project her operator's Claude Code sessions run in; the sessions can run on another machine if `AGENTBUS_URL` (and `AGENTBUS_BUS_TOKEN`) point at her bus:

```markdown
### Handing context to Peggy

When you finish a meaningful piece of work in this session (an artifact, a decision, a result Peggy
should build on), call `share_context` once with `to="contact:chris"`, `channel="telegram:peggy"` and
`source="Claude Code: <project>"`. Peggy reads it at her next turn in the DM; Chris does not see it
in Telegram and is not notified.

- One note per finished piece of work, not a running log.
- Write it so Peggy can act on it cold: what you did, where the result lives, what was decided, what
  is still open. A few sentences; long notes are rejected, and notes older than 24 hours are skipped.
- Do not use it to ask Chris something or to get his attention. Use `send_message` for that.
- Peggy's own panes never call it for their own DM.
```

### Choice buttons

`reply` and `send_message` both accept `choices` (E74) to offer single-choice answers:

- On Telegram the labels render as inline buttons (one per row, or two per row when every label is 12 characters or fewer). The tap arrives back in the same conversation and topic as an ordinary inbound message `[tapped] <label>`, with `metadata.choice_prompt_id` and `reply_to` set to the prompt's bus message. Typed replies still work.
- In the Mac app (`app` channel, E86) the labels render as buttons under the message, and the tap arrives the same way, as `[tapped] <label>` with `metadata.choice_prompt_id`, bound to the prompt's session. The body gets no numbered list. The prompt shows as answered or expired on every open app window and after a reload.
- On every other channel the labels are appended to the body as a numbered list, and `metadata.choices` is not set.
- More than 8 labels, an empty label or a label over 64 characters is rejected with an error and nothing is sent.
- Use it for a real decision the user must make, not for routine messages. Single choice only; there is no multi-select.

See [TELEGRAM_ADAPTER.md](TELEGRAM_ADAPTER.md#choice-buttons) for Telegram tap handling, expiry and limits, and [APP_ADAPTER.md](APP_ADAPTER.md#choice-buttons-e86) for the app's message fields, `choice` event and tap frame.

**Button objects (E81).** An item may be an object instead of a string: `{ "label": "...", "style": "primary|success|danger", "copy_text": "...", "url": "..." }`. `style` colors a normal button; `copy_text` (1-256 characters) makes a button that copies the text when tapped and sends nothing back; `url` (`http(s)://` or `tg://`) opens a link; `copy_text` and `url` are mutually exclusive. Strings and objects can be mixed. After a tap on a prompt that uses objects, the chosen button stays visible and disabled and the others are removed; a prompt of plain strings behaves exactly as before. In the Mac app, copy and link buttons work on the client (pasteboard, browser) and send nothing to the bus. On other channels an object renders as `N. label (copy_text or url)`.

### Send options

`reply` and `send_message` (E81) take three optional Telegram delivery flags, each independent and combinable with `choices`; other channels ignore them:

| Field | Effect |
|---|---|
| `silent` | Deliver without a notification sound (`disable_notification`). Use for routine messages |
| `no_preview` | Do not expand link cards (`link_preview_options.is_disabled`) |
| `pin` | Pin the delivered message silently. A pin failure (for example missing the Pin Messages right) is logged, not returned; use `pin_message` to see the error |

There is deliberately no `effect` option: Telegram rejects message effects in group chats (verified in the E81 spike).

### `send_email`

Starts a new email thread, as opposed to `reply`, which threads into a received message. Sends on the first configured email channel. `to` defaults to the first allowlisted address in `contacts[*].platforms.email.address`; any other `to` must also be on that allowlist or nothing is sent. `body` is Markdown and renders as HTML. See [EMAIL_ADAPTER.md](EMAIL_ADAPTER.md#agent-initiated-email-send_email-tool).

Input: `{ "body": "...", "to"?: "chris@example.com", "subject"?: "Weekly status" }`
Output: `{ "success": true, "message_id": "<uuid>", "to": "chris@example.com" }`

The email's outbound row carries `metadata.origin` too.

### Origin metadata

`reply`, `send_message` and `send_email` always stamp `metadata.origin` (E69, `src/core/origin.ts`), replacing any value the caller passed, so an agent can't set it by accident:

```ts
type Origin =
  | { kind: 'turn'; agent_id: string; conversation_id: string; label?: string }
  | { kind: 'external'; label: string };
```

- **`kind: 'turn'`** when the MCP server's environment has `AGENTBUS_TURN_CONVERSATION_ID`. `cc-headless` writes that variable into the per-turn MCP config of each normal turn (not journaling or consolidation turns), so `conversation_id` is the conversation the turn runs in. `agent_id` is the server's bare `AGENTBUS_AGENT_ID`. cc-headless's own fallback delivery (a turn that ended without a delivery tool) doesn't go through MCP and stamps `{ kind: 'turn', agent_id, conversation_id }` directly.
- **`kind: 'external'`** otherwise: a scheduled routine in another Claude Code session, a cc-pool pane, or the polling adapter.
- **`label`** precedence: the `send_message` `source` parameter, then `AGENTBUS_SOURCE_LABEL` in the MCP server's environment, then (external only) `"another agent session"`. A turn origin carries a label only when one is given explicitly, so a quote of the agent's own message isn't attributed to the generic label.
- **Scheduled turns.** When a cc-headless turn was fired by a bus schedule (`metadata.scheduled`), cc-headless sets `AGENTBUS_SOURCE_LABEL` in that turn's MCP config to the schedule's name, and its fallback delivery stamps the same `label`. The name is the schedule's `label` (`metadata.schedule_label`), else its id (`metadata.schedule_id`) when that's a config id such as `ambient-scan`, else `scheduled job <id8>` for a generated UUID id; never the prompt body (`scheduleSourceLabel` in `src/adapters/cc-headless.ts`). A per-call `source` still wins. Other turns get no label.

| Variable | Set by | Effect |
|---|---|---|
| `AGENTBUS_TURN_CONVERSATION_ID` | cc-headless, per turn, in the generated MCP config | Sends are `kind: 'turn'` for that conversation. cc-headless removes any inherited copy from the `claude` process environment, so a stray value never leaks into journaling turns |
| `AGENTBUS_SOURCE_LABEL` | You, in an MCP server's `env` (for example a project's `.mcp.json`); cc-headless, per scheduled turn, with the schedule's name | Default label for that server's sends. Prefer the per-call `source` when one project's `.mcp.json` serves several sessions, since the variable labels all of them |

The origin is stored on the outbound transcript row's `metadata`; no migration was needed. The bus uses it to decide which messages are **foreign** to a conversation: `kind: 'external'`, or `kind: 'turn'` with a different `conversation_id`. Rows with no origin (bus command responses, advisories, rows written before E69) are never foreign. Foreign sends to the Mac app's Main are injected into the next Main turn as [pending context](CC_HEADLESS_ADAPTER.md#pending-context-main); only own-turn sends advance Main's [idle clock](APP_ADAPTER.md#main-one-continuous-conversation).

### `react_to_message`

Input: `{ "message_id": "<bus id>", "emoji": "👍" }`
Output: `{ "success": true, "emoji": "👍", "message_id": "..." }`, or `{ "success": false, "reason": "Reactions not supported on channel: email" }` on a channel without reactions.

Telegram accepts a fixed set of about 74 reaction emoji. Anything else is sent as a plain text message instead. Variation selectors are stripped automatically.

### E81 Telegram-native tools

All of these enqueue the same envelope as `send_message` (so the contact allow-list and the delivery path are unchanged) and share its addressing: `to`, `channel`, optional `topic` and `reply_to`. Every send tool takes `silent` and `pin` as above. The body of the envelope is always a plain-text fallback, which is what every non-Telegram channel delivers; on a Telegram channel the native form rides `metadata.telegram_send`. Output: `{ "success": true, "message_id": "<uuid>" }`. Use that id with `edit_message` and `pin_message`.

- `send_location { latitude, longitude }`: a map card (static coordinates only, no live location). Latitude -90..90 and longitude -180..180 are checked. Fallback text: `Location: <lat>, <lon>` plus an Apple Maps link.
- `send_venue { latitude, longitude, title, address }`: a tappable venue card. Fallback: title, address and an Apple Maps link.
- `send_contact { phone_number, first_name, last_name?, vcard? }`: a shareable contact card. The phone number is required. Fallback: `Contact: <name>, <number>`.
- `send_document { path, caption?, as? }`: uploads a local file. `as` is `document` (default, 50 MB limit) or `photo` (10 MB). The caption is at most 1024 characters. The path must be absolute and, after symlinks are resolved, inside one of the adapter's `send_paths` (default: each agent's `data/` directory and its scratchpad root, `/tmp/claude-<uid>/<project slug>`); otherwise it is rejected before any upload, both here and again in the adapter. Telegram channels only: any other channel returns an "unsupported" error.
- `ask_input { kind, prompt, placeholder? }`: `kind` is `location`, `contact`, `person` or `text`. In a private chat the first three show a one-time share button (`request_location`, `request_contact`, `request_users`); `text` shows a reply prompt. Telegram only allows the share buttons in private chats, so in a group topic they degrade to a reply prompt and the user shares from the attach menu. The answer is an ordinary inbound message linked by `reply_to` to the prompt: `[location] <lat>, <lon>` with `metadata.location`, `[contact] <name>, <number>` with `metadata.contact`, `[shared person] <name> @user` with `metadata.users_shared`, or the typed text. Each also carries `metadata.input_prompt_id` and `metadata.input_kind`. The keyboard is removed after the answer or at expiry (24 hours, `choice_ttl_hours`). On other channels the prompt is plain text.
- `send_rich { markdown | html, choices? }`: a Telegram rich message (Rich Markdown preferred): headings, real tables, `<details><summary>` collapsible sections, quotes, lists and `<tg-button-row>` button rows. Up to 32768 characters; longer content is split at blank lines outside code fences and `<details>` blocks into parts ending `(part i of n)`, and one block over the limit is truncated with a marker. Off Telegram, and on Telegram if the rich call is rejected, the body is rendered to plain text: tables become `- label: value` lists, collapsible sections become `Summary:` followed by their content, buttons become `- Label: url` lines, and there are never markdown tables.
- `edit_message { message_id, body, choices? }`: edits a text or rich message the bot sent in place (Telegram messages from the last 30 days that went out as a single piece). `choices` replaces the keyboard; omitting it removes the keyboard. Same text is a no-op that returns success. An unknown id, another adapter's message, a multi-part message, a document or location, or text over the limit (4096, or 32768 for rich) returns an error. Ordinary bot messages have no edit time window.
- `pin_message { message_id, silent? }` and `unpin_message { message_id, unpin_all? }`: pin (silent by default) or unpin a message the bot sent. `unpin_all` unpins everything in that message's forum topic, or the whole chat outside a topic. Needs the bot's Pin Messages admin right; without it the error says how to grant it.

### `status`

Input: `{ "text": "Comparing the quotes" }`
Output: `{ "success": true, "status": "Comparing the quotes" }`, or an error when the text is empty after cleaning, longer than 40 characters, or more than 5 words.

Sets the short status line the user sees (Telegram's draft message) while you work. Use plain words about what you are doing; never paths, message text or other content. Letters, digits, spaces and `' , . & / -` survive; everything else (Markdown, control characters) is replaced by a space. The tool only validates: the layer that watches the turn's tool calls (cc-headless's stream parser, or the pool's tool-status hook) posts the text to the turn's chat and then keeps the automatic phrases quiet for the rest of the turn (turn-long, no timer) until your next `status` call. The call itself never shows a line of its own, and nothing is shown once you have delivered your reply, on email, or when `tool_status.mode` is `raw`. Optional: without it the automatic phrases are shown. See [TELEGRAM_ADAPTER.md](TELEGRAM_ADAPTER.md#live-tool-call-status-stream).

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
| `topic` | no | Omitted: `general` for `once`; `sched:<label-slug>` for `cron` — see [SCHEDULING.md](SCHEDULING.md#topic-and-model) |
| `priority`, `label`, `max_fires` | no | |
| `model` | no | Pane model for this job's fires (e.g. `"haiku"`); unset falls back to an override, then the pool's model |
| `stale_after_ms` | no | `once` only. Dead-letter instead of firing if overdue by more than this |

Output: `{ "ok": true, "id", "fire_at", "topic", "label" }`. Schedules created here have `created_by: agent`.

### `list_schedules`

Input: `{ "status"?: "active", "channel"?, "created_by"?, "limit"?: 20 }`. `status` is one of `active`, `paused`, `cancelled`, or `completed`; `limit` max 200.
Output: `{ "schedules": [...], "count": n }`. Each schedule row includes `topic` and `model`.

### `cancel_schedule`

Input: `{ "id": "<uuid>" }`. Output: `{ "ok": true, "id" }`.

### `update_schedule`

Update a schedule's label, topic, model, `max_fires`, or status. Only the fields provided are changed.

Input: `{ "id": "<uuid>", "label"?, "topic"?, "model"?: string | null, "max_fires"?: number | null, "status"?: "active" | "paused" }`. `model: null` clears the job's model.
Output: `{ "ok": true, "schedule": {...} }`.

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

## Knowledge store

Agent-managed structured knowledge (Phase 1: FTS5 keyword search, no embeddings yet). New and always-on. (The legacy `recall_memory` / `log_memory` tools were removed after E66; see [MEMORY.md](MEMORY.md).) See [KNOWLEDGE_STORE.md](KNOWLEDGE_STORE.md).

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

## Advisories

### `advisory_ack`

Acknowledges a bus advisory once the agent has told its owner about it. Advisories arrive in an `<agentbus-system kind="advisories">` block at the start of a turn, each with an `id:` line. See [ADVISORIES.md](ADVISORIES.md).

Input: `{ "id": "<advisory id>" }`. The calling agent's id is sent with it; a pool pane is mapped to its pool, and an agent can only acknowledge its own advisories.
Output: `{ "success": true, "id", "state": "acknowledged", "already_acknowledged": false }`. Acknowledging twice is not an error (`already_acknowledged: true`). An unknown id, another agent's advisory, or a resolved one returns `isError`.

## Journaling

### `journal_complete`

Finishes a System Message journal run (E66). The run arrives in an `<agentbus-system kind="journal" run_id="…">` block at the start of a turn. While it is open, new messages to the agent are held and its outbound sends (`reply`, `send_message`, `send_email`) fail with `journal_run_in_progress`; only this tool and `advisory_ack` work. See [JOURNALING.md](JOURNALING.md#system-message-journaler).

Input: `{ "run_id", "files_changed"?: string[], "notes"?: string, "nothing_new"?: boolean }`. The calling agent's id is sent with it.
Output: `{ "success": true, "run_id" }`. A run that already ended (timed out) or was already completed, an unknown run id, or another agent's run returns `isError`.

## Agent learning

### `propose_change`

Proposes a change to one of the agent's **protected files** (`CLAUDE.md`, its system prompt file, `skills/`, `.claude/`, or what `agents.<id>.protected_paths` lists), which the agent can't edit itself (E68). The bus sends each owner an Approve/Deny request with the rationale, evidence and a compact diff; on approval it writes the file itself, if the file hasn't changed since the proposal. See [AGENT_LEARNING.md](AGENT_LEARNING.md#self-edit-proposals).

Input: `{ "path", "new_content"? | "diff"?, "rationale", "evidence"?: string[], "run_id"? }`. Exactly one of `new_content` (the whole new file) and `diff` (a unified diff against the current file). `path` is relative to the agent's working dir. The calling agent's id is sent with it.
Output: `{ "success": true, "proposal_id", "status": "pending", "notified_owners", "expires_at" }` (plus a `note` for an identical proposal already waiting). `isError` with the reason for a path that isn't protected (memory files: edit them directly), a diff that doesn't apply, no change, more than 3 proposals in 24 h, an agent without owners, or no owner reachable on a channel with interactive approvals (Telegram).

Not available to cc-pool session journal forks (they run with no MCP servers); everywhere else, including cc-headless journaling and consolidation turns, it is.

## Polling adapter only

### `get_adapter_status`

Output: `{ "status": "healthy" | "degraded" | "disconnected", "bus_reachable", "last_poll_at", "consecutive_failures" }`. See [CC_ADAPTER.md](CC_ADAPTER.md).

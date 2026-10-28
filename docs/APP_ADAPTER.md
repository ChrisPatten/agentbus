# App channel adapter and client protocol

The `app` adapter lets a local client talk to AgentBus over the existing HTTP listener. It stores messages and session changes durably, then streams them over WebSocket. The first client is the macOS app; `scripts/app-client.ts` is a small protocol client for manual checks. This is protocol version **1**.

## Configure the bus

```yaml
bus:
  host: 127.0.0.1
  http_port: 3000

adapters:
  app:
    enabled: true
    max_upload_bytes: 26214400
    event_retention_days: 30
    ping_interval_ms: 30000
    main_idle_rotation_ms: 43200000   # E69; 0 disables Main's idle rotation
    pending_context:                  # E69; foreign messages (and E79 shared notes) injected into the next Main turn
      max_items: 10
      max_chars: 4000
  cc-headless:
    agent_id: work
    system_prompt: "You are the work agent."
    max_concurrent_turns: 5
    reserved_system_slots: 1

contacts:
  me:
    id: me
    displayName: Me
    platforms:
      app:
        token: ${APP_TOKEN_ME}

agents:
  agent:work:
    media:
      download_path: /Users/me/.agentbus/work/media
      ttl_seconds: 604800

pipeline:
  routes:
    - match: { channel: app }
      target: { adapterId: cc-headless, recipientId: agent:work }
```

| Key | Default | Purpose |
|---|---|---|
| `enabled` | `true` | Turns the channel on |
| `max_upload_bytes` | `26214400` | Largest upload (`413` above it) |
| `event_retention_days` | `30` | Replay window for durable events |
| `ping_interval_ms` | `30000` | WebSocket ping interval (minimum 1000) |
| `main_idle_rotation_ms` | `43200000` (12 h) | Retire Main's Claude session after this long with no operator message and no send from a Main turn. `0` disables rotation. See [Main](#main-one-continuous-conversation) |
| `pending_context.max_items` | `10` | Most foreign messages injected into one Main turn; older ones are counted as omitted |
| `pending_context.max_chars` | `4000` | Character budget for the injected item lines (the intro line doesn't count). Also the longest note `share_context` accepts |
| `pending_context.context_ttl_ms` | `86400000` (24 h) | E79: a note shared with `share_context` is not injected once it is older than this when the Main turn starts. `0` disables the cutoff. Visible foreign sends are never expired. E80: a listed Telegram DM uses its agent's `agents.<id>.pending_context.context_ttl_ms` when set, and this value otherwise |

When `adapters.app` is absent, code that needs these values uses the schema defaults.

Set `APP_TOKEN_ME` in the bus environment to a unique token of at least 16 characters. Each token identifies exactly one contact. Keep it in the client's Keychain or environment, never in a URL or log. When `bus.auth_token` is configured, clients also send `X-Bus-Token`. Leaving out `adapters.app` disables the channel.

The adapter uses the bus listener and defaults to `127.0.0.1`; it opens no separate port. Uploads require `media` on the routed **agent** under `agents.agent:work`, as shown. A missing media configuration makes upload return `422` with an explanation. Remote exposure is outside the tested MVP; a path-scoped proxy such as `tailscale serve --set-path /api/v1/app` can be configured separately, with both tokens kept private.

## Authentication and HTTP routes

Every `/api/v1/app/*` request and WebSocket upgrade requires `Authorization: Bearer <contact token>`. An unknown or missing token gets HTTP `401` before any message is enqueued. If `bus.auth_token` is set, include `X-Bus-Token: <bus token>` too.

| Route | Result |
|---|---|
| `GET /api/v1/app/health` | Contact, routed agent, bus version, adapter state, concurrency counts, and limits |
| `GET /api/v1/app/commands` | Slash command manifest for composer completion |
| `GET /api/v1/app/sessions?state=active\|earlier\|all&limit=50&before=<session-id>` | Visible sessions, newest first |
| `GET /api/v1/app/sessions/:id/messages?limit=50&before=<cursor>` | History page, oldest first within the returned page |
| `POST /api/v1/app/attachments` | One multipart file; returns `id`, `type`, `mime_type`, `original_filename`, and `size` |
| `GET /api/v1/app/ws` | WebSocket protocol v1 |

Session lists and history are restricted to the authenticated contact and the app route's agent. A hidden or unknown session ID returns `404`. Session entries include `session_id`, `conversation_id`, title, channel, topic, timestamps, unread count, Main/Earlier state, resumability, and activity. Main is `app` topic `general` with the title “Main”, listed once as an aggregate over all its session rows (see [Main](#main-one-continuous-conversation)); app topics have editable titles. A topic created without a title is named from the first 60 characters of its first message, and is “New Conversation” until then. Visible Telegram, email, and Siri sessions for the same agent are mirrored in the list. Scheduler-only sessions stay hidden. Bus-originated turns (a critical advisory's system-only turn, a journal run's instruction) are logged to the transcript as inbound messages from the owner, flagged `system_only`; they never appear in history, replay events, topic titles, or the session list, and stay in the database for debugging. The agent's replies to them are shown.

Each paginated response includes `next_before`. For sessions it is the last returned `session_id`; for history it is the oldest returned message's `cursor` (the transcript row ID). Pass that value as the next request's `before`. These stable cursors avoid skipping rows that share a timestamp. Every message entry carries its `conversation_id`, so a client can map messages from any of Main's rows to the one Main item. A Main history page also carries `boundaries`; other sessions' pages omit the field.

The upload request must use `multipart/form-data` with one file. `max_upload_bytes` defaults to 25 MB; an oversized file gets `413`. Reference the returned UUID in a later `send.attachment_ids`. The bus checks that each ID belongs to this contact and agent and has not expired. The agent receives the normal `[Image: …]` or `[File: … — name]` prompt line. History keeps attachment metadata and marks expired files.

## WebSocket frames

Connect to `ws://127.0.0.1:3000/api/v1/app/ws` with the same headers, then send `hello` first. All frames are JSON with a `type` field. The server sends a WebSocket ping at the configured interval and closes a connection after missed pongs; standard WebSocket clients answer pings automatically.

```json
{"type":"hello","cursor":0}
{"type":"welcome","version":1,"reset":false,"latest_seq":12}
{"type":"event","seq":13,"event":"message","data":{"message_id":"…","session_id":"…","direction":"outbound","arrival_channel":"app","body":"Hello"}}
{"type":"event","seq":14,"event":"session","data":{"session_id":"…","title":"Main","unread_count":1}}
{"type":"event","event":"activity","data":{"conversation_id":"…","session_id":"…","state":"running","turn_class":"user"}}
```

`message` and `session` events are durable and carry an increasing **per-contact** `seq`. Every agent message is followed by a `session` event for its session, so clients receive the new `unread_count` without polling. `activity` is ephemeral; it describes queued, running, typing/tool activity, or idle state and has no durable sequence. A running frame carries the turn's `tool_lines` so far, or `typing: true` when there are none. A turn can deliver several messages. Each delivered message takes the tool lines collected so far, and the next running frame starts a new list. `idle` arrives only when the headless agent finishes the turn; if no headless turn is running, delivering a message ends the activity. Session events carry an `activity` snapshot too, so clients should let later activity frames replace it. Store the highest durable `seq` only after applying its event to the local cache. On reconnect, send that value as `hello.cursor`; the bus replays every later durable event in order and then continues live. Several connections for one contact each receive events.

If `welcome.reset` is `true`, the cursor is outside the retained window. Reload `sessions` and each needed history page, replace the local cache, and resume from `welcome.latest_seq`. The default retention is 30 days. Replay survives a bus restart within that window. App delivery succeeds even when no client is connected; the event remains available for replay.

Send a message with a client-generated UUID. `target` selects Main, a new app topic, or a listed session:

```json
{"type":"send","client_msg_id":"2f93a416-08a2-4df4-a821-48759a4c15a1","target":{"kind":"main"},"body":"Hello","attachment_ids":[]}
{"type":"send","client_msg_id":"2f93a416-08a2-4df4-a821-48759a4c15a2","target":{"kind":"new","title":"Planning"},"body":"Start a plan","attachment_ids":[]}
{"type":"send","client_msg_id":"2f93a416-08a2-4df4-a821-48759a4c15a3","target":{"kind":"session","session_id":"54e6290a-2c91-49f3-92f9-9b43b2527152"},"body":"Continue","attachment_ids":[]}
{"type":"ack","client_msg_id":"2f93a416-08a2-4df4-a821-48759a4c15a1","message_id":"…","session_id":"…","status":"queued"}
```

The body or attachment list must be nonempty. Ack status is `queued`, `command`, or `rejected` (with `reason`). A retry using the same `client_msg_id` returns its original ack and does not enqueue twice, including after a bus restart. Keep the UUID until the ack is stored locally. Bus slash commands such as `/status`, `/clear`, and `/stop` go through the same send frame and return a message event. The pipeline's dedup stage rejects identical text from the same sender in the same channel and topic within `pipeline.dedup_window_ms`, with reason `Aborted at stage "dedup"`. The same text sent to different topics is accepted. A rejection is final for its `client_msg_id`, so a client retrying a rejected send must use a new UUID.

An active Telegram, email, or Siri session listed for this contact and agent can also be a `session` target. The bus keeps its session and agent identity, records the new message with `app` as its arrival channel, and delivers a direct reply to the app in that session. It does not copy the app exchange back to the original channel; that channel's chat may have gaps. `/clear`, `/stop`, and `/cost` act on the selected session. An unknown or hidden session is rejected.

A `session` target naming one of Main's ended rows is a send to Main (topic `general`), never an Earlier fork: Main's rows never appear in Earlier, and the next turn runs in Main's current row.

An Earlier session is read-only unless its Claude transcript is still available to the owning headless agent. Sending to a resumable Earlier session creates a new app topic titled `<original title> (resumed)` and returns the **new** `session_id` in the ack. The original remains in Earlier, and any current active session stays intact. An unavailable transcript returns `status: "rejected", reason: "not_resumable"`. A later Claude resume failure appears as an agent error in the new topic.

The bus durably records a send intent before passing it to the inbound pipeline. It recovers unfinished intents on startup or when the client retries. If the bus crashes after a slash command has a side effect but before its response is correlated, recovery can return `rejected` with an ambiguous-outcome reason. Inspect session history before sending that command again with a new UUID.

### Replying to a message (`reply_to`)

`send` accepts an optional `reply_to`: the `message_id` (UUID) of a transcript message to reply to as a whole. The client never supplies quote text. The bus resolves the id to a visible transcript message for the same contact and agent (any of that contact's visible sessions, including any of Main's rows and the original session of a resumed Earlier copy; it does not have to be in the target session, and a `new` target may carry it too). It then builds `metadata.quoted_message = {message_id, sender_name, text, created_at, source}` on the inbound message, where `sender_name` is `you` for an operator (inbound) message and `agent` for an agent (outbound) message, `text` is the first 200 characters of the body, `created_at` is the target's transcript time, and `source` is the target's `origin.label` when it has one (for example `Ambient scan`), else `you` or `agent`.

```json
{"type":"send","client_msg_id":"2f93a416-08a2-4df4-a821-48759a4c15a4","target":{"kind":"main"},"body":"Can you expand on that?","reply_to":"8c1f0e5e-5a38-4a0f-b3b5-6d1f2a6d8b10"}
```

- An unknown id, a message from another contact or agent, or a system-only message gets `status: "rejected", reason: "reply_target_not_found"`. Like `session_not_found`, no send intent is recorded, so the client may retry with the same `client_msg_id` after dropping `reply_to`. A malformed (non-UUID) `reply_to` is an `invalid_send` error.
- The resolved quote is stored with the send intent, so crash recovery and idempotent retries carry the same quote without re-resolving it.
- The inbound envelope's own `reply_to` stays `null`. On the app channel that field drives outbound reply binding, and a whole-message reference must not change which session the message routes to.
- The agent sees a context line above the message body (`cc-pool` and `cc-headless`). With the target's time and source it reads `[Replying to your message sent 2026-10-05 11:06 EDT: "…"]` (an agent message), `[Replying to the user's own message sent …: "…"]` (an operator message), or `[Replying to a message from Ambient scan sent …: "…"]` (a labelled send). A quote stored before E69, with no time or source, keeps the older `[Replying to you|agent: "…"]` line, which Telegram quote-replies still use. When the target is one of the pending messages injected into a Main turn, that item is also marked in the [pending-context block](CC_HEADLESS_ADAPTER.md#pending-context-main).
- Message events and history entries for a message that carries an app reference include an optional `reply_to` object, `{"message_id":"…","sender_name":"you|agent","text":"…","created_at":"…","source":"…"}` (`created_at` and `source` only when stored). It is omitted otherwise, including for Telegram quote-replies (their quote has `platform_message_id`, not `message_id`).
- **Agent replies can carry a quote too (E69).** When an agent's outbound app message has an envelope `reply_to` that resolves in the same conversation, the adapter stores `metadata.quoted_message` on it, so its events and history carry `reply_to`, unless the reply answers the operator's latest message(s). A `reply_to` naming an agent message, or an operator message the agent has since moved on from (a later visible agent message in the conversation has a different `reply_to`, or none), gets the quote. A reply to the operator's latest message(s) stays unquoted; that covers every fallback reply, a reply to the first message of a batch, and several messages from one turn answering the same thing. Outbound app rows keep their envelope `reply_to` in `metadata.reply_to` for this check. Session binding (`boundAppReply`) still reads the envelope `reply_to` as before.
- Older buses ignore unknown frame keys, so a client that sends `reply_to` to an older bus sends the message without the reference and gets no `reply_to` on events. Clients and bus should be upgraded together.

Other client frames:

```json
{"type":"create_session","request_id":"72ae031e-d507-448f-8415-e42aaf4bd10b","title":"Planning"}
{"type":"ack","status":"created","request_id":"72ae031e-d507-448f-8415-e42aaf4bd10b","session_id":"…"}
{"type":"rename_session","session_id":"…","title":"New title"}
{"type":"mark_read","session_id":"…","seq":14}
{"type":"ping"}
{"type":"pong"}
{"type":"error","code":"invalid_send"}
```

Only app topic sessions can be renamed; Main and foreign sessions cannot. `mark_read` updates the per-contact read marker and sends a `session` event so other open clients update their unread count. For Main, `mark_read` accepts any Main row id and a `seq` of an event on any Main row; the effective marker is the highest one across Main's rows, so rotation never resets it. `ping` is an optional application-level check in addition to WebSocket protocol pings.

## Main: one continuous conversation

Main (E69) behaves like a Telegram DM. The operator sees one conversation with all its scrollback, while the bus manages Claude sessions underneath it. Each Claude session is still its own `sessions` row ("one row = one context window = one `claude_session_id`"); all of Main's rows share the conversation `appConversationId(contact, 'general')` (`mainConversationId` in `src/app/main.ts`). Helpers there: `isMainConversation`, `isMainSession`, `rotateMainSession`, `mainActivityClock`, `rotateIdleMainSessions`.

**In the protocol:**

- `GET /api/v1/app/sessions` lists Main once, under `state=active` and `state=all`, never under `state=earlier`. The item is aggregated over every Main row: `session_id` is the active row, else the newest; `conversation_id`; `ended_at: null`; `is_main: true`; `resumable: true`; `started_at` is the oldest row's; `message_count` and `unread_count` span all rows. `sessionInfo` returns this item for any Main row id.
- History for any Main row id pages across every row of the conversation, in the usual `created_at`, `id` order with the same cursor. The page adds `boundaries: [{ session_id, ended_at, reason }]` for each ended Main row whose `ended_at` falls in the page's time range (from the page's oldest message, open-ended on a short last page, up to the `before` cursor, open-ended on the newest page), so pages tile. `reason` is `idle`, `clear`, or `null` for rows ended before migration 037.
- When Main's active row changes, a `session` event carries the aggregated Main item. The event recorded when a row ends through rotation is flagged by `app_events.rotation = 1` (migration 037), and replay adds `rotated: { previous_session_id, ended_at, reason }` to that event only.

```json
{"type":"event","seq":41,"event":"session","data":{"session_id":"…current Main row…","conversation_id":"…","title":"Main","is_main":true,"ended_at":null,"unread_count":0,"rotated":{"previous_session_id":"…old row…","ended_at":"2026-10-27T08:20:00.000Z","reason":"idle"}}}
```

- Read markers and sends to an ended Main row are covered above. Rows fragmented before E69 (the 30-minute teardown used to end Main rows that had only proactive sends) share the conversation, so they merge into the one Main item automatically.

**Lifecycle.** Main rows are exempt from both 30-minute teardowns: `SessionTracker.closeIdleSessions` and Stage 80's gap rule for rows with no `claude_session_id`. A Main row that has only received proactive sends therefore stays open, and repeated proactive sends land in it. Instead, every `SessionTracker` tick (`memory.summarizer_interval_ms`) calls `rotateIdleMainSessions`. It ends each active Main row that has a `claude_session_id` and whose activity clock is older than `main_idle_rotation_ms`:

- The activity clock is derived from transcripts, with no new column: the later of the newest visible inbound row in the conversation and the newest outbound row stamped `origin.kind = 'turn'` with this `conversation_id`. Proactive sends from elsewhere don't move it. With neither, the row's `started_at` is used.
- A row with no `claude_session_id` never rotates; there is nothing to journal.
- Rotation sets `ended_at` and `end_reason = 'idle'`, then the tracker's mid-flight pass on the same tick marks it closed, reports it to the journaling engine (`close` trigger) and runs `memory.on_session_close` if configured, as for any session ended outside the tracker. The next turn creates a new row and starts a fresh Claude session; the pending-context watermark is per conversation, so unseen foreign messages still carry over.
- `/clear` in Main goes through `rotateMainSession` with `end_reason = 'clear'` and fires the journaling `clear` trigger, as `/clear` does elsewhere. Scrollback is unchanged by either.

Not guarded: a single Main turn that runs longer than the whole rotation period can be rotated mid-turn.

**Pending context.** On each `cc-headless` turn in Main, foreign messages that landed in Main since the agent last saw them are prepended to the prompt as a dated context block. See [CC_HEADLESS_ADAPTER.md → Pending context](CC_HEADLESS_ADAPTER.md#pending-context-main) for the rules and an example, and [MCP_TOOLS.md → Origin metadata](MCP_TOOLS.md#origin-metadata) for how sends are classified.

### Hidden context (`share_context`)

E79. A **context-only** row is an outbound transcript row in Main with `metadata.context_only = true`, written by [`POST /api/v1/context`](HTTP_API.md#post-apiv1context) (the [`share_context` tool](MCP_TOOLS.md#share_context)). It is how an operator's Claude Code session tells Main something without a message: Main reads it as [shared context](CC_HEADLESS_ADAPTER.md#shared-context-share_context), the app never shows it. It is a second hiding flag, separate from `system_only`:

| Reader | `system_only` | `context_only` |
|---|---|---|
| App history, replay events, session-list previews and titles, unread counts, quote resolution (`reply_to`) | hidden | hidden |
| `GET /api/v1/sessions/:id/transcript`, `GET /api/v1/transcripts/search` | hidden | hidden |
| Pending context (`pendingMessages`) | hidden | **included** |
| Journaling window (`loadWindow`) | hidden | **included**, rendered `[Context shared by <label>, not shown to the user] <body>`, not a human message |
| Main's activity clock | not counted | not counted |

The condition lives in `src/app/store.ts`: `VISIBLE_TRANSCRIPT` (every app-facing read) is `NOT_SYSTEM_ONLY AND NOT_CONTEXT_ONLY`, and pending context uses `NOT_SYSTEM_ONLY` alone, so the two can't drift. A future channel that reads rows for the agent but not the user should use the same split.

**What the write does and doesn't do.** One row, no `message_queue` entry, no `DeliveryWorker`, no `AppAdapter.send`. `logOutboundTranscript` is called with `silent: true`, so it records no `session` event. It does not touch `sessions.last_activity` or `message_count`, so there is no `app_session_changed` event, no sidebar re-sort and no effect on Main's idle rotation clock (derived from visible inbound and `turn`-origin outbound rows only). The note joins Main's newest session row, open or ended, and nothing on that row changes: after an idle rotation, when the next turn hasn't started a new row yet, it attaches to the ended one and creates nothing. The one exception is a contact whose Main has never had a session row: `ensureOutboundAppSession` creates one, and its `app_session_created` event makes Main appear in the session list once, as for any first proactive send. Pending context reads every row of the conversation, so a note on an ended row is still injected into the next turn.

**Replay.** The `app_transcript_event` trigger (migration 024) inserts an `app_events` row for every transcript insert, so a hidden row still takes a `seq`. `readEvents` joins each message event to its transcript through `VISIBLE_TRANSCRIPT`, finds nothing and skips it, and the WebSocket drain sets the client's cursor to the high-water `seq` it read, so the cursor advances over the gap. Clients already see `seq` gaps for hidden rows and other agents' sessions, so they must treat `seq` as ordered, not contiguous. `unread_count` in `sessionInfo` joins the same `app_events` rows, so it filters with `VISIBLE_TRANSCRIPT` too (this also stops an outbound `system_only` row counting as unread).

Other readers that treat "the newest outbound row" as agent activity skip context-only rows: the feedback target (`latestAgentMessageId`), the hook-health activity check, the journaling pause clock (`last_outbound` in `JournalEngine.tickTimers`) and the System Message journaler's "has the agent answered" check.

## Agent guidance and proactive delivery

The agent's `system_prompt` can include this channel guidance:

```markdown
### App channel
The app accepts full Markdown without a message length limit. Uploaded attachments arrive as local file paths; read those files before answering questions about them. A message may arrive via app inside a Telegram, email, or Siri session. Use the arrival channel for a direct reply; the session channel describes the existing conversation, not where to send that reply. Explicit `send_message` calls to another channel remain available when the operator asks for them.

For scheduled work, stay in the scheduler session. Send a short update with `send_message(channel: app)` when the operator needs a result. An omitted topic goes to Main. Pass `source` (for example `"Ambient scan"`) so the Main agent sees where the message came from if the operator replies to it. Use `list_sessions` to find the title and `thread:<hash>` topic of a named app session before targeting it. The app can be closed: delivery and replay remain durable.
```

Named app topics must already exist and be active. An unknown topic returns a clear error rather than creating an unintended conversation. [Proactive delivery](APP_PROACTIVE_DELIVERY.md) has Main and named-topic examples; [scheduling](SCHEDULING.md) describes wake behavior.

## Reference client walkthrough

Run these commands against a configured, running bus. `APP_TOKEN` is the contact token; set `BUS_TOKEN` too if bus authentication is enabled. `APP_BASE_URL` defaults to `http://127.0.0.1:3000`. The client stores only its durable cursor in `.app-client-cursor.json`; set `APP_CURSOR_FILE` to use a separate cursor per contact or test.

```bash
export APP_TOKEN="$APP_TOKEN_ME"
npx tsx scripts/app-client.ts bad-token
npx tsx scripts/app-client.ts health
npx tsx scripts/app-client.ts commands
npx tsx scripts/app-client.ts send main "Hello from the scripted client"
npx tsx scripts/app-client.ts send new "Plan a trip" "Travel"
npx tsx scripts/app-client.ts sessions
```

Use a returned `session_id` with `history` or `send session:<uuid>`. To test an attachment, upload a small PDF and copy its returned `id` into `send-file`:

```bash
npx tsx scripts/app-client.ts upload ./sample.pdf
npx tsx scripts/app-client.ts send-file main <attachment-uuid> "Please read this PDF"
```

Run `watch` while sending a Telegram message to the same routed agent. The corresponding transcript should arrive as a `message` event. Press Ctrl-C, send another message, then run `watch` again: it replays events after the saved cursor. Restart the bus and repeat to check restart replay. Use `watch 0` to replay from the start of the retained window. When testing a response that takes longer than 15 seconds, set `APP_WAIT_MS` or use a second terminal running `watch`.

In a local loopback measurement, send acknowledgement was p95 **11.9 ms** over 20 sends, and a synthetic AppAdapter outbound event reached the socket at p95 **111.0 ms** over 10 runs. These figures exclude Claude runtime and tool latency.

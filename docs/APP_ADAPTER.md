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

Session lists and history are restricted to the authenticated contact and the app route's agent. A hidden or unknown session ID returns `404`. Session entries include title, channel, topic, timestamps, unread count, Main/Earlier state, resumability, and activity. Main is `app` topic `general` with the title “Main”; app topics have editable titles. A topic created without a title is named from the first 60 characters of its first message, and is “New Conversation” until then. Visible Telegram, email, and Siri sessions for the same agent are mirrored in the list. Scheduler-only sessions stay hidden. Bus-originated turns (a critical advisory's system-only turn, a journal run's instruction) are logged to the transcript as inbound messages from the owner, flagged `system_only`; they never appear in history, replay events, topic titles, or the session list, and stay in the database for debugging. The agent's replies to them are shown.

Each paginated response includes `next_before`. For sessions it is the last returned `session_id`; for history it is the oldest returned message's `cursor` (the transcript row ID). Pass that value as the next request's `before`. These stable cursors avoid skipping rows that share a timestamp.

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

An Earlier session is read-only unless its Claude transcript is still available to the owning headless agent. Sending to a resumable Earlier session creates a new app topic titled `<original title> (resumed)` and returns the **new** `session_id` in the ack. The original remains in Earlier, and any current active session stays intact. An unavailable transcript returns `status: "rejected", reason: "not_resumable"`. A later Claude resume failure appears as an agent error in the new topic.

The bus durably records a send intent before passing it to the inbound pipeline. It recovers unfinished intents on startup or when the client retries. If the bus crashes after a slash command has a side effect but before its response is correlated, recovery can return `rejected` with an ambiguous-outcome reason. Inspect session history before sending that command again with a new UUID.

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

Only app topic sessions can be renamed; Main and foreign sessions cannot. `mark_read` updates the per-contact read marker and sends a `session` event so other open clients update their unread count. `ping` is an optional application-level check in addition to WebSocket protocol pings.

## Agent guidance and proactive delivery

The agent's `system_prompt` can include this channel guidance:

```markdown
### App channel
The app accepts full Markdown without a message length limit. Uploaded attachments arrive as local file paths; read those files before answering questions about them. A message may arrive via app inside a Telegram, email, or Siri session. Use the arrival channel for a direct reply; the session channel describes the existing conversation, not where to send that reply. Explicit `send_message` calls to another channel remain available when the operator asks for them.

For scheduled work, stay in the scheduler session. Send a short update with `send_message(channel: app)` when the operator needs a result. An omitted topic goes to Main. Use `list_sessions` to find the title and `thread:<hash>` topic of a named app session before targeting it. The app can be closed: delivery and replay remain durable.
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

# AgentBus Mac Client — Product Requirements Document

**Version:** 0.1 · **Status:** Draft · **BMAD Phase:** 2 — Planning · **Parent:** `_bmad-output/planning-artifacts/PRD.md` (AgentBus PRD v1.2) · **Brief:** `product-brief.md` v0.4 · **Date:** 2026-09-29

This PRD adds a generic `app` channel to AgentBus and a native macOS client
for it. Requirement IDs are stable and will be referenced from epics
E58–E62.

---

## 1. Overview

The operator runs AgentBus and a `cc-headless` agent on a laptop. A macOS
app connects to the bus over a local WebSocket. The app's sidebar lists every
user-started session for that agent, on any channel. The operator can:

- chat in a main conversation;
- open topic conversations that run in parallel;
- continue Telegram or email sessions from the Mac;
- attach files.

The agent works in the background through the scheduler and messages the
operator in the app when it has something to say.

### 1.1 Terms

| Term | Meaning |
|---|---|
| **Session** | A row in `sessions`: one context window with the agent, tied to one `conversation_id` and, for `cc-headless`, one `claude_session_id`. One sidebar item |
| **Main** | The `app` channel's `general` topic. The default destination for proactive messages |
| **Topic session** | An `app` session on a `thread:<hash>` topic, created with "New conversation" |
| **Foreign session** | A session that started on another channel (Telegram, email, Siri) |
| **Arrival channel** | The channel a specific message came in on. For a message sent from the app into a foreign session, this is `app`, while the session's channel stays the same |
| **User turn** | A `claude -p` turn triggered by a contact's message on any channel |
| **System turn** | A `claude -p` turn triggered by the bus itself: a scheduled fire, a journaling turn (idle, ceiling, or `/clear`), or a post-restart wake-up |
| **Listed session** | A session the app shows. Rules in FR-17 |

## 2. Primary flows

### F1 — Chat in Main
1. The operator types in Main and presses Return.
2. The app sends a `send` frame over the WebSocket. The bus acknowledges it
   with the message's bus ID.
3. The pipeline routes the message to the `app` agent. `cc-headless` starts
   a user turn in Main's conversation.
4. The app shows typing, then the tool-call trail as it happens.
5. The agent calls `reply`. The reply arrives as a `message` event and
   replaces the trail with the answer.

### F2 — Parallel topic conversations
1. The operator presses ⌘N, enters an optional title, and sends a first
   message.
2. The bus creates an `app` thread topic and a new session.
3. The turn runs at the same time as a turn in Main.
4. When four user turns are already running, a fifth shows **Queued** until
   a slot frees up.

### F3 — Continue a Telegram session from the Mac
1. The operator opens a Telegram session in the sidebar and sends a message.
2. The bus binds the message to that session's conversation and routes it
   to the session's agent. The agent sees that the message arrived via `app`
   in a `telegram:peggy` session.
3. The reply comes back in the app. The Telegram chat doesn't show this
   exchange unless the agent chooses to send there.

### F4 — Background work reaches the operator
1. A cron schedule fires while the operator is away. The system turn runs in
   the reserved slot.
2. The agent calls `send_message` with `channel: app` and no topic.
3. The message lands in Main.
4. If the app is closed, the message is stored. When the app next connects,
   the message is delivered and a notification appears.

### F5 — Laptop sleeps and wakes
1. The WebSocket drops when the laptop sleeps.
2. On wake, the app reconnects and sends its last cursor. The bus replays
   every durable event after that cursor.
3. Overdue schedules fire once each.

### F6 — Clear and resume
1. The operator runs `/clear` in Main. That session moves to **Earlier** and
   a new Main session starts.
2. Later, the operator opens the Earlier session and sends a message.
   - If its `claude` session can still be resumed, the conversation
     continues.
   - If it can't, the composer is disabled and explains why.

---

## 3. Functional requirements

Priority: **M** = must for the MVP, **S** = should (MVP if cheap, otherwise
the first follow-up).

### 3.1 Parallel conversations in `cc-headless` (E58)

**FR-1 Per-conversation serialization (M).**
- `HeadlessInstance` keys its turn queue by `conversation_id`, not
  `contactId`. Today the key is set in `enqueue()` and in the poll loop's
  `bySender` grouping.
- Messages in the same conversation still run in arrival order, one turn at
  a time.
- Turns in different conversations for the same contact can run at the same
  time.
- The existing rule that the queue advances on delivery (E30) is unchanged.

**FR-2 Concurrency limit (M).**
- Each instance enforces `max_concurrent_turns`: configurable, default 5.
- It also enforces `reserved_system_slots`: configurable, default 1, and
  must be less than `max_concurrent_turns`.
- A user turn may start only when both of these hold:
  - total running turns < `max_concurrent_turns`;
  - running user turns < `max_concurrent_turns − reserved_system_slots`.
- A system turn may start whenever total running turns <
  `max_concurrent_turns`, so system turns can also use free user slots.
- A turn that can't start waits.
- When a slot frees up, the oldest waiting turn that's now allowed to start
  goes next.
- A slot is held until the turn has fully settled (process exit), not just
  until delivery. This keeps the limit an honest count of running `claude`
  processes.

**FR-3 Turn classification (M).**
- A turn is a system turn if any of these is true:
  - it's a journaling turn (`runJournalingTurn`, `journalResumeId`);
  - its batch contains a message with `metadata.scheduled: true`;
  - its batch contains a message from a `system:*` sender.
- Every other turn is a user turn.
- A batch that mixes both kinds is a user turn.

**FR-4 Queued state (M).**
- When a turn waits for a slot, the instance reports a `queued` activity
  state for that conversation, using the same bridge that typing and
  tool-call status use (`POST /api/v1/adapters/:id/…`). It reports `running`
  when the turn starts.
- Adapters without the capability ignore these states. Telegram behavior is
  unchanged.

**FR-5 `/stop` per conversation (M).**
- In-flight children are tracked by `conversation_id`.
- `/stop` kills the turn in the conversation the command was sent from. In
  the app, that's the session the operator is viewing (FR-35).
- This changes behavior on other channels: a Telegram `/stop` only stops
  that chat's turn, not every turn for the contact.

**FR-6 Journaling concurrency (M).**
- A journaling turn is serialized with its own conversation's turns.
- No two journaling turns for the same agent run at the same time. This
  gives one journaling lane per agent, which limits concurrent writes to the
  shared memory files (`MEMORY.md` and the daily journal).
- User turns can still write memory files right away under the high-stakes
  exception. That risk is accepted and documented (§8).

**FR-7 Observability (M).**
- `/status` and `GET /api/v1/health` show, for each `cc-headless` instance:
  running user turns, running system turns, waiting turns, and the limit.
- Each turn logs its class, its conversation (first 8 characters), how long
  it waited, and how long it ran.

### 3.2 `app` channel adapter and client API (E59)

**FR-10 Adapter (M).**
- `AppAdapter` is an in-process `AdapterInstance` with id `app` and
  `capabilities.channels: ['app']`.
- It declares `typing`, `toolStatus`, `registerCommands`, and the new
  activity-state capability (FR-4). It has no `maxMessageLength`.
- It's configured under `adapters.app` (§5). Leaving out the block disables
  the channel.

**FR-11 Auth is identity (M).**
- `Authorization: Bearer <token>` resolves to one contact through
  `contacts.<id>.platforms.app.token`, which must be at least 16 characters.
- Config load rejects duplicate tokens.
- A missing or unknown token gets `401`, or a refused WebSocket upgrade. The
  request is neither enqueued nor logged.
- If `bus.auth_token` is set, `X-Bus-Token` is also required.
- The same checks apply to the WebSocket upgrade request and to every
  `/api/v1/app/*` HTTP route.

**FR-12 Local binding (M).**
- The adapter runs on bus-core's existing Fastify server. It doesn't bind a
  port of its own, so it inherits `bus.host`, which defaults to
  `127.0.0.1`.
- Nothing in the MVP requires another host. `docs/APP_ADAPTER.md` documents
  remote exposure (`tailscale serve --set-path /api/v1/app`) but it isn't
  tested.

**FR-13 WebSocket connection (M).**
- The endpoint is `GET /api/v1/app/ws`, upgraded to a WebSocket.
- Frames are JSON, each with a `type` field.
- Client-to-server frame types: `hello`, `send`, `create_session`,
  `rename_session`, `mark_read`, `ping`.
- Server-to-client frame types: `welcome`, `ack`, `event`, `error`, `pong`.
- The server pings every 30 s and closes a connection after 2 missed pongs.
- A contact may have several connections open at once. Every connection gets
  every event.
- The schema is fixed in the architecture document. This PRD fixes the
  semantics in FR-14 through FR-20.

**FR-14 Durable event stream and cursor catch-up (M).**
- Every durable event gets a strictly increasing per-contact sequence number
  `seq`.
- Durable events are: `message` (inbound or outbound) and `session`
  (created, renamed, closed, reopened, or its title or state changed).
- `hello { cursor }` replays every durable event with `seq > cursor`, in
  order, then continues live.
- A cursor older than the retention window (`adapters.app.event_retention_days`,
  default 30) returns `welcome { reset: true }`. The client then reloads its
  session list and history.
- Replay works across a bus restart.
- Ephemeral events aren't stored: `activity` (typing, queued, running,
  tool-call line, idle). On `hello`, the server sends a snapshot of the
  current activity for each session that has a turn in progress.

**FR-15 Send (M).**
- A `send` frame contains:
  - `client_msg_id`, a UUID generated by the client;
  - a `target` (FR-16);
  - a `body` and optional `attachment_ids`. At least one of the two is
    required.
- The server replies with `ack { client_msg_id, message_id, session_id,
  status }`. `status` is `queued`, `duplicate`, `command`, or `rejected`,
  and `rejected` comes with a `reason`.
- Resending the same `client_msg_id` returns the original `ack` and doesn't
  enqueue anything, so the app can retry safely after a reconnect.
- A bus-scope slash command (`/clear`, `/stop`, `/status`, …) is handled
  inline, the same as on Siri. The command's reply is delivered as a
  `message` event in the target session.

**FR-16 Send targets (M).** `target` is one of:
- `{ kind: "main" }`, which resolves to the `app` + `general` conversation;
- `{ kind: "new", title? }`, which creates an `app` thread topic (FR-23) and
  sends the first message into it in one step;
- `{ kind: "session", session_id }`, which targets an existing listed
  session. An app session sends on its own channel and topic. A foreign or
  Earlier session goes through FR-30 or FR-34.

**FR-17 Session listing (M).**
- `GET /api/v1/app/sessions?state=active|earlier|all&limit&before` lists the
  contact's sessions.
- A session is listed when all of the following hold:
  - its `agent_id` is the `app` channel's routed agent;
  - its topic doesn't start with `sched:`;
  - it's either an `app` session (including one the agent opened
    proactively) or has at least one inbound message that isn't scheduled
    and isn't from a `system:*` sender.
- Each item includes:
  - `session_id`, `channel`, `topic`, `title` (FR-23);
  - `started_at`, `last_activity`, `ended_at`, `message_count`;
  - `unread_count`, based on the contact's read marker (FR-21);
  - `resumable` (FR-34), `is_main`, and the current activity state.
- Any change to a listed session also sends a `session` event.

**FR-18 History (M).**
- `GET /api/v1/app/sessions/:id/messages?before&limit` returns transcript
  rows oldest first, paginated backward.
- Each message includes:
  - `message_id`, `seq`, `direction`, `arrival_channel`, `body`,
    `created_at`;
  - attachment metadata (`id`, `type`, `original_filename`, `mime_type`,
    `expired`);
  - `scheduled: true` for scheduled prompts.
- Only listed sessions are readable. Any other `id` returns `404`.

**FR-19 Superset mirror (M).**
- Every transcript row written to a listed session becomes a `message`
  event, inbound or outbound, on any channel.
- This includes the agent's replies and `send_message` calls on Telegram,
  email, or Siri, and the operator's own Telegram messages.
- The events come from the transcript-log paths, the pipeline's Stage 80 and
  `DeliveryWorker`'s outbound logging. Other adapters' `send()` methods are
  not involved. As a result, the app shows a superset of what the agent
  sends to the operator.

**FR-20 Offline delivery (M).**
- `AppAdapter.send()` writes the durable event and pushes it to any open
  connections.
- It returns success whether or not a client is connected, so
  `DeliveryWorker` acks and never dead-letters an `app` message because the
  app is closed.

**FR-21 Read state (M).**
- A `mark_read { session_id, seq }` frame stores a per-contact,
  per-session read marker.
- Unread counts come from that marker.
- Marking a session read on one connection updates the others through a
  `session` event.

**FR-22 Attachments upload (M).**
- `POST /api/v1/app/attachments` takes a multipart upload (the existing
  `@fastify/multipart` plugin).
- The bytes are stored with `persistAttachmentBuffer` under the routed
  agent's `media` config, and the endpoint returns `{ id, type, mime_type,
  original_filename, size }`.
- Attachment IDs are then referenced in `send` frames. The agent sees the
  usual `[Image: …]` or `[File: … — name]` lines.
- A file larger than `adapters.app.max_upload_bytes` (default 25 MB) gets
  `413`.
- If the routed agent has no `media` config, the upload gets `422` with an
  actionable message. It is never dropped silently, unlike Telegram today.
- The usual TTL sweep applies. After the sweep, history reports the
  attachment as `expired: true`.

**FR-23 Session titles (M).**
- App topic sessions store a `title` in their thread-store metadata, set by
  `new` or `create_session` and changed by `rename_session`.
- Main's title is always "Main".
- A foreign session's title is, in order:
  1. the thread's stored name, for example a Telegram forum topic created
     with `create_telegram_topic`;
  2. the first 60 characters of its first inbound message;
  3. the channel's name.
- Renaming a foreign session is out of scope.

**FR-24 Health (M).**
- `GET /api/v1/app/health` (with bearer auth) returns: `ok`, `contact`,
  `agent`, `routed`, the adapter state, the bus `version`, the concurrency
  numbers (FR-7), and limits (`max_upload_bytes`, `event_retention_days`).

**FR-25 Command list (M).**
- `AppAdapter.registerCommands` keeps the `CommandRegistry` manifest.
- `GET /api/v1/app/commands` returns it for composer autocomplete.

### 3.3 Cross-channel session continuation (E60)

**FR-30 Session-bound inbound (M).**
- An inbound message can carry a session binding:
  `metadata.bound_session_id`, which only the `app` adapter sets.
- The pipeline then uses that session's `conversation_id`, `topic`, and
  `session_id` instead of deriving them from `(contact, arrival channel,
  topic)`.
- The transcript row records `channel = app`, which is the arrival channel,
  plus the bound session. The foreign session's history therefore shows the
  message in order, marked as sent from the app.

**FR-31 Routing to the owner (M).**
- A bound message is routed to the session's owning agent
  (`sessions.agent_id`), bypassing `pipeline.routes` matching for the `app`
  channel.
- Listing (FR-17) only shows the `app` agent's sessions, so in the MVP this
  is always the same agent. The rule exists so that multi-agent support
  later doesn't need to change it.

**FR-32 Agent-facing context (M).**
- For a bound message, `formatMessagesForSampling` names the arrival channel
  and the session's own channel, for example
  `New message from chris via app (in your telegram:peggy session) …`.
- Unbound messages keep today's header.
- `app` messages get a documented channel-guidance block for the
  `system_prompt`: full Markdown, no length limit, and attachments arrive as
  file paths.

**FR-33 Reply path (M).**
- `reply` to a message that arrived via `app` is delivered on `app`, in the
  bound session. The outbound transcript row goes to that same session.
- `send_message` to any other channel behaves as it does today.
  FR-19 shows it in the app either way.

**FR-34 Resuming Earlier sessions (M).**
- A session is `resumable` when both of these hold:
  - it has a `claude_session_id`;
  - Claude Code still has that session's transcript on disk, checked the way
    `--resume` would find it.
- Sending into a resumable Earlier session continues that `claude` session
  with `--resume`.
- Sending into a session that can't be resumed gets `ack { status:
  "rejected", reason: "not_resumable" }`.
- The mechanics are decided in the architecture document. The requirement is
  that resuming an Earlier session never disturbs the current active session
  on the same conversation (see §9, Q1).

**FR-35 Commands act on the targeted session (M).**
- `/clear` and `/stop` sent from the app act on the target session, whatever
  its channel.
- `/clear` in a foreign session closes that session and journals it, just as
  it would on its own channel.

**FR-36 Channel-keyed lookup audit (M).**
- Every lookup that derives a session or conversation from
  `(contact, channel)` must handle bound messages. This includes:
  - the `reply` routing and stale-reply guards;
  - the typing, tool-status, and activity endpoints;
  - `/clear`, `/stop`, and `/cost`;
  - the journaling dispatcher;
  - `SessionTracker`;
  - context-ledger keys.
- The epic's first story produces the audit list. Each item gets a test.

### 3.4 Proactive delivery (E61)

**FR-40 Default destination (M).**
- `send_message` with `channel: app` and no `topic` goes to Main.
- `send_message` with `channel: app` and a `thread:<hash>` topic for an
  existing app topic session goes to that session.
- An unknown `app` thread topic fails with a clear error. It never falls
  back to Main silently.

**FR-41 Discoverable targets (M).**
- `list_sessions` and `get_session` return `title` for `app` sessions, so
  the agent can find a topic session by name before targeting it.

**FR-42 Hidden scheduler sessions (M).**
- A scheduled turn runs in its own session (a `sched:` topic, or whatever
  topic the schedule names). When that turn sends to `app`, the message
  appears in the target listed session. The `sched:` session itself stays
  hidden (FR-17).

**FR-43 Missed schedules (M).**
- Existing behavior is kept and covered by tests. On the first tick after
  wake or restart, an overdue cron schedule fires once and then advances
  `fire_at` from the current time. An overdue one-off schedule fires once
  unless `stale_after_ms` has passed.
- `docs/SCHEDULING.md` describes this sleep and wake behavior explicitly.

**FR-44 Prompt contract (M).**
- `docs/APP_ADAPTER.md` ships the `app` channel-guidance block and the
  background-work pattern: do the work in the scheduled turn, and call
  `send_message` on `app` only when the operator needs to know.
- This is a documentation and config deliverable, not code.

### 3.5 macOS app (E62)

**FR-50 Project (M).**
- The app lives in `apps/macos/<AppName>/`, generated by XcodeGen from
  `project.yml` and built with `xcodebuild`.
- macOS 26.5 is the minimum. It uses Swift 6 strict concurrency and SwiftUI.
- No third-party packages, unless a story says otherwise.
- The project has its own `CLAUDE.md` and `README.md`, and `.gitignore`
  covers generated projects.
- It's self-contained and shares no code with `apps/ios/Peggy`.

**FR-51 Setup (M).**
- The first-run sheet asks for the bus URL (default
  `http://127.0.0.1:3000`), the app token, and an optional bus token.
- Secrets go in Keychain, other settings in `UserDefaults`.
- **Test connection** calls FR-24 and shows the agent, routing status, and
  version, or the error.

**FR-52 Connection (M).**
- The app connects with `URLSessionWebSocketTask`.
- It reconnects with exponential backoff (1 s up to 30 s).
- It reconnects immediately on wake (`NSWorkspace.didWakeNotification`) and
  when the network path changes.
- It sends `hello` with the last stored cursor.
- A toolbar indicator shows the connection state: connected, connecting, or
  offline.
- Pending sends are retried with the same `client_msg_id` (FR-15).

**FR-53 Local cache (M).**
- A SwiftData store holds sessions, messages, the cursor, and read markers.
- The UI renders from the cache and pages older history from FR-18 on
  scroll.
- `welcome { reset: true }` clears the cache and reloads it.

**FR-54 Sidebar (M).**
- The sidebar has three sections:
  - **Main**, pinned;
  - **Conversations**: active app topic sessions and active foreign
    sessions, newest activity first;
  - **Earlier**: ended sessions, collapsed by default.
- Each row shows a channel badge (App, Telegram, Email, Siri), the title,
  last activity, the unread count, and the activity state (working, queued,
  or idle).
- ⌘N opens a new conversation. Renaming works on app topic sessions only.

**FR-55 Transcript (M).**
- Messages render Markdown with code blocks that have a Copy button.
- Each message shows a timestamp. Operator and agent messages look
  different.
- A message that arrived on a channel other than the session's own gets a
  small label, for example "via Telegram" in an app session, or "from Mac"
  in a Telegram session.
- Scheduled prompts are shown as system notes.
- The operator's own messages show their send state: sending, queued,
  failed with a retry option, or command.
- Attachment chips show the file name. A chip for an expired attachment
  shows "expired".

**FR-56 Composer (M).**
- Return sends and Shift-Return adds a new line.
- Typing `/` opens slash-command autocomplete from FR-25.
- Attachments can be added by drag and drop, paste, or ⌘O. Each shows a
  thumbnail or file chip, and oversized files are rejected before upload.
- For a session that can't be resumed, the composer is disabled and shows
  the reason.

**FR-57 Agent activity (M).**
- For each session, the app shows the current state: queued, typing, or the
  running tool-call trail. The trail collapses into a disclosure attached to
  the reply once the reply arrives.
- A **Stop** button sends `/stop` to the session.

**FR-58 Notifications (M).**
- A `UserNotifications` alert is posted for each agent `message` event in a
  session the operator isn't looking at, or whenever the app isn't active.
- Messages replayed after a reconnect are grouped into one alert per
  session.
- Clicking a notification opens that session.
- The Dock badge shows the total unread count.
- A setting hides message previews.

**FR-59 Launch at login (S).**
- An optional **Open at login** toggle uses `SMAppService.mainApp`. It helps
  the app keep up with proactive messages.

---

## 4. Non-functional requirements

| ID | Requirement | Target |
|---|---|---|
| NFR-1 | Bus-added latency: `reply` tool call to the `message` event on the socket (local) | p95 ≤ 250 ms |
| NFR-2 | Send acknowledgement: `send` frame to `ack` (local, no attachments) | p95 ≤ 100 ms |
| NFR-3 | Durability | No `app` message event is lost across app quit, laptop sleep, network drop, or bus restart within the retention window |
| NFR-4 | Parallelism | 4 user turns and 1 system turn run at the same time with no cross-talk. Turns in one conversation never overlap |
| NFR-5 | Security | Bearer token per contact. Bound to `127.0.0.1` by default. Tokens in Keychain on the client. No token in logs |
| NFR-6 | Privacy | Bus logs hold at most a 60-character preview of any message body (existing convention). Notifications can hide previews |
| NFR-7 | Compatibility | macOS 26.5+. Bus on Node 20+ (unchanged). The app works when the bus has no other channels configured |
| NFR-8 | Resource use | With 5 turns running, bus-core's own CPU and memory stay flat; the load comes from `claude` processes. The app stays under 150 MB of memory with 10,000 cached messages |
| NFR-9 | Testability | Bus: vitest for the limiter (FR-2), turn classification (FR-3), per-conversation `/stop` (FR-5), WebSocket auth, replay, idempotent send, offline delivery, binding and routing (FR-30/31), and the audit list (FR-36). App: XCTest for protocol encoding and decoding, reconnect and cursor logic, and cache reset, using a mock socket |
| NFR-10 | Docs | New `docs/APP_ADAPTER.md`. Updates to `HTTP_API.md`, `CC_HEADLESS_ADAPTER.md` (parallelism, limit, `/stop`), `SLASH_COMMANDS.md` (`/stop` scope), `SCHEDULING.md` (sleep and wake), `MCP_TOOLS.md` (`title`), and `THREADING.md` (bound sessions). CHANGELOG under `[Unreleased]` |
| NFR-11 | Principles | No LLM call in bus-core. Routing stays explicit in config. The adapter only translates protocol |

---

## 5. Configuration surface (bus)

```yaml
bus:
  host: 127.0.0.1                 # default; unchanged

adapters:
  app:
    enabled: true
    max_upload_bytes: 26214400    # 25 MB
    event_retention_days: 30      # durable event replay window
    ping_interval_ms: 30000

  cc-headless:
    agent_id: work
    max_concurrent_turns: 5       # new; total claude -p per instance
    reserved_system_slots: 1      # new; must be < max_concurrent_turns
    # …existing keys…

agents:
  agent:work:
    media:                        # required for uploads (FR-22)
      download_path: /Users/me/.agentbus/work/media
      ttl_seconds: 604800

contacts:
  me:
    platforms:
      app:
        token: ${APP_TOKEN_ME}

pipeline:
  routes:
    - match: { channel: app }
      target: { adapterId: cc-headless, recipientId: agent:work }
```

## 6. API surface (bus): summary

The full frame and route contract goes in the architecture document.

| Route | Purpose |
|---|---|
| `GET /api/v1/app/ws` | WebSocket: sends, events, read markers, session create and rename |
| `GET /api/v1/app/sessions` | Listed sessions (FR-17) |
| `GET /api/v1/app/sessions/:id/messages` | Paginated history (FR-18) |
| `POST /api/v1/app/attachments` | Multipart upload (FR-22) |
| `GET /api/v1/app/commands` | Slash-command manifest (FR-25) |
| `GET /api/v1/app/health` | Reachability, routing, and concurrency (FR-24) |

## 7. Epics and acceptance

The epics are in dependency order. E58 and E61's FR-43 can ship on their own
and benefit the existing Telegram deployment. E59 must land before E60 and
E62. E62's UI work can start against a mock socket once the E59 frame schema
is fixed.

| Epic | Scope | Done when |
|---|---|---|
| **E58** Parallel `cc-headless` | FR-1–FR-7 | Four user turns in four conversations for one contact run at once, and a fifth waits. A scheduled fire starts while four user turns run. `/stop` in one Telegram topic leaves another running. Two journaling turns never overlap. Tests and docs are done |
| **E59** `app` adapter and client API | FR-10–FR-25 | A scripted WebSocket client (`scripts/app-client.ts`) can: authenticate; send to Main and to a new topic; receive replies; disconnect and replay from its cursor, including across a bus restart; upload a PDF the agent reads; and get `401` with a bad token. A Telegram reply appears as an event. Tests and docs are done |
| **E60** Cross-channel continuation | FR-30–FR-36 | On the personal bus, a message sent from the script into a Telegram session gets a reply that names the arrival channel, and the reply shows up in the app, not on Telegram. `/clear` and `/stop` from the app act on that session. A resumable Earlier session continues. One that can't be resumed is rejected. Every item on the audit list has a test |
| **E61** Proactive delivery | FR-40–FR-44 | A cron job's `send_message` on `app` lands in Main while no client is connected and replays on connect. A missed cron fires once after a simulated sleep. Docs are done |
| **E62** macOS app | FR-50–FR-59 | On the work laptop, flows F1–F6 work in the app. The app builds from a clean checkout with `xcodegen generate && xcodebuild`. The XCTest suite passes |

**MVP done:**
- E58–E62 are complete and NFR-1 through NFR-11 are met.
- One week of daily use on the work laptop has no lost messages.
- A version bump has been proposed: MINOR, since this adds a channel,
  endpoints, and config keys. The `/stop` scope change is a behavior change
  and is called out in the CHANGELOG.

## 8. Risks

| Risk | Mitigation |
|---|---|
| A user turn's immediate high-stakes memory write races a journaling turn or another user turn | Journaling has one lane per agent (FR-6). High-stakes writes are rare and are appends. Revisit with file locking if a conflict is ever seen |
| Five `claude -p` processes at once on a laptop cost more and can hit API rate limits | The limit is configurable (FR-2), and `turn_costs` already records per-turn cost for `/cost` |
| Bound sessions break assumptions that are keyed by channel | The audit story comes first in E60 (FR-36), and there's a test per item |
| Changing `/stop` scope surprises existing Telegram use | CHANGELOG entry and docs. `/stop` in a DM still stops the DM's turn, which is the common case |
| The event log grows without limit | The retention window (FR-14) and a sweeper on the existing sweeper pattern |
| Detecting whether a session can be resumed depends on Claude Code's on-disk layout | Keep the check in one small function with a test. If the check is wrong, the fallback is a `--resume` failure that's reported to the app, not lost data |

## 9. Open questions for architecture

1. **Earlier-session resume mechanics (FR-34).** `getActiveSession` assumes
   one active session per `conversation_id`. Options:
   - reopen the old session row and move the current one aside;
   - fork the resumed `claude` session into a new app thread topic so it has
     its own conversation;
   - track more than one active session per conversation.

   Recommendation: fork into a new app topic, titled "<original title>
   (resumed)".
2. **Event log storage (FR-14).** A new `app_events` table, or `seq`
   derived from `transcripts.rowid` plus a session-change table?
3. **WebSocket library.** `@fastify/websocket` (the proposal) versus `ws`
   directly.
4. **App name.** A neutral product name for `apps/macos/<AppName>/`, the
   bundle ID, and the notification sender.
5. **Activity bridge.** Extend `POST /api/v1/adapters/:id/tool-status`
   with a `state` field, or add `/activity`?

## 10. Out of scope

- The agent sending files to the operator, on any channel.
- Approve/Deny UI. E51 approvals only resolve for `cc-pool` backends, and
  `cc-headless` runs with `--allowedTools all`, so it never asks. This comes
  back when a headless approval backend exists.
- Remote access. It's documented only.
- An iOS target, and switching between agents.
- Multiple users.
- Showing scheduler or journaling sessions.
- Renaming foreign sessions.
- Menu-bar quick ask.
- Token-level streaming.
- App Store distribution and notarization.
- Running while the laptop sleeps.

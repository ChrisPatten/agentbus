# Proactive delivery to the app

An agent can notify a contact through the `app` channel even when no app client
is connected. The bus persists the outbound message and its replay event before
acknowledging delivery. A reconnecting client uses its last durable cursor to
receive the message. Socket presence does not affect delivery.

## Choose a destination

`send_message` with `channel: "app"` and no `topic` targets **Main** (`general`).
To send to a named app topic, use `list_sessions` with `channel: "app"` and
the contact filter. It returns each session's `title` and `topic`. Pass the
chosen active session's `thread:<hash>` topic to `send_message`. An unknown,
ended, or deleted app topic is rejected with an error; it does not create a
replacement session or silently route to Main.

```json
{"to":"contact:chris","channel":"app","body":"Your report is ready."}
```

```json
{"to":"contact:chris","channel":"app","topic":"thread:0123456789abcdef","body":"The travel plan is ready."}
```

## Main stays one conversation (E69)

Repeated proactive sends to Main land in the same Main conversation, in
order, with no new Earlier entries. A Main row that has only received
proactive sends is never closed by the 30-minute teardown; Main rotates its
Claude session only after `adapters.app.main_idle_rotation_ms` (12 h by
default) without operator messages or sends from a Main turn, or on `/clear`.
See [APP_ADAPTER.md → Main](APP_ADAPTER.md#main-one-continuous-conversation).

Every send is stamped with `metadata.origin`. A send from anywhere other than
a turn running in Main (a scheduled routine, another agent session) is
foreign to Main. On the next turn in Main, the agent gets every foreign
message it hasn't seen as a dated context block ahead of the operator's
message, so it can answer a reply to one of them. Pass `source` to label
the sender:

```json
{"to":"contact:chris","channel":"app","body":"Two calendar items need you today.","source":"Ambient scan"}
```

See [MCP_TOOLS.md → Origin metadata](MCP_TOOLS.md#origin-metadata) and
[CC_HEADLESS_ADAPTER.md → Pending context](CC_HEADLESS_ADAPTER.md#pending-context-main).

## Background work

Run scheduled work in its own `sched:` topic. Its prompt and transcript stay in
that scheduler session, which is hidden from the app sidebar. When the work
produces something the operator needs to know, call `send_message` on `app` to
deliver a concise update to Main or an existing named topic. The app receives
only the outbound notification in that destination session. Other background
work can remain in the scheduler session without generating an app alert.

For an app contact token, agent route, and the WebSocket replay protocol, see
[APP_ADAPTER.md](APP_ADAPTER.md). For cron and missed-fire behavior, see
[SCHEDULING.md](SCHEDULING.md).

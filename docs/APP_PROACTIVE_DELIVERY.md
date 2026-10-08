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

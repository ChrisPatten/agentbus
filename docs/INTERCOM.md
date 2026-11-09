# Intercom (E90, E91)

Intercom is a glanceable surface for a conversation that already exists. The first surface is an iPhone web app reached over Tailscale (the "iPhone prototype"); the second will be the Compact, a round 466x466 AMOLED device. Both speak the protocol below.

A surface **follows** one conversation, normally Chris's Telegram DM with Peggy (`telegram:peggy`, contact `chris`). It always shows what the agent is doing (the E79 status line). It shows replies only for interactions that began on the surface. Everything still appears in Telegram as usual: Intercom adds a view and diverts nothing.

Source: `src/intercom/` (service, store, calendar, glance), `src/http/intercom-routes.ts`, `scripts/intercom-pair.ts`. Epics: `_bmad-output/epics/E90-intercom-channel-follow.md`, `E91-intercom-surface.md`. This document describes protocol version **1**, which still works unchanged.

**E96 (Surface API v2).** Surfaces now have **devices**: each paired device gets its own credential, can be listed and revoked, and can speak protocol **2** (revisioned resources with delta push, actions, a Conversation view) on `/api/v1/surface/*`, optionally over a separate TLS listener on the LAN. The contract is [SURFACE_API.md](SURFACE_API.md). What changed for v1 clients is summarised in [Surface API v2 and devices](#surface-api-v2-and-devices-e96) below.

## Configure the bus

```yaml
adapters:
  intercom:
    enabled: true
    interaction_grace_s: 120      # window stays open this long after the agent's turn ends
    echo_to_followed: true        # silent "⌨️ text" echo into the followed Telegram chat
    calendar:
      calendars: ["Birthdays", "Boston Celtics 2026-27 Full-Season Schedule", "Formula 1", "Patriots 🏈", "Events Calendar 🎪", "Home", "Family", "Kids", "Work", "Chris Patten", "BCG"]
      cache_s: 300
    surfaces:
      - id: iphone-proto
        token_env: INTERCOM_IPHONE_TOKEN     # optional since E96: a pre-E96 shared token, kept as a legacy device
        profile: round466
        follow: { contact: chris, channel: telegram:peggy }   # add topic: thread:... for a forum topic
        publishers: [peggy]                  # E96: agents that may publish Events, slots and widgets
        max_devices: 10                      # E96: paired devices allowed at once
```

| Key | Default | Purpose |
|---|---|---|
| `enabled` | `true` | Turns the adapter on. Omitting `adapters.intercom` disables it |
| `interaction_grace_s` | `120` | Seconds the interaction window stays open after the agent's turn ends |
| `echo_to_followed` | `true` | Post a silent echo of each surface message into the followed chat |
| `event_retention_days` | `7` | Replay window for durable events |
| `ping_interval_ms` | `30000` | WebSocket ping interval |
| `hello_timeout_ms` | `5000` | A socket with no valid `hello` by then is closed with 4401 |
| `activity_stale_s` | `900` | A turn with no activity signal for this long is shown as idle and its window starts closing (guards against a missing Stop hook) |
| `pair_ttl_hours` | `12` | Default pairing-code lifetime for the CLI |
| `pair_rate_limit_per_min` | `10` | `POST /pair` attempts per remote address per minute |
| `calendar.calendars` | all | Calendar names as `calctl calendars` reports them. Matching ignores case, emoji and punctuation, so `Patriots 🏈` matches `Patriots`. Empty means every calendar |
| `calendar.cache_s` | `300` | Seconds a `calctl` result is reused |
| `calendar.calctl_path` | `calctl` | Binary to run |
| `calendar.timezone` | `America/New_York` | Zone for "today" and the event offsets |
| `desk.commute_file` | `integrations/intercom/commute.json` | Desk-mode timetable (E94): MBTA trains and holidays. See Desk mode below |
| `desk.plan_file` | `/Users/chrispatten/workspace/peggy-claude-code/memory/project_commute_plan.md` | Office-day plan: a Markdown file with a fenced `commute-plan` block (office days, AM/PM train, lead time, per-date overrides). Re-read when its modification time changes |
| `desk.event_travel_min` | `20` | **Deprecated, ignored.** Calendar events no longer produce a leave-by; kept only so existing configs still load |
| `surfaces[].id` | | Lowercase letters, digits, `-`, `_` |
| `surfaces[].token_env` | none | Optional (E96). Name of the env var holding a pre-E96 shared surface token (at least 32 characters). When set and usable, bus-core installs it at startup as the surface's legacy device `<id>-legacy`, so a phone paired before E96 keeps working. Unset or too short: a warning, no legacy device, and the surface still works through paired devices |
| `surfaces[].publishers` | `[]` | E96. Bare agent ids allowed to publish Events, slots and widgets to the surface; `*` for any agent. See [SURFACE_API.md](SURFACE_API.md#configuration) |
| `surfaces[].max_devices` | `10` | E96. Non-revoked devices allowed at once (1-50); the legacy device counts |
| `surfaces[].profile` | `round466` | Display profile hint for the client |
| `surfaces[].follow` | | `contact`, `channel`, optional `topic` |

New surfaces need no token: pair devices instead. If you keep a legacy token, mint it with `openssl rand -hex 24` (48 characters). Tokens and credentials are never put in a URL or the YAML.

`bus.auth_token` does not apply to `/intercom`, `/api/v1/intercom/*` and `/api/v1/surface/*`: a browser cannot send `X-Bus-Token`, and these routes carry their own auth. Tailscale serve should expose only those path prefixes. For devices on the LAN, use the separate TLS listener instead ([SURFACE_API.md](SURFACE_API.md#the-surface-listener)): it serves only these prefixes.

## Pairing

A browser gets its credential through a one-time code, so the credential is never typed or placed in a URL. Since E96 every redeemed code creates a **device** with its own credential; `scripts/surface-pair.ts` is the successor CLI (it also sets the device's name, profile and scope) and `scripts/intercom-pair.ts` keeps working. See [SURFACE_API.md](SURFACE_API.md#pairing).

```sh
AGENTBUS_CONFIG=~/workspace/peggy-claude-code/agentbus-config.yaml \
  npx tsx scripts/intercom-pair.ts iphone-proto --ttl 12h --base https://bobafett.tail64ec4d.ts.net
```

It prints the code and the URL `https://…/intercom/#pair=CODE`. The CLI writes a sha256 hash of the code into the bus database (SQLite WAL, so bus-core can keep running) and needs no bus restart. Open the URL on the device; the code travels in the fragment, which is never sent to a server. The page exchanges it:

`POST /api/v1/intercom/pair` with `{"code":"…"}` returns `200 {"surface_id":"…","token":"…", …}`: `token` is the new device's credential (also returned as `credential`, with `device_id`, `scope`, `profile` and `cert_fingerprint`; v1 clients ignore the extra fields). `400` bad body, `404` unknown code, `409` `device_limit` (the surface already has `max_devices` devices; the code is not spent), `410` expired or already used, `429` too many attempts (10 per minute per address), `503` the surface is no longer configured. A code works once. `POST /api/v1/surface/pair` is the same handler.

The CLI reads the config the way bus-core does, so the environment variables the config references (and the `.env` beside it) must be available. The surface's own token variable need not be set for the CLI. Options: `--ttl` (`90m`, `12h`, `2d`), `--base`, `--config`, `--db`.

## HTTP routes

| Route | Auth | Result |
|---|---|---|
| `GET /intercom`, `/intercom/*` | none | Static files from `apps/intercom-web/` (relative to the repo root). `/intercom` redirects to `/intercom/`. MIME types set, `Cache-Control: no-cache`, no directory traversal (encoded `..`, backslashes, NUL bytes and symlinks leaving the root are refused). A missing directory gives 404, never 500 |
| `POST /api/v1/intercom/pair` | none | See above |
| `GET /api/v1/intercom/health` | Bearer device credential (a legacy token through its legacy device) | `{surface_id, follow, version, connected_clients}` |
| `GET /api/v1/intercom/today` | Bearer | Calendar payload below; `503` if `calctl` fails and nothing is cached |
| `GET /api/v1/intercom/desk` | Bearer | Desk-mode summary (E94), below |

Calendar payload (from `calctl show date:YYYY-MM-DD --output json`, filtered to the configured calendars, titles untouched, all-day events first, then by start). `calctl` reports no colours, so each calendar gets a stable colour from a fixed palette.

```json
{"date":"2026-11-01","tz":"America/New_York","generated_at":"…",
 "events":[{"id":"…","title":"Busy","start":"2026-11-01T09:00:00-05:00","end":"…","all_day":false,"calendar":"Work","color":"#8e8e93"}]}
```

Events from `calctl` that have a location carry it as an optional `location` string (used for the leave-by estimate).

## Desk mode (E94)

`GET /api/v1/intercom/desk` (same surface token as `/today`, no new public route) is the read-only summary behind the agent-status ring and the leave-by line. It is transport-neutral so the Compact reuses it.

```json
{"generated_at":"…",
 "sessions":[{"id":"agent:peggy-pool-2","title":"Intercom Build","state":"waiting","channel":"telegram:peggy","since":"2026-11-02T15:40:00.000Z"}],
 "counts":{"working":3,"needs_you":1},
 "departure":{"label":"5:37 train","leave_at":"2026-11-02T17:07:00-05:00","kind":"train","train":{"number":"867","departs":"2026-11-02T17:37:00-05:00"}}}
```

- **Sessions** are the leased cc-pool panes (read through the lease store, approvals, open choice prompts and watchdog incidents, never message text). `state`: `stuck` (dead pane with a conversation, or an open watchdog incident), `waiting` (a pending approval or open choice prompt), `working` (launching, or a delivered message with no turn end yet), `finished` (a turn ended in the last 10 minutes), `idle`. Titles are the app topic title, the stored forum-topic name, or the channel. Sorted stuck, waiting, working, finished, idle; at most 12 (counts cover all). cc-headless instances are not included.
- **`needs_you`** counts waiting plus stuck.
- **`departure`** is null unless there is a train for today. The only candidate is the train line, on an **office day** per the plan file; the earliest leave time that is not more than 10 minutes past wins. Calendar entries never produce a leave-by on their own (the agent curates what reaches the surface): a leave-by for an appointment comes from a surface Event that carries `travel`, drawn client side. `kind` is `train` today; `event` remains in the type for older clients. `leave_at` and `train.departs` are the scheduled times; an optional `delay_min` means clients add it to both. `delay_min` comes from the live MBTA predictions (below); without them (disabled or API down) the bus does not set it; the dev mock does.
- **Live train ETA and "on my way"** (`desk.mbta`, `src/intercom/mbta.ts`, `on-my-way.ts`). The bus reads MBTA V3 `/predictions` (route `CR-Providence`, boarding stop `am_stop`/`pm_stop`, inbound for the morning train, outbound for the evening one, `include=trip,schedule`; train number = trip name). It only asks for trains within 90 minutes before to 30 minutes after their scheduled departure, or flagged on my way; results are cached `cache_s` (30) per stop and direction with in-flight de-duplication, so at most two requests a minute. A failure backs off 60 s, serves the last answer for up to 3 minutes, then reports "unavailable"; with the API unavailable the desk behaves exactly as before (scheduled times, "Late"). The key is read from the env var named by `api_key_env` (`MBTA_API_KEY`, optional: without it the public 20 requests/min limit applies; put it in the bus `.env`). While a train has a live prediction, `delay_min` = predicted minus timetable departure (minutes, never negative) and the leave time and 10-minute grace shift with it.
  - **On my way.** The bus flags the train itself; Peggy needs to do nothing for the flag. Two taps set it, both through `noteOnMyWayTrain` in `service.ts`, which flags the train for today in SQLite (`intercom_on_my_way`, survives restarts) and pushes the desk:
    - **Commute Event (Surface v2, current).** The commute watcher publishes an urgent Event `commute-am-<YYYY-MM-DD>` (morning; button `omw` "On my way") or `commute-pm-<YYYY-MM-DD>-<train>` (evening; buttons `taking` "Taking it" and `later` "Later train"). When the action handler answers `done` (or `already_done` for a `once` button that fired before) it calls `onEventFired`, and `IntercomService.noteEventFired` flags the train if the action id is `omw` or `taking` or the label is "On my way" / "Taking it" (case-insensitive). The morning train is today's office-day AM train from the plan; the evening train is the number in the id. The date in the id must be today in `calendar.timezone`; a tap on another day's Event, on "Later train" or on any other Event does nothing. The Event's own job still injects its `run.body` into the conversation.
    - **Commute notification (E89, legacy).** "On my way" (morning, key `commute-am`) or "Taking it" (evening, key `commute-pm-<train>`), handled in `handleNotificationAction` (source must be `Commute`; other labels such as "Later train" do nothing): after acknowledging, it flags the train and then forwards `[tapped] <label>` to the agent as before.

    For a flagged train the API still shows at the station, `departure` carries `on_my_way: true` and `live: { departs }` (ISO, predicted) in addition to `delay_min`, and the departure stays on the face past its leave time. The flag clears when the API shows the train gone (its prediction passed by more than a minute, or no prediction after the scheduled time), at midnight (date key), or after `on_my_way_timeout_min` (180); then the departure clears as usual.
- **Office-day plan** (`desk.plan_file`, the peggy repo's `memory/project_commute_plan.md`). Its last fenced block, tagged `commute-plan`, is YAML-like: `office_days: [tue, thu]`, `am_train: "6008"`, `pm_train: null`, `am_travel_min: 15`, `pm_travel_min: 30`, `overrides: [{date: "2026-11-05", mode: "wfh"}, {date: "2026-11-06", mode: "office", am_train: "6010", pm_train: "6029"}]`. A date is an office day when its weekday is in `office_days` or an override has `mode: office`; an override with `mode: wfh` cancels it; a holiday in the timetable cancels it regardless. On an office day the AM train line is `am_train` (leave time = departs minus `am_travel_min`) and the PM line is `pm_train` (leave time = departs minus `pm_travel_min`; mornings travel inbound to Boston, afternoons outbound, so the two differ); when `pm_train` is null there is no PM line (nothing is guessed). An override may carry its own `am_train`/`pm_train`; missing keys fall back to the plan's. Legacy keys still work: `am_travel_min` falls back to `leave_before_min` then 15; `pm_travel_min` falls back to `walk_min`, then `leave_before_min` (so an old file with one lead keeps it for both directions), then 30. On non-office days there is no train line at all. The file is stat-ed on each desk tick and re-parsed only when its mtime changes. A missing or malformed file is logged once and means no train line; there is then no desk departure.
- **Timetable** `integrations/intercom/commute.json` (copied from the peggy repo's `data/reference_commute.md`; update when the MBTA schedule changes; trains renumbered the week of Oct 26, 2026, AM 6006 to 6016, PM 6021 to 6033). It lists trains and holidays only; which train shows when comes from the plan. BCG holidays through 2027 are listed in it.
- **Event** `desk`: the same payload, sent after `calendar` on `welcome`, then whenever it changes (checked every 5 seconds, so at most one per 5 s). Ephemeral (no `seq`).
- Face down turning the screen off is a device-only behaviour (the Compact's motion sensor); the web client does not implement it.

## WebSocket protocol v1 (`/api/v1/intercom/ws`)

Every frame is JSON with a `type`. The server pings every 30 s.

**Handshake.** The first frame must be `hello`. Its `token` is the device credential (or a legacy token). Without a valid one within `hello_timeout_ms` (5 s), or with a bad or revoked credential, the server closes with code **4401**. A socket whose device is revoked while connected is closed with **4403** `revoked` within 5 s. `hello.protocol: 2` (with `revs`) opts into protocol v2 on this path too; without it the connection is protocol v1 exactly.

```json
{"type":"hello","token":"…","cursor":0,"client":"intercom-web/0.1"}
{"type":"welcome","version":1,"surface_id":"iphone-proto","follow":{"contact":"chris","channel":"telegram:peggy"},"latest_seq":7,"reset":false,"server_time":"…"}
```

After `welcome` the server replays durable events with `seq > cursor` (oldest first), then sends the current `activity` snapshot, an `interaction` event if a window is open, and a `calendar` event. `reset: true` means the cursor is outside retention (or ahead of the log): drop local state and resume from `latest_seq`; nothing is replayed.

**Server to surface** (`{"type":"event","event":"…","seq":N?,"data":{…}}`; only durable events carry `seq`, a per-surface counter that survives retention sweeps):

| Event | Durable | Data |
|---|---|---|
| `activity` | no | `{state: running\|queued\|idle, status_text, interaction_id}`. Sent on every change for the followed conversation, whoever started the turn. `status_text` is the E79 status line, or null |
| `interaction` | no | `{interaction_id, state: open\|closed}` |
| `reply` | yes | `{message_id, interaction_id, glance, body, has_attachments, more_on_telegram, created_at}`. Only for agent outbound in the followed conversation while a window is open. `body` is plain text (markdown stripped, bullets as `•`), cut to 1,200 characters at a word boundary. `more_on_telegram` is true for attachments, choices, other Telegram-native messages, or a cut body |
| `calendar` | no | The calendar payload. After `welcome`, then every 5 minutes and on date change |
| `desk` | no | The desk-mode summary (E94). After `calendar` on `welcome`, then on change, at most once per 5 s |

**Surface to server**

| Frame | Answer |
|---|---|
| `{"type":"send","client_msg_id":"<uuid>","body":"…"}` (1-4,000 characters) | `{"type":"ack","client_msg_id","status":"queued","message_id","interaction_id"}`, or `status:"rejected"` with `reason` (`invalid_body`, the pipeline's abort reason such as `Aborted at stage "dedup"`, `no_route`, `internal_error`), or `status:"command"` for a slash command the bus handled itself. Idempotent on `client_msg_id`: a retry gets the stored ack and nothing is enqueued twice, including after a restart. A rejected send is final for its id except `internal_error`, which is not stored |
| `{"type":"state","quiet":false,"battery":null}` | none; stored in memory and logged, and (E96) written to the device's item in the `device` resource |
| `{"type":"ping"}` | `{"type":"pong"}` |

Errors: `{"type":"error","code":"invalid_frame"\|"unauthorized"\|"internal_error"\|"notification_not_found"\|"read_only"}`. `read_only` (E96) answers `send` and `notification_action` from a device paired with `read_only` scope.

**Notifications (E89).** When `notifications.enabled`, the server also sends `notification` (durable) and `attention` (ephemeral) events, plus a snapshot of open items after `welcome`, and accepts `notification_ack` and `notification_action` frames. The agent note on each surface message then also carries the notify-versus-message guidance. See [NOTIFICATIONS.md](NOTIFICATIONS.md).

## Follow engine

### What a surface send does

1. The body becomes an inbound message exactly as a Telegram message from the contact in that chat would be: `channel` = the follow channel, `topic` = the follow topic (omitted means the pipeline's `general`), `sender` = `contact:<id>`. It goes through the normal pipeline (contact resolve, dedup, route resolve, pool route resolve, transcript), so it lands in the same conversation, session and cc-pool pane. The agent's ordinary `reply(message_id)` goes back to Telegram.
2. Metadata `origin: "intercom"`, `surface_id`, `interaction_id`, `client_msg_id` ride on the envelope.
3. The agent sees a one-line system block (never stored in the transcript): *Sent from Intercom (iphone-proto), a small round glance display. Reply as usual with reply(); keep it to 1-3 sentences, lead with the answer, and pass glance: a plain line of at most 100 characters.*
4. Then the silent echo: `⌨️ <text>` plus `— via Intercom`, posted straight through the followed channel's adapter (it never enters the message queue or `DeliveryWorker`). On Telegram it is plain text (no markdown parsing), silent, without a link card, and it does not touch the typing indicator or the live status draft. Because it bypasses delivery, the echo is never routed to the agent as inbound, never opens or answers an interaction and never counts as an agent reply (it is also explicitly ignored if it ever does reach the hook).
5. The interaction window opens (or is refreshed and reuses its `interaction_id`).

### Follow target resolution

The target `{contact, channel, topic?}` resolves to a conversation the way the pipeline does: `conversation_id = sha256(sorted([contact, channel, topic or "general"]).join(":"))`.

- **Telegram DM:** `{contact: chris, channel: telegram:peggy}`. The channel is the bot's DM channel and the topic is `general`, so this is the conversation the cc-pool DM pane serves (route `telegram:peggy` to `agent:peggy`).
- **Forum topic:** `{contact: chris, channel: telegram:peggy:group:-1003977797157, topic: "thread:<hash>"}`, the `thread:` id as the Telegram adapter stores it (the `topic` value `create_telegram_topic` returns, or the session's `topic` from `list_sessions`). The echo lands in that topic through the thread store.
- Anything else in the contact's other chats or topics is ignored. Matching is on channel, topic (`""` and `general` are the same) and contact.

### Interaction window

- **Opens** on a surface send. Another send while open refreshes it.
- **While open**, each agent message delivered to the followed conversation (sender `agent:*`; not `system_only`, `context_only`, `bus_notice` or the echo) becomes a durable `reply` event. `DeliveryWorker` calls the service only after the adapter confirmed delivery, so a failed Telegram send never appears on the dial. Outside the window nothing is delivered to the surface.
- **Closes** `interaction_grace_s` after the agent's turn ends (the Stop hook's `turn-ended`, via `POST /api/v1/journal/events` or the pool endpoint). Any new activity signal cancels a pending close. If no turn end ever arrives, `activity_stale_s` forces idle and the close.

### Activity

`activity` is mirrored for the followed conversation at all times from the signals the bus already receives: `POST /api/v1/adapters/:channel/typing` (running), `/tool-status` (running with the E79 text, which is the status line the pane's hook or cc-headless posts; `status` tool text arrives the same way) and the Stop hook (idle). A surface send sets `queued` until the first signal. No new hook is needed.

### Latency marks (I7)

Each interaction logs structured lines, `[intercom] {"evt":"latency","mark":"inbound_accepted"|"first_status"|"first_reply","surface_id","interaction_id","ms"}`, with `ms` since the send was accepted. Cold-pane start-up is not handled specially; the marks exist so it can be measured.

## Glance (I3)

`reply` and `send_message` take an optional `glance`: a plain line of at most 100 characters. A longer one is truncated at a word boundary with `…`, not rejected. It is stored in the outbound message's `metadata.glance`; Telegram and the other adapters ignore it. When it is missing, `POST /api/v1/messages` derives one for every agent-sent text message: the first sentence of the body (skipping abbreviations such as `Mr.`) with markdown stripped, cut to 100 characters on a word boundary with `…`. The surface's `reply.glance` is that stored value, and its `body` is derived from the message text.

## Deviations from the M0 contract

- **Not a registry adapter.** `adapters.intercom` is a config block and the service lives in `src/intercom/`, but it registers no channel with the adapter registry because it owns no delivery channel. The socket is a sibling route, as the contract says; the app socket is untouched. `DeliveryWorker` gained an optional `onDelivered` hook, and the typing, tool-status and turn-ended routes call the service.
- **`calendar.calendars` empty means all calendars** (the contract only showed a list). The names in the contract's example list that `calctl` does not know today (`Red Sox 2026 ⚾`, `J Sports`) simply match nothing. The real calendars include `Chris Patten` and `BCG`, which the contract's list lacks; add them if they should appear.
- **Slash commands.** A body such as `/status` goes through the same pipeline, is handled by the bus and answered on Telegram; the surface gets `status: "command"` and no window stays open.
- **Dedup.** The pipeline's dedup stage still applies to surface sends. Identical text from the contact in the same channel and topic within `pipeline.dedup_window_ms` (30 s) is rejected (`Aborted at stage "dedup"`), whether it came from Telegram or the surface. A retry with the same `client_msg_id` never reaches the pipeline again; it gets the stored ack.
- **Pairing** creates a device (E96); `503 surface_unavailable` now means only that the code's surface was removed from the config.

## Known gaps

- Cold panes are not warmed (Q4); only measured.
- A turn that started on another channel for a different conversation does not affect the surface (by design).
- `state` frames (quiet, battery) are logged and, since E96, shown in the `device` resource; the bus acts on neither.
- Choice taps and voice (E92) are not built. Notifications (E89) are built: see [NOTIFICATIONS.md](NOTIFICATIONS.md).

## Surface API v2 and devices (E96)

The full contract is [SURFACE_API.md](SURFACE_API.md). For v1 operators and clients:

- **Every credential is a device credential.** With `adapters.intercom.enabled`, bus-core keeps a device registry. Each pairing creates a device; a surface's old shared `token_env` token becomes the device `<surface>-legacy` at startup. The v1 routes and the v1 WebSocket accept device credentials exactly as they accepted the surface token, so an existing phone keeps working with its stored token.
- **Several devices per surface** (up to `max_devices`, default 10). List and revoke them with `npx tsx scripts/surface-devices.ts list|revoke`. A revoked device gets `401` and `4401` from then on, and its open sockets close with `4403` within 5 s. Revoking the legacy device lasts until the next start while `token_env` is set.
- **Read-only devices** (`--scope read_only` on `surface-pair.ts`) receive everything but cannot `send`, tap notification actions or fire actions.
- **`/api/v1/intercom/*` is an alias.** The v2 paths are `/api/v1/surface/*`; the v1 paths keep the same handlers, credentials and WebSocket handler (protocol 2 is available on both) until the web prototype migrates in E97.
- **Migration note (AgentBus to Intercom rename).** `/api/v1/surface` is deliberately product-neutral so the planned rename does not move the paths again. New clients should use `/api/v1/surface`; `/api/v1/intercom/*` stays only as the alias for the existing web prototype.
- **LAN listener.** `surface_api.enabled` starts a separate TLS listener (default `0.0.0.0:3443`) that serves only `/api/v1/surface`, `/api/v1/intercom` and `/intercom`. Certificates come from `scripts/surface-cert.ts`; the pairing answer carries the certificate fingerprint for pinning.

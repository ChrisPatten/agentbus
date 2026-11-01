# Intercom (E90, E91)

Intercom is a glanceable surface for a conversation that already exists. The first surface is an iPhone web app reached over Tailscale (the "iPhone prototype"); the second will be the Compact, a round 466x466 AMOLED device. Both speak the protocol below.

A surface **follows** one conversation, normally Chris's Telegram DM with Peggy (`telegram:peggy`, contact `chris`). It always shows what the agent is doing (the E79 status line). It shows replies only for interactions that began on the surface. Everything still appears in Telegram as usual: Intercom adds a view and diverts nothing.

Source: `src/intercom/` (service, store, calendar, glance), `src/http/intercom-routes.ts`, `scripts/intercom-pair.ts`. Epics: `_bmad-output/epics/E90-intercom-channel-follow.md`, `E91-intercom-surface.md`. This is protocol version **1**.

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
        token_env: INTERCOM_IPHONE_TOKEN     # env var holding the token (at least 32 characters)
        profile: round466
        follow: { contact: chris, channel: telegram:peggy }   # add topic: thread:... for a forum topic
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
| `surfaces[].id` | | Lowercase letters, digits, `-`, `_` |
| `surfaces[].token_env` | | Name of the env var holding the surface token. A surface whose variable is unset or shorter than 32 characters is skipped with a warning |
| `surfaces[].profile` | `round466` | Display profile hint for the client |
| `surfaces[].follow` | | `contact`, `channel`, optional `topic` |

Mint a token with `openssl rand -hex 24` (48 characters). Tokens are never put in a URL or the YAML.

`bus.auth_token` does not apply to `/intercom` and `/api/v1/intercom/*`: a browser cannot send `X-Bus-Token`, and these routes carry their own auth. Tailscale serve should expose only those two path prefixes.

## Pairing

A browser gets the token through a one-time code, so the token is never typed or placed in a URL.

```sh
AGENTBUS_CONFIG=~/workspace/peggy-claude-code/agentbus-config.yaml \
  npx tsx scripts/intercom-pair.ts iphone-proto --ttl 12h --base https://bobafett.tail64ec4d.ts.net
```

It prints the code and the URL `https://…/intercom/#pair=CODE`. The CLI writes a sha256 hash of the code into the bus database (SQLite WAL, so bus-core can keep running) and needs no bus restart. Open the URL on the device; the code travels in the fragment, which is never sent to a server. The page exchanges it:

`POST /api/v1/intercom/pair` with `{"code":"…"}` returns `200 {"surface_id":"…","token":"…"}`. `400` bad body, `404` unknown code, `410` expired or already used, `429` too many attempts (10 per minute per address), `503` the surface is not active (its token env var is not set in the bus). A code works once.

The CLI reads the config the way bus-core does, so the environment variables the config references (and the `.env` beside it) must be available. The surface's own token variable need not be set for the CLI. Options: `--ttl` (`90m`, `12h`, `2d`), `--base`, `--config`, `--db`.

## HTTP routes

| Route | Auth | Result |
|---|---|---|
| `GET /intercom`, `/intercom/*` | none | Static files from `apps/intercom-web/` (relative to the repo root). `/intercom` redirects to `/intercom/`. MIME types set, `Cache-Control: no-cache`, no directory traversal (encoded `..`, backslashes, NUL bytes and symlinks leaving the root are refused). A missing directory gives 404, never 500 |
| `POST /api/v1/intercom/pair` | none | See above |
| `GET /api/v1/intercom/health` | Bearer surface token | `{surface_id, follow, version, connected_clients}` |
| `GET /api/v1/intercom/today` | Bearer | Calendar payload below; `503` if `calctl` fails and nothing is cached |

Calendar payload (from `calctl show date:YYYY-MM-DD --output json`, filtered to the configured calendars, titles untouched, all-day events first, then by start). `calctl` reports no colours, so each calendar gets a stable colour from a fixed palette.

```json
{"date":"2026-11-01","tz":"America/New_York","generated_at":"…",
 "events":[{"id":"…","title":"Busy","start":"2026-11-01T09:00:00-05:00","end":"…","all_day":false,"calendar":"Work","color":"#8e8e93"}]}
```

## WebSocket protocol v1 (`/api/v1/intercom/ws`)

Every frame is JSON with a `type`. The server pings every 30 s.

**Handshake.** The first frame must be `hello`. Without a valid one within `hello_timeout_ms` (5 s), or with a bad token, the server closes with code **4401**.

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

**Surface to server**

| Frame | Answer |
|---|---|
| `{"type":"send","client_msg_id":"<uuid>","body":"…"}` (1-4,000 characters) | `{"type":"ack","client_msg_id","status":"queued","message_id","interaction_id"}`, or `status:"rejected"` with `reason` (`invalid_body`, the pipeline's abort reason such as `Aborted at stage "dedup"`, `no_route`, `internal_error`), or `status:"command"` for a slash command the bus handled itself. Idempotent on `client_msg_id`: a retry gets the stored ack and nothing is enqueued twice, including after a restart. A rejected send is final for its id except `internal_error`, which is not stored |
| `{"type":"state","quiet":false,"battery":null}` | none; stored in memory and logged only |
| `{"type":"ping"}` | `{"type":"pong"}` |

Errors: `{"type":"error","code":"invalid_frame"\|"unauthorized"\|"internal_error"\|"notification_not_found"}`.

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
- **Pairing against a surface with no token in the bus environment** returns `503 surface_unavailable` and the code is spent.

## Known gaps

- Cold panes are not warmed (Q4); only measured.
- A turn that started on another channel for a different conversation does not affect the surface (by design).
- `state` frames (quiet, battery) are logged only.
- Choice taps and voice (E92) are not built. Notifications (E89) are built: see [NOTIFICATIONS.md](NOTIFICATIONS.md).

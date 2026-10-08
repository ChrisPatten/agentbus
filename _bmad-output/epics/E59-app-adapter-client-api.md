# E59 — App Channel Adapter and Client API

| Field | Value |
|---|---|
| Epic ID | E59 |
| Status | Implemented; live scripted walkthrough pending |
| Dependencies | E58 activity bridge; E27 thread store; transcript logging (E8/E31); attachments (E17); command registry (E6); Fastify server |
| Story Count | 8 |
| Estimated Complexity | XL |

Source: `planning-artifacts/mac-client/product-brief.md` §5–6 and `planning-artifacts/mac-client/PRD.md` §3.2 (FR-10–FR-25), §4–7. E60 adds foreign-session sends and Earlier-session resume on top of this API.

## Epic Summary

Add a generic, local `app` channel and a durable client protocol for one contact and one routed agent. A scripted client can send in Main or a new app topic, list and page its sessions, see all transcript messages for that agent across channels, upload files, and recover events after disconnection or bus restart. Socket disconnection never makes an agent-to-app delivery fail.

## Entry Criteria

- An architecture pass fixes the JSON frame schema, event-log storage and transactional sequence assignment, WebSocket library, activity bridge, and cursor/reset semantics before client implementation. Resolve PRD §9 Q2, Q3, Q5 here and publish the contract for E62.
- Preserve session ID, arrival channel, and ownership as distinct concepts so E60 can bind a send to a foreign session without changing the protocol.

## Exit Criteria

1. FR-10–FR-13: `AppAdapter` registers only when `adapters.app.enabled`; bearer-token contact identity and optional bus token gate every app HTTP route and socket upgrade. Duplicate or short contact tokens fail config validation. The adapter uses the existing local Fastify listener and declares its capabilities.
2. FR-14: per-contact durable `message` and `session` events have increasing `seq`; `hello` replays `seq > cursor` in order, then live events without a gap or duplicate, across restart. A stale cursor produces `welcome.reset`, and current activity is snapshotted separately.
3. FR-15/16: Main, new-topic, and listed app-session sends acknowledge with message/session IDs and status. Retrying a `client_msg_id` returns the original ack and enqueues nothing twice. Commands are handled inline and their responses appear as message events.
4. FR-17–FR-19/21: listing, titles, pagination, history, read markers, unread counts, and cross-channel transcript mirroring obey agent/contact visibility. Hidden scheduler and journaling sessions never appear. Multiple connections get the same events.
5. FR-20: `send_message(channel: app)` succeeds with no socket client; the event is durable and replayable, and `DeliveryWorker` can ack it.
6. FR-22–FR-25: authenticated multipart upload uses the routed agent's media settings, enforces the default 25 MB cap, returns actionable `413`/`422`, preserves attachment metadata and expiry, and exposes health and command manifests.
7. `scripts/app-client.ts` passes the PRD §7 E59 scripted walkthrough, including a bad-token `401`, a PDF the agent can read, a Telegram transcript event, disconnect/replay, and restart/replay. Bus tests cover auth, replay, idempotency, visibility, uploads, and offline delivery; NFR-1/2 latency targets are measured locally.
8. `docs/APP_ADAPTER.md`, `docs/HTTP_API.md`, config example, and `[Unreleased]` CHANGELOG are updated.

## Stories

### S59.1 — Architecture contract and data migration (FR-13/14)

Publish versioned frame examples for `hello`, `welcome`, `send`, `ack`, `event`, `error`, `pong`, `create_session`, `rename_session`, `mark_read`, and `ping`. Choose a durable per-contact event log and retention/reset rule; define a transaction boundary joining transcript/session changes to event creation so replay cannot miss an event between catch-up and live subscription. Define replay ordering, sequence allocation, and cursor behavior for an empty or stale cache. Add migration and repository tests.

### S59.2 — Adapter registration and authenticated transport (FR-10–FR-13)

Add `adapters.app` config and `AppAdapter` on the existing Fastify server. Resolve a bearer token to exactly one contact, also check `X-Bus-Token` when configured, and apply one guard to every app route and WebSocket upgrade. Keep tokens out of logs. Implement heartbeat/pong timeouts and several sockets per contact. Test disabled config, malformed/duplicate/short tokens, unauthorized upgrade and HTTP, and localhost defaults.

### S59.3 — Durable stream, mirror, and offline send (FR-14, FR-19/20)

Create events from the transcript-write paths for inbound and outbound rows, including Stage 80 and `DeliveryWorker`, rather than sending through other channel adapters. Filter to listed sessions and the authorized contact/agent. Add session lifecycle events, retention sweep, ordered replay and live handoff, activity snapshot, and offline app outbound persistence. Test reconnect and process restart, retention reset, duplicate delivery prevention, and an offline `send_message` acknowledgement.

### S59.4 — Session targets and idempotent sends (FR-15/16, FR-23)

Implement Main (`app`/`general`), atomic new `thread:<hash>` creation plus first send, and existing app-session targeting. Persist `client_msg_id` and its original ack so retry cannot enqueue twice, including after restart. Inline bus slash commands and transcript their response. Store app-topic title in thread metadata, support `create_session`/`rename_session`, and keep Main titled "Main". Reject nonlisted or foreign session sends with a clear status until E60 adds binding.

### S59.5 — Session listing, history, and read state (FR-17/18/21)

Implement filtered list and paginated history with title fallback, arrival channel, scheduled flag, attachment metadata, activity, `resumable`, and unread count. Store a per-contact/session high-water read marker; broadcast changed session state to all sockets. Enforce contact and agent ownership on every query, `mark_read`, and target resolution; return `404` for hidden IDs. E60 supplies the authoritative Earlier `resumable` check.

### S59.6 — Uploads and attachment lifecycle (FR-22)

Accept multipart files through `persistAttachmentBuffer` under the routed agent's media config. Authorize attachment IDs at send time so one contact cannot reference another's upload. Enforce `max_upload_bytes`, reject missing media config with `422`, render standard `[Image: …]` and `[File: …]` agent lines, and report expired history chips after TTL sweep. Cover boundary size, file-only sends, stale IDs, and path/name safety.

### S59.7 — Health, commands, activity, and scripted client (FR-24/25)

Return agent/routing/version/adapter/capacity/limit data from authenticated health and the `CommandRegistry` manifest from commands. Bridge E58 queued/running with typing and tool lines as ephemeral session activity; clear it on completion/failure. Add `scripts/app-client.ts` for manual protocol checks and use it for the scripted exit walkthrough.

### S59.8 — Verification and documentation

Run targeted protocol/security tests, the full bus suite, and type check. Measure local reply-event and send-ack latency against NFR-1/2. Write `docs/APP_ADAPTER.md` (config, token handling, protocol, replay, retention, local deployment and optional remote path), update `HTTP_API.md` and CHANGELOG. Mark the final frame schema as the E62 client contract.

## Out of Scope

- Sending into foreign or closed Earlier sessions (E60).
- macOS UI and local cache (E62).
- Remote access setup, outbound file attachments, approvals, and text-token streaming.

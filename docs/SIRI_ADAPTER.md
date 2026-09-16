# Siri Channel

The `siri` channel lets Siri on an iPhone ask the agent a question and speak
the answer. The Peggy iOS app (`apps/ios/Peggy`) runs an `Ask Peggy` App
Intent that posts the spoken question to `POST /api/v1/siri/ask`. The bus
runs the question through the normal inbound pipeline, holds the HTTP request
open until the agent's `reply` is delivered, and returns the reply body in the
same response for Siri to read aloud.

This document covers the synchronous ask path, the health check, and the
latency probe. Durable request records, late-reply retrieval, dedup join, rate
limiting, and fallback re-delivery are specified in
`_bmad-output/planning-artifacts/siri-bridge/architecture.md` and tracked as
epic E43.

## Architecture

```
iPhone  "Hey Siri, ask Peggy" ─▶ AskPeggyIntent ─▶ HTTPS over Tailscale
  ─▶ POST /api/v1/siri/ask            (src/http/siri-routes.ts)
  ─▶ processInbound() ─▶ pipeline ─▶ message_queue (agent:peggy)
  ─▶ agent calls the `reply` tool ─▶ POST /api/v1/messages ─▶ DeliveryWorker
  ─▶ SiriAdapter.send()               (src/adapters/siri.ts) resolves the open request
  ─▶ 200 { status: "answered", reply: { body } } ─▶ Siri speaks it
```

`SiriAdapter` is a full `AdapterInstance` with `capabilities.channels:
['siri']`, so the existing `DeliveryWorker` hands every outbound `siri`
message to its `send()` without any change to the worker, the `reply` tool, or
the pipeline. The route generates the inbound message id itself and registers
a waiter for it before the pipeline runs; the agent's `reply` sets `reply_to`
to that id, which is how the reply finds the waiting request. A reply with no
`reply_to` falls back to the oldest waiting request for the same recipient.

A reply that arrives after the wait has elapsed matches no waiter. `send()`
still reports it delivered, so `DeliveryWorker` acks it and writes the
outbound transcript row; the text is searchable with `search_transcripts` but
is not retrievable through the Siri API until E43.

## The bearer token is the sender's identity

`POST /api/v1/siri/ask` and `GET /api/v1/siri/health` require
`Authorization: Bearer <token>`. The token is looked up in
`contacts.<id>.platforms.siri.token` and resolves the sender straight to
`contact:<id>`, the same model as the Pebble webhook. A missing or unknown
token is a hard `401` with nothing enqueued and nothing logged to
transcripts. Two contacts cannot share a token; config validation rejects
duplicates at startup.

The token is a send-as-contact credential. Mint it with
`openssl rand -hex 24` (the schema requires at least 16 characters), keep it in
`.env`, and rotate it by editing both `.env` and the app's settings.

If `bus.auth_token` is set, requests must also carry `X-Bus-Token`; the two
checks are layered.

## Configuration

```yaml
adapters:
  siri:
    enabled: true
    reply_timeout_ms: 25000        # server-side cap on how long an ask waits
    max_body_bytes: 8192
    # debug_delay_ms: 0            # device testing only; see below

contacts:
  chris:
    platforms:
      siri:
        token: ${SIRI_TOKEN_CHRIS}

pipeline:
  routes:
    - match: { channel: siri }
      target: { adapterId: claude-code, recipientId: agent:peggy }
```

| Key | Default | Notes |
|---|---|---|
| `enabled` | `true` | Registers the adapter and mounts `/api/v1/siri/*`. Omit the block to disable the channel entirely. |
| `reply_timeout_ms` | `25000` | Upper bound on the server-side wait. A client `wait_ms` above this is clamped. Range 1000–60000. |
| `max_body_bytes` | `8192` | Requests with a larger `Content-Length` get `413` before parsing. |
| `debug_delay_ms` | `0` | Holds every ask response for this long. Used once to find Siri's real wait cutoff on device. The adapter refuses to start when it is set and `NODE_ENV=production`. |
| `late_reply_ttl_ms`, `rate_limit`, `fallback` | see schema | Accepted so the config shape is stable; acted on from E43. |

The route target is whichever adapter answers the agent today. The answering
agent must reply through the `reply` tool for the request to complete.

## HTTP contract

### `POST /api/v1/siri/ask`

| Field | Required | Notes |
|---|---|---|
| `text` | yes | The question, 1–2000 characters |
| `wait_ms` | no | How long to hold the request. Clamped to `reply_timeout_ms`. Default `reply_timeout_ms` |
| `request_id` | no | Client-generated UUID. Echoed back; used as the idempotency key from E43 |
| `client` | no | Free-form object, for example `{ "device": "iphone", "app_version": "0.1.0", "locale": "en_US" }`. Stored in message metadata |

The envelope submitted to the pipeline is `channel: siri`,
`sender: contact:<id>`, a text payload, and
`metadata: { source: "siri", request_id, client, sent_at }`. Transcripts are
logged inbound and outbound like every other channel, in a conversation of
their own (`sha256` of contact, `siri`, topic), so the agent's session
continuity is separate from its Telegram or email sessions.

```bash
curl -s -X POST http://127.0.0.1:3000/api/v1/siri/ask \
  -H "Authorization: Bearer $SIRI_TOKEN_CHRIS" \
  -H "Content-Type: application/json" \
  -d '{"text":"What day is it?","wait_ms":20000}'
```

Answered (`200`):

```json
{
  "ok": true, "request_id": "…", "message_id": "…", "status": "answered",
  "reply": { "message_id": "…", "body": "It's Tuesday the fifteenth.", "received_at": "2026-09-16T01:20:11.402Z" },
  "timing": { "received_at": "…", "queued_at": "…", "answered_at": "…", "queued_ms": 14, "answered_ms": 8931 }
}
```

No reply within the wait (`200`):

```json
{
  "ok": true, "request_id": "…", "message_id": "…", "status": "pending",
  "timing": { "received_at": "…", "queued_at": "…", "queued_ms": 12, "waited_ms": 20000 }
}
```

The question was still queued for the agent; only the wait ended.

A bus-scope slash command in `text` (for example `/status`) is answered
inline: `status: "answered"` with `command_handled: true` and the command's
response as `reply.body`.

| Status | Body | When |
|---|---|---|
| `400` | `{ "ok": false, "error": "text is required (1..2000 chars)" }` | Validation failed |
| `401` | `{ "ok": false, "error": "Unauthorized" }` | Missing or unknown bearer token |
| `409` | `{ "ok": false, "error": "duplicate", "reason": "duplicate" }` | Same text from the same contact within `pipeline.dedup_window_ms` |
| `413` | `{ "ok": false, "error": "Request body too large" }` | `Content-Length` above `max_body_bytes` |
| `503` | `{ "ok": false, "error": "Not queued: …", "reason": "…" }` | The pipeline dropped the message, for example no route with `drop_unrouted: true` |

Log lines: `[siri] ask`, `[siri] queued … queued_ms=`, `[siri] answered …
answered_ms=`, `[siri] timeout … waited_ms=`, and `[siri] unmatched reply` for
a reply that found no waiter. Only a 60-character preview of the question is
logged.

### `GET /api/v1/siri/health`

Bearer-authenticated. Lets the app show "connected" without running a turn.

```json
{
  "ok": true, "routed": true, "agent": "agent:peggy",
  "adapters": { "claude-code": "online" }, "version": "0.11.0",
  "limits": { "reply_timeout_ms": 25000, "max_body_bytes": 8192 }, "pending": 0
}
```

`routed` is whether a `pipeline.routes` rule matches a `siri` message from
this contact; `agent` is that rule's `recipientId`; `adapters` reports the
rule's `adapterId` as `online` (registered in-process), `external` (the
`claude-code` MCP connector, which polls from its own process and never
registers), or `missing` (an in-process adapter id that is not running).

## Prompt contract

The first `reply` is what Siri speaks, so the answering agent needs to know a
`siri` message is a voice question. Add this to the agent's channel guidance.
For a `cc-headless` instance it goes in `system_prompt`; for a persistent
Claude Code session it goes in that project's `CLAUDE.md` (messages arrive as
`New message from <sender> via siri`):

```
- siri*: You were asked BY VOICE through Siri. Call `reply` exactly once, then stop.
  Answer first, in at most 60 words of plain spoken prose: no markdown, no lists,
  no links, no emoji, no code. Do not say "I'll check" and go quiet. If the task
  needs more than a few seconds of tool use, reply now with what you already know
  and say a fuller answer will follow on Telegram, then continue working and send
  the full answer with `send_message` on telegram:peggy.
```

The follow-up channel is the agent's choice through its existing tools; the
bus does not orchestrate it.

## Exposing the endpoint on your tailnet

The phone reaches the bus over Tailscale. Mount only the Siri prefix on the
Mac's tailnet HTTPS listener so the app gets a valid certificate and no other
bus route is reachable from the phone:

```bash
tailscale serve --bg --https=443 --set-path /api/v1/siri http://127.0.0.1:3000/api/v1/siri
tailscale serve status
```

The app's base URL is then `https://<hostname>.<tailnet>.ts.net`. Turn on
Tailscale's **Connect on demand** on the phone so a Siri-triggered ask works
on cellular. `bus.host` does not need to change.

## Latency probe

Two scripts measure whether the agent answers inside Siri's budget (target
p50 ≤ 12 s, p95 ≤ 25 s over 20 mixed asks). Results and gate decisions are
recorded in `_bmad-output/planning-artifacts/siri-bridge/spike-results.md`.

```bash
# Gate 0: historical time-to-first-reply from the transcripts table (read-only backup copy of the DB)
npx tsx scripts/siri-gate0-latency.ts --days 14

# Gate 1: 20 live asks through POST /api/v1/siri/ask against the running bus
npx tsx scripts/siri-probe.ts --n 20 --mix trivial:8,memory:8,tool:4 --wait 25000
```

The probe reads the token from `SIRI_TOKEN_CHRIS` in `.env`, prints one line
per ask and p50/p95/max per class, and writes a CSV to
`~/.agentbus/siri-probe-<timestamp>.csv`. Edit the question banks in the
script so the memory questions match what the agent actually knows.

Latency is dominated by the answering agent. Knobs, in order of leverage: the
answering adapter's `poll_interval_ms`, the agent's cold start (`claude -p`
spawn and context assembly for `cc-headless`), and per-contact serialization,
which queues a Siri ask behind an in-flight turn from the same contact on any
other channel. `DeliveryWorker` adds up to one second (fixed 1 s tick until
E45 makes it configurable).

## Limits of the current implementation

- A reply after the wait is kept only in the outbound transcript; there is no
  late-reply endpoint yet.
- The same question twice within the dedup window returns `409` rather than
  joining the in-flight request.
- No per-token rate limit.
- Waiters live in memory; a bus restart ends every open request with the
  client seeing a transport error.

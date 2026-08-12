# Pebble Webhook Channel

The `pebble` channel (`POST /api/v1/webhooks/pebble` in `src/http/api.ts`) is a
receive-only HTTP ingress for the [Pebble Ring](https://www.pebble.io/) Index
01 — a wearable that transcribes short voice memos and POSTs the result to a
user-configurable webhook. There is no dedicated `PebbleAdapter` class and no
poll loop: the route is registered directly in `createHttpServer`, the same
way `POST /api/v1/inbound` is, because there is nothing to poll or connect to
and no outbound `send()` capability — the ring has no channel back to itself.

---

## Architecture

```
Pebble Ring ──(records + transcribes)──> your proxy ──HTTPS POST──> /api/v1/webhooks/pebble ──processInbound──> pipeline / queue
```

The ring itself sends its webhook payload with user-configurable headers but
no bearer-token support baked into the device UI beyond a fixed header value,
so in practice you stand up a small proxy (any HTTPS endpoint you control)
that receives the ring's POST and forwards it to AgentBus with the
`Authorization: Bearer <token>` header AgentBus expects. The proxy is your
responsibility; AgentBus only implements the receiving side.

---

## The bearer token IS the sender's identity

Unlike `config.bus.auth_token` (a single shared secret protecting the whole
HTTP API), the pebble webhook's bearer token is **per contact** and doubles as
sender resolution — there is no separate login step:

- Each contact who owns a ring/proxy gets their own token under
  `contacts.<id>.platforms.pebble.token`.
- On a request, AgentBus looks the token up directly against this map. A
  match resolves the envelope's `sender` straight to `contact:<id>` — the
  same "already canonical" fast path `contact-resolve.ts` uses for
  `contact:`-prefixed senders.
- A missing, malformed (`Authorization` header not of the form
  `Bearer <token>`), or unrecognized token is **always a hard 401**. There is
  no anonymous fallback identity (unlike an unrecognized Telegram sender,
  which still gets a `platform:telegram:<id>` envelope) — a bearer token that
  doesn't resolve to anyone has no legitimate sender to attribute the memo to.
- Two contacts may not share the same token; config validation rejects it at
  startup.
- One endpoint serves every configured contact — there is no notion of named
  `pebble:<name>` instances (compare Telegram/email's multi-bot/multi-mailbox
  support). Revisit only if per-user rate limiting or distinct webhook paths
  per user becomes a real requirement.

---

## Configuration

```yaml
adapters:
  pebble:
    enabled: true          # default true when this block is present
    max_body_bytes: 65536   # default 64 KiB — voice transcripts are short text

contacts:
  chris:
    id: chris
    displayName: Chris
    platforms:
      pebble:
        token: "s3cr3t-bearer-token-for-chris"   # matches `Authorization: Bearer <token>`

pipeline:
  routes:
    - match: { channel: pebble }
      target: { adapterId: cc-headless, recipientId: agent:peggy }
```

The route above delivers ring memos directly to an agent. To instead forward
the memo into an existing conversation on another channel (e.g. prepend
"Pebble ring voice note:" and land it in a Telegram chat), see
`pipeline.relays` — a separate, general-purpose pipeline capability (tracked
as its own epic) rather than something the pebble channel does itself.

If `adapters.pebble` is omitted, the route is not registered at all — a POST
to `/api/v1/webhooks/pebble` returns Fastify's default 404.

If `config.bus.auth_token` is *also* set, the pebble webhook requires **both**
headers: the shared `X-Bus-Token` (checked by the global `onRequest` hook,
same as every other route) and its own per-contact `Authorization: Bearer`
token. The two are layered, not either/or.

---

## Webhook contract

```
POST /api/v1/webhooks/pebble
Authorization: Bearer <token>
Content-Type: multipart/form-data

  transcription: "<the spoken text>"
  recordedAt:    "<unix epoch seconds>"
  client:        "ring"
```

`curl` example:

```bash
curl -X POST https://your-agentbus-host/api/v1/webhooks/pebble \
  -H "Authorization: Bearer s3cr3t-bearer-token-for-chris" \
  -F "transcription=buy oat milk" \
  -F "recordedAt=1735000000" \
  -F "client=ring"
```

**Response (200) — queued:**
```json
{ "ok": true, "queued": true, "id": "...", "enqueued_count": 1 }
```

**Response (200) — not queued** (e.g. deduped as a retried delivery):
```json
{ "ok": true, "queued": false, "reason": "duplicate" }
```

**Error responses:**

| Status | Cause |
|---|---|
| 401 | Missing/malformed `Authorization` header, or a token that matches no contact |
| 400 | Not `multipart/form-data`; empty/missing `transcription`; missing or non-numeric `recordedAt` |
| 413 | Request body exceeds `adapters.pebble.max_body_bytes`, or a multipart file part is present (the webhook accepts only the three text fields — no attachments) |
| 404 | `adapters.pebble` is not configured |

An unexpected `client` value (anything other than `"ring"`) is logged as a
warning but does not fail the request — future ring firmware may add fields.

**`recordedAt` units:** assumed to be unix epoch **seconds**. This was not
verified against a live captured payload from the device; if your proxy
actually forwards milliseconds, the memo will be timestamped in the year
~57323 in `metadata.recordedAt` and you'll need to adjust the conversion in
`src/http/api.ts` (search for `recordedAtSeconds`).

---

## What gets enqueued

```json
{
  "channel": "pebble",
  "sender": "contact:chris",
  "payload": { "type": "text", "body": "buy oat milk" },
  "metadata": { "recordedAt": 1735000000, "client": "ring", "source": "pebble" }
}
```

**Note on timestamps:** the envelope's `timestamp` field is deliberately left
unset by the pebble route. `MessageQueue`'s `rowToQueuedMessage`
(`src/core/queue.ts`) unconditionally overwrites `timestamp` with the queue
row's own enqueue time on every dequeue, for every channel — so whatever
value the pipeline sets earlier never survives to a delivered message. The
memo's actual recording time is preserved durably instead in
`metadata.recordedAt`, which — unlike `timestamp` — survives enqueue/dequeue
unchanged.

Retried/duplicate webhook deliveries of the same memo (same `transcription` +
`recordedAt` + sender, within `pipeline.dedup_window_ms`) are dropped by
Stage 30 (`dedup`) exactly like any other channel — at most one message is
ever delivered.

---

## Security notes

- The bearer token grants full send-as-contact access — anyone who has it can
  inject messages attributed to that contact. Treat it like a password, not
  like `bus.auth_token`.
- Tokens are stored in plaintext in `config.yaml`, consistent with every
  other adapter secret in this repo (IMAP/SMTP passwords, `bus.auth_token`).
  Rotate a token by changing `contacts.<id>.platforms.pebble.token` in config
  and updating your proxy to match; there is no revocation list — the old
  token simply stops matching any contact.
- There is no rate limiting beyond the dedup window. If your proxy is
  internet-facing, put it behind whatever access control you'd use for any
  other webhook receiver.

---

## Related

- [docs/HTTP_API.md](HTTP_API.md) — full HTTP surface
- [docs/EMAIL_ADAPTER.md](EMAIL_ADAPTER.md) — another channel that resolves
  sender identity via a per-contact allowlist, for comparison
- `_bmad-output/epics/E25-pebble-webhook-channel.md` — epic scoping and design
  rationale

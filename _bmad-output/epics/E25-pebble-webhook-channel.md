# E25 — Pebble Webhook Channel

| Field | Value |
|---|---|
| Epic ID | E25 |
| Dependencies | None required to stand alone. Pairs well with E26 (channel relay) for the "forward to another channel with a wrapper" use case, but E25 is fully usable on its own via a direct `pipeline.routes` entry. |
| Story Count | 5 |
| Estimated Complexity | M |

---

## Epic Summary

The Pebble Ring (Index 01) transcribes short voice memos and POSTs the result
to a user-configurable webhook with user-configurable headers. E25 adds a
**`pebble` channel**: a single HTTP ingress endpoint that accepts the ring's
`multipart/form-data` payload (`transcription`, `recordedAt`, `client`) and
turns it into a normal inbound `MessageEnvelope`, using the bus's existing
pipeline unchanged from that point on.

The key design decision (confirmed with the operator): **the bearer token
supplied in `Authorization: Bearer <token>` is not a shared secret — it *is*
the sender's identity.** Each contact who owns a ring/proxy gets their own
token, configured under `contacts.<id>.platforms.pebble.token`. This means:

1. **One endpoint, many users.** There is no need for named adapter instances
   (`pebble:peggy`, `pebble:someone-else`) — the channel is always just
   `pebble`, and the token disambiguates who sent each memo, exactly the way
   `contact-resolve.ts` already disambiguates Telegram senders by `userId` or
   email senders by address. A token match resolves the envelope's `sender`
   directly to `contact:<id>` before the pipeline even starts.
2. **Auth failure has no soft fallback.** Unlike an unrecognized Telegram
   user (which still gets a `platform:telegram:<id>` envelope), a pebble
   request with a missing/unknown/malformed token is a hard `401` — there is
   no legitimate "anonymous ring" to log, since the token is the only signal
   of who's speaking.
3. **Receive-only.** The ring has no channel back to itself; there is nothing
   to reply to. This is an HTTP-push ingress with no poll loop and no
   outbound send, so it does not need a full `AdapterInstance` in
   `AdapterRegistry` — the route is added directly in `src/http/api.ts`,
   following the same precedent as the existing generic
   `POST /api/v1/inbound` endpoint.
4. **Tokens live in `config.yaml` in plaintext**, consistent with how every
   other adapter secret in this repo is currently stored (e.g.
   `bus.auth_token`, IMAP/SMTP passwords). No env-var indirection layer is in
   scope for this epic.

---

## Entry Criteria

None — `contacts.*`, `processInbound()`, and the pipeline stages this relies
on (`contact-resolve`, `dedup`, `route-resolve`) already exist and require no
changes for this epic (see Notes on why `contact-resolve.ts` itself is
untouched).

---

## Exit Criteria

1. `POST /api/v1/webhooks/pebble` with a valid `Authorization: Bearer
   <token>` matching a configured contact, and valid multipart fields
   (`transcription`, `recordedAt`, `client`), enqueues exactly one
   `MessageEnvelope`: `channel: pebble`, `sender: contact:<id>`,
   `payload.body: <transcription>`, `metadata.recordedAt` +
   `metadata.client` captured — and it flows through the standard pipeline
   (dedup → topic-classify → priority-score → route-resolve →
   transcript-log) exactly like any other channel.
2. Missing, malformed, or unrecognized bearer token → `401`. No envelope is
   constructed; nothing is enqueued or logged.
3. Malformed multipart (missing/empty `transcription`, unparseable
   `recordedAt`, oversized body) → `400`. Nothing enqueued.
4. A retried/duplicate webhook delivery of the same memo (e.g. the operator's
   proxy retries on a transient failure) is deduped by Stage 30 like any
   other channel — no duplicate downstream delivery.
5. `tsc --noEmit` clean; tests cover token resolution, multipart
   parsing/validation, dedup behavior, and all rejection paths.
6. `docs/PEBBLE_ADAPTER.md` documents the webhook contract, the config
   shape, and how to point a proxy at AgentBus; `CHANGELOG.md` updated.

---

## Config Shape

```yaml
adapters:
  pebble:
    enabled: true              # default true when this block is present

contacts:
  chris:
    id: chris
    displayName: Chris
    platforms:
      pebble:
        token: "s3cr3t-bearer-token-for-chris"   # matches `Authorization: Bearer <token>`

pipeline:
  routes:
    # Direct delivery — no wrapper/relay. Sufficient on its own without E26.
    - match: { channel: pebble }
      target: { adapterId: cc-headless, recipientId: agent:peggy }
```

Webhook contract:

```
POST /api/v1/webhooks/pebble
Authorization: Bearer <token>
Content-Type: multipart/form-data

  transcription: "<the spoken text>"
  recordedAt:    "<unix epoch>"     # confirm units (s vs ms) against a real device payload — see S25.2
  client:        "ring"
```

---

## Stories

### S25.1 — Config schema: pebble contact tokens + adapter toggle

**User story:** As an operator, I want to configure which bearer token
identifies which contact so incoming ring memos are attributed to the right
person.

**Acceptance criteria:**
1. `contacts[*].platforms.pebble.token: z.string()` added to
   `ContactPlatformsSchema`.
2. New optional `adapters.pebble: { enabled: boolean (default true) }` block
   in `AppConfigSchema` — a pure toggle, no host/port/instance fields, since
   there's nothing to poll or connect to.
3. Config validation rejects two contacts sharing the same `pebble.token`
   (duplicate-token guard, mirroring existing uniqueness checks elsewhere,
   e.g. schedule IDs).

**Complexity:** S

### S25.2 — Multipart webhook endpoint

**User story:** As the ring's proxy, I want to POST a voice memo as
`multipart/form-data` and get a clear success/failure response.

**Acceptance criteria:**
1. `@fastify/multipart` added as a dependency and registered; new route
   `POST /api/v1/webhooks/pebble` parses `transcription`, `recordedAt`,
   `client` fields from the multipart form.
2. Missing/empty `transcription`, or an unparseable `recordedAt` → `400`
   with a descriptive error body. An unexpected `client` value is logged as
   a warning but does not hard-fail (future firmware may add fields).
3. Confirm against a real captured payload from the device (or the
   operator's proxy spec) whether `recordedAt` is seconds or milliseconds
   since epoch; document the assumption in code and docs.
4. Body-size guard: reject with `413` beyond a configurable max (default
   e.g. 64 KB — voice transcripts are short text).

**Complexity:** M

### S25.3 — Bearer token → contact resolution (auth *is* identity)

**User story:** As the bus, I want the bearer token to both authenticate the
request and tell me who sent it, without a separate login step.

**Acceptance criteria:**
1. At startup, build a token → contact map from
   `config.contacts[*].platforms.pebble.token` (mirrors the
   `byTelegramUserId`/`byEmailAddress` maps already built in
   `contact-resolve.ts`, but scoped to this HTTP route rather than a pipeline
   stage, since auth must happen *before* an envelope is even constructed).
2. Missing `Authorization` header, a non-`Bearer` scheme, or a token with no
   match → `401`, request rejected before any envelope/pipeline work
   happens. No fallback identity — no `platform:pebble:<token>` path (per
   the hard-reject decision above).
3. On a match, the envelope's `sender` is set directly to the canonical
   `contact:<id>` form, so `contact-resolve`'s existing "already canonical"
   branch (`src/pipeline/stages/contact-resolve.ts:51`) handles it with
   **zero changes to that file**.

**Complexity:** M

### S25.4 — Envelope construction & dedup correctness

**User story:** As the bus, I want each ring memo to become a normal inbound
message that behaves like any other channel for dedup/logging/routing.

**Acceptance criteria:**
1. Envelope: `channel: 'pebble'`, `sender: 'contact:<id>'` (from S25.3),
   `payload: { type: 'text', body: transcription }`, `metadata: {
   recordedAt, client, source: 'pebble' }`.
2. `envelope.timestamp` is left unset at construction (verified during
   implementation: `MessageQueue`'s `rowToQueuedMessage` unconditionally
   overwrites `timestamp` with the DB row's enqueue time on every dequeue —
   see `src/core/queue.ts` — so any value set earlier in the pipeline is
   silently discarded before a message is ever delivered, for every channel,
   not just pebble). `recordedAt` (when the memo was actually spoken) is
   preserved durably in `metadata.recordedAt` instead, which survives
   enqueue/dequeue unlike `timestamp`.
3. Uses the existing `processInbound(message, deps)` — no new
   enqueue/pipeline-invocation path.
4. Retried identical webhook POSTs (same `transcription` + `recordedAt` +
   sender) within the dedup window are dropped by Stage 30 exactly like any
   other channel; covered by a test.

**Complexity:** S

### S25.5 — Wiring, docs, tests

**User story:** As a maintainer, I want the new route wired into the HTTP
server with docs and tests.

**Acceptance criteria:**
1. Route registered in `createHttpServer` (`src/http/api.ts`), gated by
   `adapters.pebble.enabled`.
2. `docs/PEBBLE_ADAPTER.md`: webhook contract, config example, a `curl`
   example, how to point the ring's proxy at the endpoint, and a security
   note on token rotation (the bearer token grants full send-as-contact
   access).
3. `CHANGELOG.md` entry under `[Unreleased]`.
4. Tests: valid request → enqueued envelope with correct fields; bad/missing
   token → 401; malformed body → 400; duplicate → deduped.
5. `tsc --noEmit` clean.

**Complexity:** S

---

## Notes

- **No `AdapterInstance` for pebble.** This is HTTP-push ingress only — no
  poll loop, no outbound `send()`. Registering a full adapter in
  `AdapterRegistry` (as Telegram/email/BlueBubbles do) would exist purely for
  interface compliance with no real capability behind it. The route lives
  directly in `src/http/api.ts`, matching the existing
  `POST /api/v1/inbound` precedent. Revisit only if health-dashboard
  visibility or capability-based routing later requires a registry entry.
- **Why no named instances (`pebble:peggy`).** Identity comes from the
  bearer token → contact mapping, not from a named config block, so one
  endpoint already serves multiple rings/users. Revisit only if per-user
  rate limiting or distinct webhook paths per user becomes a real
  requirement.
- **This auth model is intentionally different from `bus.auth_token`.** The
  existing `x-bus-token` on `/api/v1/inbound` authenticates *any* caller as
  *any* sender they claim to be. A pebble token authenticates the caller
  *as a specific, fixed sender* — closer to a per-user API key than a shared
  secret. Treat it with the same care as a password.

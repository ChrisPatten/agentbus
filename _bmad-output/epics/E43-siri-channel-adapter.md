# E43 — `siri` Channel Adapter (production)

| Field | Value |
|---|---|
| Epic ID | E43 |
| Dependencies | E42 (spike code + Gate 1 pass or async-first pivot). Runs in parallel with / before E45. |
| Story Count | 7 |
| Estimated Complexity | L |
| Planning package | `siri-bridge/architecture.md` §3–§6, §9–§11, §14; `PRD.md` FR-1…FR-13, NFR-1…NFR-10 |

---

## Epic Summary

Turn the E42 spike into the production `siri` channel: a durable request/reply
store so a bus restart or a slow Peggy never loses an answer; a long-poll
endpoint for late replies; optional deterministic re-delivery of late replies
on another channel (iMessage/Telegram); dedup **join** instead of a hard 409
when Siri repeats a question; per-token rate limiting; history and health
endpoints for the app; and full docs/tests. The HTTP contract is frozen in
`architecture.md` §4 — the iOS POC (E44) already speaks it.

Nothing here reasons about content. The fallback is a templated copy of
Peggy's own reply enqueued as an outbound envelope (ADR-7), not a relay into an
agent.

---

## Entry Criteria

- E42 merged behind `adapters.siri.enabled`; Gate 1 decision recorded.

## Exit Criteria

1. All routes in `architecture.md` §4 implemented with the documented status codes and JSON shapes; `GET /api/v1/siri/health` reports routing/adapter state.
2. `siri_requests` (migration 013) is the source of truth: a reply arriving after a timeout, or after a bus restart, is stored, retrievable via `GET /replies/:id`, and (if configured) re-delivered on the fallback channel exactly once.
3. Identical asks within the dedup window join the in-flight request; rate limits return 429 with `retry_after_ms`.
4. `docs/SIRI_ADAPTER.md` (contract, config, prompt paragraph, `tailscale serve` setup, security notes), `docs/HTTP_API.md`, `docs/DEPLOYMENT.md`, `docs/CC_HEADLESS_ADAPTER.md`, `CHANGELOG.md` updated; MINOR version bump proposed.
5. Test coverage per architecture §14 (bus list); `tsc` + vitest clean.

---

## Config Shape (full)

See `PRD.md` §5. Fallback example:

```yaml
adapters:
  siri:
    enabled: true
    reply_timeout_ms: 25000
    late_reply_ttl_ms: 86400000
    rate_limit: { per_minute: 20, max_in_flight: 4 }
    fallback:
      channel: bluebubbles
      template: "Re your Siri question \"{{question}}\":\n{{body}}"
```

---

## Stories

### S43.1 — Finalise config schema + startup validation

**User story:** As the operator, I want every Siri setting validated at startup with clear errors.

**Acceptance criteria:**
1. `SiriAdapterSchema` complete per architecture §5 (all keys, defaults, ranges); `fallback.channel` that matches no registered adapter logs a startup **warning** (not fatal — adapters can be paused) and `health` reports `fallback: 'missing'`.
2. `debug_delay_ms > 0` with `NODE_ENV=production` → startup exits non-zero with a message.
3. `getSiriConfig(config)` helper mirrors `getTelegramInstances()` style (normalises defaults; single instance only — documented decision: identity comes from tokens, not instances, as with Pebble).
4. Tests for each validation path.

**Complexity:** S

### S43.2 — Migration 013 + durable request store

**User story:** As the bus, I want every Siri request and reply persisted so nothing depends on process memory.

**Acceptance criteria:**
1. `src/db/migrations/013_siri_requests.sql` exactly as architecture §6; runner picks it up; `runMigrations` idempotent.
2. `SiriRequestStore` (in `src/adapters/siri.ts` or `src/adapters/siri-store.ts`): `create`, `markQueued`, `recordReply(first|extra)`, `markTimedOut`, `markClaimed`, `get`, `listForContact`, `findInFlightByKey(contact,text)`, `findByMessageId`, `sweepExpired(ttl)`.
3. `POST /ask` writes the row **before** `processInbound` (status `pending`), updates `message_id`/`queued_at` after; failures set `failed` with a reason column value in `client` JSON (`{"error":…}`) — no new column.
4. `SiriAdapter.send()` reads the request by `reply_to` from the store (not only memory), so a reply for a pre-restart request still lands. First reply → `answered` (+`reply_body`, `reply_message_id`, `answered_at`); subsequent → appended to `extra_replies`.
5. Unsolicited Peggy messages on `siri` stored as `request_id = 'unsolicited:<message_id>'`, status `answered`.
6. Sweeper: `expired` after `late_reply_ttl_ms`, deleted after 2× TTL, on a 10-minute timer started with the adapter (pattern: `AttachmentSweeper`).
7. Tests: restart simulation (new adapter instance over the same DB resolves a reply); extra replies; unsolicited; sweep.

**Complexity:** M

### S43.3 — Late replies: `GET /api/v1/siri/replies/:request_id` long-poll + claim

**User story:** As the app, after a `pending` answer I want to wait for the reply without polling in a loop.

**Acceptance criteria:**
1. Route per architecture §4: auth → row must belong to the token's contact (else 404) → if `answered`/`claimed` return immediately and set `claimed_at` → else register a waiter for `min(wait_ms, reply_timeout_ms)` → `answered` or `pending` with `waited_ms`.
2. Waiters are keyed by `message_id` and shared with `POST /ask`; multiple concurrent GETs for the same request all resolve.
3. `POST /ask` timeout path sets `timed_out = 1` (used by fallback in S43.5).
4. Tests: immediate return; wait then reply; expired → 404; wrong contact → 404.

**Complexity:** S

### S43.4 — Dedup join + rate limiting + idempotent `request_id`

**User story:** As the operator, I want a repeated "ask Peggy…" to attach to the question already in flight instead of failing, and runaway retries to be throttled.

**Acceptance criteria:**
1. `inFlightByKey` (`contact_id\ntext`) populated on create, cleared on answer/timeout+TTL; `POST /ask` consults it **before** `processInbound`, and again when `processInbound` returns `duplicate`; a join returns the existing `request_id` and waits on the same waiter. No in-flight match → 409 `{reason:'duplicate'}`.
2. `request_id` replay: a second `POST /ask` with an already-known `request_id` returns the current state of that request (never enqueues twice).
3. Token-bucket rate limit per bearer token: `per_minute` and `max_in_flight`; 429 with `retry_after_ms`; limits visible in `health.limits`.
4. Tests for join (before/after `processInbound`), replay, 409, 429 (per-minute and in-flight).

**Complexity:** M

### S43.5 — Fallback re-delivery of late replies

**User story:** As Chris, if Siri gave up waiting, I still want Peggy's answer to reach me on iMessage.

**Acceptance criteria:**
1. When a **first** reply arrives for a request with `timed_out = 1` and `adapters.siri.fallback` is set, `SiriAdapter` enqueues one outbound envelope: `channel: fallback.channel`, `sender: <reply.sender>`, `recipient: <request.contact_id>`, `topic: 'general'`, body = template rendered with `{{body}}` and `{{question}}` via the shared `renderTemplate` from `prompt-renderer.ts`, `metadata: { source: 'siri-fallback', siri_request_id }`.
2. Exactly once per request (idempotent under duplicate `send()`); extra replies are **not** re-delivered (they are in the app history) — documented.
3. Unsolicited `siri` messages are also re-delivered when fallback is configured (Peggy can "message Siri" and it lands on iMessage).
4. Delivery failures on the fallback channel follow the normal `DeliveryWorker` dead-letter path; the request row is unaffected.
5. Tests: fallback enqueued with rendered body; not enqueued when reply was in time; not enqueued twice; no fallback configured → nothing.

**Complexity:** S

### S43.6 — Health, history, single-request endpoints + `/status` line

**User story:** As the app, I want to show "Connected to Peggy" and a history list.

**Acceptance criteria:**
1. `GET /api/v1/siri/health`, `GET /api/v1/siri/requests` (`limit` ≤ 100, `since`), `GET /api/v1/siri/requests/:request_id` per architecture §4; all bearer-scoped to the contact.
2. `health.routed` is computed by evaluating `pipeline.routes` against a synthetic `siri` envelope from that contact (reuse `channelMatches`); `agent` = the matched `recipientId`; `adapters[target adapterId]` = registry presence.
3. `/status` slash command appends `siri: pending N · answered(24h) M · p50 Xs` when the adapter is registered.
4. Tests for each endpoint incl. contact scoping.

**Complexity:** S

### S43.7 — Docs, `tailscale serve` runbook, tests, CHANGELOG, version proposal

**User story:** As a maintainer, I want the channel fully documented and the release prepared.

**Acceptance criteria:**
1. `docs/SIRI_ADAPTER.md`: architecture summary, full HTTP contract with `curl` examples, config reference, the Peggy prompt paragraph, dedup/rate-limit behaviour, fallback semantics, restart guarantees, security notes (token = send-as-contact; rotation), and the `tailscale serve --set-path /api/v1/siri …` runbook (+ reverse-proxy alternative).
2. `docs/HTTP_API.md` gains the `/api/v1/siri/*` section; `docs/DEPLOYMENT.md` gains "Exposing the Siri endpoint on your tailnet"; `docs/CC_HEADLESS_ADAPTER.md` gains a "siri channel" note pointing at the prompt contract.
3. `CHANGELOG.md` `[Unreleased]`: Added — `siri` channel adapter (E43) with a two-sentence summary; Changed — config schema additions.
4. Test suite covers architecture §14 (bus list); `tsc` + vitest clean.
5. Version proposal to the operator: MINOR (new adapter + endpoints). No bump without approval.

**Complexity:** S

---

## Notes

- **Why not `pipeline.relays` for fallback:** relays re-arrive a message as *inbound* to an agent; a late reply must go *outbound to Chris*. Enqueueing an outbound envelope is the same path `send_message` uses (ADR-7).
- **Why waiters are keyed by `message_id`, not `request_id`:** `reply_to` on Peggy's envelope is the inbound bus message id; the store maps both ways.
- **Multi-user:** tokens are per contact, so a second person could be given their own token and route — no design change; not configured.
- **E29 tool-status:** `reportToolCall` appends to `status_lines` for the newest pending request of that contact; consumed in Phase 3 only. Keep it tiny.

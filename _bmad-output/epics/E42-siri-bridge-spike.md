# E42 — Siri Bridge Spike: thin `siri` channel + latency probe (POC-1)

| Field | Value |
|---|---|
| Epic ID | E42 |
| Dependencies | E19/E23 (cc-headless, Peggy instance), E31 (outbound transcript rows — used by the Gate 0 SQL). No iOS work. |
| Story Count | 5 |
| Estimated Complexity | M |
| Planning package | `_bmad-output/planning-artifacts/siri-bridge/` (README → product-brief → PRD → architecture §3–§8, §11 → implementation-plan §2–§3) |

---

## Epic Summary

Before building anything for iOS, answer the only question that matters with
real numbers: **can Peggy's first reply reach a waiting HTTP request inside
Siri's ~30 s budget (target p50 ≤ 12 s, p95 ≤ 25 s)?**

This epic adds the *thinnest* possible `siri` channel to the bus — a
bearer-authenticated `POST /api/v1/siri/ask` that submits the question through
the normal pipeline and holds the connection open until Peggy's `reply` is
delivered to a new `SiriAdapter.send()` — plus a probe script that measures
it 20 times against the live bus. Output is a filled-in Gate 0 and Gate 1
section in `spike-results.md` and a go / tune / pivot decision.

Design constraints (from `architecture.md`): channel id `siri`; per-contact
bearer token is the identity (E25 pattern); full `AdapterInstance` so the
existing `DeliveryWorker` delivers Peggy's reply into `send()`; no changes to
`DeliveryWorker`, `cc-headless`, `reply`, or any pipeline stage. Nothing in
bus-core calls a model.

Code written here is kept if it matches `architecture.md` §3; the durable
table, late replies, fallback, rate limiting, and docs are E43.

---

## Entry Criteria

- Peggy runs on `cc-headless` (named instance) and answers on Telegram today.
- Operator has run the Gate 0 prerequisites checklist (`implementation-plan.md` §2).

## Exit Criteria

1. `spike-results.md` has Gate 0 (historical) and Gate 1 (probe) tables filled with real runs, a cold-start breakdown, and a written decision.
2. With `adapters.siri.enabled: true` and a route for `channel: siri`, `curl -X POST …/api/v1/siri/ask` with a valid bearer token returns Peggy's first reply in the same response (or `status: pending` after `reply_timeout_ms`).
3. With `adapters.siri` absent, no `/api/v1/siri/*` route exists (404) and nothing else changes; `npx tsc --noEmit` and `npx vitest run` are clean.
4. Peggy's system prompt has the `siri*` branch and she replies once, briefly, in spoken prose, on the `siri` channel.
5. `scripts/siri-probe.ts` exists, is documented in its header, and writes a CSV.

---

## Config Shape (spike subset)

```yaml
adapters:
  siri:
    enabled: true
    reply_timeout_ms: 25000
  cc-headless:
    peggy:
      poll_interval_ms: 250            # run 2 of the probe; default 1000 for run 1
      # system_prompt: add the siri* branch (architecture §7)

contacts:
  chris:
    platforms:
      siri:
        token: ${SIRI_TOKEN_CHRIS}     # ≥ 16 random chars; `openssl rand -hex 24`

pipeline:
  routes:
    - match: { channel: siri }
      target: { adapterId: cc-headless, recipientId: agent:peggy }
```

---

## Stories

### S42.1 — Gate 0: prerequisites + historical Peggy turn latency

**User story:** As the operator, I want to know from existing data whether Peggy is fast enough for a spoken interface before I write any code.

**Acceptance criteria:**
1. Prerequisites checklist from `implementation-plan.md` §2 completed and recorded (device/iOS build, Xcode 27, Tailscale, agentbus version).
2. The Gate 0 SQL (implementation-plan §2) run against a *copy* of `data/agentbus.db` for the last 14 days of `telegram*` traffic; n, mean, p50, p95, max recorded in `spike-results.md`. Percentiles computed from the per-row dump (a 20-line `scripts/latency-percentiles.ts` or a spreadsheet — either is fine; note which).
3. Gate 0 decision written using the thresholds in implementation-plan §2 (existing instance / fast lane / async-first).

**Complexity:** S

### S42.2 — Config schema: `adapters.siri` (subset) + `contacts.*.platforms.siri.token`

**User story:** As the operator, I want to enable the Siri channel and bind a bearer token to my contact in `config.yaml`.

**Acceptance criteria:**
1. `SiriAdapterSchema` added to `src/config/schema.ts` per architecture §5 — for the spike, at least `enabled`, `reply_timeout_ms`, `max_body_bytes`, `debug_delay_ms` (all keys may be added now; unused ones documented as "E43").
2. `ContactPlatformsSchema.siri.token: z.string().min(16)`; duplicate token across contacts rejected with the same shape of issue as the pebble check.
3. `config.yaml.example` and `.env.example` updated (commented block + `SIRI_TOKEN_CHRIS=`).
4. Schema tests: valid config parses; duplicate token fails; token < 16 chars fails.

**Complexity:** S

### S42.3 — `SiriAdapter` (in-memory waiters) + `POST /api/v1/siri/ask`

**User story:** As an HTTP client with a valid token, I want to POST a question and receive Peggy's first reply in the same response.

**Acceptance criteria:**
1. `src/adapters/siri.ts` implements `AdapterInstance` with `id: 'siri'`, `capabilities.channels: ['siri']`, `send: true`, `typing: false`; `awaitReply(messageId, waitMs)` registers a waiter; `send(envelope)` resolves the waiter whose key equals `envelope.reply_to` (fallback: oldest pending for `envelope.recipient`) and returns `{ success: true, platformMessageId: envelope.id }`. Unmatched replies are logged at info level and still return success (never dead-letter).
2. `src/http/siri-routes.ts` exports `registerSiriRoutes(server, deps)`; `createHttpServer` calls it only when `config.adapters.siri?.enabled`. Route order: 413 body guard → bearer auth (map built from `contacts.*.platforms.siri.token`, hard 401 with no fallback identity) → zod body validation (`text` 1..2000, `wait_ms` optional int, `request_id` optional uuid, `client` optional object) → `processInbound()` with the envelope from architecture §7 → wait → respond with the §4 shapes (`answered` / `pending`), including `timing.queued_ms` and `timing.answered_ms`.
3. `processInbound` abort cases: `duplicate` → 409 `{reason:'duplicate'}` (join logic is E43); `command_handled` → 200 answered with the command response; other → 503.
4. `src/index.ts` instantiates and registers `SiriAdapter` when enabled and passes it into `createHttpServer` deps; it is started/stopped with the other adapters.
5. `debug_delay_ms > 0` inserts an artificial delay before responding and refuses to start when `NODE_ENV=production`.
6. Tests (`src/http/siri-routes.test.ts`, `src/adapters/siri.test.ts`): 401 paths; happy path with a stubbed reply delivered through `siri.send()` after a short delay; timeout → `pending`; 404 when the adapter is disabled; `send()` fallback-by-recipient path.
7. `npx tsc --noEmit` and `npx vitest run` clean.

**Complexity:** M

### S42.4 — Peggy prompt contract + route config on the live bus

**User story:** As the operator, I want Peggy to answer Siri questions once, briefly, in spoken prose, without changing how she behaves elsewhere.

**Acceptance criteria:**
1. The `siri*` branch from architecture §7 added to the live Peggy instance's `system_prompt` (config change; document the exact text in `docs/SIRI_ADAPTER.md` stub).
2. `pipeline.routes` entry for `channel: siri` → Peggy; `make restart`; `GET /api/v1/adapters` lists `siri`.
3. Manual check via `curl` (document the command): a trivial question returns one spoken-style reply with no markdown; a question that needs tools returns a short answer that mentions a follow-up on iMessage (per the contract) *or* the full answer if fast — either is acceptable; a second `reply` from Peggy for the same request is logged as unmatched/late and not lost in the transcript (`search_transcripts` finds it).
4. Transcripts show the `siri` conversation with its own `conversation_id` (distinct from Telegram) and `sessions.agent_id = agent:peggy`.

**Complexity:** S

### S42.5 — `scripts/siri-probe.ts` + Gate 1 measurement

**User story:** As the operator, I want a repeatable measurement of end-to-end ask→reply latency so the go/pivot decision is numeric.

**Acceptance criteria:**
1. `scripts/siri-probe.ts` (run with `npx tsx`): args `--base`, `--token`, `--n` (default 20), `--mix trivial:8,memory:8,tool:4`, `--wait` (ms), `--pause` (ms between asks, default 3000, to avoid dedup and per-contact queueing artefacts). Question banks for the three classes live in the script and are editable; memory questions must reference things Peggy actually knows (operator edits before running).
2. Prints a table per ask (class, queued_ms, answered_ms or TIMEOUT, first 60 chars of reply) and p50/p95/max/timeouts per class and overall; writes `~/.agentbus/siri-probe-<ISO date>.csv`.
3. Runs recorded in `spike-results.md` per the table there: run 1 (defaults), run 2 (`poll_interval_ms: 250`), and — if Gate 0 or run 2 requires — run 3 with a `peggy-siri` fast-lane instance (config in PRD FR-13; `journaling.enabled: false`, `journal_lookback_days: 1`, `model` set to the fastest available Claude model on the CLI).
4. Cold-start breakdown captured once from cc-headless `stream-json` timestamps (spawn → `init` → first assistant event → `reply` tool call); if the adapter does not log these, add a `debug`-level timing line to `invokeClaude()` (small, gated by `log_level: debug`) and keep it.
5. Gate 1 decision written with the thresholds from implementation-plan §3; the config that passed becomes the recommended config in `docs/SIRI_ADAPTER.md` (E43 finalises the doc).

**Complexity:** M

---

## Notes

- **Why the adapter is real code and not a mock:** the latency that matters is the whole loop through `processInbound`, the queue, cc-headless polling, `claude -p`, the `reply` tool, `POST /api/v1/messages`, and the `DeliveryWorker` tick. Only a real `send()` target measures that.
- **Dedup will bite the probe** if two identical questions run within 30 s — hence `--pause` and distinct question banks. The join behaviour is E43; the spike just avoids the case.
- **Per-contact serialization:** do not chat with Peggy on Telegram during a probe run, or the numbers include queueing behind those turns. Note the effect in the results if it happens — it is a real-world risk (architecture §8).
- **Do not** add a `siri_requests` table here unless it costs nothing; E43 owns durability.

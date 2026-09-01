# E38 — Configurable Raw Webhook Request Logging

| Field | Value |
|---|---|
| Epic ID | E38 |
| Dependencies | None structural. Touches the Pebble webhook route (`src/http/api.ts`) and adds a new generic helper (`src/http/webhook-log.ts`) and config schema fragment (`src/config/schema.ts`). |
| Story Count | 2 |
| Estimated Complexity | S |

---

## Epic Summary

1. **Request** (Chris, 2026-08-31/09-01): add configurable logging for raw
   incoming webhook requests from Pebble — both successful and rejected
   requests — so a misbehaving proxy or unexpected device payload can be
   debugged after the fact without reproducing it live. Explicitly asked for
   this to be **reusable for future** webhooks, not a pebble-only bolt-on.
2. **No existing precedent.** There was no application-code (TypeScript)
   pattern anywhere in `src/` for writing raw request data to date-based log
   files — only shell scripts (`scripts/safe_restart.sh`) had that
   directory-naming convention (`logs/<feature>/...`).
3. **Fix**: a small, generic helper — `logWebhookRequest(config, entry)` in
   `src/http/webhook-log.ts` — appends one JSON line per request to
   `<dir>/<webhook>/<YYYY-MM-DD>.jsonl` (one file per day, per webhook name).
   Off by default (request bodies may carry sensitive content), best-effort
   (a write failure logs a `console.error` and never affects the actual
   webhook response), and generic enough that any future webhook route can
   call it with its own `{ enabled, dir }` config and webhook name — no
   pebble-specific coupling in the helper itself.
4. **Config**: a shared `WebhookLoggingConfigSchema` fragment
   (`{ enabled: boolean, dir: string }`, defaults `false` /
   `logs/webhooks`) added to `src/config/schema.ts`, embedded as
   `adapters.pebble.logging`. Reusable by any future adapter's config block.
5. **Wired into the Pebble webhook** at every return point — each of the six
   rejection paths (413 body-too-large, 401 unauthorized, 400 not-multipart,
   400 malformed-multipart, 400 missing-transcription, 400
   invalid-recordedAt) and the success path — via a small local `logRequest`
   closure in the route handler.

---

## Exit Criteria

1. `adapters.pebble.logging.enabled: true` causes both a successful and a
   rejected request to append a JSON line to
   `logs/webhooks/pebble/<YYYY-MM-DD>.jsonl` (or the configured `dir`).
2. Default (`enabled: false`) writes nothing — no directory is even created.
3. The log line's `reason` field distinguishes every outcome
   (`unauthorized`, `body_too_large`, `not_multipart`,
   `multipart_parse_error`, `missing_transcription`, `invalid_recordedAt`,
   `ok`).
4. A write failure never throws and never affects the HTTP response —
   caught and reported via `console.error` only.
5. The helper and config shape are generic (webhook name + `{enabled, dir}`
   passed in, nothing pebble-specific inside `webhook-log.ts`) so a future
   webhook route can reuse them without modification.
6. Tests, docs (`docs/PEBBLE_ADAPTER.md`), and `CHANGELOG.md` updated. Full
   suite green, `tsc --noEmit` clean.

---

## Stories

### S38.1 — Generic `logWebhookRequest` helper + config schema

**Acceptance criteria:**
1. `src/http/webhook-log.ts` exports `logWebhookRequest(config, entry)`,
   where `entry` carries `webhook`, `ok`, `status`, `reason`, and an
   optional `raw` payload.
2. No-op when `config` is `undefined` or `config.enabled` is `false`.
3. Writes append (never overwrite) to `<config.dir>/<entry.webhook>/<today's
   date, YYYY-MM-DD>.jsonl`, one JSON object per line, each with an added
   `timestamp`.
4. A write failure (e.g. an unwritable directory) is caught and logged via
   `console.error`, never thrown.
5. `WebhookLoggingConfigSchema` (`{ enabled: z.boolean().default(false), dir:
   z.string().default('logs/webhooks') }`, `.prefault({})`) added to
   `src/config/schema.ts`, exported as `WebhookLoggingConfig`.
6. Unit tests: a line is written for a successful entry and for a rejected
   entry; the file path is date-based; disabled/undefined config is a
   no-op; multiple calls append to the same day-file; distinct webhook names
   get distinct subdirectories; a write failure doesn't throw.

**Complexity:** S

### S38.2 — Wire into the Pebble webhook + docs

**Acceptance criteria:**
1. `adapters.pebble.logging: WebhookLoggingConfigSchema` added to
   `PebbleAdapterSchema`.
2. The Pebble webhook route (`src/http/api.ts`) calls `logWebhookRequest` at
   every return point — all six rejection paths plus the success path —
   via a local closure that captures request headers as the base `raw`
   payload.
3. `docs/PEBBLE_ADAPTER.md` gets a "Raw request logging" section (config
   example, line format, reason values, off-by-default rationale) and the
   config example block gets the new `logging` key.
4. `.gitignore` gets a `logs/` entry (first application-code writer to that
   directory).
5. `CHANGELOG.md` entry under `[Unreleased]`.
6. Integration tests (`src/http/pebble-webhook.test.ts`): disabled by
   default (no directory created); a successful request logs `ok: true`;
   a rejected request (bad bearer token) logs `ok: false` with the right
   `reason`; the file path is date-based.

**Complexity:** S

---

## Notes

- **Epic number**: this would naturally have been E37, but that number was
  already claimed by a concurrent in-flight epic
  (`E37-pebble-relay-topic-routing.md`, Pebble→Telegram-topic relay routing)
  discovered mid-implementation — bumped to E38 to avoid collision.
- **"Raw" is pragmatic, not literal-byte-for-byte.** Fastify's multipart
  parser consumes the request stream; capturing genuinely raw HTTP bytes
  would require a raw-body-capture plugin ahead of multipart parsing, which
  is a much bigger lift for a debugging aid. What's logged is the closest
  practical proxy: request headers (always available) plus parsed
  multipart fields (once parsing succeeds) — sufficient for diagnosing "what
  did the device/proxy actually send" without literal wire-format capture.
- **Reusability is in the helper + schema fragment, not a bus-wide toggle.**
  Each adapter that wants this embeds its own `logging` field using the same
  `WebhookLoggingConfigSchema`, matching the existing per-adapter config
  block convention (Telegram, email, etc. each have independent schemas)
  rather than introducing a new global config section.

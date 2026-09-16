# E45 — Siri Bridge MVP Hardening (app + bus tuning)

| Field | Value |
|---|---|
| Epic ID | E45 |
| Dependencies | E43 (production endpoints), E44 (Gate 2 numbers). |
| Story Count | 7 |
| Estimated Complexity | L |
| Planning package | `siri-bridge/architecture.md` §8, §10–§12, §14; `PRD.md` FR-22…FR-27, NFR-1…NFR-9; `implementation-plan.md` §5 |

---

## Epic Summary

Take the POC app to something Chris uses every day for a week without
thinking about it: secrets in the Keychain, a real settings screen, the
late-reply hand-off (background fetch → local notification), history, error
dialogs that say what to do, an AppIntentsTesting suite, and TestFlight (or
stable Xcode signing). On the bus side, two small latency knobs
(`bus.delivery_poll_ms`, `/status` line) and, if Gate 1/2 data demanded it,
the documented fast-lane instance. Ends with a 7-day soak measured from the
bus's own request table.

MVP definition and Gate 3 are in `implementation-plan.md` §5.

---

## Entry Criteria

- E43 merged; E44 Gate 2 recorded with a default `waitBudget` and primary-UX decision.

## Exit Criteria

1. All PRD FR-20…FR-26 met; FR-27 evaluated with a written keep/drop decision.
2. Soak: 7 consecutive days of real use; `GET /api/v1/siri/requests` dataset shows ≥ 95 % answered-in-budget-or-handed-off-and-delivered, p50/p95 within NFR-1 (or within the pivoted targets if Gate 1 pivoted). Numbers in `spike-results.md` Gate 3.
3. App installable via TestFlight (or documented Xcode signing flow); `apps/ios/Peggy/README.md` is a complete setup guide.
4. Bus: `bus.delivery_poll_ms` configurable; `/status` shows the siri line; docs + CHANGELOG updated.

---

## Stories

### S45.1 — Keychain + settings hardening

**User story:** As Chris, I want my tokens stored securely and readable by the background intent.

**Acceptance criteria:**
1. `Keychain.swift` per architecture §12.3 (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`); `Settings` stops holding tokens; POC UserDefaults token storage removed and migrated on first launch (then deleted).
2. `AskPeggyIntent.makeClient` resolves tokens from Keychain; missing → "Open the Peggy app to set up the connection first."
3. Settings screen adds: notification permission button (state shown), "Hide reply on Lock Screen" toggle, default `waitBudget` from Gate 2.
4. Tests: Keychain round-trip (simulator), settings migration.

**Complexity:** S

### S45.2 — Late-reply hand-off: background `URLSession` + local notification

**User story:** As Chris, when Siri gives up waiting I still want Peggy's answer to reach me on my phone.

**Acceptance criteria:**
1. `BackgroundReplyFetcher` per architecture §12.6 with `@UIApplicationDelegateAdaptor` handling `handleEventsForBackgroundURLSession`; scheduled from the `pending` branch of `AskPeggyIntent`.
2. On completion with `answered`/`claimed`: `Notifier.post(title: "Peggy", body: reply)` (respecting the Lock Screen toggle via `UNNotificationContent` relevance/`hiddenPreviewsBodyPlaceholder` — pick the simplest supported mechanism and document it) and history update; on `pending`: re-arm, max 5 attempts / 10 min, then mark `failed:late` in history.
3. Verified on device with the bus's `debug_delay_ms` (or a deliberately slow question): notification arrives while the app is suspended, and after a force-quit + relaunch the history shows the reply.
4. Tests: delegate decoding paths with a stubbed response file.

**Complexity:** M

### S45.3 — History (SwiftData) + pull-to-refresh

**User story:** As Chris, I want to see what I asked and what Peggy said, including late replies.

**Acceptance criteria:**
1. `AskRecord` model per §12.3; `AskHistory` actor with `begin/answered/answeredLate/failed`; `HistoryView` newest-first with status badges; tap on `pending` → `fetchReply(wait 0)`; pull-to-refresh merges `GET /api/v1/siri/requests` (server wins on status/reply).
2. Extra replies shown beneath the first reply.
3. Tests: merge logic (local pending + server answered → answered).

**Complexity:** S

### S45.4 — Test suite completion + speech sanitiser

**User story:** As a maintainer, I want every dialog path and the HTTP mapping covered without Siri.

**Acceptance criteria:**
1. `AskPeggyIntentTests` covers answered / pending / unauthorized / unreachable / duplicate / rateLimited / notConfigured with exact FR-20 strings.
2. `BusClientTests` with a `URLProtocol` stub: headers (`Authorization`, `X-Bus-Token` present/absent), body JSON, status→`BusError` mapping, timeout configuration = `waitBudget + 3`.
3. `SpeechSanitizerTests`: markdown emphasis, headings, lists, links, code spans, and emoji-only lines handled; plain text untouched.
4. `xcodebuild … test` green in CI-style invocation from the command line.

**Complexity:** S

### S45.5 — Bus tuning: `bus.delivery_poll_ms` + `/status` siri line (+ optional fast lane)

**User story:** As the operator, I want to shave the fixed second from the delivery loop and see Siri health at a glance.

**Acceptance criteria:**
1. `DeliveryWorker` reads `config.bus.delivery_poll_ms` (default 1000; min 100) instead of the `POLL_INTERVAL_MS` const; documented in HTTP_API/DEPLOYMENT; tests updated.
2. `/status` appends the siri line (S43.6 if not already done there — do not duplicate).
3. If Gate 1 selected the fast lane: `config.yaml.example` gains the `peggy-siri` instance block (PRD FR-13) with a comment on journaling being disabled for it, and `docs/SIRI_ADAPTER.md` explains the trade-off (transcripts searchable, memory not journaled from Siri turns). If not selected, document the option only.
4. Re-run the E42 probe once after tuning; record in `spike-results.md`.

**Complexity:** S

### S45.6 — Spike: `LongRunningIntent` hand-off variant

**User story:** As the operator, I want to know whether iOS 27's `LongRunningIntent` gives a better late-answer experience than the background fetch.

**Acceptance criteria:**
1. `AskPeggyLongIntent: LongRunningIntent` waits up to 120 s via `performBackgroundTask`, updating `progress.localizedAdditionalDescription` ("Peggy is thinking…", then status lines from `GET /requests/:id` if present), posting the notification itself on answer; `CancellableIntent` handles `.timeout`.
2. Registered as a second App Shortcut phrase ("Ask \(.applicationName) and wait") for A/B testing only.
3. Compared on device over ≥ 10 slow asks each: notification delivery rate, delay after Peggy's reply, what Siri says when it stops waiting, Live Activity behaviour; table in `spike-results.md`.
4. Decision: keep one; remove the other's code and shortcut (no dead code ships).

**Complexity:** M

### S45.7 — TestFlight/signing + 7-day soak (Gate 3)

**User story:** As Chris, I want a stable install and a week of real use to prove it.

**Acceptance criteria:**
1. Either a TestFlight build (App Store Connect record, internal tester) or a documented long-lived Xcode signing flow; `README.md` covers install, Tailscale on-demand, and Siri setup ("Ask Peggy" in Settings → Siri & Search → Peggy).
2. Daily use for 7 days; soak table filled from `GET /api/v1/siri/requests` (script: extend `siri-probe.ts` with `--report since=<date>`).
3. Top failure class identified with a follow-up backlog entry if unresolved.
4. `CHANGELOG.md` updated (bus side); iOS README versioned.

**Complexity:** S

---

## Notes

- **Hand-off primary vs sync primary** (Gate 2) only changes defaults and copy: if hand-off is primary, `waitBudget` defaults lower (e.g. 8 s) and the `pending` dialog is phrased as the normal case ("Sent to Peggy — I'll notify you.").
- **Battery:** background fetches are bounded (≤ 5 attempts, 90 s server wait each); `isDiscretionary = false` because the user just asked for it.
- **Do not add APNs here.** Push is a Phase-3 option (E46) because it needs bus-side provider code and an App Store Connect key.

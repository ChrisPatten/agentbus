# Siri Bridge — Spike Results (living document; the agent fills this in)

Every gate decision must be written here with the numbers that justified it. Keep the raw runs; add rows, never overwrite.

---

## Gate 0 — historical Peggy turn latency (E42 / S42.1)

| Date | DB window | n | mean s | p50 s | p95 s | max s | Notes |
|---|---|---|---|---|---|---|---|
| 2026-09-15 | 30 days | 214 | 65.7 | 22.2 | 282.8 | 565.0 | `channel LIKE 'telegram%'`, replies > 600 s excluded. Mixed runtimes: cc-headless until 2026-09-11, then the claude-code MCP adapter (persistent session) from 2026-09-14 13:57 |
| 2026-09-15 | 14 days | 154 | 56.2 | 19.5 | 273.5 | 565.0 | Same mix; includes the 2026-09-11→14 outage window (no rows) |
| 2026-09-15 | 7 days | 73 | 39.4 | 18.2 | 191.6 | 329.5 | |
| 2026-09-15 | 2 days | 11 | 21.1 | 13.4 | 60.7 | 60.7 | claude-code MCP adapter only (the runtime Peggy is on today). Small n; 6 of 11 rows are Pebble→Telegram relays |

Script: `scripts/siri-gate0-latency.ts` (runs the implementation-plan §2 SQL against a `better-sqlite3` backup copy of `~/.agentbus_data/agentbus.db` and computes percentiles from the per-row dump; `--dump` prints the rows).

Prerequisites checklist (recorded 2026-09-15):
- iPhone on iOS 27 with Siri AI: **operator to confirm** — the Mac only sees an iPhone 12 mini pairing record (unavailable); `iphone172` is online on the tailnet.
- Xcode: **26.0.1 (17A400) with the iOS 26.0 SDK**, not Xcode 27. The POC builds against iOS 26 (`IntentModes`/`supportedModes` are iOS 26 APIs, so nothing in the POC needs 27). Installing to an iOS 27 device needs Xcode 27's device support. No code-signing identity is present on the Mac yet (`security find-identity` → 0), so the first device install is done from Xcode after signing in with an Apple ID.
- Tailscale: Mac `bobafett` (`bobafett.tail64ec4d.ts.net`), `tailscale serve` already active for another service on `/`; the `/api/v1/siri` path mount is added in S42.4.
- agentbus: `dev`/`feat/siri-bridge-poc` at 0.11.0 + unreleased; Peggy runs on the **`claude-code` MCP adapter** (persistent Claude Code session in tmux), not `cc-headless` — the headless instance has been disabled since 2026-09-11 (rotated Anthropic API key). `transcripts` has outbound rows (E31).

Decision: ☐ proceed with existing instance ☑ fast lane required ☐ async-first pivot
Rationale: historical p50 is 18–22 s across the 7/14/30-day windows, over the 20 s threshold on the longer windows and just under on the 7-day one, so by the plan the spike must compare a fast lane. Two caveats that shape what "fast lane" means here: (1) the measurement is an upper bound — it includes Telegram delivery, quote-reply lookups, and tool-heavy turns, none of which a trivial Siri ask incurs; (2) the runtime has changed. The only fast-lane config the plan describes is a dedicated `cc-headless` instance, and `cc-headless` is currently disabled for want of a working API key, so run 3 (fast lane) cannot be executed until the key is restored. The 2-day MCP-era slice (p50 13.4 s, n=11) is the closest proxy for what the Gate 1 probe will see. Proceed to E42 S42.2–S42.5 on the existing routing; treat Gate 1 run 1 as the real decision point and record the fast-lane run when `cc-headless` is available again.

## SDK verification (E44 / S44.1) — exact signatures found in the Xcode 27 SDK

Checked 2026-09-15 against the **iOS 26.0 SDK** shipped with Xcode 26.0.1 (`AppIntents.swiftmodule/arm64e-apple-ios.swiftinterface`), because Xcode 27 is not installed on the build Mac. Re-check the two "not present" rows when Xcode 27 arrives.

| Item | Expected (architecture.md) | Found | Deviation handled? |
|---|---|---|---|
| `IntentModes` / `supportedModes` | `static let supportedModes: IntentModes = .background` | `static var supportedModes: IntentModes { get }` on `AppIntent`, `@available(iOS 26.0, *)`; `IntentModes.background`, `.foreground`, `.foreground(.immediate | .deferred | .dynamic)`. `openAppWhenRun` is deprecated in 26.0 in favour of it | Yes — used as specified; deployment target 26.0 |
| `IntentDialog(full:supporting:)` | per WWDC26-343 | `init(full: LocalizedStringResource, supporting: LocalizedStringResource)` (+ `systemImageName:` variants) | Yes |
| `AppIntentsTesting` invocation API | per WWDC26-295 | **Not present** anywhere in Xcode 26 (no framework of that name in the SDK or the Xcode bundle) | Yes — `AskPeggyIntent.run(question:waitBudgetSeconds:)` holds the whole ask minus App Intents plumbing and returns an `AskPeggyOutcome` whose `dialogText` is the FR-20 string; `PeggyTests/AskPeggyIntentTests.swift` covers every outcome through `MockBusClient` with plain XCTest, plus one `perform()` smoke test. Swap to AppIntentsTesting in E45 once Xcode 27 is installed |
| `LongRunningIntent.performBackgroundTask` | per docs | **Not present** in the iOS 26 SDK (iOS 27 API) | Not needed for E44; E45's hand-off spike depends on Xcode 27 |
| `AppShortcut(intent:phrases:shortTitle:systemImageName:)` | | Present (iOS 16+), `phrases` must interpolate `\(.applicationName)`; `AppShortcutsProvider.appShortcuts` is `@AppShortcutsBuilder`; `shortcutTileColor` optional | Yes |
| `@Parameter(title:requestValueDialog:)` | | `init(title:description:default:requestValueDialog:inputConnectionBehavior:)` | Yes |
| `SiriTipView(intent:)`, `ShortcutsLink()` | | Both present in `_AppIntents_SwiftUI` | Yes |

## S42.4 — live-bus manual check (2026-09-15)

Config applied to the live bus (`peggy-claude-code/agentbus-config.yaml`, symlinked as `config.yaml`): `adapters.siri: { enabled: true, reply_timeout_ms: 25000 }`, `contacts.chris.platforms.siri.token: ${SIRI_TOKEN_CHRIS}` (48-char hex in `.env`), route `channel: siri → claude-code / agent:peggy`. Prompt contract added to Peggy's `CLAUDE.md` ("Siri (`via siri`)" rule under *Inbound Message Handling*) and, commented, to the disabled `cc-headless` `system_prompt`. Tailnet: `tailscale serve --bg --https=443 --set-path /api/v1/siri http://127.0.0.1:3000/api/v1/siri` on `bobafett` — `https://bobafett.tail64ec4d.ts.net/api/v1/siri/health` returns 200 with the token, 401 without, and `/api/v1/health` outside the mount is not the bus (502 from the other service on `/`). `scripts/safe_restart.sh` 21:46:42 → healthy; `GET /api/v1/health` lists `siri: online`.

```bash
curl -s -X POST http://127.0.0.1:3000/api/v1/siri/ask \
  -H "Authorization: Bearer $SIRI_TOKEN_CHRIS" -H 'content-type: application/json' \
  -d '{"text":"What day of the week is it today?","wait_ms":25000}'
```

Result: `status: answered`, reply `"Tuesday, September 15th."`, `queued_ms: 13`, `answered_ms: 4270` — one `reply`, spoken-style, no markdown, even though the running Peggy session predates the CLAUDE.md rule (it takes effect on her next context rebuild). Transcripts show the `siri` conversation with its own `conversation_id`.

## Gate 1 — end-to-end probe (E42 / S42.5)

Run format: `npx tsx scripts/siri-probe.ts --n 20 --mix trivial:8,memory:8,tool:4 --wait 25000`

| Run | Date | Config (instance / model / poll_ms / lookback) | n | timeouts | p50 answered_ms | p95 answered_ms | max | CSV |
|---|---|---|---|---|---|---|---|---|
| 1 | | peggy / default / 1000 / 3 | | | | | | |
| 2 | | peggy / default / 250 / 3 | | | | | | |
| 3 | | peggy-siri / <fast model> / 250 / 1 | | | | | | |

Cold-start breakdown (from cc-headless logs, one representative trivial ask): spawn→init event ___ ms; init→first assistant event ___ ms; first→`reply` tool call ___ ms.

Decision: ☐ pass ☐ pass with fast lane ☐ async-first pivot
Rationale:

## Gate 2 — on-device Siri behaviour (E44 / S44.5)

| Check | Result | Notes |
|---|---|---|
| "Hey Siri, ask Peggy" → prompt → spoken reply (background, locked) | | |
| Siri AI one-shot "Ask Peggy what day it is" (no prompt) | | |
| Cutoff sweep `debug_delay_ms` 10 / 15 / 20 / 25 / 30 s — largest that still speaks | | |
| AirPods (voice-only) | | |
| CarPlay | | |
| Siri overhead: hand-off→intent start ms; dialog return→speech start ms | | |
| Duplicate ask within 30 s → "give her a moment" | | |

Chosen default `waitBudget`: ___ s. Decision: ☐ sync primary ☐ hand-off primary
Rationale:

## E45 hand-off spike — background URLSession vs LongRunningIntent

| Approach | Notification arrived (n/n) | Median delay after reply | Battery/Live Activity notes | Keep? |
|---|---|---|---|---|
| background URLSession | | | | |
| LongRunningIntent | | | | |

## Gate 3 — 7-day soak (E45 / S45.7)

| Window | asks | answered in budget | handed off & delivered | failed | p50 | p95 | Top failure class |
|---|---|---|---|---|---|---|---|
| | | | | | | | |

## E47 spike — semantic Q&A over memory notes

| Entity model | 5 recall questions answered by Siri AI (n/5) | Notes |
|---|---|---|
| plain `IndexedEntity` | | |
| `.notes.note` schema | | |

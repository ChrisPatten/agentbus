# E44 — Peggy iOS App POC: `Ask Peggy` App Intent on device (POC-2)

| Field | Value |
|---|---|
| Epic ID | E44 |
| Dependencies | E42 (bus endpoint + Gate 1). Runs before E43 completes — the E42 endpoint is contract-compatible. |
| Story Count | 5 |
| Estimated Complexity | M |
| Planning package | `siri-bridge/architecture.md` §9, §12 (all subsections), §14; `research-ios27-siri.md` §2–§3; `PRD.md` FR-20…FR-23; `implementation-plan.md` §4 |

---

## Epic Summary

The smallest iOS app that proves the whole loop on a real iPhone: "Hey Siri,
ask Peggy" → Siri collects the question → `AskPeggyIntent` calls the bus over
Tailscale → Siri speaks Peggy's reply — with the app in the background, screen
locked, AirPods in. The epic also **measures** the things Apple does not
document: Siri's real wait cutoff (via the bus's `debug_delay_ms`), whether
Siri AI fills the question from a one-shot utterance, and Siri-side overhead.

Deliberately excluded: Keychain, notifications, late-reply hand-off, history,
polish — all E45. The POC stores the token in `UserDefaults` behind a big
"POC only" comment and is replaced in S45.1.

The app lives at `apps/ios/Peggy/` (monorepo, ADR-6), generated from
`project.yml` with XcodeGen, built with `xcodebuild`, and gets its own
`CLAUDE.md` (template below) so agents working in that subtree follow iOS
rules without re-reading the whole package.

---

## Entry Criteria

- Gate 1 recorded (pass, or async-first pivot — the POC is still built; only the expected dialog changes).
- Xcode 27 + a signing team available; iPhone on iOS 27 with Siri AI; Tailscale on both ends; `tailscale serve` path mount active (architecture §9).

## Exit Criteria

1. On the operator's iPhone: "Hey Siri, ask Peggy" → prompt → question → Peggy's reply spoken, app in background, screen locked. Works from AirPods.
2. `spike-results.md` Gate 2 table fully filled (one-shot test, cutoff sweep, surfaces, overhead) with a chosen default `waitBudget` and a "sync primary / hand-off primary" decision.
3. `apps/ios/Peggy/` builds with `xcodebuild` from a clean checkout after `xcodegen generate`; `PeggyTests` has at least one AppIntentsTesting test that passes on the simulator.
4. `apps/ios/Peggy/CLAUDE.md` exists; `.gitignore` excludes `*.xcodeproj`, `DerivedData`, `xcuserdata`.

---

## `apps/ios/Peggy/CLAUDE.md` (template — create verbatim in S44.2, then keep current)

```markdown
# Peggy (iOS)

Companion app for AgentBus's `siri` channel. Spec: `_bmad-output/planning-artifacts/siri-bridge/architecture.md` §12.

## Commands
brew install xcodegen                      # once
xcodegen generate                          # regenerates Peggy.xcodeproj (git-ignored) from project.yml
xcodebuild -project Peggy.xcodeproj -scheme Peggy -destination 'generic/platform=iOS' build
xcodebuild -project Peggy.xcodeproj -scheme Peggy -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test
export DEVELOPMENT_TEAM=XXXXXXXXXX          # before xcodegen; never commit a team id

## Rules
- iOS 27 minimum, Swift 6 strict concurrency. No third-party packages without a story saying so.
- All App Intents live in `Peggy/Intents/`. Every dialog outcome has an AppIntentsTesting test in `PeggyTests/`.
- Networking only through `BusClient` (`BusClientProtocol` for mocks). The HTTP contract is `architecture.md` §4 — do not invent fields; if the bus needs a change, write it in the bus epic.
- Secrets: Keychain only (from E45 on). Never log tokens or full reply bodies.
- Any Apple API marked [verify in Xcode 27 SDK] in the architecture doc: confirm the signature in the SDK first, record deviations in `spike-results.md`.
- Docs: update `apps/ios/Peggy/README.md` in the same change as any user-visible behaviour change; bus-level CHANGELOG stays for bus changes.
```

---

## Stories

### S44.1 — SDK verification spike (30 minutes, no app code)

**User story:** As the dev agent, I want to confirm the exact App Intents API signatures in the Xcode 27 SDK before writing code against them.

**Acceptance criteria:**
1. In a scratch Xcode project (or `swift-frontend -dump-interface` on the AppIntents module), confirm and record in `spike-results.md` → "SDK verification": `IntentModes`/`supportedModes`, `IntentDialog(full:supporting:)`, `AppShortcut(intent:phrases:shortTitle:systemImageName:)`, `AppShortcutsProvider`, `ProvidesDialog`, `@Parameter(title:requestValueDialog:)`, `AppIntentsTesting` invocation API (`AppIntentsTesting` framework — how to run an intent and read its dialog), `LongRunningIntent.performBackgroundTask`.
2. Any deviation from `architecture.md` §12 code is noted with the corrected snippet.

**Complexity:** S

### S44.2 — Project scaffold with XcodeGen

**User story:** As the dev agent, I want a reproducible iOS project generated from a committed spec.

**Acceptance criteria:**
1. `apps/ios/Peggy/project.yml` per architecture §12.2 (adjust from S44.1 findings); `xcodegen generate` produces a project that builds for `generic/platform=iOS` and the simulator.
2. Files per §12.1 exist as compilable stubs: `PeggyApp.swift` (SwiftUI `App` with a placeholder `RootView`), `Info.plist` keys via `project.yml` (`UILaunchScreen`, display name "Peggy"), `Assets.xcassets` with a placeholder icon.
3. `apps/ios/Peggy/CLAUDE.md` (template above), `README.md` (one paragraph + commands), `.gitignore` entries at repo root for `*.xcodeproj/`, `DerivedData/`, `xcuserdata/`, `*.xcworkspace/xcuserdata`.
4. `PeggyTests` target with one trivial passing test.

**Complexity:** S

### S44.3 — `AskPeggyIntent` + `PeggyShortcuts` + `BusClient`

**User story:** As Chris, I want "Ask Peggy" to send my question to the bus and speak the reply.

**Acceptance criteria:**
1. `BusModels.swift`, `BusClient.swift` (actor, `BusClientProtocol`), `AskPeggyIntent.swift`, `PeggyShortcuts.swift` per architecture §12.4–§12.5, with corrections from S44.1. `supportedModes = .background` (or the verified equivalent) — the app must **not** foreground when the intent runs.
2. Dialog outcomes per PRD FR-20 (answered / pending / unauthorized / unreachable / not configured); `SpeechSanitizer.clean(_:)` strips markdown before dialog.
3. POC-only `Settings` reads `baseURL`, `siriToken`, `busToken`, `waitBudget` from `UserDefaults` (comment: "replaced by Keychain in S45.1").
4. App Shortcut phrases include `\(.applicationName)` variants from FR-21; `AppShortcuts.updateAppShortcutParameters()` called on launch.
5. AppIntentsTesting tests: with `MockBusClient` scripted to answered / pending / unauthorized / unreachable / notConfigured, the intent returns the expected dialog text (exact strings from FR-20).
6. Simulator run: Shortcuts app shows "Ask Peggy"; running it prompts for the question and (against the live bus over Tailscale from the Mac) returns Peggy's reply as dialog.

**Complexity:** M

### S44.4 — Minimal Settings screen + "Test connection"

**User story:** As Chris, I want to enter the bus URL and token once and confirm the app can reach Peggy.

**Acceptance criteria:**
1. `SettingsView`: base URL, Siri token (SecureField), optional bus token, wait budget slider (5–25 s, default 20), "Test connection" → `BusClient.health()` → shows `routed`, `agent`, bus `version` or the error; `SiriTipView(intent: AskPeggyIntent())` and a `ShortcutsLink()`.
2. Values persist across launches (UserDefaults for the POC).
3. Manual test documented in `README.md`.

**Complexity:** S

### S44.5 — On-device validation + Gate 2 measurements

**User story:** As the operator, I want the real Siri behaviour measured so the MVP defaults are evidence-based.

**Acceptance criteria:**
1. App installed on the iPhone via Xcode signing; Siri on device runs "Ask Peggy" hands-free (screen locked) and speaks a trivial reply. Record pass/fail + video/log timestamps.
2. One-shot test: "Ask Peggy what day it is" (and two paraphrases) — record whether Siri AI skips the prompt.
3. Cutoff sweep: with the bus's `adapters.siri.debug_delay_ms` set to 10 000 / 15 000 / 20 000 / 25 000 / 30 000 in turn (restart each), ask a trivial question and record the largest delay at which Siri still speaks the reply; note what Siri says/does past the cutoff. Reset `debug_delay_ms: 0` afterwards (`NODE_ENV=production` guard also covers it).
4. Surfaces: AirPods (voice-only → `full` dialog is what is read), CarPlay (if available), Lock Screen; record each.
5. Siri overhead: log `Date()` at `perform()` start and at return; combine with bus `timing` to compute hand-off and TTS-start overheads; record.
6. Duplicate ask within 30 s → the "give her a moment" dialog (E42 returns 409 until E43 joins) — record.
7. `spike-results.md` Gate 2 section complete with the chosen default `waitBudget` (cutoff − 3 s, floor 8 s) and the primary-UX decision; `Settings` default updated accordingly.

**Complexity:** M

---

## Notes

- **App name is a functional requirement:** App Shortcut phrases must contain `\(.applicationName)`; the display name "Peggy" makes "Ask Peggy" the literal phrase. If the bundle display name must differ, the phrase changes with it.
- **No entitlement is needed** for App Intents/App Shortcuts (unlike SiriKit's Siri capability). Do not add the Siri capability.
- **Local network prompt:** Tailscale addresses (`100.64/10`, MagicDNS) do not trigger the Local Network privacy prompt in testing so far; if it appears, add `NSLocalNetworkUsageDescription` and record it.
- **ATS:** `tailscale serve` gives a valid certificate. If the POC must hit plain `http://` on the LAN, add a temporary `NSExceptionDomains` entry and remove it in E45.
- **If Gate 1 pivoted to async-first**, S44.3's expected happy-path dialog becomes the `pending` text; everything else is identical.

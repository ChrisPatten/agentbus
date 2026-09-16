# Peggy (iOS)

Companion app for AgentBus's `siri` channel. Spec: `_bmad-output/planning-artifacts/siri-bridge/architecture.md` §12. Bus contract: `docs/SIRI_ADAPTER.md`.

## Commands
brew install xcodegen                      # once
xcodegen generate                          # regenerates Peggy.xcodeproj (git-ignored) from project.yml
xcodebuild -project Peggy.xcodeproj -scheme Peggy -destination 'generic/platform=iOS' build
xcodebuild -project Peggy.xcodeproj -scheme Peggy -destination 'platform=iOS Simulator,name=iPhone 16 Pro Max,OS=27.0' test
export DEVELOPMENT_TEAM=ABCDE12345          # your 10-char Team ID, before xcodegen; never commit it (README: Finding your Team ID)

Add `CODE_SIGNING_ALLOWED=NO` to a build or test command when no signing team is set up (simulator and generic builds do not need one).

## Rules
- iOS 27 minimum (Xcode 27 / iOS 27 SDK on the build Mac), Swift 6 strict concurrency. No third-party packages without a story saying so.
- All App Intents live in `Peggy/Intents/`. Every dialog outcome has a test in `PeggyTests/` through `AskPeggyIntent.run` + `MockBusClient` (XCTest; `AppIntentsTesting` cannot read dialog), and `AskPeggyIntentFrameworkTests` drives the intent through `AppIntentsTesting` (currently skips: the runtime session is cancelled under `xcodebuild test` on the simulator — see spike-results.md).
- Networking only through `BusClient` (`BusClientProtocol` for mocks). The HTTP contract is `architecture.md` §4 — do not invent fields; if the bus needs a change, write it in the bus epic.
- Secrets: Keychain only (from E45 on). The POC keeps them in `UserDefaults` behind the comment in `Storage/Settings.swift`. Never log tokens or full reply bodies.
- Any Apple API marked [verify in Xcode 27 SDK] in the architecture doc: confirm the signature in the SDK first, record deviations in `spike-results.md`.
- Docs: update `apps/ios/Peggy/README.md` in the same change as any user-visible behaviour change; bus-level CHANGELOG stays for bus changes.

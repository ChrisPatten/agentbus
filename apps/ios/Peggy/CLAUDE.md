# Peggy (iOS)

Companion app for AgentBus's `siri` channel. Spec: `_bmad-output/planning-artifacts/siri-bridge/architecture.md` §12. Bus contract: `docs/SIRI_ADAPTER.md`.

## Commands
brew install xcodegen                      # once
xcodegen generate                          # regenerates Peggy.xcodeproj (git-ignored) from project.yml
xcodebuild -project Peggy.xcodeproj -scheme Peggy -destination 'generic/platform=iOS' build
xcodebuild -project Peggy.xcodeproj -scheme Peggy -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test
export DEVELOPMENT_TEAM=XXXXXXXXXX          # before xcodegen; never commit a team id

Add `CODE_SIGNING_ALLOWED=NO` to a build or test command when no signing team is set up (simulator and generic builds do not need one).

## Rules
- Deployment target is iOS 26.0 while the build Mac has Xcode 26.0.1 / the iOS 26 SDK; raise to 27.0 (and adopt `LongRunningIntent`, `AppIntentsTesting`) once Xcode 27 is installed. Swift 6 strict concurrency. No third-party packages without a story saying so.
- All App Intents live in `Peggy/Intents/`. Every dialog outcome has a test in `PeggyTests/` — today through `AskPeggyIntent.run` + `MockBusClient` (plain XCTest), because `AppIntentsTesting` is not in the iOS 26 SDK.
- Networking only through `BusClient` (`BusClientProtocol` for mocks). The HTTP contract is `architecture.md` §4 — do not invent fields; if the bus needs a change, write it in the bus epic.
- Secrets: Keychain only (from E45 on). The POC keeps them in `UserDefaults` behind the comment in `Storage/Settings.swift`. Never log tokens or full reply bodies.
- Any Apple API marked [verify in Xcode 27 SDK] in the architecture doc: confirm the signature in the SDK first, record deviations in `spike-results.md`.
- Docs: update `apps/ios/Peggy/README.md` in the same change as any user-visible behaviour change; bus-level CHANGELOG stays for bus changes.

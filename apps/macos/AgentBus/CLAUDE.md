# AgentBus for Mac

This is a self-contained SwiftUI/macOS 26.5 client. Its protocol source is `docs/APP_ADAPTER.md` at the repository root. The bus must enable the `app` adapter and route it to the work agent. Keep credentials in Keychain; never log token values or put them in URLs. Do not import Peggy code.

Generate with `xcodegen generate` in this directory. Build and test with `xcodebuild -project AgentBus.xcodeproj -scheme AgentBus -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build test`. Xcode 26.6 with macOS SDK 26.5 is the baseline. Check the E62 acceptance list before changing sprint status.

# AgentBus for Mac

This is a self-contained SwiftUI/macOS 27 client. Its protocol source is `docs/APP_ADAPTER.md` at the repository root. The bus must enable the `app` adapter and route it to the work agent. Keep credentials in Keychain; never log token values or put them in URLs. Do not import Peggy code.

Generate with `xcodegen generate` in this directory. Build and test with `xcodebuild -project AgentBus.xcodeproj -scheme AgentBus -destination 'platform=macOS' build test`. Xcode 27 and its macOS 27 SDK are required. Check the E62 acceptance list before changing sprint status.

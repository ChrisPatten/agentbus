# AgentBus for Mac

**Name:** AgentBus. **Bundle ID:** `com.chrispatten.agentbus.mac`. **Notification identity:** this bundle ID; notification thread IDs are bus session IDs. This is an agent-neutral operator client for one local bus/contact/agent.

Requires macOS 26.5 or later, Xcode 26.6, and XcodeGen. From this directory:

```sh
xcodegen generate
xcodebuild -project AgentBus.xcodeproj -scheme AgentBus -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build test
```

Run the generated scheme. On first launch, enter the bus URL (`http://127.0.0.1:3000` by default) and the app contact token. Enter the bus token only if `bus.auth_token` is configured. **Test Connection** reports contact, agent, route, version, and errors. Save starts the WebSocket client. Tokens are stored in Keychain, URL and preferences in UserDefaults. The bus must have an `app` adapter, an `app` route, and a contact `app` token as described in [the protocol guide](../../../docs/APP_ADAPTER.md).

The app caches sessions, messages, read markers, and the last durable event cursor in SwiftData. Sending retries with the same client message ID after reconnect. Notification previews can be hidden in Settings. For local HTTP development, App Transport Security allows local networking only. Other URLs should use HTTPS/WSS.

The work-laptop acceptance gate is E62 S62.8: clean generation/build/test, PRD flows F1–F6, a 10,000-message memory check, and a week of daily use. This repository's command line tools alone cannot perform those Xcode and live-bus checks.

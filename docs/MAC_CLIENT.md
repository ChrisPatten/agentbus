# Native macOS client (E62)

The source lives in `apps/macos/AgentBus`. It is a SwiftUI app for one configured AgentBus contact and routed agent. The project name is **AgentBus**, bundle ID `com.chrispatten.agentbus.mac`, minimum macOS 27. It shares no source with Peggy.

## Build and setup

On a Mac with Xcode 27, the macOS 27 SDK, and XcodeGen:

```sh
cd apps/macos/AgentBus
xcodegen generate
xcodebuild -project AgentBus.xcodeproj -scheme AgentBus -destination 'platform=macOS' build test
```

The app's Settings accepts a bus URL, app token, and optional bus token. **Test Connection** calls `/api/v1/app/health` and reports the contact, routed agent, routing status, and bus version. Save writes tokens to Keychain. Configure the bus as in [APP_ADAPTER.md](APP_ADAPTER.md). The default URL is `http://127.0.0.1:3000`; for a remote URL use HTTPS so the socket uses WSS.

## Client behavior

- The socket sends protocol v1 `hello` with the last applied durable sequence. On a dropped connection it retries with 1–30 second exponential backoff. Wake and a satisfied network path trigger an immediate reconnect.
- Session and message events are stored in SwiftData, with the cursor updated in the same save as each event. A repeated event is ignored. `welcome.reset` reloads the session list and recent history, replacing the local cache at the server's latest sequence. Older history is fetched by cursor on request.
- Outgoing sends are stored with a stable `client_msg_id` before transmission. After a disconnect they are resent under that same ID until acknowledged. A rejection remains visible with its reason and a Retry action.
- Main, active conversations, and Earlier sessions appear in the sidebar. Earlier sessions without a resumable Claude transcript have a disabled composer. The transcript shows Markdown, channel labels, timestamps, attachments, expired files, and pending sends. Return sends; Shift-Return inserts a newline. Files can be selected, dropped, or pasted, and are checked against the server's size limit before upload.
- Agent messages outside the viewed session or while the app is inactive notify through UserNotifications. Replayed messages group by session. The app Dock badge totals unread counts; Settings can hide preview text. Open at login uses `SMAppService.mainApp` where the app package supports registration.

## Acceptance still needed

On 2026-09-30 this work laptop selected Xcode 26.6 and macOS SDK 26.5. The full Swift source passed strict-concurrency typechecking against that SDK after a Return-key handler fix. XcodeGen is absent, and this project targets macOS 27 per the PRD. Generation, build, XCTest, and live flows F1–F6 remain pending a macOS 27/Xcode 27 environment. E62 also requires the 10,000-message memory measurement and one-week no-loss period.

The bus already sends `typing` and `tool_lines` in ephemeral `activity` frames for app-originated turns. The client decoder still needs to consume those optional fields. Original-channel turns in foreign sessions do not yet mirror their typing/tool lines to the app; E63 tracks that bus work. E63 also tracks a new active app session after `/clear`, so F6 can select Main immediately.

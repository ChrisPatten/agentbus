# Native macOS client (E62)

The source lives in `apps/macos/AgentBus`. It is a SwiftUI app for one configured AgentBus contact and routed agent. The project name is **AgentBus**, bundle ID `com.chrispatten.agentbus.mac`, minimum macOS 26.5. It shares no source with Peggy.

## Build and setup

On a Mac with macOS 26.5, Xcode 26.6, and XcodeGen:

```sh
cd apps/macos/AgentBus
xcodegen generate
xcodebuild -project AgentBus.xcodeproj -scheme AgentBus -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build test
```

Settings (⌘,) has General, Connection, and Notifications tabs. Connection accepts a bus URL, app token, and optional bus token. **Test Connection** calls `/api/v1/app/health` with the typed values and shows "Connected as <contact>" or the error, plus the routed agent, agent slots, upload limit, and bus version. A successful test saves the tokens to Keychain and reconnects; changed tokens are also saved when the tab closes. With no stored token, the app opens Settings › Connection on launch, and the first successful test opens Main and closes Settings. General has **Open at login** and Quit; ⌘Q is in the app menu. Configure the bus as in [APP_ADAPTER.md](APP_ADAPTER.md). The default URL is `http://127.0.0.1:3000`; for a remote URL use HTTPS so the socket uses WSS.

## Client behavior

- The socket sends protocol v1 `hello` with the last applied durable sequence. On a dropped connection it retries with 1–30 second exponential backoff. Wake and a network path changing from unavailable to available trigger an immediate reconnect. A path update while already online does not restart the socket.
- Session and message events are stored in SwiftData, with the cursor updated in the same save as each event. A repeated event is ignored. `welcome.reset` reloads the session list and recent history, replacing the local cache at the server's latest sequence. Older history is fetched by cursor on request.
- Session list and history requests keep their `state`, `limit`, and `before` values in the URL query so the bus routes match correctly.
- Outgoing sends are stored with a stable `client_msg_id` before transmission. After a disconnect they are resent under that same ID until acknowledged. While offline, the transcript labels them **Waiting for connection** and displays the connection error with a Reconnect button. A rejection remains visible with its reason and a Retry action.
- Ephemeral `activity` frames drive each session's live state, and also overwrite the cached session's `activity`, so a stale snapshot from a session event can't keep the spinner going after the turn. `running` shows "Working · 0:24" with the frame's `tool_lines`; `queued` shows "Waiting for a free slot". An idle frame without `session_id` is matched by `conversation_id`. When the reply's message event arrives, the trail is stored locally on that reply as a "Used N tools · 41s" disclosure. The bus does not store trails, so replies reloaded after a cache reset have none, and the disclosure is hidden. Each frame's slot counts update the sidebar footer and inspector; the inspector also polls `/health` every 15 seconds while visible.

## Interface

The UI follows `_bmad-output/planning-artifacts/mac-client/design/DESIGN.md` using stock SwiftUI controls, system colors, and SF Symbols.

- **Window:** `NavigationSplitView` with a sidebar, detail, and a toggleable inspector (⌥⌘I, remembered per window). Default size 1280 × 800, minimum 900 × 560. Double-click a row or use ⌥⌘O to open a session in its own window.
- **New Conversation (⌘N or the ✎ button):** asks the bus for an empty, untitled topic and selects it. The transcript shows the "New Conversation" placeholder and the composer is focused. The bus names the topic from its first message; rename it with ⌘R. This needs a connection. There is no title sheet.
- **Sidebar:** Main, Conversations by last activity, and a collapsed Earlier section. Each row shows the channel symbol, title, and a line with channel, relative time, or "<date> · read only". It has one trailing indicator: working spinner, queued clock, unread badge, or lock. The footer shows "Connected · 4 of 5 slots busy" or "Offline · reconnecting". The context menu has Rename (app topics), Open in New Window, Stop, and Clear Session.
- **Toolbar:** title and subtitle ("Started Sep 28 · 142 messages", "Telegram · continuing from Mac", "Sep 21 · 38 messages · read only"); Stop, inspector, and More. While the socket is down, a red "Offline · retrying in 8s" pill appears.
- **Transcript:** follows new messages, tool lines, and your own sends while you are at the bottom. If you have scrolled up, it stays put. Day labels; operator bubbles with Sending…, Queued, Delivered, Command, or "Not sent · <reason>" with Retry. Retry resends an unacknowledged send under the same ID; a bus rejection is final for that ID, so Retry sends it again under a new one. Hover over an agent reply to show **Copy**, which copies its Markdown source, plus "From Mac" or "via Telegram" when the arrival channel differs; agent replies as block Markdown (paragraphs, lists, headings, quotes, fenced code with Copy); attachment cards with expired state; `/clear` and scheduled prompts as centered notes. Code blocks and Copy show "Copied" briefly. Older pages load when the top is reached. A cache reset shows a reloading overlay. A session resumed from Earlier on this Mac shows the original's messages above a "Resumed from …" note. The bus doesn't link the two sessions, so this link is kept locally.
- **Composer:** a floating glass capsule with attach, a 1–8 line field, and send. Return sends; Shift-Return inserts a newline. Files can be added with ⌘O, drop anywhere on the detail column, or ⌘V in the composer, which attaches copied Finder files instead of pasting their names. Pasted rich text is converted to Markdown: bold, italic, code, strikethrough, links, and bullets. Double-clicking an attachment you sent from this Mac opens Quick Look; the file paths are remembered across launches. Files over the bus `max_upload_bytes` show "Over 25 MB" and are never uploaded. Typing `/` opens a popover of `/api/v1/app/commands`, aligned to the composer's left edge; use arrow keys to move, Return or Tab to complete, and Escape to close. A resumable Earlier session sends into a new copy, which is then selected. An unresumable one shows a read-only bar with **New Conversation**. Drafts are kept per session while the app runs.
- **Inspector:** channel, topic, agent, Claude session when the bus provides it, start time, message count, a slot bar, Clear Session (confirmed), and Cost.
- **Menus:** Session menu with Stop (⌘.), Clear Session (⇧⌘K), and Rename (⌘R); Next/Previous Session (⌃Tab/⌃⇧Tab) in Window.
- **Notifications:** agent messages outside every on-screen session, or any while the app is inactive, notify with the session title and preview ("New message" when previews are off). Replays send one "N new messages while you were away" alert per session. Alerts group by session ID, a click selects the session, and permission is requested before the first alert. The Dock badge totals unread counts and updates from each session event, whether or not a window is open. New messages in a visible session are announced to VoiceOver.
- **Notifications diagnostics:** each alert attempt is logged to the unified log under subsystem `com.chrispatten.agentbus.mac`, category `alerts`, with the authorization status and any error. Use `log stream --predicate 'subsystem == "com.chrispatten.agentbus.mac"' --level debug` to see them.
- **Previews:** `PreviewSupport.swift` seeds the mockup data. It has `#Preview` blocks for Main (light), the Telegram session (dark, with inspector), Earlier read-only/offline, empty states, each Settings tab, composer tokens, send states, and sidebar rows.

Not yet verified: Space-bar Quick Look on attachment cards (double-click works only for files picked on this Mac). Check it during S62.8.

## Acceptance still needed

On 2026-09-30 this work laptop selected Xcode 26.6 and macOS SDK 26.5. XcodeGen 2.46 generated the project; `xcodebuild` built it and passed all 5 XCTest cases. The generated project uses macOS deployment target 26.5 and Swift 6 strict concurrency. Live flows F1–F6 remain pending, as do the 10,000-message memory measurement and one-week no-loss period.

The bus already sends `typing` and `tool_lines` in ephemeral `activity` frames for app-originated turns. The client decoder still needs to consume those optional fields. Original-channel turns in foreign sessions do not yet mirror their typing/tool lines to the app; E63 tracks that bus work. E63 also tracks a new active app session after `/clear`, so F6 can select Main immediately.

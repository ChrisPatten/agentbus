# AgentBus for Mac — UI design handoff

**Target:** `apps/macos/AgentBus` (SwiftUI, macOS 26.5+, Swift 6). **Requirements:** `_bmad-output/planning-artifacts/mac-client/PRD.md` FR-50 to FR-59, flows F1 to F6. **Status:** design approved for implementation.

This folder is the visual spec for the Mac client. Read this file first, then compare against the screenshots. The HTML files are a supplement for exact spacing.

```
mac-design/
  DESIGN.md            ← this file
  screenshots/         ← PNG exports of each screen (source of truth for look)
  screens/*.html       ← HTML mockups; open in a browser, read for spacing/radii
```

| Screen | File | Shows |
|---|---|---|
| Main | `screens/main.html` | Light mode. Sidebar, transcript, queued turn, composer |
| Telegram session | `screens/telegram.html` | Dark mode. Foreign session, live tool trail, inspector, slash popover, attachment tokens incl. an oversized file |
| Earlier session | `screens/earlier.html` | Read-only Earlier session, Earlier section expanded, bus offline |
| New Conversation | `screens/sheet.html` | ⌘N sheet over Main |
| Settings | `screens/settings.html` | Settings scene, Connection tab |
| Notifications | `screens/notifications.html` | Notification banners and Dock badge |

---

## 1. Rules that override the mockups

1. **Use system colors and materials, never the hex values in the HTML.** The mockups hard-code colors only because HTML can't read the system palette. The app must follow light/dark mode, the user's accent color, Increase Contrast and Reduce Transparency automatically. Any `Color(red:green:blue:)` or hex literal in a view is a bug.
2. **Use stock controls and let macOS draw them.** `List` with `.sidebar` style, `Toolbar`, `Form`, `.sheet`, `.inspector`, `.popover`, `Settings`. Don't rebuild a sidebar, toolbar or toggle from shapes. Native sizing (28–32 pt rows, 13 pt body) comes for free.
3. **Use SF Symbols.** The SVGs in the mockups are stand-ins; §3 lists the real symbol names.
4. **Do not draw the window chrome.** Traffic lights, title bar and window corners in the mockups come from AppKit.
5. **Liquid Glass comes from the system.** Toolbar items, sheets and popovers get it automatically on macOS 26. Apply `.glassEffect` yourself only to the floating composer (§4.4).
6. No third-party packages (FR-50) unless a story explicitly allows one.

## 2. Design tokens: mockup value → SwiftUI

| Role | Mockup (light / dark) | Use in SwiftUI |
|---|---|---|
| Window background | `#FFFFFF` / `#1E1E20` | Default window background (don't set one) |
| Sidebar | translucent grey panel | `.listStyle(.sidebar)` inside `NavigationSplitView` (system draws the floating glass sidebar) |
| Primary text | `#1D1D1F` / `#F2F2F7` | `.primary` |
| Secondary text | `#6E6E73` / `#A1A1A8` | `.secondary` |
| Separators | 0.5 px, 9–10% black/white | `Divider()` or `.separator` shape style |
| Subtle fills (chips, code, read-only bar) | 4.5–10% black/white | `.fill.quaternary` / `.fill.tertiary` |
| Accent (operator bubble, send, selection) | `#0063D1` / `#1F6FD8` | `Color.accentColor` / `.tint` (user's system accent) |
| Working | orange | `Color.orange` |
| Error, Stop, offline | red | `Color.red` |
| Connected, success | green | `Color.green` |
| Body text | 13 pt | `.body` |
| Transcript text | 14 pt | `.body` with `.font(.system(size: 14))` only if 13 pt reads too small in testing; otherwise `.body` |
| Captions, timestamps, row subtitles | 11 pt | `.caption` / `.caption2` |
| Section headers | 11 pt semibold secondary | Provided by `Section` in sidebar style |
| Code | 12 pt monospaced | `.system(.callout, design: .monospaced)` |
| Operator bubble radius | 18 | `RoundedRectangle(cornerRadius: 18, style: .continuous)` |
| Code block / attachment card radius | 10–12 | `cornerRadius: 10/12, style: .continuous` |
| Transcript max width | 760 | `.frame(maxWidth: 760)` centered |
| Transcript message spacing | 20 | `LazyVStack(spacing: 20)` |

## 3. SF Symbols

| Use | Symbol |
|---|---|
| Channel: App | `bubble.left` |
| Channel: Telegram | `paperplane` |
| Channel: Email | `envelope` |
| Channel: Siri | `waveform` |
| Queued | `clock` |
| Read-only / not resumable | `lock` |
| Stop | `stop.fill` (tinted red) |
| Inspector toggle | `sidebar.right` |
| More | `ellipsis.circle` |
| New conversation | `square.and.pencil` (or `plus`) |
| Attach | `plus` (in composer) / `paperclip` (menu item) |
| Send | `arrow.up` in a filled circle (`arrow.up.circle.fill`) |
| Tool trail disclosure | system `DisclosureGroup` chevron |
| Copy code | `doc.on.doc` |
| Attachment | `doc` / file icon from `NSWorkspace.shared.icon(forFile:)` when the file is local |
| Oversized file | `exclamationmark.triangle.fill` (red) |
| Offline | `wifi.slash` |
| Connected | `checkmark.circle.fill` (green) |
| Settings tabs | `gearshape`, `link`, `bell` |

## 4. Screens and components

### 4.1 Window (`main.html`, `telegram.html`)

```
NavigationSplitView {
    SessionSidebar()            // min 240, ideal 268
} detail: {
    SessionDetail()             // toolbar + transcript + composer
        .inspector(isPresented: $showInspector) { SessionInspector() }   // ideal 260
}
```

- `WindowGroup` for the main window. Also `WindowGroup(for: Session.ID.self)` so a session can open in its own window (double-click a row, or File › Open in New Window).
- Default window size 1280 × 800; minimum about 900 × 560.

### 4.2 Sidebar (FR-54)

- `List(selection: $selectedSessionID)` with `.listStyle(.sidebar)`.
- Sections, in order:
  - `Section("Main")`: one row, pinned.
  - `Section("Conversations")`: active app topics and active foreign sessions, newest activity first.
  - `Section("Earlier", isExpanded: $showEarlier)`: ended sessions, collapsed by default.
- **Row** (two lines; see `SessionRow` in the mockup):
  - Leading: channel symbol (§3), tinted with the accent color.
  - Line 1: title, `.body`, single line, truncating tail.
  - Line 2: `.caption`, `.secondary`. Shows "<Channel> · <relative time>" for foreign sessions, the relative time for app sessions, and "<date> · read only" for non-resumable Earlier rows. Use `Text(date, style: .relative)` or `.formatted(.relative(presentation: .named))`.
  - Trailing, one of:
    - working: `ProgressView().controlSize(.small)`;
    - queued: `Image(systemName: "clock")`, secondary;
    - unread: `.badge(count)`;
    - not resumable: `lock`.

    Show at most one. Priority: working > queued > unread > lock.
- Earlier rows titled "Main" must show their date in line 2 so several cleared Mains can be told apart.
- Sidebar footer (a `safeAreaInset(edge: .bottom)` on the list): a 7 pt status dot plus "Connected · 4 of 5 slots busy" or "Offline · reconnecting", `.caption`, `.secondary`.
- Context menu on rows: Rename… (app topics only, FR-23), Open in New Window, Stop (when working), Clear Session….

### 4.3 Toolbar

- `.navigationTitle(session.title)` and `.navigationSubtitle(...)`. Examples:
  - "Started Sep 28 · 142 messages"
  - "Telegram · continuing from Mac"
  - "Sep 21 · 38 messages · read only"
- `ToolbarItemGroup(placement: .primaryAction)`: Stop (`stop.fill`, red, disabled when the session is idle), inspector toggle, More menu. macOS 26 renders these as one glass capsule.
- When the socket is not connected, add a status item before the group: a red capsule "Offline · retrying in 8s" (`wifi.slash`). Hide it when connected; don't show a green "Connected" item in the toolbar.

### 4.4 Transcript (FR-55, FR-57)

- `ScrollView { LazyVStack(alignment: .leading, spacing: 20) { … } }`, `.defaultScrollAnchor(.bottom)`, content `.frame(maxWidth: 760)` centered, horizontal padding 28.
- Load older pages when the top row appears (FR-53).
- **Day label:** centered `.caption` semibold secondary, for example "Today 7:02 AM".
- **Operator message:**
  - Right-aligned bubble, accent fill, white text, max width 70% of the column, padding 8 × 13, radius 18 continuous.
  - Under it, right-aligned `.caption2` secondary: send state ("Sending…", "Queued", "Delivered", or "Not sent" plus a Retry button), then a source label if the arrival channel differs from the session's ("From Mac" in a foreign session; "via Telegram" in an app session), then the time.
  - A failed send shows the red "Not sent" with a small Retry button that resends with the same `client_msg_id`.
- **Agent message:**
  - Left-aligned, no bubble, max width 680.
  - Above it: the time in `.caption2` secondary, then a `DisclosureGroup("Used 5 tools · 41s")` (`.caption`, secondary) with the tool trail lines, when the reply had a trail.
  - Body: rendered Markdown, `.textSelection(.enabled)`.
- **Markdown:** `AttributedString(markdown:)` handles inline styles only. Write a small block renderer for paragraphs, bullet and numbered lists, headings and fenced code blocks.
- **Code block:**
  - `.fill.quaternary` background, radius 10.
  - Header row: the language in `.caption` secondary, and a borderless Copy button (`doc.on.doc`) that writes to `NSPasteboard`.
  - Body: monospaced 12 pt, horizontal `ScrollView`.
- **Live activity** (the session's current turn; not stored):
  - Working: `ProgressView().controlSize(.small)` plus "Working · 0:24" in orange `.caption`, then the tool lines indented 20 in monospaced `.caption`. Lines are secondary except the newest, which is primary.
  - Queued: `clock` plus "Waiting for a free slot · all 4 conversation slots are busy", `.caption` secondary.
  - When the reply arrives, the live block is replaced by the reply and its trail moves into the reply's disclosure (FR-57).
- **Attachment card** (sent or received): icon 26 pt, file name `.callout` medium, size `.caption2` secondary; radius 12, `.fill.quaternary`. Expired attachments show "· Expired" in italic and a secondary icon. Space bar or double-click opens Quick Look (`.quickLookPreview`) when the file is still local.
- **System note:** centered `.caption2` secondary, for example "Cleared with /clear · Sep 21, 4:31 PM". Scheduled prompts (FR-55) use the same style.

### 4.5 Composer (FR-56)

- Floating capsule at the bottom of the detail column, max width 760, padding 20 sides / 18 bottom: `.glassEffect(.regular, in: .rect(cornerRadius: 22))` (capsule when single-line).
- Contents, left to right:
  - Attach button: `plus` in a 32 pt circle with `.fill.quaternary`. Opens `.fileImporter`; ⌘O also triggers it.
  - `TextField("Message <title>", text:, axis: .vertical)`, `.lineLimit(1...8)`, plain style.
  - Send button: `arrow.up` in a 32 pt accent circle. Disabled when the field is empty and nothing is attached.
- Return sends; Shift-Return inserts a newline. Handle this with `.onKeyPress(.return)` and check `modifiers`.
- **Attachment tokens:** a wrapping row inside the capsule, above the text field. Each token is 26 pt tall with radius 8 and `.fill.tertiary`, and shows the doc icon, name, size and a remove (`xmark`) button.
  - Over `max_upload_bytes`: red `exclamationmark.triangle.fill` and red "Over 25 MB". The file is rejected before upload (FR-56), and Send ignores it.
  - Adding files: `.dropDestination(for: URL.self)` on the whole detail column (show a drop highlight), `.onPasteCommand`, and ⌘O.
- **Slash popover:**
  - Typing `/` at the start of the field opens `.popover(isPresented:, arrowEdge: .top)` anchored to the composer. It's 320 wide and lists the commands from `GET /api/v1/app/commands` (FR-25), filtered by prefix.
  - Each row shows the command in monospaced `.callout` and its description in `.callout` secondary.
  - Up/Down move the selection (accent row), Return or Tab completes, Escape closes.
- **Read-only state** (`earlier.html`, FR-56):
  - Replace the composer with a bar of the same width: radius 22, `.fill.quaternary`.
  - Contents: `lock` icon; "This session can't be resumed. Its Claude transcript is no longer on disk." in `.callout` secondary; and a bordered "New Conversation" button that opens the ⌘N sheet.
- **Resumable Earlier session:** the composer stays enabled, with placeholder "Continue in a new conversation". On send, the ack returns a new session ID (architecture §5, resume creates a copy). Select that session in the sidebar and keep the draft's send state on the new row.
- **Offline:** the composer stays enabled. Sends are queued locally and show "Sending…" until the socket reconnects (FR-52).

### 4.6 Inspector (`telegram.html`)

- `.inspector(isPresented:)`, toggled by the toolbar button and ⌥⌘I. Remember the state in `@SceneStorage`.
- **Session** group (`LabeledContent` rows): Channel, Topic, Agent (monospaced), Claude session (monospaced, middle-truncated, with a Copy context menu), Started, Messages.
- **Agent slots:**
  - A 5-segment bar with running user turns in orange and free slots in `.fill.tertiary`.
  - Caption: "4 user turns running · 1 slot reserved for scheduled work · 1 queued".
  - The data comes from `/api/v1/app/health` (FR-24). Refresh it when the inspector is visible and on activity events.
- Buttons: "Clear Session…" (asks for confirmation, then sends `/clear`) and "Cost" (sends `/cost`).

### 4.7 New Conversation sheet (`sheet.html`, F2)

- `.sheet` on the main window, opened by ⌘N (`CommandGroup(replacing: .newItem)`) and the sidebar's new-conversation button.
- Contents:
  - Title: "New Conversation".
  - `Form` with a right-aligned-label layout (`.formStyle(.columns)`):
    - "Title:" `TextField`, optional;
    - "Message:" `TextEditor`, 5 lines, focused on open.
  - Footer: "Runs alongside Main" (`.caption` secondary) on the left; on the right, Cancel (`.cancelAction`) and Start (`.defaultAction`, prominent).
- Start sends `target: { kind: "new", title }` and selects the new session when the ack arrives.

### 4.8 Settings (`settings.html`, FR-51, FR-59)

- A `Settings { TabView { … } }` scene with `Tab("General", systemImage: "gearshape")`, `Tab("Connection", systemImage: "link")` and `Tab("Notifications", systemImage: "bell")`. Use `Form` with `.formStyle(.grouped)` on each tab. The window is about 640 × 560.
- **Connection tab:**
  - Group 1: Bus URL `TextField` (default `http://127.0.0.1:3000`), App token `SecureField`, Bus token `SecureField` (prompt "Optional").
  - Footer note: "Tokens are stored in your login keychain."
  - Group 2: a status row ("Connected as chris" with a green check, or the error in red) with a trailing "Test Connection" button, then read-only `LabeledContent` rows from FR-24: Agent, Agent slots, Upload limit, Bus version.
- **General tab:** "Open at login" `Toggle`, using `SMAppService.mainApp` (FR-59).
- **Notifications tab:** "Show message previews" `Toggle` (FR-58), and a button to open System Settings when permission is denied.
- Keep the existing first-run behavior: if no token is stored, open Settings › Connection on launch.

### 4.9 Notifications and Dock (`notifications.html`, FR-58)

- Post a `UNUserNotificationCenter` alert for each agent message in a session that isn't on screen, or whenever the app isn't active.
  - Title: the session title. Body: the message preview, or "New message" when previews are off.
  - Set `threadIdentifier = session_id` so macOS groups the alerts by session.
- After a reconnect replay, post one alert per session: "3 new messages while you were away".
- Clicking an alert activates the app and selects that session.
- Dock: `NSApp.dockTile.badgeLabel` is the total unread count, or nil when zero.

## 5. Keyboard and menus

| Command | Shortcut | Menu |
|---|---|---|
| New Conversation | ⌘N | File |
| Open in New Window | ⌥⌘O | File |
| Attach Files… | ⌘O | File |
| Stop | ⌘. | Session |
| Clear Session… | ⇧⌘K | Session |
| Rename… | ⌘R | Session (app topics only) |
| Show/Hide Inspector | ⌥⌘I | View |
| Show/Hide Sidebar | ⌃⌘S | View (system) |
| Next / Previous Session | ⌃Tab / ⌃⇧Tab | Window |
| Settings… | ⌘, | App (system) |

Add the Session menu with `CommandMenu("Session")`. Its items act on the focused session, through `@FocusedValue`.

## 6. States checklist (each must be visible somewhere and testable in previews)

| State | Where | Requirement |
|---|---|---|
| Idle / working / queued session | Sidebar row, toolbar Stop, transcript live block | FR-4, FR-54, FR-57 |
| Unread count | Sidebar `.badge`, Dock badge | FR-21, FR-58 |
| Operator send: sending, queued, delivered, failed + retry, command | Under operator bubble | FR-15, FR-55 |
| Arrival label ("From Mac", "via Telegram") | Under operator bubble | FR-55 |
| Tool trail live, then collapsed into reply | Transcript | FR-57 |
| Attachment uploading, oversized (rejected), sent, expired | Composer tokens, attachment card | FR-22, FR-56 |
| Earlier: resumable (composer enabled, sends to a copy) / not resumable (read-only bar) | Composer | FR-34, FR-56 |
| Offline / reconnecting | Toolbar pill, sidebar footer | FR-52 |
| Cache reset (`welcome.reset`) | Brief progress overlay on the transcript while reloading | FR-53 |
| Empty states: no Conversations, empty Earlier, new session with no messages | Sidebar, transcript (`ContentUnavailableView`) | — |
| Setup needed (no token) | Settings › Connection on launch | FR-51 |

Add `#Preview` blocks with mock data for: Main (light), the Telegram session (dark, inspector open), Earlier read-only, the sheet, and each Settings tab.

## 7. Accessibility

- Every icon-only button has a `.help(...)` tooltip and an accessibility label (Stop, Show Inspector, Attach Files, Send, Copy Code, Remove <file>).
- The sidebar row's accessibility label combines title, channel, state and unread count, for example "Standup notes, Telegram, working".
- Announce new agent messages in the visible session with `AccessibilityNotification.Announcement`. Don't announce messages in other sessions.
- Everything must work with full keyboard access, Increase Contrast, Reduce Transparency (glass falls back to solid automatically) and Dynamic Type sizes in Settings › Accessibility › Text Size.

## 8. Not in this design

These are out of scope for the MVP (PRD §10): approve/deny UI, agent-sent files, menu-bar quick ask, agent switching, renaming foreign sessions and token streaming. The app icon in the mockups is a placeholder.

## 9. Open questions for the implementer to raise, not decide

1. Unread counts should only count agent messages. FR-17 doesn't say this yet; confirm it on the bus side.
2. Tool trails aren't stored on the bus, so after a cache reset older replies have no "Used N tools" disclosure. Hide the disclosure when there's no data. Don't show "Used 0 tools".
3. The agent-slots numbers come from polling `/health`. If that feels stale, propose an `activity` summary event on the socket rather than polling faster.

## 10. Done when

- Each screenshot is matched in layout, hierarchy and states, in both light and dark mode, using system colors (rule 1).
- PRD flows F1 to F6 work against a running bus.
- The §6 states each have a preview.
- `xcodegen generate && xcodebuild` builds from a clean checkout, and the existing XCTest suite passes.

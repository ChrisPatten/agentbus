# E62 — Native macOS App MVP

| Field | Value |
|---|---|
| Epic ID | E62 |
| Status | In progress — client source implemented; Xcode and live acceptance pending |
| Dependencies | E59 frozen frame/API contract; E60 foreign/Earlier continuation; E61 proactive delivery; E58 activity states |
| Story Count | 8 |
| Estimated Complexity | XL |

Source: `planning-artifacts/mac-client/product-brief.md` §4–8 and `planning-artifacts/mac-client/PRD.md` §3.5 (FR-50–FR-59), flows F1–F6, §4, §7. UI scaffolding and mock-socket tests may start once E59 fixes the protocol schema.

## Epic Summary

Build a self-contained SwiftUI client under `apps/macos/` for the operator's local AgentBus instance. It shows Main, active conversations, and Earlier sessions; supports Markdown chat, files, activity, commands, notifications, and offline recovery. The first deployment is one work agent on one work laptop, with no other channels required.

## Entry Criteria

- Freeze E59's frame schema and HTTP shapes, including `welcome.reset`, `ack` states, session and message events, attachments, and activity snapshots.
- Choose a neutral app name, bundle ID, and notification identity (PRD §9 Q4); record these in the project README before generating the project.
- Confirm the work-laptop Xcode/macOS 27 SDK is available for the clean-build acceptance gate. Mock-client and source work can proceed before this check.

## Exit Criteria

1. FR-50/51: a clean checkout generates and builds with `xcodegen generate && xcodebuild`; macOS 27+, Swift 6 strict concurrency, SwiftUI, project-local README/CLAUDE.md, no shared Peggy code. Setup stores tokens in Keychain, URL in UserDefaults, and Test Connection shows health/routing/version or actionable error.
2. FR-52/53: the WebSocket client reconnects after drops, network changes, and wake; persists cursor and pending `client_msg_id`; retries without duplicate sends; replays in order and resets/reloads the SwiftData cache on `welcome.reset`.
3. FR-54/55: Main, Conversations, and Earlier render by PRD rules, with channel, title, last activity, unread and activity state. Transcript shows Markdown/code copy, timestamps, arrival labels, scheduled notes, attachment/expiry chips, and send states.
4. FR-56/57: Return/Shift-Return, slash-command autocomplete, drag/paste/⌘O files with pre-upload size checks, disabled composer for unresumable Earlier sessions, queued/typing/tool activity, and session-scoped Stop work.
5. FR-58: notifications occur for agent messages outside the viewed session or when inactive; replay alerts group per session; a click opens the session; Dock badge totals unread; preview hiding works.
6. FR-59 is a should-priority follow-up within MVP if cheap: an Open at login toggle uses `SMAppService.mainApp`. Its absence does not block must-priority acceptance.
7. XCTest covers protocol encoding/decoding, reconnect/cursor, idempotent retry, and cache reset with a mock socket. On the work laptop F1–F6 pass, including a week of daily use with no lost messages, and the app stays below 150 MB with 10,000 cached messages (NFR-8).

## Stories

### S62.1 — Project, naming, and first-run setup (FR-50/51)

Record the neutral name/bundle ID, create `apps/macos/<AppName>/project.yml`, source/tests, README, CLAUDE.md, and generated-project ignore rules. Use Swift 6 strict concurrency and no third-party package by default. Build a first-run sheet for URL (default `http://127.0.0.1:3000`), app token, optional bus token; store secrets in Keychain. Test Connection calls authenticated app health and reports agent, route, version, and errors.

### S62.2 — Protocol client and resilient connection (FR-52)

Implement typed JSON frames and HTTP endpoints from E59. Manage `URLSessionWebSocketTask` lifecycle, server heartbeat, 1–30 second exponential backoff, immediate wake/network reconnect, connection indicator, and `hello` with persisted cursor. Track pending sends by stable `client_msg_id` and retry after reconnect until acknowledged. XCTest uses a mock transport to prove ordered replay, duplicate ack, and offline transitions.

### S62.3 — SwiftData cache and synchronization (FR-53)

Persist sessions, messages, read markers, and last applied cursor. Apply durable events atomically in sequence order; avoid duplicate rows on replay. Load session list and recent history after first connect, page older history on scroll, and fully clear/reload on `welcome.reset`. Keep ephemeral activity separate from durable history. Test cursor crash/restart and reset logic against a 10,000-message fixture.

### S62.4 — Sidebar and transcript (FR-54/55)

Build three sections: pinned Main, active Conversations by last activity, collapsed Earlier. Rows show channel badge, title, activity age, unread, and working/queued/idle. ⌘N creates a topic, and rename is offered only for app topic sessions. Render operator/agent Markdown distinctly, code Copy button, timestamp, cross-channel arrival label, scheduled note, attachment and expired state, and sending/queued/failed/command state with retry.

### S62.5 — Composer, attachments, and activity (FR-56/57)

Implement Return send, Shift-Return newline, command completion from `/commands`, and drop/paste/⌘O upload with thumbnails/chips. Reject oversized files before HTTP upload, report media-config and upload failures in place, and send returned attachment IDs. Disable a nonresumable Earlier composer with an explanation. Show queued, typing, and tool-call trail; collapse the trail into the reply disclosure. Stop targets the viewed session.

### S62.6 — Notifications, read state, and Dock badge (FR-58)

Request notification permission in context. Alert for agent messages outside the active viewed session or while the app is inactive, group replayed events into one alert per session, deep-link a click, and suppress duplicate alerts after reconnect. Update read markers when viewed and compute Dock badge from unread counts. Offer a hide-previews setting and honor it in alerts.

### S62.7 — Open at login (FR-59, should)

If supported in the local-build deployment, add an optional `SMAppService.mainApp` toggle and verify enable/disable across restart. Record any packaging limitation and schedule a follow-up if this should-priority story cannot ship with the MVP.

### S62.8 — Clean build, end-to-end flows, and docs

From a clean checkout run XcodeGen, xcodebuild, and XCTest. On the work laptop verify PRD F1–F6: Main; parallel topics and queued fifth turn; foreign-session continuation; offline scheduled delivery/notification; sleep/wake catch-up; `/clear` and Earlier resume/read-only. Measure app memory at 10,000 cached messages and run the one-week daily-use no-loss acceptance period. Complete project README/setup guidance and root CHANGELOG.

## Out of Scope

- iOS target or sharing code with `apps/ios/Peggy`.
- Agent switching, multiple users, remote access setup, App Store/notarization.
- Agent-sent files, approval UI, token-level streaming, menu-bar quick ask.

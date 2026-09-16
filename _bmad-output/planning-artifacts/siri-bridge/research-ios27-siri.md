# Research — iOS 27, Siri AI, and App Intents (as of 2026-09-14, iOS 27 GA)

Purpose: ground truth for the Siri Bridge design. Every claim below is tagged **[Apple]** (Apple documentation / WWDC26 session / Apple engineer on the developer forums), **[Press]** (reputable secondary reporting), or **[Unverified]** (claims we could not confirm against Apple sources — do not build on these).

---

## 1. What Siri can do with third-party apps in iOS 27

**[Apple]** Siri in the 27 releases gains three app-facing capabilities, all built on App Intents: (1) access your app's *entities* (structured content), (2) take *actions* via your intents, (3) understand *on-screen* context via view annotations. Source: WWDC26 session 240 "Build intelligent Siri experiences with App Schemas" — https://developer.apple.com/videos/play/wwdc2026/240/

**[Apple]** "Siri AI uses the schemas to match actions and content to phrases people say in everyday conversation." Schemas (e.g. `.messages.sendMessage`) are how Siri AI maps natural language onto your intent parameters. Source: https://developer.apple.com/documentation/appintents/apple-intelligence-and-siri-ai

**[Apple]** Non-schema (custom) App Intents still surface across Shortcuts, Spotlight, widgets, Action button, and as **App Shortcuts** with registered phrases. Phrases must include `\(.applicationName)`. Free-text parameters on custom intents are collected by a follow-up dialog (`requestValueDialog` / `$param.requestValue(...)`), not parsed from the trigger phrase. (Session 240 §"Making actions available"; session 343 §"Customize how Siri responds".)

**[Apple]** Siri AI availability: "rolling out to users" on iPhone 15 Pro/Pro Max and all iPhone 16+ (release notes as published by 9to5Mac, 2026-09-09: https://9to5mac.com/2026/09/09/ios-27-here-are-apples-full-release-notes/). English first. A waitlist has existed in betas [Press].

**[Press]** Beta 3 testers saw Siri AI pulling live data from third-party apps (EV battery via Tessie/Ford), with a permission prompt before accessing app data: https://9to5mac.com/2026/07/07/siri-ai-can-pull-info-from-third-party-apps-in-the-latest-developer-beta/

## 2. Execution-time budget (the constraint that shapes everything)

**[Apple]** "App intents generally have 30 seconds to run on most Apple platforms (macOS has no fixed time limit). However, Siri may also enforce its own time limits on how long it'll wait for an intent's result." — Apple Frameworks Engineer, https://developer.apple.com/forums/thread/832257

**[Apple]** "When your AppIntent's perform() is called by Shortcuts, Siri or other features it will be given 30 seconds of CPU runtime." — https://developer.apple.com/forums/thread/832170

**[Apple]** `LongRunningIntent : ProgressReportingIntent` (iOS 27+) extends background execution past 30 s via `performBackgroundTask { … }`; you must update `progress` regularly or the system cancels the extension; a system-managed Live Activity shows progress. Pair with `CancellableIntent` for `.timeout` / `.userCancelled` reasons. https://developer.apple.com/documentation/appintents/longrunningintent

**[Apple]** App Intents execute **in your app's process**; `supportedModes` declares background vs foreground execution. https://developer.apple.com/forums/thread/833681

**Design consequence:** the synchronous "ask → spoken reply" path must complete in ≤ ~25 s wall clock including Siri overhead; the app should stop waiting at ~20 s and hand off. Siri's *own* cutoff is undocumented — E44 measures it empirically.

## 3. Content as a source: entities, schemas, semantic index

**[Apple]** `@AppEntity(schema: .messages.message) struct MessageEntity: IndexedEntity` with `@Property(indexingKey: \.textContent)` → indexed into the system semantic index; "Siri can search your content, reason over it, and use it to answer questions, not just retrieve items." Index with `CSSearchableIndex(name:).indexAppEntities([entity])`; support reindexing with `IndexedEntityQuery`. Keep the index fresh (add/update/delete). (Sessions 240 and 343.)

**[Apple]** "depending on the App Intents domain, indexing entities in Spotlight provides semantic search capabilities" (session 343) — i.e. semantic Q&A is tied to schema domains; non-schema `IndexedEntity` content gets Spotlight indexing but semantic reasoning is not promised. **Consequence:** model Peggy's replies as Messages-domain entities (E46); memory files as a schema-backed note/document entity (E47 — spike first).

**[Apple]** `EntityStringQuery` for data too large / server-side to index; `IntentValueQuery` for structured search inputs (e.g. `AudioSearch`); `.system.searchInApp` (renamed from `.system.search`) re-runs Siri's search string inside your app.

**[Apple]** Messages domain requires all five schemas together: `draftMessage`, `sendMessage`, `editSentMessage`, `unsendMessage`, `setMessageReadStatus`; entities `conversation`, `message`, `messagePerson`, `customAttachment`. Xcode validates the set at build time and offers Fix-Its. https://developer.apple.com/documentation/appintents/app-schema-domain-messages

**[Apple]** Responses: `ProvidesDialog` with `IntentDialog(full:supporting:)` (full text is read on voice-only devices such as AirPods); `ShowsSnippetView` for a SwiftUI snippet; `$param.requestValue("…")` for mid-intent clarifying questions. Notifications can carry `appEntityIdentifiers` so an announced notification supports "Reply …" on AirPods. (Session 343.)

**[Apple]** `AppIntentsTesting` — new framework to invoke intents in isolation in unit tests; validate progressively: AppIntentsTesting → Shortcuts app → Spotlight → Siri. (Sessions 240, 295.)

**[Apple]** iOS 27 release notes, App Intents section: entity size limit 10 MB cumulative (fixed crash); `RelevantEntities`; `@UnionValue`; `Duration` params; `IntentValueRepresentation` (Transferable) fixes; `calendar.deleteEvents` → `deleteEvent`; notes schemas gain `AttributedString` names. https://developer.apple.com/documentation/ios-ipados-release-notes/ios-ipados-27-release-notes

## 4. What is NOT available (do not design on these)

**[Press, with primary evidence]** *Siri Extensions / Model Delegation* — a developer ran Claude as a Siri Extension via a "Model Delegation API in App Intents" on iOS 27 betas; it **requires the private `com.apple.developer.model-delegation` entitlement** and the author expects public release around 27.4: https://x.com/itspdfu/status/2099122424209916015. Apple did not announce it at WWDC26; The Next Web reports the framework is present but disabled on Apple's backend: https://thenextweb.com/news/apple-siri-extensions-third-party-ai-missing-wwdc. **Not in the iOS 27 GA release notes.** → Backlog.

**[Unverified]** "Apple adopted MCP system-wide in iOS 27, making registered MCP servers callable by Siri AI" (softwareseni.com, June 2026). **Nothing** in the iOS 27 release notes, the App Intents documentation, or WWDC26 sessions 122/240/343 mentions MCP for Siri. The only Apple MCP surface found is Xcode 27 plugins ("Plugins bring skills, MCP tools, and any agent through the agent-client protocol" — Platforms State of the Union, https://developer.apple.com/videos/play/wwdc2026/122/). 9to5Mac reported in Sept 2025 that Apple was laying groundwork for MCP in App Intents in macOS 26.1 betas (https://9to5mac.com/2025/09/22/macos-tahoe-26-1-beta-1-mcp-integration/) — no public API has surfaced since. → Backlog watch item; if it ships, `agentbus` (already an MCP server) could register directly.

**[Unverified]** Blog claims of "App Intents 2.0 streaming responses" and "multi-turn conversational follow-ups" as new APIs — not found in Apple sources. Conversation continuity in our design comes from the bus (`--resume` on the Peggy session), not from Siri.

## 5. Other verified facts we rely on

- **[Apple]** iOS 27 SDK apps must include a launch screen key in `Info.plist` and must use the UIKit scene-based lifecycle (SwiftUI `App` is fine). (Release notes, UIKit section.)
- **[Apple]** Stricter TLS requirements in 27.0 apply to *system processes* (MDM, app install, updates); ATS still requires HTTPS for app networking by default. (Release notes, Network Security.) → use `tailscale serve` (Let's Encrypt cert on the MagicDNS name) or an ATS exception for a LAN-only POC.
- **[Apple]** `SpotlightSearchTool` exists for Foundation Models sessions to search the Core Spotlight index in-app (release notes, Core Spotlight) — useful later if the Peggy app ever wants on-device retrieval over indexed entities; not needed for Siri.

## 6. Mapping to the design

| Need | Mechanism | Epic |
|---|---|---|
| "Ask Peggy X" → spoken answer | Custom `AskPeggyIntent` + `AppShortcutsProvider` phrase "Ask Peggy"; `ProvidesDialog`; `supportedModes = .background` | E44/E45 |
| Fit in 30 s | Server-side wait ≤ 25 s; client stops at ~20 s; durable late-reply store; background fetch + local notification; optional `LongRunningIntent` variant | E42/E43/E45 |
| One-shot natural language ("Tell Peggy …") | Messages domain `sendMessage` with Peggy as `messagePerson` | E46 |
| Siri answers from Peggy's replies | `MessageEntity` (`.messages.message`) + `IndexedEntity` + `indexAppEntities`; transcript sync from the bus | E46 |
| Siri answers from Peggy's memory | Note/document entity + `IndexedEntity`; read-only memory export endpoint on the bus | E47 |
| "Reply" to an announced Peggy answer on AirPods | `UNMutableNotificationContent.appEntityIdentifiers` | E46 |
| Validate without Siri | `AppIntentsTesting` | E44+ |

# Siri Bridge — Product Requirements Document

**Version:** 1.0 · **Status:** Approved · **BMAD Phase:** 2 — Planning · **Parent:** `_bmad-output/planning-artifacts/PRD.md` (AgentBus PRD v1.2) · **Date:** 2026-09-14

This PRD extends the AgentBus PRD with a new bidirectional channel (`siri`) and a companion iOS app (**Peggy**). Requirement ids are stable and referenced from epics E42–E47.

---

## 1. Overview

Chris speaks to Siri; Siri runs an App Intent in the Peggy app; the app calls AgentBus over Tailscale; the bus routes the question to Peggy exactly as it would a Telegram message; Peggy's `reply` is delivered back to the waiting HTTP request; Siri speaks it. If Peggy is slow, the app hands the answer off to a notification (and optionally the bus re-delivers it on iMessage/Telegram). In Phase 3, the app also mirrors Peggy's messages and memory as App Entities so Siri AI can answer from them directly.

## 2. Personas and primary flows

### Flow F1 — Synchronous ask (MVP core)
1. "Hey Siri, ask Peggy" → Siri: "What would you like to ask Peggy?" → "what's on my calendar tomorrow". *(Or, if Siri AI fills the parameter from "Ask Peggy what's on my calendar tomorrow" in one utterance — to be verified in E44 — the prompt is skipped.)*
2. `AskPeggyIntent.perform()` → `POST /api/v1/siri/ask {text, wait_ms: 20000, request_id}`.
3. Bus: auth → envelope → pipeline → queue → Peggy (`cc-headless`) → `reply` tool → bus → `SiriAdapter.send()` resolves the waiting request.
4. App returns `IntentDialog(full: reply)`; Siri speaks it.

### Flow F2 — Late reply
1. Steps 1–3 as F1, but no reply within `wait_ms`.
2. Bus responds `{status: "pending", request_id}`; app returns dialog "Peggy's still working on it — I'll notify you when she answers." and starts a background fetch of `GET /api/v1/siri/replies/{request_id}?wait_ms=…`.
3. When Peggy replies, the bus stores it (durable) and completes the background fetch; the app posts a local notification with the reply and stores it in history.
4. Optionally (config) the bus also re-delivers the late reply on a fallback channel (iMessage/Telegram) with a deterministic wrapper.

### Flow F3 — Setup
Open the Peggy app → Settings: bus base URL (`https://mini.<tailnet>.ts.net`), Siri token, optional bus token, wait budget → "Test connection" → status shown. Tokens stored in Keychain.

### Flow F4 — History
App shows recent asks with status (answered / pending / failed) and replies; tapping a pending item polls once.

### Flow F5 — Siri AI native messaging (Phase 3)
"Send a message to Peggy asking whether the mooring invoice was paid" → Messages-domain `sendMessage` (Peggy is a `messagePerson`) → bus ask (async) → reply lands as a `MessageEntity` + notification annotated with the entity → "Reply, thanks" on AirPods works.

### Flow F6 — Peggy as a source (Phase 3)
"What did Peggy say about the boat insurance?" → Siri AI semantic search over indexed `MessageEntity`s (and memory notes) → Siri answers without calling Peggy.

---

## 3. Functional requirements

### 3.1 Bus — `siri` channel (E42 thin → E43 production)

**FR-1 Ask endpoint.** `POST /api/v1/siri/ask` accepts `{ text: string (1..2000 chars), wait_ms?: number, request_id?: uuid, client?: { device?: 'iphone'|'ipad'|'watch'|'carplay'|'mac'|'unknown', app_version?: string, locale?: string } }` and returns within `min(wait_ms, adapters.siri.reply_timeout_ms)` either `status: "answered"` with the reply body or `status: "pending"`. Response always carries `request_id`, `message_id`, and timing fields.

**FR-2 Auth is identity.** `Authorization: Bearer <token>` resolves to exactly one contact via `contacts.<id>.platforms.siri.token`. Missing/malformed/unknown token → `401`, nothing enqueued, nothing logged as a transcript. If `bus.auth_token` is set, `X-Bus-Token` is additionally required (existing global hook; layered like Pebble). Duplicate tokens across contacts are rejected at config load.

**FR-3 Pipeline integration.** The envelope is `{ channel: 'siri', sender: 'contact:<id>', topic: '' (classified), payload: {type:'text', body: text}, metadata: { source: 'siri', request_id, client, sent_at } }` submitted through `processInbound()` — no new enqueue path. Routing is via `pipeline.routes` (`match.channel: siri`). Transcripts are logged inbound (Stage 80) and outbound (DeliveryWorker) like every channel, so `search_transcripts`/`get_transcript` cover Siri conversations.

**FR-4 Reply correlation.** `SiriAdapter.send(envelope)` resolves the pending request whose inbound `message_id === envelope.reply_to` (or, if `reply_to` is null, the oldest pending request for `envelope.recipient` on channel `siri`). The **first** matching reply completes the HTTP response; any further replies for the same request are appended to the durable reply record (visible via FR-5/FR-9) and never lost.

**FR-5 Durable late replies.** Every request is persisted (`siri_requests`) at creation with status `pending`; replies update it to `answered`. `GET /api/v1/siri/replies/:request_id?wait_ms=` long-polls (server-side, capped by `reply_timeout_ms`) and returns the reply when present; the first successful retrieval marks it `claimed`. Records expire after `late_reply_ttl_ms` (default 24 h) via the existing sweeper pattern. A bus restart must not lose pending or answered records (waiters are re-hydrated from the table on startup).

**FR-6 Fallback delivery (optional, deterministic).** If `adapters.siri.fallback` is configured, a reply that arrives **after** its request timed out is additionally enqueued as an *outbound* envelope to `fallback.channel` for the same contact, body rendered from `fallback.template` (`{{body}}`, `{{question}}`), sender = the replying agent. No LLM, no re-routing to an agent.

**FR-7 Duplicate join.** If `processInbound` reports `queued:false, reason:'duplicate'` and an in-flight request exists for the same contact + text, the new call attaches to that request (same `request_id` returned); otherwise `409 { reason: 'duplicate' }`.

**FR-8 Rate limit.** Per token: default 20 asks/min and 4 in flight; excess → `429`. Configurable.

**FR-9 History.** `GET /api/v1/siri/requests?limit=&since=` returns the caller's recent requests with status, question, reply body, timestamps (auth-scoped to the token's contact).

**FR-10 Reachability.** `GET /api/v1/siri/health` (bearer-authenticated) returns `{ ok, routed: boolean, agent: 'agent:peggy', adapters: { 'cc-headless': 'online'|… } }` so the app can show "Connected to Peggy" without running a turn.

**FR-11 Observability.** Each request logs `[siri] request_id=… contact=… queued_ms=… answered_ms=…|timeout` and the response includes `timing: { received_at, queued_at, answered_at?, queued_ms, answered_ms? }`. `GET /api/v1/siri/requests` doubles as the latency dataset.

**FR-12 Peggy prompt contract.** The `cc-headless` `system_prompt` gains a `siri*` branch (operator config, template shipped in docs): exactly one `reply`, ≤ 60 words, plain spoken prose (no markdown, bullets, links, emoji), answer first; if the task is long, say what is known now and that a fuller answer will follow on iMessage. This is a config/doc deliverable, not code.

**FR-13 Fast lane (optional).** Documented config for a dedicated `cc-headless` instance `peggy-siri` (`agent_id: peggy-siri`, same `working_dir`, `model` set to a fast model, `journal_lookback_days: 1`, `journaling.enabled: false`) with the `siri` route pointed at it. Enabled only if Gate 0/1 requires it.

**FR-14 Tool-status (Phase 3, optional).** `SiriAdapter.reportToolCall` appends status lines to the in-flight request record; exposed on `GET /api/v1/siri/requests/:id` for a Live Activity / progress UI.

### 3.2 iOS — Peggy app (E44 POC → E45 MVP)

**FR-20 App Intent.** `AskPeggyIntent: AppIntent` with `@Parameter var question: String` (requestValueDialog "What would you like to ask Peggy?"), `supportedModes = .background` (never opens the app), `ProvidesDialog`. Outcomes → dialog text:
- answered → the reply body verbatim (full) / same (supporting);
- pending → "Peggy's still working on it — I'll notify you when she answers.";
- unauthorized → "Peggy rejected the token. Open the Peggy app to fix the setup.";
- unreachable/timeout at transport → "I can't reach Peggy right now. Check that Tailscale is connected.";
- not configured → "Open the Peggy app to set up the connection first.".

**FR-21 App Shortcuts.** `AppShortcutsProvider` registers phrases: "Ask \(.applicationName)", "Ask \(.applicationName) a question", "Talk to \(.applicationName)", short title "Ask Peggy", SF Symbol `bubble.left.and.text.bubble.right`. Phrases update via `AppShortcuts.updateAppShortcutParameters()` on launch.

**FR-22 Wait budget.** The intent waits at most `waitBudget` (default 20 s, settable 5–25 s) for `POST /ask`; transport timeouts: connect 5 s, request = waitBudget + 3 s.

**FR-23 Settings & secrets.** Base URL and wait budget in `UserDefaults`; Siri token and bus token in Keychain (`kSecAttrAccessibleAfterFirstUnlock` so background intents can read them). "Test connection" calls FR-10.

**FR-24 Late-reply hand-off.** On `pending`, the intent registers a background `URLSession` download task to `GET /api/v1/siri/replies/:id?wait_ms=90000`; on completion (even if the app was suspended) the app posts a local notification titled "Peggy" with the reply and updates history. Notification permission is requested in-app during setup.

**FR-25 History.** SwiftData store of asks (id, question, reply, status, timestamps); list view; pull-to-refresh calls FR-9.

**FR-26 Build/test tooling.** XcodeGen `project.yml`; `Peggy` + `PeggyTests` targets; `AppIntentsTesting` tests for every dialog outcome with a mocked bus client; `xcodebuild` commands documented in `apps/ios/Peggy/CLAUDE.md`.

**FR-27 Long-running variant (spike).** `AskPeggyLongIntent: LongRunningIntent` that keeps waiting up to 120 s with progress ("Peggy is thinking…") and posts the notification itself. Evaluated in E45; kept only if it improves the hand-off UX over FR-24.

### 3.3 Phase 3 — Peggy as a source (E46, E47)

**FR-30 Messages domain.** Entities: `PeggyPersonEntity` (`.messages.messagePerson`, exactly one: Peggy), `ConversationEntity` (`.messages.conversation`, one per bus channel/topic), `MessageEntity` (`.messages.message`, `IndexedEntity` with `textContent` indexing). Intents: `sendMessage` (→ bus ask, async, returns the sent `MessageEntity`; adds `ProvidesDialog` and, if the reply arrives within budget, speaks it), `draftMessage` (opens compose UI), `editSentMessage` / `unsendMessage` (unsupported → user-facing error dialog), `setMessageReadStatus` (local).

**FR-31 Transcript sync.** App pulls Siri-channel (and, opt-in, other-channel) transcripts from `GET /api/v1/sessions` + `GET /api/v1/sessions/:id/transcript` into SwiftData and indexes `MessageEntity`s with `CSSearchableIndex.indexAppEntities`; supports `IndexedEntityQuery` reindex; deletes on removal.

**FR-32 Reply notifications with entity ids.** Late/async replies post notifications with `appEntityIdentifiers = [MessageEntity id]` so AirPods "Reply …" routes to `sendMessage`.

**FR-33 Push (optional).** Bus-side APNs provider (token-based `.p8`) to wake the app for new Peggy messages; otherwise BGAppRefresh + fetch-on-foreground.

**FR-34 Memory export.** `GET /api/v1/agents/:agent_id/memory` (bearer-authenticated, read-only) lists and returns the agent's memory index + recent daily journals + topic files as text with content hashes; the app mirrors them as indexed note entities. Spike first: confirm Siri AI answers questions over them.

---

## 4. Non-functional requirements

| Id | Requirement | Target |
|---|---|---|
| NFR-1 | End-to-end spoken-answer latency (Siri hands us the text → HTTP answered) | p50 ≤ 12 s, p95 ≤ 25 s |
| NFR-2 | Bus overhead (ask received → enqueued; reply posted → HTTP resolved) | ≤ 50 ms each |
| NFR-3 | Late-reply delivery | 100 % within 2 min of Peggy replying |
| NFR-4 | Durability | Bus restart loses no pending/answered request |
| NFR-5 | Security | HTTPS only; per-contact bearer; tokens in Keychain; endpoint exposed only on the tailnet; rate-limited |
| NFR-6 | Privacy | No question/answer text in bus logs beyond a 60-char preview (existing convention); notifications respect a "hide preview on lock screen" toggle |
| NFR-7 | Compatibility | iOS 27+, iPhone 15 Pro+ for Siri AI (classic Siri App Shortcut path works on any iOS 27 device) |
| NFR-8 | Testability | Bus: vitest coverage for auth, correlation, timeout, late reply, duplicate join, fallback, restart re-hydration. iOS: AppIntentsTesting for all dialog outcomes; BusClient tests with URLProtocol stubs |
| NFR-9 | Docs | `docs/SIRI_ADAPTER.md`, HTTP_API.md, DEPLOYMENT.md (tailscale serve), CC_HEADLESS_ADAPTER.md (siri prompt), CHANGELOG |
| NFR-10 | Principles | No LLM call in bus-core; routing explicit in config; adapter does protocol translation only |

---

## 5. Configuration surface (bus)

```yaml
adapters:
  siri:
    enabled: true
    reply_timeout_ms: 25000        # server-side cap for POST /ask and GET /replies waits
    late_reply_ttl_ms: 86400000    # 24 h retention of request/reply records
    max_body_bytes: 8192
    rate_limit: { per_minute: 20, max_in_flight: 4 }
    fallback:                      # optional
      channel: bluebubbles         # any channel with a registered adapter
      template: "Re your Siri question \"{{question}}\":\n{{body}}"
    debug_delay_ms: 0              # E44 only: artificial delay before responding (Siri cutoff measurement); must be 0 in prod

contacts:
  chris:
    platforms:
      siri:
        token: ${SIRI_TOKEN_CHRIS}

pipeline:
  routes:
    - match: { channel: siri }
      target: { adapterId: cc-headless, recipientId: agent:peggy }   # or agent:peggy-siri (FR-13)
```

## 6. API surface (bus) — summary; full contract in `architecture.md` §4

| Route | Purpose |
|---|---|
| `POST /api/v1/siri/ask` | Submit question; wait ≤ `wait_ms` for reply |
| `GET /api/v1/siri/replies/:request_id` | Long-poll a late reply; claims it |
| `GET /api/v1/siri/requests` | History / latency dataset |
| `GET /api/v1/siri/requests/:request_id` | One request incl. status lines (Phase 3) |
| `GET /api/v1/siri/health` | Reachability + routing check |
| `GET /api/v1/agents/:agent_id/memory` | Phase 3 memory export |

## 7. Acceptance criteria by phase

- **POC-1 done:** `npx tsx scripts/siri-probe.ts --n 20` prints p50/p95 and per-ask timings against the live bus; numbers recorded in `spike-results.md`; Gate 1 decision written.
- **POC-2 done:** On Chris's iPhone, "Hey Siri, ask Peggy" → question → Peggy's spoken reply, hands-free, with the app not in the foreground; Siri cutoff measured; Siri AI one-shot phrasing tested; results in `spike-results.md`.
- **MVP done:** all FR-1..FR-13, FR-20..FR-26 met; NFR-1..NFR-10 met; 7-day soak log shows ≥ 95 % answered-or-handed-off; docs and CHANGELOG updated; version bump proposed (MINOR).
- **Phase 3 done:** FR-30..FR-32 (+FR-33/34 as scoped); five recall questions answered by Siri AI from indexed content.

## 8. Out of scope

Siri Extensions/Model Delegation; watchOS/macOS apps; multi-user; streaming dialog; bus-side LLM; App Store distribution (TestFlight/personal signing only).

## 9. Open questions (resolved by spikes)

1. Siri's real maximum wait for an intent result (E44, `debug_delay_ms`).
2. Whether Siri AI fills `AskPeggyIntent.question` from "Ask Peggy X" in one utterance (E44).
3. Whether non-schema `IndexedEntity` notes get semantic Q&A, or only Messages-domain entities do (E47 spike).
4. Whether `LongRunningIntent` improves the late-reply UX vs background `URLSession` (E45 spike).
5. Whether a dedicated `peggy-siri` instance is needed (Gate 0/1 data).

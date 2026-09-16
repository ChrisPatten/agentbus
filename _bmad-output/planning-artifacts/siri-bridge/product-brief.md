# Siri Bridge — Product Brief

**Version:** 1.0 · **Status:** Approved for planning · **BMAD Phase:** 1 — Analysis · **Date:** 2026-09-14

---

## 1. Problem

Peggy (Chris's personal assistant agent, running headless in Claude Code behind AgentBus) is reachable from Telegram, iMessage, email, and the Pebble ring — but not from the interface Chris uses hands-free the most: Siri. iOS 27 ships today with a rebuilt Siri ("Siri AI") that is explicitly designed to pull content and actions from third-party apps through App Intents. There is no path today for "Hey Siri, ask Peggy …" to reach the bus, and no way for Siri to treat what Peggy knows as personal context.

## 2. Vision

> From any Apple surface with Siri (iPhone, AirPods, CarPlay, Watch later), Chris can ask Peggy a question and hear her answer — and Siri itself can answer questions from what Peggy has said and remembers, without a round trip.

Two distinct capabilities, delivered in order:

1. **Live channel (POC → MVP):** Siri → Peggy → spoken answer, in one breath, within Siri's execution budget.
2. **Peggy as a source (Phase 3):** Peggy's replies and memory are indexed on-device as App Entities so Siri AI's personal-context search ("what did Peggy say about the boat insurance?") is answered by Siri directly.

## 3. What we learned about the platform (summary — full detail in `research-ios27-siri.md`)

| Fact | Consequence for us |
|---|---|
| App Intents are **the only supported way** Siri reaches a third-party app in iOS 27; SiriKit is deprecated. | We build App Intents, nothing else. |
| An App Intent's `perform()` gets **~30 s**; Siri may impose a shorter wait of its own. iOS 27 adds `LongRunningIntent` for >30 s background work with a system Live Activity — but Siri won't keep listening that long. | The sync path must finish in ≤ ~25 s end-to-end. Anything slower must degrade gracefully to a notification. **This is the #1 feasibility risk and is measured first.** |
| Siri AI fills intent parameters from natural language **for schema intents** (e.g. Messages domain `sendMessage`: "Send a message to Peggy asking what time the party starts"). Custom App Shortcuts are triggered by their registered phrases, and a free-text `String` parameter is captured through a follow-up prompt. | MVP uses a custom `AskPeggyIntent` (fast to build, works with classic Siri and Siri AI). Phase 3 adopts the Messages domain so "Tell/Ask Peggy …" is one natural utterance. |
| `IndexedEntity` + `CSSearchableIndex.indexAppEntities` puts entities in the **semantic index**; Siri AI can "answer questions over your content" for indexed, schema-conforming entities. | This is the mechanism for "Peggy as a source" — no LLM call to Peggy needed for recall. |
| **Siri Extensions / Model Delegation** (third-party model in Siri's "Ask…" menu) exists in iOS 27 but requires a private entitlement and is not in the GA release notes. | Out of scope. Backlog. |
| **MCP support in iOS 27** is claimed by some secondary sources but appears nowhere in Apple's iOS 27 release notes or WWDC26 sessions. | Not planned on. Backlog watch item. |

## 4. Goals and success metrics

| Goal | Metric | Target |
|---|---|---|
| G1 — Spoken answers via Siri | End-to-end latency from Siri handing us the question to Siri starting to speak the reply, p50 / p95, over 20 mixed asks | p50 ≤ 12 s, p95 ≤ 25 s |
| G2 — No lost answers | Asks that time out still deliver Peggy's reply (notification and/or fallback channel) | 100 % of late replies delivered within 2 min |
| G3 — Reliability | Successful asks (answered or cleanly handed off) over a 7-day daily-use period | ≥ 95 % |
| G4 — Setup once | Token/URL configured once in the app; no re-auth in normal use | Zero re-setups in 7 days |
| G5 — Peggy as a source (Phase 3) | Siri AI answers a question from indexed Peggy messages without invoking the live channel | Demonstrated for ≥ 5 recall questions |

## 5. Users

- **Chris** — sole operator. Uses Siri hands-free (AirPods, car). Wants Peggy's answer spoken, short, and correct; wants long answers to land somewhere he can read later.
- **Peggy** — the agent. Gets a new channel (`siri`) with a "spoken, single reply" contract expressed in her system prompt. Needs nothing else to change.
- **AgentBus** — stays a deterministic courier. The new adapter translates protocol only.

## 6. Scope by phase

| Phase | Epic(s) | Deliverable | Gate to pass |
|---|---|---|---|
| **Gate 0** (no code) | — | Prereqs verified; **historical Peggy turn latency** computed from `transcripts` | p50 historical turn ≤ 20 s or a fast-lane plan |
| **POC-1** | E42 | Thin `siri` channel on the bus + `scripts/siri-probe.ts` latency harness; numbers in `spike-results.md` | p50 ≤ 12 s, p95 ≤ 25 s over 20 asks |
| **POC-2** | E44 | iOS app with `AskPeggyIntent`; on a real iPhone, "Ask Peggy" → spoken Peggy reply | Works on device; Siri's real wait limit measured; Siri AI natural-language trigger tested |
| **MVP** | E43 + E45 | Production adapter (durable late replies, fallback, dedup join, rate limit, docs, tests) + hardened app (Keychain, settings, background late-reply fetch → local notification, error dialogs, AppIntentsTesting suite, TestFlight) | 7-day soak meets G1–G4 |
| **Phase 3** | E46, E47 | Messages-domain adoption (Peggy as a contact; semantic index of her replies; notifications with entity annotations); memory files indexed as notes | G5 |

## 7. Non-goals (this initiative)

- Replacing Siri's model with Peggy (Siri Extensions / Model Delegation) — not publicly available.
- Multi-user support — single operator; tokens are per contact by construction but only Chris is configured.
- watchOS / macOS targets — after MVP (backlog).
- Streaming spoken responses — App Intents return one dialog; no token streaming to Siri.
- Any LLM call inside bus-core — forbidden by AgentBus principles; all generation stays in Peggy.

## 8. Fail-fast gates (the whole point of the sequencing)

| Gate | Question it answers | Pass | Fail → pivot |
|---|---|---|---|
| **0** | Is Peggy fast enough *today* to ever fit a Siri turn? | Historical p50 ≤ 20 s (SQL in E42) | Do the fast-lane experiment (dedicated `peggy-siri` cc-headless instance, faster model, trimmed memory) **before** any iOS code. If still > 25 s p95 → MVP becomes async-first (Siri confirms, answer arrives as a notification / iMessage); the synchronous spoken answer is dropped from MVP scope. |
| **1** | Does the bus path (HTTP → pipeline → Peggy → reply → HTTP) meet the budget? | p50 ≤ 12 s, p95 ≤ 25 s over 20 probe asks | Tune (poll intervals, fast lane). If tuning fails → async-first MVP as above. |
| **2** | Does Siri actually speak the reply on device, and how long will Siri wait? | Spoken reply for a trivial ask; measured Siri cutoff ≥ 20 s | If Siri's own cutoff is < 15 s → shorten `wait_ms`, promote background hand-off to the primary UX, and pull E46's Messages-domain flow (fire-and-forget send + reply notification) forward. |
| **3** | Is it reliable in daily use? | 7-day soak ≥ 95 % | Fix top failure class before Phase 3. |

## 9. Decisions already made (see README table; ADRs in architecture §16)

Channel id `siri`; full adapter in-process; sync long-poll with durable late-reply store; Peggy answers via existing routing; app named **Peggy**; iOS 27 minimum; monorepo `apps/ios/Peggy`; Tailscale `serve` path-scoped HTTPS; custom intent for MVP, Messages domain for Phase 3; Extensions out of scope.

## 10. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Peggy's cold-start + tool use exceeds Siri budget | High | High | Gate 0/1 measurement; fast-lane instance; async hand-off is always available |
| Siri's own wait limit is shorter than 30 s (undocumented) | Medium | High | Measure in E44 with a config-gated artificial delay; make `wait_ms` a client setting |
| Custom intent's two-step "What would you like to ask?" is annoying | Medium | Medium | Test whether Siri AI fills the parameter from "Ask Peggy X" in one shot; otherwise E46 Messages domain gives one-shot NL |
| Per-contact serialization in cc-headless makes a Siri ask wait behind an in-flight Telegram turn | Medium | Medium | Fast-lane instance has its own queue; or per-conversation queue keying (E45 option) |
| Tailscale VPN not up on the phone when Siri fires (cellular) | Medium | Medium | Tailscale on-demand; clear "can't reach Peggy" dialog; Cloudflare Tunnel as an alternative exposure path (backlog) |
| Duplicate asks dropped by pipeline dedup (same text within 30 s) | Low | Medium | Ask endpoint joins the in-flight request instead of failing |
| App Store / signing friction | Low | Low | Personal device via Xcode signing; TestFlight later |

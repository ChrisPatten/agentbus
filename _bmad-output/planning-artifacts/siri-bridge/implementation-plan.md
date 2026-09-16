# Siri Bridge — Implementation Plan (sequencing, POC, MVP, gates)

**Version:** 1.0 · **Date:** 2026-09-14 · **Principle:** fail fast — every step before MVP exists to kill or confirm the synchronous spoken-answer design with real numbers, before the expensive parts (iOS polish, Messages domain) are built.

---

## 1. The one question that decides the design

> Can Peggy answer through the bus inside Siri's execution budget often enough to be worth a spoken interface?

Everything else is engineering. So the sequence front-loads measurement:

```
Gate 0  (hours)   — historical data from the DB you already have
E42     (1–2 eve) — thin bus channel + probe → real end-to-end numbers          → Gate 1
E44     (2–3 eve) — minimal iOS intent on a real phone → Siri behaviour numbers → Gate 2
E43+E45 (1–2 wk)  — production adapter + hardened app → 7-day soak             → Gate 3 (MVP)
E46     (2 wk)    — Messages domain + semantic index ("Peggy as a source")
E47     (1 wk)    — memory files as a source (spike-gated)
```

"eve" = an evening of focused agent-assisted work. Estimates assume Chris drives an agent; they are for sequencing, not commitments.

---

## 2. Gate 0 — before writing any code (E42 story S42.1)

Prerequisites checklist:
- [ ] iPhone 15 Pro or newer on iOS 27.0 GA with Siri AI enabled in Settings → Apple Intelligence & Siri.
- [ ] Xcode 27 installed on the Mac that will build the app (Mac mini or laptop); Apple Developer account with a team id (free account is enough for on-device testing; paid for TestFlight).
- [ ] Tailscale on the iPhone (Connect on demand on) and on the Mac mini; `tailscale serve` available.
- [ ] `agentbus` on `main` at ≥ 0.11.0; Peggy running via `cc-headless`; `transcripts` has outbound rows (E31 shipped 2026-08-31).

Historical latency (run against a copy of `data/agentbus.db`):

```sql
-- Per inbound message: time to the first outbound reply in the same conversation.
WITH inbound AS (
  SELECT id, conversation_id, created_at FROM transcripts
  WHERE direction = 'inbound' AND channel LIKE 'telegram%' AND created_at >= datetime('now', '-14 days')
),
paired AS (
  SELECT i.id, i.created_at AS asked_at,
         (SELECT MIN(o.created_at) FROM transcripts o
            WHERE o.conversation_id = i.conversation_id AND o.direction = 'outbound' AND o.created_at > i.created_at) AS answered_at
  FROM inbound i
)
SELECT COUNT(*) AS n,
       ROUND(AVG((julianday(answered_at) - julianday(asked_at)) * 86400), 1) AS mean_s,
       ROUND(MAX((julianday(answered_at) - julianday(asked_at)) * 86400), 1) AS max_s
FROM paired WHERE answered_at IS NOT NULL
  AND (julianday(answered_at) - julianday(asked_at)) * 86400 < 600;   -- ignore replies > 10 min (not a "turn")
-- For percentiles, dump the per-row seconds and compute p50/p95 in the probe script or a spreadsheet.
```

Caveat: this includes Telegram delivery time and Peggy's habit of interim messages; it is an upper bound on "time to first reply", which is exactly what Siri would speak.

**Gate 0 decision:**
- p50 ≤ 20 s → proceed to E42 with the existing Peggy instance.
- p50 > 20 s → E42 must include the fast-lane instance (`peggy-siri`, fast model, `journal_lookback_days: 1`) as its primary configuration, and the probe compares both.
- p50 > 40 s even with a plausible fast lane → **stop**: MVP becomes async-first (Siri confirms "Sent to Peggy", answer arrives as a notification / iMessage). Skip E45's sync polish; go E43 (durable store + fallback) → E46 (sendMessage flow) directly.

---

## 3. POC-1 — E42: thin `siri` channel + latency probe

**Definition:** the smallest bus change that lets an HTTP client ask Peggy a question and receive her first reply on the same connection, plus a script that measures it 20× against the live bus. Throwaway quality is acceptable *only* if it is behind `adapters.siri.enabled` and does not touch existing routes; the clean parts are kept for E43.

**Scope (in):** config keys (`enabled`, `reply_timeout_ms`, contact token), `SiriAdapter` with in-memory waiters, `POST /api/v1/siri/ask`, `pipeline.routes` entry, Peggy prompt paragraph, `scripts/siri-probe.ts`, numbers in `spike-results.md`.
**Scope (out):** durable table, late replies, fallback, rate limiting, dedup join, docs beyond a stub, iOS.

**Gate 1 (numeric):** over 20 probe asks — 8 trivial ("what day is it"), 8 memory ("what did we decide about the boat mooring"), 4 tool-using ("what's on my calendar tomorrow"):
- p50 `answered_ms` ≤ 12 000 **and** p95 ≤ 25 000 **and** timeouts ≤ 1/20 → **pass**, go to E44.
- Fail → try in order, re-measuring each: `poll_interval_ms: 250`; fast-lane instance; prompt tightened ("answer from memory before using tools"). Record every run.
- Still failing after tuning → pivot: async-first MVP (see Gate 0), but still do E44 because the iOS plumbing is the same; the intent just always returns "Sent to Peggy".

---

## 4. POC-2 — E44: `Ask Peggy` on a real iPhone

**Definition:** an installable Peggy app with `AskPeggyIntent` + App Shortcut, Settings (URL/token), and nothing else, proving Siri → bus → Peggy → spoken reply on device.

**Gate 2 (empirical, all recorded):**
1. "Hey Siri, ask Peggy" → prompt → question → spoken reply, app in background, screen locked: **works / doesn't**.
2. Siri AI one-shot: "Ask Peggy what day it is" without the follow-up prompt: **works / doesn't** (decides whether E46 is UX-critical or nice-to-have).
3. Cutoff sweep with `debug_delay_ms` ∈ {10, 15, 20, 25, 30} s: the largest value at which Siri still speaks the reply = **Siri cutoff**. Set the app's default `waitBudget` to cutoff − 3 s (floor 8 s).
4. Surfaces: AirPods (voice-only, `full` dialog), CarPlay, Lock Screen — each works / doesn't.
5. Total Siri overhead (Siri hand-off → intent start, and dialog return → speech start) measured with timestamps in the app log.

Pass = (1) works and cutoff ≥ 15 s. If cutoff < 15 s → the hand-off UX (background fetch + notification) becomes the *primary* experience and E45 prioritises it; the sync path stays for trivial questions.

---

## 5. MVP — E43 (bus, production) + E45 (app, hardening)

**MVP definition (what "done" means):**
- Chris can ask Peggy anything by voice from iPhone/AirPods/CarPlay and hear the answer when it arrives within budget.
- When it doesn't, nothing is lost: the answer arrives as a local notification (and optionally on iMessage), and shows in the app history.
- The bus survives restarts without losing requests; duplicates and rate spikes are handled; endpoints are documented and tested; the app has a settings screen, Keychain storage, and an AppIntentsTesting suite; installed via TestFlight or Xcode signing.
- A 7-day soak (`GET /api/v1/siri/requests` dataset) shows ≥ 95 % answered-or-handed-off and p50/p95 within NFR-1.

**Order inside MVP:** E43 first (the app POC already talks to the thin endpoint; E43 keeps the contract), then E45. The E45 stories are sequenced so the app is always installable at the end of each story.

**Gate 3:** soak numbers in `spike-results.md`; version bump proposal (MINOR) per `CLAUDE.md`.

---

## 6. Phase 3 — E46, E47 ("Peggy as a source")

- E46 first: Messages domain (Peggy as a contact), transcript sync, semantic index of Peggy's replies, notifications with entity ids, `sendMessage` → ask. Gate: five recall questions answered by Siri AI from indexed messages; one-shot "Tell Peggy …" works.
- E47 (spike-gated): memory export endpoint + note entities; only continue past the spike if Siri AI answers from them.

---

## 7. Dependency graph

```
S42.1 (Gate 0) ─▶ S42.2 config ─▶ S42.3 adapter+route ─▶ S42.4 prompt+route config ─▶ S42.5 probe ─▶ Gate 1
                                                                                            │
E44: S44.1 SDK verification ─▶ S44.2 project ─▶ S44.3 intent+shortcut ─▶ S44.4 settings ─▶ S44.5 device tests ─▶ Gate 2
                                                                                            │
E43: S43.1 schema ─▶ S43.2 migration+durable store ─▶ S43.3 late replies+GET ─▶ S43.4 dedup join+rate limit ─▶ S43.5 fallback ─▶ S43.6 health/history ─▶ S43.7 docs/tests
E45: S45.1 Keychain+settings ─▶ S45.2 hand-off+notifications ─▶ S45.3 history ─▶ S45.4 tests ─▶ S45.5 delivery_poll_ms + /status ─▶ S45.6 LongRunningIntent spike ─▶ S45.7 soak+TestFlight ─▶ Gate 3
                                                                                            │
E46: S46.1 entities ─▶ S46.2 five schema intents ─▶ S46.3 sync ─▶ S46.4 index ─▶ S46.5 notifications ─▶ S46.6 (opt) APNs ─▶ S46.7 validation
E47: S47.1 memory endpoint ─▶ S47.2 note entities spike ─▶ S47.3 (if pass) index+refresh
```

---

## 8. Definition of "fail fast" applied

- No iOS code before bus numbers exist (E42 before E44).
- No Messages domain before a spoken answer works (E46 after MVP).
- Every spike writes numbers to `spike-results.md`; a gate without numbers is not passed.
- Pivots are pre-decided (async-first; fast lane) so a failed gate costs a config change, not a redesign.

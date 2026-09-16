# Siri Bridge — Start Here

**Initiative:** Connect AgentBus to Siri on iOS 27 so Siri can reach Peggy (and, later, use Peggy's knowledge as a source).
**Status:** Planning complete — ready for BMAD implementation, starting at Gate 0 / E42.
**Owner:** Chris. **Executor:** a Claude Code agent working in this repo (bus) and in `apps/ios/Peggy` (iOS).
**Date:** 2026-09-14 (iOS 27 GA day).

This folder is a self-contained BMAD planning package. Everything an agent needs to start work is here or referenced by path. Nothing in this folder is implementation — it is the spec the implementation is measured against.

---

## Artifact map (read in this order)

| # | File | What it is | Read when |
|---|------|------------|-----------|
| 1 | `product-brief.md` | Why, goals, success metrics, phases, decisions already made, fail-fast gates | Always, first |
| 2 | `research-ios27-siri.md` | Verified facts about iOS 27 / Siri AI / App Intents with sources, and what is *not* available (MCP, Siri Extensions) | Before any iOS story; when tempted to "just use X" |
| 3 | `PRD.md` | Functional + non-functional requirements (FR-/NFR- ids), flows, config/API surface, phase acceptance criteria | Before writing any story |
| 4 | `architecture.md` | End-to-end design: bus `siri` adapter, HTTP contract, DB migration, config schema, iOS app structure with Swift reference code, latency budget, security, testing, ADRs | Before E43+ implementation; the source of truth for specifics |
| 5 | `implementation-plan.md` | Sequencing, POC-1 / POC-2 / MVP definitions, gates and kill criteria, estimates | Before starting each epic |
| 6 | `spike-results.md` | Template the agent **fills in** during E42/E44 with measured numbers and gate decisions | During spikes |
| 7 | `../../epics/E42…E47-*.md` | Formal epics with stories + acceptance criteria (repo convention, same shape as E25) | When implementing |
| 8 | `sprint-status-additions.yaml` | Snippet to merge into root `sprint-status.yaml` | When starting E42 |
| 9 | `backlog-additions.md` | Entries to append to `_bmad-output/backlog.md` | When starting E42 |

---

## Epic sequence (summary)

```
Gate 0 ─▶ E42 (bus spike: thin `siri` channel + latency probe) ─▶ Gate 1
      ─▶ E44 (iOS POC: `Ask Peggy` App Intent on device)        ─▶ Gate 2
      ─▶ E43 (production `siri` adapter) + E45 (MVP hardening)  ─▶ MVP
      ─▶ E46 (Peggy as a Siri AI source: Messages domain + semantic index)
      ─▶ E47 (Peggy's memory as a source)
```

Gates are **kill/pivot points**, not ceremonies. Each has a numeric criterion in `implementation-plan.md`. Do not start the next epic until the gate result is written into `spike-results.md`.

---

## How to execute with an agent

1. Merge `sprint-status-additions.yaml` into `sprint-status.yaml` and append `backlog-additions.md` to `_bmad-output/backlog.md`. Set `current_epic: E42`.
2. For each epic, in order: read `product-brief.md` → `PRD.md` (relevant FRs) → `architecture.md` (relevant sections) → the epic file. Implement story by story. Every story's ACs are the definition of done.
3. Repo rules still apply (`CLAUDE.md`): `.js` import extensions, docs updated in the same change, `CHANGELOG.md` `[Unreleased]` bullets, `npx tsc --noEmit` + `npx vitest run` for app-code changes, never bump versions without approval.
4. iOS work lives in `apps/ios/Peggy/` (see `architecture.md` §12). The iOS project is generated with XcodeGen from a committed `project.yml`; build/test with `xcodebuild` from the Mac. Add an `apps/ios/Peggy/CLAUDE.md` in E44 (template in the epic).
5. Record every measurement and every gate decision in `spike-results.md`. If a gate fails, follow the pivot listed for that gate — do not improvise a new architecture mid-epic.

---

## Fixed decisions (do not re-litigate inside stories)

| Decision | Value | Rationale (details in product-brief / ADRs) |
|---|---|---|
| Bus channel id | `siri` | Single channel; identity comes from a per-contact bearer token (E25 pattern) |
| Bus adapter type | Full `AdapterInstance` (`src/adapters/siri.ts`), in-process | Needs `send()` to complete waiting HTTP requests — unlike Pebble it is bidirectional |
| Request/response model | Synchronous long-poll `POST /api/v1/siri/ask` with server-side wait, plus durable late-reply store | Siri gives an App Intent ~30 s; we hold the HTTP request open for ≤ 25 s and hand off if the reply is late |
| Which agent answers | Existing `cc-headless` Peggy instance via `pipeline.routes` (`channel: siri` → `agent:peggy`); an optional dedicated `peggy-siri` fast-lane instance is a **tuning option gated on measured latency**, not the default | Deterministic routing; no LLM in the bus core |
| iOS app name | **Peggy** (bundle id `com.chrispatten.peggy`, adjust if taken) | App Shortcut phrases must contain `\(.applicationName)`; "Ask Peggy" must literally be the phrase |
| iOS minimum | iOS 27, Swift 6, SwiftUI, App Intents | Siri AI features (schemas, IndexedEntity Q&A, LongRunningIntent) are 27+ |
| Where the iOS code lives | `apps/ios/Peggy/` in this repo (monorepo) | One place for the agent, shared sprint-status; can be split out later |
| Network path | Tailscale + `tailscale serve` HTTPS on the Mac mini, path-scoped to `/api/v1/siri` | Already the network boundary for AgentBus; valid TLS for ATS with zero cert work |
| Free-text capture (MVP) | Custom `AskPeggyIntent` with a `String` parameter (Siri prompts for the question if not captured) | Only schema intents get natural-language parameter filling from Siri AI; the Messages domain (E46) removes the two-step prompt |
| Siri Extensions / Model Delegation | Out of scope (private entitlement) | Tracked in backlog; revisit when Apple opens it |

---

## Naming used everywhere

- **Siri Bridge** — the initiative (bus + app).
- **`siri` channel / `SiriAdapter`** — the AgentBus side.
- **Peggy app** — the iOS app; **`AskPeggyIntent`** — the App Intent.
- **request** — one Siri ask; `request_id` (client idempotency key, UUID) and `message_id` (bus inbound envelope id) are both kept.

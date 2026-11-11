# Intercom V1 — Milestones (draft 1)

Nov 7, 2026. For tweaking here before anything goes on the Trello board. No dates; each milestone has an outcome and a test that says it is done. Built in a fresh repo, planned from scratch (no reuse of old epics). Agentbus serves as a prototyping ground for concepts and keeps running Peggy, Baxter and the Compact until cutover. Opinions are marked *Peggy's view*.

## How the work is organised

- **Two tracks.** The *build track* is the new repo (M0 onward). The *prototype track* (P) tries concepts in agentbus first, cheaply, and hands findings to the build track. A concept is prototyped only when we are unsure how it should work.
- **Walking skeleton first.** A thin path from the Mac app to a harness and back, then widen. Each milestone leaves something that runs.
- **Test for every milestone** is a thing a person can do, not a list of tasks.

## Prototype track (in agentbus)

- **P1 Automatic session and topic management.** The user never sees sessions; Intercom chooses, resumes, rotates and repairs them. Prototype the rules (when a message starts a new conversation, how a session is assigned and recovered) before M2.
- **P2 INTERCOM.md and context delivery.** A managed instruction file referenced from `AGENTS.md`/`CLAUDE.md`, carrying `recent.md`, plus block-level re-injection. Check what Claude Code, Codex and opencode each do with it.
- **P3 Approval and question routing to the originating conversation** (your Nov 3 backlog note). Informs M3.
- **P4 Skill auto-install and update** across harnesses (format and location differ). Informs M6.

## Build track

**M0 — Foundations.** Create the repo and decide the things everything else hangs from, recorded as short decision notes: implementation stack (Swift/SwiftUI app with a separate core daemon, or another split), vocabulary, the conversation model, the envelope and addressing rules (an undeliverable address is rejected, never silently accepted), the harness interface (required tier: messages plus MCP tools; optional tier: hooks), and the protocol and capability model for surfaces.
*Done when:* the decision notes exist and a new person could read them and state the model in one paragraph.

**M1 — Walking skeleton.** One conversation, end to end: type in the Mac app, a Claude Code harness replies, the exchange is stored, restart the app and it is still there. Required tier only; set-up by hand.
*Done when:* a message round-trips, and a forced harness crash is repaired without the user doing anything.

**M2 — Conversations and short-term memory.** The conversation as the only user-visible unit. Automatic session management from P1. Transcripts and search. `INTERCOM.md`, `recent.md`, `share_context` and block re-injection from P2. Journaling triggers calling the harness as invisible background turns.
*Done when:* a fact told in one conversation shows up in another conversation's context without the user doing anything, and the user never sees the words session or compaction.

**M3 — Interaction primitives.** Ask, choose, approve, notify and status defined once, with the lifecycle, the routing rule (originating conversation by default) and a degrade path for surfaces without buttons. Rendered in the Mac app first.
*Done when:* the same approval works in the Mac app, and a surface with no buttons receives a usable text version.

**M4 — Scheduling and offline behaviour.** Best-effort schedules, recurring schedules one deep, `scheduled_for` and `fired_at` on every firing, the optional staleness ceiling. Inbound messages queue while the Mac sleeps, and the user is told the agent is offline or catching up.
*Done when:* closing the lid across a scheduled time produces one late firing carrying both times, and an inbound message sent meanwhile is answered on wake with the offline notice shown.

**M5 — Telegram and email surfaces.** The two messaging surfaces on the conversation and interaction protocols. Guided in-app Telegram bot setup.
*Done when:* a first-time user creates a Telegram bot from the app's instructions and exchanges messages, with buttons working and topics mapping to conversations.

**M6 — Harness breadth.** Codex and opencode harnesses. Hook-tier adapters for memory freshness, status and approvals, each declared per harness. Intercom-managed skills installed and updated automatically. `AGENTS.md`/`CLAUDE.md` reference check for `INTERCOM.md`.
*Done when:* the M2 and M3 tests pass on all three harnesses, with differences shown as declared capabilities.

**M7 — Surface API and the Compact.** Feeds, the resource-sync protocol, device lifecycle and the capability declaration; Moments and Alerts first, then Tasks/Commitments and widgets. The Compact, the Kindle dashboard and the Phase prototype move onto it. The Compact is a V1 gate (Chris, Nov 7). Build this in parallel with M5 and M6 once M3 exists; the Compact hardware is due about Nov 20 and starts on agentbus.
*Done when:* a third party can build a device client from the documentation alone, and the Kindle and the Compact run the same contract.

**M8 — Setup, supervision and packaging.** Guided first-run, the dependency check that fixes what it finds, process supervision with self-repair, a health view, configuration without hand-edited files, a signed and notarized build under Chris's Apple Developer account, and an update channel.
*Done when:* the first-run scenario in the brief passes on a clean Mac with no Terminal.

**M9 — Reference installs (dogfood).** Baxter moves first (Mac app only, no external channels, closest to what M1 to M4 deliver), then Peggy once M5 to M7 stand. *Peggy's view:* Baxter first, but only after M4, since a work agent should not be the guinea pig for an unfinished skeleton. Agentbus is retired for each instance only when the new one has run a clean week.
*Done when:* both run daily on Intercom and agentbus is off.

**M10 — Friend beta.** Two or three less technical friends run the first-run scenario. We fix what they hit.
*Done when:* each reaches a first reply in under 15 minutes and never meets the words session, pane, lease, compaction or journal.

**M11 — Public release.** Trademark search or lawyer review of the name, a check of anything ported from agentbus for secrets and personal data, README, contributor and security-reporting notes, MIT license, community support set-up.
*Done when:* the repo is public and the signed download is available.

## Decisions

1. **Implementation stack (M0).** *Open.* The brief fixes a native Mac app but not what the core is written in. This shapes everything and is the first thing to settle.
2. **Baxter before Peggy: decided (Nov 7).** Baxter is the first reference install, after M4; Peggy follows once M5 to M7 stand.
3. **The Compact is a V1 gate: decided (Nov 7).** V1 does not ship until the Compact runs on the Surface API (M7) on Intercom. *Consequence (Peggy's view):* M7 moves onto the critical path, so the capability and protocol design should start no later than M3, not after M6.

## Not on the list yet

Security review in depth, cost tracking (agentbus has `/cost`; unsaid whether V1 needs it), and anything for households. Say if any belongs in a milestone.

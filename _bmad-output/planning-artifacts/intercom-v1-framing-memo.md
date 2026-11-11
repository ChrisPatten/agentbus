# AgentBus V1 — Framing the Major Areas

Draft for prioritization, Nov 6, 2026. Prepared by Peggy from the repo (`agentbus` dev @ 2889c52), `_bmad-output/` (PRD, principles, architecture, epics E1–E101, backlogs) and the live config. Facts I checked are stated plainly. Opinions are marked **Peggy's view** and are there to be argued with.

---

## 1. Where we are

- About 45,000 lines of non-test TypeScript, 211 test files, 57 database migrations, 40 documentation guides, 95 epic files (E1–E101).
- Live config: one agent (`agent:peggy`), eight adapters enabled (Telegram, BlueBubbles, claude-code, cc-pool, email, Pebble, Siri, Intercom), and a second bot (PokeClaude) on its own pool. Beyond the config: a Mac app, the Surface API, the Phase web client, Slack POC.
- The product started as "one inbox and outbox for one AI agent" (PRD goals G1–G6) and grew in three directions the PRD did not plan for: an interactive agent-runtime manager (the tmux pool), a memory and learning system, and owned client surfaces (Mac app, Intercom, Phase).

**The planning documents no longer describe the product.**
- The PRD's v1 non-goals include "no web UI", "no authentication" and "no agent-to-agent routing". The Mac app, Intercom and Surface API, bus auth and pairing all exist now.
- `README.md` still calls `cc-headless` "the primary agent runtime". It has been disabled since Sep 11; cc-pool is what runs.
- `principles.md` says the bus is a courier: never calls an LLM, never manages agent state, never sequences agent actions. In practice the bus runs journaling and consolidation agents, manages session leases and model choices, approves tool prompts, and proposes edits to the agent's own files.

That last point is the most important thing to settle first (see section 4).

---

## 2. The major areas of functionality

Each area lists what exists, where it hurts, and the V1 question it raises.

### A. Core messaging fabric
- **Exists:** the message envelope, the inbound pipeline (normalize, contact resolve, relay, dedup, slash command, topic, priority, route, transcript, memory inject), the queue, the delivery worker, dead letter, outbound messages table, content-transform relay.
- **Hurts:** delivery addressing is a footgun. `send_message` and `send_document` accept a recipient that is not `contact:...`, report success, and the message sits `pending` forever (11 messages lost Nov 3–6; guarded today only by a rule in CLAUDE.md).
- **V1 question:** what is the canonical envelope and addressing scheme, and does the API reject anything that cannot be delivered?

### B. Identity, contacts and conversations
- **Exists:** contact resolution across channels, owner contacts, `conversation_registry`, `threads`, `sessions`, `topics`, `pool_leases`, cross-channel continuation (E60), main continuity (E69), `share_context` (E82).
- **Hurts:** five overlapping words for "a conversation": topic, thread, conversation, session, lease. Each was added for a good reason. Together nobody can state the model in a sentence.
- **V1 question:** one canonical model of conversation, with sessions and leases clearly as runtime concerns beneath it.

### C. Channel adapters and the plugin contract
- **Exists:** Telegram (large: topics, reactions, status stream, commands), email (IMAP IDLE and SMTP), Pebble, Siri, BlueBubbles (backlog), Slack POC, App/Mac, Intercom. An `AdapterCapabilities` model exists.
- **Hurts:** the plugin loader (E11) was never built, so adapters are compiled in. Each adapter reimplements the same higher-level features (see D).
- **V1 question:** which adapters are in V1 (Telegram, email, Mac app, Intercom?), which are experiments, and is a real plugin API in V1 or later?

### D. Interaction primitives (human-in-the-loop)
- **Exists:** choice buttons (Telegram E74, Mac E86), input prompts, formal approval requests (E51, Telegram only; an app version E74-app is "planned"), advisories, notifications (E89), live status lines (E79), answer-needed flag (Surface API).
- **Hurts:** this is the clearest bolt-on pattern. Each primitive was built for one channel, then rebuilt for the next. Approvals do not yet route to the topic that triggered them (your Nov 3 backlog note).
- **Peggy's view:** define the primitives once as channel-independent concepts (ask, choose, approve, notify, status), each with a lifecycle, a routing rule (default: the originating conversation) and a degrade path for channels that cannot render buttons. Adapters then implement a small rendering interface.

### E. Agent runtimes
- **Exists:** `cc-headless` (disabled), `cc-pool` (tmux panes leased per conversation, with watchdog, model selection, keep-warm, `/pool`), `claude-code` (single persistent session, legacy), `mcp-polled`. A capabilities matrix (E64). `codex-headless` is scoped, not built.
- **Hurts:** cc-pool carries the most operational pain. Panes are the unit of failure, and tonight's incident (an orphan tmux server) showed how many assumptions sit on top of tmux state. The runtime capability matrix has four columns, but per the runbook two of the runtimes (`cc-headless`, `claude-code`) are disabled or legacy.
- **V1 question:** which runtimes are supported, and is tmux-driven interactive Claude Code the V1 runtime, or a stepping stone to something with a proper control channel? **Peggy's view:** pick one first-class runtime, mark the others "legacy" or remove them, and keep the capability interface so a second provider can come back later.

### F. Memory, journaling and learning
- **Exists:** transcripts with full-text search, pluggable journaling (E66), native memory layout and `recent.md` (E67, E73), learning and self-edit proposals (E68), a knowledge store (E50), session context ledger (E49).
- **Hurts:** this is the biggest departure from the principles document. Three generations of memory design coexist (legacy summarizer, journaling, native memory), and the knowledge store overlaps with the agent's own files.
- **V1 question:** does the bus own memory? Options: (1) bus provides transcripts and triggers only, agent owns its files; (2) bus runs journaling as a first-class "background agent" feature; (3) both, with a clear line. Today it is effectively (3) with the line unwritten.

### G. Scheduling and proactive delivery
- **Exists:** cron and one-shot scheduled messages, durable post-restart wake-ups (E40), staleness dead-letter, proactive delivery to the app, calendar proposals (E55–57).
- **Hurts:** little. This area is the most settled. Calendar proposals are domain logic that arguably belongs to the agent, not the bus.
- **V1 question:** keep scheduling as core; decide whether calendar proposals ship in the bus or move out.

### H. Surfaces and first-party clients
- **Exists:** Mac app (E62, E63, E72, E75, E77, E99), Intercom (E89–E93), Surface API v2 (E96) with revisioned resources and delta push, Phase (Plum Dusk) web client (E101), the Compact hardware device (due ~Nov 20), iOS Siri app.
- **Hurts:** these are products in their own right, with their own roadmaps, sharing the bus repo and release train. The Surface API is the right shape (a documented client contract) but is adjacent to the older App API and the Intercom WebSocket protocol.
- **V1 question:** is the bus V1 the courier plus a documented client API, with Mac, Intercom and Phase as separate "V1 apps" that consume it? Or one product? **Peggy's view:** separate them in planning even if they stay in one repo. Their cadence is different.

### I. Agent tool surface and commands
- **Exists:** MCP tools (reply, send, schedule, transcripts, knowledge, surface, notify, and more), slash commands, skills-in-the-command-menu (E78 planned), provider command forwarding (E71).
- **Hurts:** tools and commands grew per feature. No stated policy on what is a tool, what is a command, and what is a hook.
- **V1 question:** a stable, versioned tool contract, with a deprecation policy.

### J. Operations, safety and observability
- **Exists:** pm2 deployment, `safe_restart.sh` with rollback, health endpoint, `/cost` and turn costs, pane incidents table, advisories, config in YAML with a Zod schema, bus auth token, pairing codes, TLS on the LAN surface listener.
- **Hurts:** state that should survive a restart lives in memory (the E88 launch fence). Config is a symlink into another repo, with layered imports (E87) still unbuilt. Reconcile-on-restart had to be patched twice in one night. There is no single "what is wrong right now" view beyond reading logs.
- **V1 question:** which failures must the bus detect and repair by itself (dead panes, orphans, stuck deliveries), and what is the operator's one-screen health view?

### K. Packaging, docs and contributor workflow
- **Exists:** 40 guides, versioning doc, changelog discipline, BMAD-style epics, a public site.
- **Hurts:** planning hygiene: epic numbers collide (E54 and E74 each used twice), the PRD, architecture and principles pre-date most of the code, and two backlog files plus a sprint-status file overlap.
- **V1 question:** who is V1 for? One operator (you), or something others install? That changes how much to invest in A–C and K.

---

## 3. Patterns behind the "bolt-ons"

Seen in the code and planning files while preparing this:

1. **Per-channel rebuilds.** Choices, approvals and status each shipped for one channel, then again for the next.
2. **State in the wrong place.** Fences, in-flight launches and leases split between memory, the database and tmux, so a restart or a stray process can desynchronise them.
3. **Identity by name only.** A pane or agent is identified by its id string. Anything that borrows the name is trusted (the Oct 31 incident).
4. **Silent acceptance.** Invalid recipients, stale launches and unreachable panes are accepted, then fail quietly later.
5. **Concept sprawl.** Five words for conversation; four runtimes with two disabled or legacy; three memory generations.
6. **Docs that describe the past.** PRD and principles are not the product.

---

## 4. Decisions to make before prioritizing

In the order I think they unlock the rest:

1. **What is AgentBus V1?** (a) a deterministic courier with a clean client API, (b) a personal-assistant platform that also runs agents, memory and clients, or (c) (a) as the product, with (b)'s extras as separate packages on top. This decides the fate of areas E, F and H.
2. **Who is it for?** Only you, you plus a few friends, or public. Decides auth, plugin API, setup and docs effort.
3. **Which runtime is the V1 runtime?** One first-class, others legacy or removed.
4. **Does the bus own memory?** The three options in area F.
5. **Canonical conversation model.** One sentence that everything else hangs from.
6. **Interaction primitives as a core layer.** Yes or no. If yes, it replaces several planned epics (E74-app, parts of E78, the approval routing note).
7. **Which channels are V1.** My starting guess: Telegram, email, Mac app, Intercom/Surface API. Everything else is an experiment or a plugin.
8. **Contract stability.** Which of API, tools, commands, config schema and database are frozen at V1.

---

## 5. A first-draft prioritization lens (to argue with)

- **Define first, because everything depends on it:** A (envelope and addressing), B (conversation model), D (interaction primitives), the V1 runtime choice from E.
- **Make solid next:** E (the chosen runtime, including self-repair), J (state that survives restarts, health view), G (already close).
- **Decide what stays in the repo:** F (memory and learning), H (clients), the calendar piece of G.
- **Defer or cut for V1:** more adapters (BlueBubbles, Slack, Codex), plugin loader, sub-agent spawning (E24), the unbuilt Siri epics (E43, E45–47), unless V1 decision 1 says otherwise.
- **Hygiene, any time:** refresh PRD, principles and README; renumber or retire stale epics; consolidate backlogs.

---

## 6. Suggested next steps

1. You answer decisions 1–4 (a short call, or one reply each).
2. Peggy writes the V1 Product Brief: identity statement, scope per area (in, out, later), the conversation model, and the interaction-primitives layer.
3. Map each existing epic to a V1 area and mark it keep, merge, rework or cut.
4. Plan the re-foundation work as a short list of epics in dependency order (addressing and envelope, conversation model, primitives, runtime hardening), and only then schedule the rest.

Not covered here: security review in depth, cost modelling, and a user-by-user feature audit of the Mac app and Intercom. Each could be a follow-up memo.

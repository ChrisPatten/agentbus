# Intercom V1 — Product Brief (Draft 1)

Nov 6, 2026. Written by Peggy from Mr. Patten's direction in the Enhancements topic (17:09–17:11), the AgentBus repo and the framing memo. **Everything here is a proposal for correction.** Where I filled a gap with a guess it is marked *(assumption)*. Section 10 lists the open questions.

---

## 1. What Intercom is

Intercom connects a person and a personal AI agent, and makes the agent smarter by managing the short-term context around it. The person experiences a persistent agent that learns over time and knows what they have talked about, much like texting or emailing a capable person. The agent does its work through a *harness* (Claude Code first), which owns the agent's long-term memory and its ability to use a computer. Intercom carries the messages, hosts the tools the agent calls, keeps short-term context flowing between sessions, schedules work, and exposes everything to the person's touch points: a native Mac app, Telegram, email, Siri, Pebble, and devices like the Compact.

Intercom is the whole product. AgentBus is the codebase that becomes it.

## 2. Who it is for

- **Primary:** Mr. Patten (Peggy, a personal agent, many touch points) and his work agent Baxter (a locked-down BCG laptop, Mac app only).
- **Next:** his less technical friends, each running their own copy on their own Mac, who want a personal agent that is not from a large vendor and does not take a lot of setup.
- **Not in V1:** a hosted service, monetization, enterprise administration.
- **Open by design:** a household with several agents (see 6.8). Do not rule it out; do not build it yet.

## 3. Principles

1. **It feels like a person, not a system.** The user never has to think about sessions, leases, compaction, journaling or panes. If they see one, that is a bug. Conversations (an email thread, a Telegram topic, the Mac app window) are the only structure the user sees.
2. **The harness owns long-term memory; Intercom owns short-term context.** Long-term memory is files the harness reads and writes (markdown on disk). Intercom shares context between sessions, loads `recent.md`, hands off context between conversations, and runs journaling as invisible background turns through the harness.
3. **No lock-in to a harness or model provider.** Personal agents handle sensitive data. Harness and model provider are configuration. Data stays on the user's Mac.
4. **Every touch point is a client of one API.** The Mac app, the Compact, a Kindle dashboard and a photo frame use the same documented, versioned contract as any later device.
5. **Explicit, deterministic routing.** The bus follows rules the user or app set up; it does not guess intent. (Kept from the old principles.) Intercom does not itself write content; anything generated comes from an agent turn.
6. **Local-first and private.** Each user runs their own copy. No cloud account is required. Secrets live in the system keychain. Nothing leaves the machine except what the user's chosen channels and model provider carry.
7. **Self-repairing and quiet.** Intercom detects and fixes its own failures (dead panes, stuck deliveries, orphan processes) and only speaks to the user when it needs them.
8. **Design every area against one scenario:** a friend installs the app, follows guided setup, and gets a first reply (section 8).

## 4. Reference installs

- **Peggy (today's install):** tmux pane pool running Claude Code on a subscription, all touch points, one human, scheduled work, two bots (Peggy and PokeClaude).
- **Baxter:** a separate Intercom instance on a work laptop, `claude -p` headless runtime, no Telegram (infosec), Mac app as the only channel, hard firewall from personal data.
- **A friend's Mac *(assumption)*:** one agent, the Mac app plus perhaps Telegram or email, Claude Code on a subscription or `claude -p` with an API key.

A feature belongs in V1 only if it serves at least one of these installs without breaking the others.

## 5. Vocabulary (draft canonical model)

Today five words overlap for "conversation" (topic, thread, conversation, session, lease). Proposed:

- **User** — a person who talks to agents. **Agent** — a persistent personal agent: identity, harness, model provider, memory directory.
- **Conversation** — the only unit the user sees. A thread of messages between one user and one agent, living in a channel container (email thread, Telegram topic, Mac app thread). Has a stable ID.
- **Turn** — one agent run triggered by messages, a schedule or a system event.
- **Session** and **lease** — internal. A harness session (Claude session ID, tmux pane) serving a conversation. Created, resumed, evicted and repaired invisibly.
- **Three layers (Chris, Nov 7):** **Harnesses** are the back end (Claude Code, `claude -p`, others: where the agent thinks, acts and keeps long-term memory). **Surfaces** are the front end (Telegram, email, Siri, Pebble, Mac app, Compact, Kindle, photo frame: where the user talks and looks). **Intercom** sits in the middle: conversations, short-term context, scheduling, interaction primitives, the Surface API.
- **Surface** — anything the user touches, whether it exchanges messages (Telegram, email) or displays and acts on content through the Surface API (Compact, Kindle). "Channel" is retired as a user-level word; internally a channel is just the message transport a surface uses.

*Note:* in the Surface API docs, today's "surface" (a named content stream) becomes a "feed". The existing "Intercom" channel (E90-E93, the Compact and phone prototype) is simply one surface (the Compact) and needs a device name once Intercom is the product name. The earlier "Surfaces" rename suggestion is withdrawn, since "surface" now means the whole front end.

## 6. Functional areas

### 6.1 Core messaging
Canonical envelope, addressing, inbound pipeline, queue, delivery with dead letter, contact and identity resolution, relay. **V1 rule:** the API refuses anything it cannot deliver (no more messages that report success and sit pending). Addressing is one scheme everywhere.

### 6.2 Harness layer
One interface with two tiers.
- **Required:** deliver messages to the agent, receive its replies, serve the Intercom MCP tools. Everything else is optional.
- **Optional (hooks):** turn-ended, pre-compact, session-end, clear, memory-freshness, richer status. Where a harness supplies hooks, Intercom uses them for streamlined context management and richer interactions.
- **V1 implementations:** Claude Code via the **tmux pane pool** and via **`claude -p` (cc-headless)**, plus **Codex** and **opencode** (which reaches local and other providers). The harness owns the LLM and tool usage; a generic API-loop harness is out of V1. The existing capability matrix (E64) is extended, not replaced.
- **Instruction file:** Intercom owns an application-managed **`INTERCOM.md`** (format defined by Intercom) and checks that the agent's `AGENTS.md` references it. It carries the `recent.md` content and any other instructions a harness needs for smooth integration. *To verify per harness:* that each of Claude Code, Codex and opencode actually reads `AGENTS.md` (Chris, Nov 7: Claude Code reads `AGENTS.md` when present and `CLAUDE.md` is not; where a `CLAUDE.md` exists, such as Peggy's, `INTERCOM.md` needs an import from it) and honours file references.
- **Skills:** Intercom ships Intercom-related skills (for example, how to push content to the Compact) and installs and updates them automatically in each harness. *To verify:* each harness's skill format and location.
- **tmux is not shipped with macOS.** The app installs or bundles it, and checks it at launch.

### 6.3 Conversations and sessions
Implements the model in section 5. Sessions, leases, model switches, resume and fork are internal. Cross-conversation context sharing (`share_context`, main continuity) remains, under one documented mechanism.

### 6.4 Interaction primitives
Defined once, channel-independent: **ask** (open question), **choose** (buttons), **approve** (permission prompt), **notify** (attention item), **status** (what the agent is doing). Each has a lifecycle, defaults to the originating conversation (your Nov 3 approvals note), and degrades gracefully where a channel cannot render it (numbered list, plain text). Channels implement a small renderer interface. This replaces the separate Telegram, Mac and Intercom builds of choices and approvals.

### 6.5 Memory and context
- **Short-term memory owned by Intercom (Chris, Nov 7):** the agentbus-managed `recent.md` included by reference (via `INTERCOM.md`), the `share_context` tool, and block-level re-injection of changed context. `MEMORY.md` injection is Claude Code native behaviour; how other harnesses load their index is to be investigated.
- **Intercom does:** record transcripts, deliver `recent.md` and context blocks, hand off context between conversations, trigger journaling and consolidation as invisible background turns through the harness, provide search over transcripts.
- **The harness does:** hold long-term memory, decide what to write.
- **Cut from V1 (Chris, Nov 7):** the knowledge store (E50) and agent self-edit proposals (E68). The harness owns long-term memory and changes its own files; Intercom does not curate knowledge or propose edits to the agent.

### 6.6 Scheduling
Cron and one-shot messages to the agent, durable across restarts, user- and agent-created. **Semantics (Chris, Nov 7):** best effort, on or after the scheduled time; a recurring schedule queues one deep (a missed run is replaced by the next, never doubled); every firing carries `scheduled_for` and `fired_at` so the agent can see a delay. Today's one-shot `stale_after_ms` dead-letter stays an optional per-schedule ceiling. Calendar proposals (E55–E57) are domain logic; propose moving them out of core *(assumption)*.

### 6.7 Touch points and the Surface API
- **Surfaces in V1:** Mac app, Telegram, email, Siri, Pebble, plus the Compact and other devices through the Surface API. Slack and BlueBubbles are out of V1 *(assumption)*.
- **Protocols and capabilities (Chris, Nov 7; Peggy's proposal, to be refined):** a surface *adopts protocols* and *declares capabilities*. Test: a different wire shape is a protocol; a different value in the same shape is a capability.
  - **Protocols:** Conversation (messages, attachments, buttons, answer-needed, live appends); Interaction (ask, choose, approve, notify, with actions, hold-to-confirm, idempotency, terminal states); Resource sync (revisioned collections, set/patch/remove ops, deltas, resume, coalescing: the Surface API v2 core); Device lifecycle (pairing, tokens, scope, revocation, device state). Voice stream reserved.
  - **Capabilities (declared at hello):** display profile, colour and refresh, image and markdown support, per-surface text limits (today global in `BOUNDS`), input type (touch, tap vs hold, voice), delivery (push or poll, always on, sound or haptic, spoken limits), and the content kinds and widget types it renders.
  - **Principle:** agents publish meaning (a Moment with a time span and weight, a Task, a widget with data); Intercom fits it to each surface's capabilities and degrades gracefully. Compact-specific vocabulary (Day Dial ring fields, `primary` and `context` slots, `layout` keys, the 100-character glance line) leaves the agent-facing API and becomes a capability of the round profile.
- **Surface API:** the documented, versioned contract that carries Resource sync and Device lifecycle for devices and apps (Compact, Kindle dashboard, photo frame, Mac app). Content types so far: **Moments**, **Alerts**; planned: **Tasks/Commitments** and **flexible widgets**. Its detailed design is a separate work item.
- **Naming:** the Surface API docs and code use "surface" for a named content stream and "device" for the paired client. Under the V1 vocabulary the stream is renamed a **feed**, and "surface" means the front-end client (today's "device").
- **V1 requirement:** a third party can build a device client from the documentation alone.

### 6.8 Households and multiple agents (not ruled out)
One install may later hold several users and agents (personal agents, plus a household agent). V1 consequences: agents are first-class entities with no hard-coded single agent; every conversation is scoped by user and agent; memory directories and data are per agent. **Not decided:** how private personal agents are from one another, and whether agents may message each other. Baxter is a separate instance, not a test of this.

### 6.9 The Mac app (V1's main product surface)
- **Conversation interface** — the zero-setup channel, complete on its own (as Baxter needs).
- **Guided setup** — installs or checks dependencies (tmux, Claude Code), signs in or takes an API key, names the agent, picks channels, and sends a first message.
- **Configuration** — channels, harness and provider, schedules, contacts, agent settings, with no hand-edited YAML.
- **Process supervision** — the app owns the Intercom service (E77): starts, stops, repairs, updates it, and shows plain-language health.
- **Distribution** — a signed, notarized app with automatic updates *(assumption)*.

### 6.10 Operations, safety and trust
Authentication and device pairing by default; secrets in the keychain; state that must survive a restart lives in the database (not in memory); self-repair on start and on a timer; a one-screen health view; cost visibility for API-key users; diagnostics a non-technical friend can send to Mr. Patten with one tap *(assumption)*.

## 7. Out of V1 (revisit later)

Hosted or multi-tenant service; monetization; agent-to-agent messaging; household privacy model (design-compatible only); Slack, BlueBubbles; knowledge store (E50); agent self-edit proposals (E68); a generic API-loop harness (the harness owns the LLM and tool usage); sub-agent spawning (E24); the unbuilt Siri semantic-index epics (E46, E47); a general plugin loader (E11) unless Surface API clients need one.

## 8. The design scenario: first run

A friend with a Mac and a Claude subscription (or an API key) downloads Intercom and opens it. In under 15 minutes *(assumption)*, with no Terminal and no config files, they:
1. Pass a dependency check the app fixes for them.
2. Sign in to their harness or paste an API key.
3. Name the agent and describe themselves in a sentence or two.
4. Send a message in the Mac app and get a reply that knows who they are.
5. Optionally add Telegram or email through a guided flow.
6. Close the laptop, reopen it, and find the conversation intact, with the app having repaired anything that stopped.

Pass condition: they never see the words session, pane, lease, compaction or journal.

## 9. Proposed sequence (no dates)

1. **Decide:** answer the open questions; freeze the vocabulary, the harness interface and the interaction primitives.
2. **Foundations:** addressing and envelope rules, conversation model, persisted runtime state, harness interface with the two V1 implementations, interaction primitives layer. Roll in E88's fencing and dead-pane repair.
3. **The app as installer and supervisor:** E77, guided setup, configuration UI, health, updates.
4. **Surface API design and conformance:** the Moments, Alerts, Tasks and widgets design pass; bring the Compact, Kindle and Mac app onto the same contract.
5. **Friend beta:** run the first-run scenario with two or three friends; fix what they hit.
6. **Doc refresh in parallel:** a new PRD and principles replace the old ones; retire stale epics and merge backlogs.

## 10. Open questions (all ten answered Nov 7, 2026; see each item for consequences still to settle)

1. **Always-on (answered for schedules, Nov 7):** schedules are best effort and run on or after the scheduled time. A recurring schedule queues at most one missed run, so a missed instance is replaced by the next and never runs twice. A fired schedule carries both the originally scheduled time and the actual time, so the agent knows it was delayed. **Inbound while asleep (answered):** inbound messages are queued and handled on wake, and the user is told the agent is offline or catching up (how and where is a design detail for the surface protocols). The optional per-schedule `stale_after_ms` ceiling is kept.
2. **Model providers in V1 (answered Nov 7):** Anthropic (Claude Code), OpenAI (Codex), and local or any other provider through **opencode**. The harness owns the LLM and tool usage; Intercom does not. A generic API-loop harness is explicitly out of V1. *Consequence:* V1 harness set is Claude Code, Codex and opencode; the Codex harness is back in scope.
3. **Knowledge store and self-edit proposals (answered Nov 7):** cut both from V1. *Follow-up:* decide what happens to the existing code, tools (`write_knowledge`, `search_knowledge`, `propose_change`) (checked Nov 7: the live `knowledge` and `self_edit_proposals` tables hold 0 rows and Peggy does not use them): remove, or leave dormant outside the V1 contract. Removal is low-risk.
4. **Telegram setup for friends (answered Nov 7):** guided steps in the Mac app walk the user through creating their own bot with BotFather and pasting the token. No shared hosted bot (it would centralise everyone's messages, against the no-lock-in principle). Telegram stays optional; the Mac app conversation works without it.
5. **Open source and support (answered Nov 7):** public release at V1, MIT licensed, community support (issues and discussions; no support commitment). *Consequences to plan:* because V1 is a fresh repo, no history audit is needed, but anything ported from `agentbus` must be checked for secrets, personal data and Peggy-specific config first; contributor and security-reporting docs, clear first-run and self-diagnosis in the app so the community is not the first line of help, and an honest README that matches the product.
6. **Distribution (answered Nov 7):** direct download of a signed, notarized Mac app, signed by Chris under his own Apple Developer account; no App Store in V1. An update channel is still to be chosen (for example Sparkle). **A fresh repo:** Intercom V1 is built in a new repository, not in `agentbus`.
7. **Household privacy model (answered Nov 7):** deferred past V1. V1 stays design-compatible only: agents are first-class, conversations are scoped by user and agent, memory and data are per agent.
8. **Hooks (answered Nov 7):** memory freshness, status and approvals are equal priority for the optional tier. Each harness adapter declares which of the three it supports; without hooks the required tier (messages plus MCP tools) still works. *Consequence:* the hook surface differs per harness (Claude Code, Codex, opencode), so the capability declaration must say which of the three each supports.
9. **Naming (answered Nov 7):** **Intercom stays the working name.** Proposed: repo `intercom`; Mac app "Intercom" (bundle id `dev.chrispatten.intercom`); the old Intercom channel and its docs become **Compact** (adapter id `compact`); the phone prototype is **Phase**; the old Surface API stream is a **feed**; instruction file `INTERCOM.md`; MCP server `intercom` (renaming `mcp__agentbus__*` tools is a deliberate cutover). *Open before public release:* a USPTO search or lawyer review of the name, because Intercom, Inc. is an established customer-messaging company; screened alternatives (Handset least conflicted, Switchboard, Parlor, Errand, Tandem, Hearth, Tether, Steno) were all crowded or taken.
10. **Work instances (answered Nov 7):** today's setup is enough. A work install is a separate Intercom instance with the Mac app as its only surface and no external channels. No locked-down mode or audit log in V1.

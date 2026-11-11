# Intercom interaction model (draft 1)

Nov 10, 2026. How Conversations, sessions, context windows and agent-initiated work fit together. Decisions by Chris are marked *Decided*. Opinions are marked *Peggy's view*. Nothing here is built; the prototype track (P1, P3) tests the open parts.

## 1. Terms

- **Conversation:** the durable thread between a user and an agent. Owned by Intercom. It is the only thing a user sees.
- **Session:** one harness process and its context window. A cache of a Conversation, disposable and rebuildable. Never shown to the user.
- **Context assembly:** what Intercom puts into a session when it starts or wakes, built from the Conversation and short-term memory.
- **Job:** one-off background work with no user in it (a schedule, an alert from a process). Runs as its own session and decides what to do.
- **Routine:** named, standing background work (*Decided, Chris, Nov 10: the name*). Each trigger starts a run. A routine is also the address a script or another agent sends to. May resume or start fresh each run.
- **Container:** a place on a surface that already groups messages (a Telegram topic, an email thread). Some surfaces have none (Siri, Pebble, Compact voice).
- **Run record:** a log entry for each job run: name, trigger, start and end, the outcome it chose, where the output went.

## 2. Principles

1. The Conversation is the truth; sessions are caches of it.
2. A wrong attach costs more than a wrong new Conversation.
3. Explicit signals always win and skip the router.
4. The user never sees sessions, compaction or journaling.
5. An agent that works alone reports like a real assistant: only when it matters, in the right place, with enough context.
6. An undeliverable message is rejected, never silently accepted.

## 3. Conversations

- Identity comes from the container when one exists. Explicit containers are permanent and always reattachable.
- Implicit Conversations age through three states: **active**, **dormant**, **archived**. State sets eligibility for reattachment. The time limits are to be tuned from shadow-mode data (*Peggy's view*: start with hours for active, days for dormant).
- Each Conversation keeps a durable transcript, searchable.
- Each keeps a structured summary, written by the agent that was in the Conversation: topic, status, open questions, decisions, files, commitments, and the last few turns verbatim.
- Today in agentbus: a pane is leased per conversation; idle panes can be evicted after 30 minutes and are released after 6 hours, with the pane cleared and journaling run on release.

## 4. Sessions and the two compactions

- A session is leased to a Conversation and can be evicted at any time without loss.
- **Window compaction** (the harness shrinking a full context window) and **Conversation summary** (Intercom's durable record) are different things. Pinned context (INTERCOM.md, recent short-term memory, open commitments) must survive both.
- Waking a Conversation after eviction means assembling context again, not restoring the old window.

## 5. Context assembly

On a start or wake, Intercom assembles, in order:

1. `INTERCOM.md` (managed instructions, with the `recent.md` short-term memory).
2. The Conversation summary and recent turns.
3. Pending context notes left by other agents or jobs since the last wake (data, never instructions).
4. Queued inbound messages.

Changed blocks are re-injected mid-session, not only at the start. MEMORY.md injection is native to Claude Code; other harnesses are still to be checked.

## 6. Routing an inbound message

Order of precedence:

1. **Explicit signals** (no router): a reply to an email thread; a post in a Telegram topic; a reply to a prior message in Telegram or the app; a direct message within N minutes of the last response.
2. **Stronger-than-recency signals:** a pending agent question (`answer_needed`), or work in flight on a Conversation.
3. **Router model** over eligible Conversations (active and dormant, by state). It returns a Conversation and a confidence.
4. **Below the confidence threshold:** start a new Conversation, cross-referenced to the best candidates, with a compacted summary of the nearest old Conversation as context.

Safeguards:
- The surface shows which Conversation received the message, with a cheap move or undo.
- Container-less surfaces lean on the router most, and spoken text has recognition errors, so confidence thresholds should be stricter there.
- **Shadow mode first:** the router logs what it would have chosen while explicit rules do the real routing, so accuracy is measured before it is trusted.

*Decided (Chris, Nov 10):* "instance" means session. An agent can see anything any of its own sessions did, so context for a new Conversation may come from any of that agent's old Conversations. Later, with several agents, an agent sees only summaries and search results of another agent's Conversations. A Conversation can carry a **private** flag that hides it from other agents. Context never crosses between users.

## 7. Agent-initiated work

A job is not a Conversation, because no user is engaged yet. It runs as its own session and ends with one of these outcomes:

- **Do nothing and log it.** A normal result; most scheduled runs end here.
- **Post to a Conversation,** with an attached note for that Conversation's agent.
- **Start a new Conversation,** seeded with a brief and a first message. A normal Conversation, with its session assembled from the brief rather than reusing the job's session.
- **Hand off silently:** wake the Conversation's agent with a brief; that agent decides whether the user hears anything.
- **Leave a note without waking:** the receiving agent finds it on its next wake (today's `share_context`).

### 7.1 One tool

`send(target, agent_message, user_message?, data?, priority, wake_agent, accept_response)` plus `key?`, `expires_after?`, `idempotency_key?`.

- **Sender** is never a parameter; Intercom knows the calling session, so attribution and the permission check cannot be faked.
- **`target`** is a Conversation id, a routine, or `new` (with an optional `title`). A `new` call without a `user_message` is rejected.
- **One tool for both jobs *(Decided, Chris, Nov 10)*:** with `target` omitted, the call speaks to the user in the Conversation the session is attached to. In that mode `wake_agent`, `accept_response`, `agent_message` and the idle cooldown are ignored or rejected, since the user is already in the exchange. A session with no attached Conversation, such as a job, has no default target, so omitting it is rejected. Ask, choose and approve (M3) are shapes of a user message, not extra parameters.
- **`agent_message`** is for the agent only. **`user_message`**, when present, is shown to the user. Messages posted by a job are recorded as coming from that job.
- **`wake_agent`:** with no `user_message`, false is an inert note and true is a silent handoff. With a `user_message`, false tells the user and lets the agent find the note when the user replies, true tells the user and has the agent act now.
- **`data`** is opaque JSON with a size cap, delivered marked as data, never instructions.
- **`attachments`** *(Decided, Chris, Nov 10)*: files and images are part of `send`. *Peggy's view:* the agent refers to a file; Intercom copies it into the Conversation's file store and delivers by capability (Telegram as a document or photo, the app inline; a surface that cannot show it gets a link or a note that the file is in the app). Local paths are checked against an allowed set, as send_document does today.
- **`priority`** governs how the user is reached (notification level, quiet hours, digest) and the order of queued wakes. A sender's token caps the priority it may claim.
- **Returns** delivered, queued (with reason) or rejected (with reason). `idempotency_key` prevents a retried call from posting twice.

### 7.2 Who may message whom

*Decided (Chris, Nov 10):* first contact is always allowed. The `accept_response` flag gates replies only: agent B may not send to agent A unless A set `accept_response` on the message B is answering.

*Peggy's view on details:* the grant is attached to that message through a reply handle, expires, and covers one reply by default. A reply carries `accept_response` false unless set, so agents cannot ping-pong without both opting in. A hop limit sits behind that. A job's session may be gone when its question is answered, so a reply to a routine either re-wakes it or arrives as a note.

### 7.3 Delivery rules

- **Cooldown *(Decided in direction, Chris, Nov 10):*** a `user_message` is posted only if the Conversation has been idle N minutes. Otherwise it is delivered alongside the user's next message, or directly when the idle period ends. *Peggy's view:* an urgent priority bypasses the cooldown; N is tuned per surface.
- **Labelling:** a message that arrives between turns is labelled as from the job, so the thread does not read as a non sequitur.
- **Supersession and expiry *(Decided, Chris, Nov 10):*** a newer message with the same `key` replaces or resolves the older one; `expires_after` drops a message that has gone stale. Generalised from the Compact's notifications.
- **Offline:** inbound messages queue while the Mac sleeps and the user is told the agent is offline (milestone M4).

### 7.4 The directory

`list_conversations` returns, per Conversation: id, title, state, last activity, one-line summary, open question if any. It can rank by relevance to a description the agent supplies ("where does this belong?"), reusing the router. *Decided (Chris, Nov 10):* it takes an optional `agent` parameter that scopes the list to that agent's eligible Conversations; if unset, it defaults to the calling agent. Another agent's private Conversations never appear.

### 7.5 Choosing the surface *(Decided, Chris, Nov 10: default policy agreed)*

- **Record and delivery are separate.** Every user message lands in the Conversation, so the Mac and iOS apps always show it. Delivering it to Telegram, the Compact or email is a second decision.
- **Default policy, in order:** (1) the Conversation's container if it has one (Telegram topic, email thread); (2) the surface where the user last acted in that Conversation, if recent; (3) the surface where the user was last active at all (presence); (4) the app, with a push notification. Higher priority adds attention surfaces (Compact, phone). Quiet hours apply and the user's per-surface preferences win.
- **One primary notification.** Only the chosen surface makes a sound; others show the message quietly, if at all, unless the priority is urgent. The `key` resolves it everywhere once handled.
- **Read state lives only in the first-party apps.** No syncing to Telegram or the Compact. A message delivered elsewhere shows in the app as delivered to that surface instead of unread, and a reply from any surface clears everything before it.
- **Approvals have one referee:** the first answer wins; other surfaces change to answered (terminal state and idempotency from the interaction protocol).
- **`surface` parameter:** optional; a specific surface or `all`, for explicit cases ("say this on the Compact"). Rejected with a reason if the surface lacks the capability (voice, buttons, long text). Unset, the policy runs.
- **Presence waits until after V1** *(Decided, Chris, Nov 10)*. In V1, step 3 is skipped and the policy falls through to the app with a push notification.

### 7.6 Forms of a message, and how agents learn each surface

- **Forms:** one `send` carries `user_message` (full text), an optional `glance` (one short line for small displays) and an optional `spoken` (for voice surfaces). One call replaces today's speak plus reply. Intercom delivers the spoken form first, then the text. A `spoken` field implies the message is user-visible. Speak's results (spoken, queued, skipped with a reason) become per-surface delivery results in the return, and a skipped speech never loses the message.
- **Limits:** the tool *may* enforce limits where a surface needs them (for example the glance length) but does not have to. `spoken` has no enforced length; the agent is told what to do by the surface skill. *(Decided, Chris, Nov 10.)*
- **Three layers of skills:** (1) a **core skill** on how to use the Intercom tools; (2) **surface skills**, one per surface type (Telegram, the Compact, email, the Mac app), managed by Intercom, installed and updated automatically, loaded on demand, each covering what that surface can do and how the tools are used when addressing it; (3) **user skills**, written by the user, on what the agent should use the tools for (for example, "put leave-by alerts on the Compact"). *(Decided, Chris, Nov 10.)* A separate protocol skill is not needed; a surface skill plus user skills covers it.
- **Capabilities stay as declarations:** a surface still declares what it can do at hello, and Intercom uses that to fit or skip a form. The knowledge of how to use a surface lives in its skill. Someone building a new surface ships the declaration and the skill together.
- **Loading:** when a surface becomes active in a Conversation (a message arrives from it, or it is in the delivery set), context assembly adds a one-line pointer to read that surface's skill. The pointer repeats at the start of a new session and after a window compaction, as pinned context. *(Peggy's view; skills load only if the agent chooses to load them, so the pointer matters.)*
- **User-tuned guides** (for example the voice guide) stay as data the surface skill points to. When one changes, block-level re-injection delivers the change.
- **Harness support:** Chris reports that Codex and opencode use the same skill format; still to confirm for Claude Code. A harness without skills receives the same content as a block in `INTERCOM.md`.
- **Health check (M8):** for every surface connected, its skill is installed and current.

### 7.7 Guard rails and records

- Hop limit on agent-to-agent chains; cost ceiling per job; scoped tokens per routine name for the HTTP endpoint (the Compact's automation token is the precedent).
- Every run leaves a run record. The user-facing view is an activity log, not a view of sessions. The Conversation's agent can open a run's record when asked "what did you do about that?"
- Reading another Conversation: *Decided:* an agent may read any Conversation of its own, across all its sessions. Between different agents (later): summaries and search results only, and never a Conversation flagged private.

### 7.8 Status

*Decided (Chris, Nov 10):* status is a separate tool, not part of `send`. He floated `send` returning a handle that status updates must carry, so they show on the right surface.

*Peggy's view:* `status(text, handle?)`. In an attached Conversation the handle is implicit: the turn being worked on already knows which surface the user wrote from, so the status shows there (an edited-in-place status message on Telegram, a status face on the Compact, a working indicator in the app). A handle is needed where there is no such turn: a job reporting progress to a Conversation gets one from its first `send` and carries it on later status calls. Status is ephemeral: it clears when the turn ends or a message lands, never wakes anyone, never notifies, is rate limited and coalesced, and is kept in the run record only.

### 7.9 Triggers

*Decided (Chris, Nov 10):* schedules first. Scripts may also trigger work, through an HTTP endpoint and a stdio MCP interface. App Intents for Shortcuts and Siri are wanted too.

*Peggy's view:*
- **A trigger is a `send` from a non-agent sender.** Senders have kinds: an agent session, a schedule, a script (with a scoped token), an App Intent, the user. Triggering a routine and an agent sending to one are the same operation, so attribution, permission checks, idempotency and the data-not-instructions rule are written once. A token scopes which targets a sender may address and the highest priority it may claim.
- **HTTP is the contract; a small CLI wraps it** so scripts need not speak MCP. The Intercom MCP exposes the same verb to agents. The endpoint answers with a run id at once; waiting for the result is optional. Local-only by default, as the notifications endpoint is today.
- **App Intents** come in two kinds. Free text into Siri or Shortcuts is an inbound user message and goes through the router (Siri has no container). "Run routine X" is a trigger. Shortcuts personal automations (time, place, charging, Focus) give iOS-side triggers without building them.
- **A routine definition** holds its standing instructions (a user skill), the agent, session mode (fresh, resume, or notes file), concurrency policy (queue, coalesce or drop), a cost ceiling, the targets it may address and its priority cap. Payloads are data and never rewrite the instructions.

*Routines: MVP and later (Chris, Nov 10):*
- **MVP:** a scheduled prompt, or "the caller passes the prompt" as today. *Peggy's view:* record which one a routine uses. With a **fixed prompt**, the caller's payload is only data. With a **caller prompt**, the caller's text is the instruction, so it is allowed only for senders trusted to instruct (an agent session, the user's own scheduler, a script token with that scope), never for outside webhooks or mail content.
- **Later:** multi-step workflows that run scripts and pass results to agents with prompts. Permissions then live with Intercom: each routine declares which scripts it may run and what they may touch, which targets it may message, and Intercom enforces it. *Peggy's view:* write the definition format as a list of steps from the start, with the MVP having one agent step, so steps can be added without a rewrite. Results pass between steps as data.
- **Later still:** an MCP tool to add, edit and run scripts, so the agent manages script work inside Intercom instead of separately. *Peggy's view, a caution:* an agent that can edit a script and then run it with the routine's permissions could gain more than it was given. Script changes should need approval (the approval primitive), and a routine's permissions should bind to an approved version of the script, not to whatever it currently says.

## 8. Decided so far

- First contact is always allowed; `accept_response` gates replies.
- An agent reads all of its own sessions' Conversations; cross-agent is later and limited to summaries and search.
- A private flag on a Conversation hides it from other agents. Both the user and the agent may set it, and the user's setting wins *(Decided, Chris, Nov 10)*. It hides only from other agents, not from the owning agent's own sessions *(my reading, as Chris's rule was that an agent sees everything its own sessions did)*.
- `list_conversations` takes an optional `agent`, defaulting to the caller.
- One `send` tool; with `target` omitted it speaks to the user in the attached Conversation.
- Surface choice follows the default delivery policy in 7.5; apps always hold the Conversation and own read state.
- `send` carries optional `glance` and `spoken` forms; the tool may enforce limits but need not (`spoken` unenforced).
- Skills in three layers: core, per-surface (managed, on demand), and user. No separate protocol skills.
- Attachments are part of `send`. Status is a separate tool.
- Triggers: schedules first; scripts through an HTTP endpoint and a stdio MCP interface; App Intents for Shortcuts and Siri.
- Supersession and expiry keys: yes.
- Cooldown before a job's user message is posted into an active exchange: yes.
- Multi-agent support: later.

## 9. Deferred

- **User controls over jobs** (muting, "stop telling me about this", a visible mute list): to be dug into later (Chris).
- Multi-agent and cross-agent addressing.

## 10. Not yet covered

- What happens when a job or routine crashes midway, and concurrency (two triggers for one routine at once: queue, coalesce or drop).
- Retention, deletion and export of Conversations and run records.
- How voice surfaces handle agent-initiated messages.
- Default values for N (idle cooldown, DM window), state time limits and the confidence threshold, to be tuned with real data.
- Test plan and accuracy targets for the shadow-mode router.
- Cost: what a wake costs and how it is reported to the user.
- Corrections: moving a message to another Conversation, merging and splitting Conversations, and who writes Conversation titles.
- Routine definition (where it lives, who writes it, how a user creates one), concurrency and crash policy per routine, sender identities and scoped tokens, and webhook verification for outside services. Other trigger sources (inbound mail rules, file watchers) are still to be listed.
- Editing or retracting a sent message (today: edit_message) versus superseding it by `key`.
- Long spoken messages: a way to stop speech on the device, and guidance in the voice guide.

## 11. Where this lands in the milestones

- **P1** (automatic session and topic management): routing, states, summaries, shadow-mode router.
- **P3** (approval and question routing): widen to the whole `send` tool, the reply handle and the callback path.
- **M2:** Conversations, summaries, context assembly. **M3:** the interaction primitives and the `send` tool's user-facing rendering. **M4:** schedules, offline queueing, routine triggers.

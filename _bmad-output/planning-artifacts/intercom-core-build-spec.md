# Intercom core build: specification (v0.1)

Nov 10, 2026. Owner: the product owner (Chris Patten). Written by Peggy from the planning sessions of Nov 6 to Nov 10. This is the spec for a first autonomous build of the Intercom core. Opinions of the spec's author are marked *Peggy's view*. Where the spec says "default", the builder may choose otherwise using judgement, but must record the choice (see section 17).

## 1. What is being built

A working core of Intercom, the middle layer between harnesses (the agents, back end) and surfaces (the places a user talks to them, front end). It is an Electron desktop app plus a local daemon, in a fresh repo, for one user, one agent identity and Claude Code as the only real harness.

It exists to prove the interaction model end to end: Conversations that the user sees, sessions that the user never sees, routing of messages to the right Conversation, and one MCP interface that lets agents talk to the user, to other Conversations and to routines. It should be solid enough to become the foundation of V1, not a throwaway, but the design may be rewritten where the model demands it.

Reference documents, read in this order before anything else (absolute paths, in `~/workspace/agentbus/_bmad-output/planning-artifacts/`):

1. `intercom-interaction-model-draft1.md`: the interaction model. Authoritative wherever this spec is silent.
2. `intercom-v1-product-brief.md`: the product vision and decisions.
3. `intercom-v1-milestones-draft1.md`: milestones (this build covers a slice of M0 to M4 in the interaction-model direction; see section 2).
4. `intercom-core-stack-memo.md`: the stack discussion (superseded for the UI by this spec's choice of Electron).

Where this spec and the interaction model differ, this spec wins for this build, and the difference goes in the decision log.

The old agentbus repo (`~/workspace/agentbus`) may be read for facts, such as how Claude Code behaves when driven from a process. It must not be copied and must not shape the design.

## 2. Scope

### In scope

- Conversations: durable transcript, lifecycle states, titles, summaries, a private flag, search.
- Managed sessions: Intercom starts, resumes, evicts, rebuilds and repairs Claude Code sessions on its own. The user never sees them.
- Context assembly: what a session is given when it starts or wakes.
- Routing: explicit signals, stronger signals, a router model with a confidence threshold, shadow-mode logging, corrections, and a labelled evaluation set.
- The MCP interface for agents: `send`, `status`, `list_conversations`, `read_conversation`, `search_conversations`, `update_conversation`.
- Agent-initiated work: routines, runs, the five outcomes, an HTTP trigger endpoint with scoped tokens, run records.
- Delivery rules: priority, the idle cooldown, supersession keys, expiry, interaction shapes (choices, answer needed), attachments.
- An Electron UI that is simple but properly styled, covering every function above.
- Automated tests and a written acceptance run (section 15).
- Documentation, a decision log and a narrated progress document.

### Out of scope for this build

- Scheduling (user-facing schedules, cron, recurring runs). Internal timers (idle eviction, lifecycle aging, the cooldown, run time limits) are in scope.
- The Compact, Telegram, email, Siri, App Intents, Shortcuts, voice. The `glance` and `spoken` fields exist in the message schema and are stored, but nothing renders or speaks them.
- Presence (where the user was last active). Decided: after V1.
- Multiple real agents, cross-agent reading and households. The data model carries an agent id and the permission rules are implemented and tested with two fake agents, but the UI shows one agent.
- Codex and opencode harnesses, harness hooks, `INTERCOM.md` and `recent.md` short-term memory, managed skills. The harness interface must leave room for them.
- First-run setup wizard, dependency installer, signing, notarization, an update channel, the Surface API and device protocols.
- User controls such as muting a routine.
- Retention, deletion and export of Conversations.

## 3. Vocabulary

- **Harness:** the agent runtime that owns the model, tools and long-term memory. Here: Claude Code.
- **Surface:** a place the user talks to the agent. Here: the Electron app only.
- **Conversation:** the durable thread between the user and an agent. Owned by Intercom. The only unit the user sees.
- **Session:** one harness process and its context window. A disposable cache of a Conversation. Never shown to the user as a concept.
- **Routine:** named, standing background work. Each trigger starts a **run**. A routine is also an address that others send to.
- **Container:** a place that already groups messages. In this build: a Conversation the user created or opened in the app.
- **Note:** a message for an agent only, not shown to the user by default.
- **Run record:** the log entry for one run of a routine.

## 4. Architecture

Two programs:

- **`intercomd`, the daemon.** Owns all state and logic: storage, Conversations, sessions, context assembly, routing, the MCP endpoint, the trigger endpoint, timers. It runs headless and can be started on its own. Default implementation language: **Swift**, as the owner proposed. It runs as a plain process in this build (no launchd, no app bundle).
- **The Electron app.** A UI only. It holds no business logic. It talks to the daemon over loopback HTTP and a WebSocket event stream, like any other client would.

The daemon language is a risk, not a certainty. Before committing to Swift, run a short, time-boxed spike (suggested: half a day of effort) that proves Swift can do these five things well: serve HTTP and WebSocket, use SQLite, host a streamable-HTTP MCP server, supervise long-lived child processes and survive their death, and parse streaming JSON from a child. If any is painful, fall back to a **TypeScript daemon on Node** (the Electron toolchain already includes Node), and record the decision with the evidence. Either way, the wire protocols in this spec are the same.

Defaults:

- Daemon listens on `127.0.0.1:4747` only (configurable; do not use port 3000, which agentbus uses).
- Data directory `~/.intercom-dev/` (override with the environment variable `INTERCOM_HOME`; tests always use a temporary directory). It holds the SQLite database, attachments, logs and the token file.
- A random API token is generated on first run and stored in `~/.intercom-dev/token` with mode 0600. Every HTTP, WebSocket and MCP request must carry a valid token.
- The WebSocket stream carries events with a monotonic id, so the UI can reconnect and resume from the last id it saw.
- Time is stored as UTC ISO strings; the UI shows local time.

*Peggy's view:* keep the daemon's API surface small and documented from day one (an `API.md`), because the later Surface API will grow from it.

## 5. Data model

Entities and the fields that matter. Names are suggestions.

- **agent:** id, display name, working directory, model, extra instructions. One agent (`default`) in the UI. Tests use a second fake agent.
- **conversation:** id, title, agent_id, origin (`explicit` when the user created or opened it by hand, `implicit` when the router or a job created it), state (`active`, `dormant`, `archived`), private (bool, who set it), created_at, last_activity_at, last_user_activity_at, last_agent_message_at, pending_question (message id or null), current_summary_id.
- **message:** id, conversation_id, sender (kind: `user`, `agent`, `routine`, `script`, `system`; plus id and display name), role (`user` for the human, `agent` for text shown to the user, `note` for agent-only, `system` for notices), text, interaction (choices list, answer_needed flag, resolved choice), data (JSON, size capped), attachments, priority, key, expires_at, state (`delivered`, `held`, `superseded`, `expired`), in_reply_to (a message id or a reply handle), glance, spoken (stored only), created_at.
- **session:** id, conversation_id or run_id, harness, process id, state (`starting`, `idle`, `busy`, `evicted`, `dead`), model, last_used_at, mcp token id, context snapshot id.
- **context_snapshot:** the exact assembled context given to a session at start (for debugging and tests).
- **summary:** id, conversation_id, version, fields (topic, status, open_questions, decisions, files, commitments), written_by (session id), created_at. The last few turns are quoted verbatim by the daemon at assembly time, not stored in the summary.
- **routing_decision:** id, message id, mode (`explicit`, `heuristic`, `router`), candidates with scores, chosen conversation or `new`, confidence, threshold, applied (bool), model, latency, later correction (if the user moved the message), label correct or incorrect.
- **routine:** name, agent, instructions, prompt_source (`fixed` or `caller`), session_mode (`fresh`, `resume`, `notes`), concurrency (`queue`, `coalesce`, `drop`), max_turns, max_seconds, allowed_targets, priority_cap.
- **run:** id, routine, trigger sender, status (`queued`, `running`, `done`, `failed`, `cancelled`), outcome (`logged`, `posted`, `started`, `handed_off`, `noted`), targets touched, session id, started, ended, turn count, failure reason.
- **grant:** reply handle, granting message, granting sender, allowed responder, expires_at, used (bool).
- **token:** id, label, sender kind, scopes (`trigger`, `instruct`, `read`), allowed targets, priority cap.
- **attachment:** id, message id, name, mime type, size, stored path.

## 6. Conversations

- A Conversation has a durable, searchable transcript, kept entirely by Intercom. Sessions are rebuilt from it.
- **Origin.** Conversations the user creates by hand are `explicit`: permanent and always reattachable. Conversations created by the router (for container-less input) or by a job are `implicit`. The user may promote an implicit one to explicit ("keep").
- **Lifecycle.** Implicit Conversations age: `active`, then `dormant` after a period of inactivity, then `archived`. Eligibility for the router depends on state: active and dormant are eligible, archived is not. A direct send to an archived Conversation, or the user opening it, makes it `active` again. Explicit ones never age.
- Defaults (all configurable; tests override with seconds): active to dormant after 120 minutes idle; dormant to archived after 7 days.
- **Summaries.** When a Conversation goes dormant, when its session is evicted, and on demand, the daemon asks the agent that was in the Conversation to write a structured summary (a background turn, invisible to the user). Fields: topic, status, open questions, decisions, files, commitments. The prompt for this turn is part of the build and should be evaluated for quality.
- **Titles.** New Conversations get a placeholder title, then the agent (or the daemon via a small model) proposes a title after the first exchange. The user can rename.
- **Private flag.** Hides a Conversation from other agents. The user or the owning agent may set it, and the user's setting wins. It does not hide from the owning agent's own sessions.
- **Search.** Full-text search over transcripts (SQLite FTS5 or equivalent).

## 7. Managed sessions

The user never sees sessions. Intercom owns them.

- **Harness interface.** A small interface (start, send a turn and stream events, stop, is-alive) with two implementations: the Claude Code harness and a **fake harness** (scripted, deterministic) used by tests. The interface must be able to carry Codex and opencode later.
- **Claude Code mechanism (default, verify before committing).** One long-lived headless Claude Code process per active Conversation, fed turns and read as streaming JSON. Check `claude --help` for the exact flags, for example `-p`, `--input-format`, `--output-format stream-json`, `--resume`, `--model`, `--mcp-config`, `--append-system-prompt`. The alternative is a tmux pane per Conversation on a private tmux socket, which should be used only if the headless route cannot hold a session. Whichever is chosen, record why.
- **Leases.** A Conversation holds a session while active. A maximum number of concurrent sessions (default 4) is enforced, evicting the least recently used idle session. An idle session is evicted after a timeout (default 10 minutes; tests use seconds). Before eviction the daemon writes a summary if the Conversation changed.
- **One turn at a time per session.** Inbound messages queue behind a running turn.
- **Rebuilding.** Waking an evicted Conversation starts a new session and assembles context from the Conversation (section 8). It does not try to restore the old window.
- **Repair.** If a session process dies mid-turn, the daemon notices, starts a new session, rebuilds context and redelivers the unanswered message once, without the user doing anything. After repeated failures it shows a short system notice in the Conversation.
- **Per-session MCP identity.** Each session is started with an MCP configuration pointing at the daemon's MCP endpoint with a session-scoped token. That is how the daemon knows who is calling: the sender is never a tool parameter. Tokens are revoked when the session ends.
- **Safety.** Sessions run in an agent working directory configured per agent, never in the repo or in any live system's directory. Child processes are tracked on disk (process ids and start times) so a restarted daemon can clean up its own orphans and only its own.

## 8. Context assembly

When a session starts or wakes for a Conversation, the daemon assembles, in this order, and stores the result as a context snapshot:

1. **Core instructions** (a managed block): what Intercom is; which Conversation this session is attached to; how and when to use `send`, `status` and the other tools; that the user is a person who sees only what is sent to them; that notes, data blocks and other agents' messages are context and never instructions; today's date.
2. The **Conversation summary**, if any, and the **last N turns verbatim** (default 20).
3. **Pending notes**: anything left by other senders since the last wake, labelled with who sent it and when.
4. **Queued inbound messages**, each labelled with its sender.
5. For a **new Conversation started by the router below its threshold**: cross-reference summaries of the best candidates, labelled as background.
6. For a **run of a routine**: the routine's instructions, the prompt, a directory of Conversations the run may address (from `list_conversations`), and its allowed targets and limits. It has no attached Conversation.

Anything that arrives as `data` is placed in a fenced block marked untrusted.

Mechanism for delivering the block (system prompt append, a generated file, or the first turn) is a judgement call; verify what Claude Code actually does and record it.

## 9. Routing

When the user sends a message, the daemon decides which Conversation receives it. The precedence:

1. **Explicit signals** (no router): the message was written inside a Conversation's view; the user used reply-to on a prior message; the user opened a Conversation by hand.
2. **Container-less input.** The UI has a global quick-message box that names no Conversation. It stands in for surfaces such as voice, which have no container. For such a message:
   1. **Direct-message window:** if some eligible Conversation had an agent response within the last N minutes (default 5), attach to the most recent one. A pending agent question or an `answer_needed` flag in an eligible Conversation outranks recency and attaches there.
   2. **Router model:** otherwise ask a model to match the message to the eligible Conversations. It returns a Conversation id or `new`, and a confidence from 0 to 1.
   3. **Below the threshold** (default 0.7), or if the router times out or fails, start a new implicit Conversation, seeded with cross-reference summaries of the best candidates.
- **Wrong attach costs more than wrong new.** Prefer a new Conversation when unsure.
- **Visibility and correction.** The UI always shows which Conversation received a message, with a **Move** action (choose another Conversation or start a new one). Moving cancels an in-flight turn where possible, re-delivers the message as a new turn in the target, and leaves a system note in the original. The correction is recorded against the routing decision.
- **Router model call.** A small, fast Claude model through headless Claude Code or the API the builder verifies is available (for example Haiku 5.5). Never Groq. The prompt receives the message and up to K candidates (default 8, by recency) with title, state, summary, last turns, open question and last activity time. It returns strict JSON. A timeout (default 8 seconds) falls back to the below-threshold path.
- **Modes.** `live` (the router's choice is applied) and `shadow` (the router runs and is logged, but only explicit and heuristic rules decide; otherwise a new Conversation starts). The decision log is written in both modes. Default: `live`; `shadow` selectable in settings.
- **Evaluation.** A labelled set of at least 30 synthetic scenarios (several Conversations with summaries plus an incoming message and the expected target, including ambiguous and `new` cases) and a command that replays them against the router and reports accuracy, by category. The user can also label real decisions as correct or incorrect in the UI.

## 10. The MCP interface

One MCP server hosted by the daemon (streamable HTTP at a path such as `/mcp`; confirm what Claude Code supports and how it passes headers). Tools:

### 10.1 `send`

Parameters:
- `target`: a Conversation id, a routine name, or `new` (with optional `title`). **Omitted** means "the Conversation this session is attached to". A session with no attached Conversation (a run) must supply a target; omitting it is rejected.
- `agent_message`: text for the receiving agent, not shown to the user. In own-Conversation mode it is ignored or rejected.
- `user_message`: text shown to the user.
- `data`: opaque JSON, size capped (default 16 KB), delivered to the receiving agent in a fenced untrusted block.
- `attachments`: files to attach (paths checked against an allowed set of roots; copied into the daemon's store).
- `priority`: `low`, `normal`, `high`, `urgent`.
- `wake_agent`: boolean (cross-Conversation only).
- `accept_response`: boolean (cross-Conversation only).
- `in_reply_to`: a reply handle from an earlier grant, used to answer a message when the sender is not otherwise allowed to message the target.
- `choices` (1 to 8 labels) and `answer_needed`: interaction shapes of a user message.
- `key` and `expires_after_seconds`: supersession and expiry.
- `idempotency_key`.
- `glance` and `spoken`: accepted and stored, not rendered in this build.

Meaning of the combinations:
- Own Conversation, `user_message` (or `agent_message` as the visible text): speaks to the user. The cooldown does not apply, since the user is in the exchange.
- Cross-Conversation, no `user_message`, `wake_agent` false: an inert **note**, found by the receiving agent at its next wake. No turn starts.
- Cross-Conversation, no `user_message`, `wake_agent` true: a **silent handoff**. The receiving Conversation's agent runs a turn with the message and decides whether the user hears anything.
- Cross-Conversation, `user_message`, `wake_agent` false: the user is told; the agent finds the note when the user next writes.
- Cross-Conversation, `user_message`, `wake_agent` true: the user is told and the agent acts now.
- `target: new` requires a `user_message`; it creates an implicit Conversation seeded with the agent message as context.

Rules:
- **Sender is implicit**, taken from the calling token.
- **First contact is always allowed.** Replies are gated: a sender may message a target that has previously messaged it only if the earlier message set `accept_response`, via the reply handle. The grant covers one reply, expires (default 24 hours), and a reply carries `accept_response` false unless set.
- **Attribution:** messages from a sender other than the Conversation's own agent are recorded and shown as coming from that sender (for example "from routine bill-watch"), so the Conversation's agent never believes it said them.
- **Priority** governs how the user is reached: `low` makes no unread count and no notification; `normal` makes an unread count; `high` adds a desktop notification; `urgent` also bypasses the idle cooldown and shows a banner. A token's priority cap limits what a sender may claim.
- **Idle cooldown:** a `user_message` from a non-attached sender is posted only if the Conversation has been idle (no user activity and no turn in progress) for N minutes (default 5; tests use seconds). Otherwise it is **held** and delivered with the user's next message (labelled as from its sender) or when the idle period ends. Urgent bypasses.
- **Supersession and expiry:** a newer message with the same key, target and sender replaces the older (state `superseded`); a message past `expires_after_seconds` becomes `expired` and is never delivered if it was still held.
- **Hop limit:** every send carries a hop count that grows along wake chains; above the limit (default 4) it is rejected.
- **Returns:** `delivered`, `queued` (held or waiting on a turn, with a reason), or `rejected` (with a reason: unknown target, not permitted, reply not permitted, bad parameter, hop limit, private, rate limit). The result includes the message id and, when `accept_response` was set, a reply handle. Never silently accept something undeliverable.
- **Interaction:** choices render as buttons; a tap sends `[tapped] <label>` into the Conversation as if typed and resolves the interaction. `answer_needed` marks the Conversation as needing the user until answered.
- **Data is data:** never instructions, in any sender kind.

### 10.2 `status`

`status(text, handle?)`. Shows a short, ephemeral "working on it" line. In an attached Conversation the handle is implicit (the turn being worked on); a run reporting progress to a Conversation uses a handle returned by its first `send`. A status never wakes anyone, never notifies, is rate limited and coalesced, clears when the turn ends or a message lands, and is kept only in the run record.

### 10.3 `list_conversations`

`list_conversations(agent?, query?, states?, limit?)`. Returns, per Conversation: id, title, state, last activity, one-line summary, open question if any. `agent` scopes to that agent's eligible Conversations and defaults to the caller. A different agent's private Conversations never appear. With `query`, results are ranked by relevance using the same router logic, with a score.

### 10.4 `read_conversation` and `search_conversations`

`read_conversation(id, before?, limit?)` returns the summary and a page of the transcript. An agent may read all Conversations of its own agent; for another agent (later), summary and search results only, never private. `search_conversations(query, agent?)` returns matching snippets.

### 10.5 `update_conversation`

`update_conversation(id, title?, private?)`. The user's setting of `private` wins over an agent's.

## 11. Agent-initiated work

A run is not a Conversation, because no user is engaged yet. It runs as its own session and decides what to do.

- **Routine definition.** Name, agent, standing instructions, `prompt_source` (`fixed`: the caller's payload is data only; `caller`: the caller's text is the instruction, allowed only for senders whose token has the `instruct` scope), session mode, concurrency policy, limits (`max_turns`, `max_seconds`), allowed targets, priority cap. Written so a later version can hold a list of steps (script steps, agent steps); this build has one agent step.
- **Trigger.** `POST /v1/routines/{name}/trigger` with a scoped token, a JSON body (`prompt?`, `data?`, `priority?`, `idempotency_key?`, `wait?`) and an immediate answer carrying a run id. Local only. A trigger is a `send` from a non-agent sender, subject to the same permission, idempotency and data rules. An optional small CLI wraps it.
- **Outcomes** of a run: log only (nothing sent, a normal result), post to a Conversation, start a new Conversation, hand off silently, leave a note. The run records which.
- **Concurrency:** `queue` (default), `coalesce` (a newer trigger replaces a queued one), `drop`.
- **Limits:** a run over `max_turns` or `max_seconds` is stopped and marked failed with reason `ceiling`.
- **Session modes:** `fresh` (default), `resume` (keeps the session across runs), `notes` (a notes file in the data directory; may be deferred).
- **Run record:** name, trigger, start and end, status, outcome, targets touched, turn count, failure reason, and a link to the run's transcript. Shown in an Activity view; the Conversation's agent can read it.
- **Guard rails:** hop limit, limits above, scoped tokens, payloads as data, rate limits per sender.
- Schedules are **not** part of this build. Triggers come from the HTTP endpoint (and the CLI) and from other agents' `send` to a routine name.

## 12. User interface

Electron, with `contextIsolation` on, `nodeIntegration` off and a minimal preload. The UI is a client of the daemon; it can be restarted without losing anything. Stack choice (for example React with Vite, or another small framework) is the builder's call; keep dependencies modest.

**Simple but not unstyled.** Use one design-token file (colors, spacing on an 8-pixel grid, radius, type scale), the system font stack, a restrained palette with light and dark modes, clear focus states, real empty states and loading states, consistent components, and a layout that reads well at ordinary desktop sizes. No ornamental effort beyond that. Verify visually with screenshots, which are saved in the docs.

Screens and behaviors:

- **Conversation list (sidebar):** grouped as Needs you, Active, Dormant, Archived (collapsible); unread markers; a lock for private; origin shown (explicit or implicit); a search box; New conversation; "keep" to promote an implicit one.
- **Conversation view:** transcript with the user's messages and the agent's; senders other than the Conversation's agent labelled ("from routine X", "from another conversation"); notes hidden behind a "show agent notes" toggle; a status line while the agent works; buttons for choices; a banner for urgent messages; attachments as chips, images inline; a routing badge where routing was applied ("Sent here, 0.82. Move…"); reply-to; a composer (Enter sends, Shift+Enter newline).
- **Quick message box** (global, in the top bar): sends with no container and exercises the router.
- **Details drawer** for a Conversation: summary, state, private toggle, rename, session state (alive, idle, evicted, model), pending notes, held messages.
- **Activity view:** runs with outcome, status, duration, targets; open one to see its transcript and what it did.
- **Routing view:** the decision log (message, candidates, scores, choice, confidence, mode, applied or not), a way to label decisions correct or incorrect, and a button to run the evaluation set.
- **Routines view:** list, definition editor (a simple form or JSON), a Trigger button, tokens (copy, create, revoke).
- **Settings:** tunables (section 16), router mode, theme, daemon address.
- **Notifications:** Electron desktop notifications for `high` and `urgent`.

Message text is rendered as a safe Markdown subset. No raw HTML. Links open in the system browser. Agent-supplied content is untrusted.

## 13. Security and safety

- Daemon binds to loopback only; every request needs a valid token; the token file is mode 0600; no CORS.
- Session tokens are scoped, short-lived and revoked at session end. Script tokens carry scopes, allowed targets and a priority cap.
- Attachment paths are checked against configured allowed roots; no path outside them is read.
- Secrets are never written to logs, transcripts or the progress documents.
- Untrusted content (data, notes, other agents' messages, router input) is never promoted to instructions.
- Tests and development use a temporary or dedicated data directory. Nothing in this build touches the owner's live systems: not agentbus, its pm2 processes, its `peggy-pool` tmux server, the Telegram bot or its tokens, or any memory directory.
- No Groq, for any purpose.
- No personal data in the repo; it is intended to go public later under the MIT license.

## 14. Repository and engineering

- New repo at `~/workspace/intercom` (local only; no remote, no push, no GitHub repo without the owner's go-ahead). MIT license. If that directory already exists and is not empty, stop and ask.
- Suggested layout: `daemon/`, `app/` (Electron), `docs/`, `tests/`, `scripts/`. Documents: `docs/SPEC.md` (a copy of this spec), `docs/ARCHITECTURE.md`, `docs/API.md` (HTTP, WebSocket, MCP), `docs/DECISIONS.md`, `docs/PROGRESS.md`, `README.md` with run instructions.
- Small, frequent commits on a working branch or `main` with clear messages. Tests run with one command.

## 15. Testing and acceptance

Two kinds of tests: automated tests against the **fake harness** (deterministic, fast, run everywhere) and **live tests** against real Claude Code on a cheap model (a limited number, run on purpose and recorded, since they cost money). Each scenario below must pass, and the acceptance run is written up in `docs/ACCEPTANCE.md` with evidence (logs, screenshots).

1. **Round trip.** Create a Conversation in the UI, send a message, a real Claude Code session replies; restart the daemon and the app; the transcript is intact.
2. **Crash repair.** Kill the session process mid-turn; the user's message is answered after an automatic retry, with no user action.
3. **Eviction and recall.** After the idle timeout the session is evicted and a summary written; the next message rebuilds a session, and the agent correctly recalls a fact told earlier.
4. **Explicit routing.** A message written in a Conversation, and one sent with reply-to, go to the right Conversation without the router.
5. **Direct-message window.** A quick message shortly after an agent reply attaches to that Conversation.
6. **Pending question outranks recency.** With two recent Conversations, a quick message answering an open question goes to the one that asked.
7. **Router by topic.** With several Conversations on distinct topics, a quick message about one of them attaches there. The labelled evaluation set runs and reports accuracy by category; flag if clear cases score below 80 percent.
8. **Low confidence.** An unrelated quick message starts a new Conversation, cross-referenced and seeded with a summary of the nearest candidate.
9. **Move and undo.** Moving a misrouted message re-delivers it correctly and records the correction.
10. **Lifecycle.** An implicit Conversation ages to dormant (with a summary written) and then archived; archived ones are not eligible for the router; explicit ones never age; a direct send reactivates an archived one.
11. **Summary quality.** A summary contains the structured fields and is used to seed a new Conversation.
12. **Own-Conversation send.** `send` with no target speaks to the user in the attached Conversation.
13. **Cross-Conversation post.** A session posts a `user_message` with an `agent_message` into another Conversation; the user sees it labelled with its sender; when the user replies, that Conversation's agent knows what the message was about.
14. **Silent handoff.** `wake_agent` true with no `user_message` starts a turn in the receiving Conversation without telling the user; the agent's choice to message the user or not is visible in the Activity view.
15. **Note without wake.** An inert note appears in the next wake's context, not in the UI transcript, and starts no turn.
16. **Reply grants.** A reply through `in_reply_to` succeeds once; a second reply, an expired grant, or a reply without a grant is rejected with a reason; first contact is always allowed.
17. **Cooldown.** A routine's `user_message` during an active exchange is held, then delivered with the next user message or at the idle timeout; urgent bypasses.
18. **Keys and expiry.** A newer message with the same key supersedes the older; an expired held message is never delivered.
19. **Priority.** Low, normal, high and urgent produce the specified unread, notification and banner behavior; a token's cap is enforced.
20. **Interaction.** Choices render as buttons; a tap arrives as `[tapped] <label>`; `answer_needed` marks the Conversation Needs you until answered.
21. **Status.** A status line appears during a turn and clears afterwards; a run's status uses its handle.
22. **Attachments.** A file and an image attached by an agent display correctly; a path outside the allowed roots is rejected.
23. **Routines.** An HTTP trigger with a caller prompt starts a run and returns a run id; queue, coalesce and drop behave as specified; the ceiling stops a runaway run; the run record is complete; a caller prompt with a token lacking the `instruct` scope is rejected; a routine can start a new Conversation (`target: new`).
24. **Directory and privacy.** `list_conversations` ranks by relevance, honours the `agent` parameter, and hides another agent's private Conversations (tested with two fake agents); a private flag set by the user cannot be unset by an agent.
25. **Hop limit.** A wake chain above the limit is rejected.
26. **Data as data.** A payload containing "ignore your instructions" appears in a fenced untrusted block in the assembled context (checked in the context snapshot) and does not change behavior.
27. **UI.** Every screen in section 12 exists, works and is styled, in light and dark; screenshots are in the docs.
28. **Documentation.** README run steps work on a clean checkout; ARCHITECTURE, API, DECISIONS, PROGRESS and ACCEPTANCE are complete and current.

## 16. Tunable defaults

All in one settings file and the Settings screen. Tests override with short values.

- Session idle eviction: 10 minutes. Max concurrent sessions: 4.
- Active to dormant: 120 minutes. Dormant to archived: 7 days.
- Direct-message window: 5 minutes. Router confidence threshold: 0.7. Router timeout: 8 seconds. Router candidates: 8.
- Idle cooldown: 5 minutes. Reply grant expiry: 24 hours. Hop limit: 4.
- Context: last 20 turns verbatim. Data field cap: 16 KB.
- Routine limits default: `max_turns` 20, `max_seconds` 600.

## 17. Judgement calls the builder may make, and how to report them

The builder is empowered to decide anything the spec leaves open or where a better answer appears, using judgement. Every such decision is recorded in `docs/DECISIONS.md` with: what was decided, the options considered, why, how reversible it is, and whether it changes the spec. Decisions that change the spec, or that the owner would plausibly want to overrule, are flagged **Needs review** and repeated in the next progress entry. Examples of calls expected here: the daemon language, the Claude Code session mechanism, how context is delivered to a session, the router prompt and model, the UI framework, the summary prompt, and the exact tunables.

The builder must stop and ask before: changing anything in section 2's out-of-scope list, creating a remote repo or pushing anywhere, touching a live system, spending beyond what the progress document states as the expected cost, weakening a rule in section 13, or abandoning the Electron plus daemon split.

## 18. Deferred and open

Not in this build: schedules, other surfaces, presence, multi-agent, harness breadth, skills and `INTERCOM.md`, short-term memory (`recent.md`), setup and packaging, retention and deletion, muting, a workflow engine for routines. Still to decide later: which surface hears a job's message once more than one exists (the default policy is agreed: container, last-acted, then app and push), and the shape of routine steps.

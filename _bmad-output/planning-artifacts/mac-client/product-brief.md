# AgentBus Mac Client — Product Brief

**Version:** 0.4 · **Status:** Ready for PRD · **BMAD Phase:** 1 — Analysis · **Parent:** `_bmad-output/planning-artifacts/PRD.md` · **Date:** 2026-09-29

Working name: **AgentBus for Mac**. Branding is agent-neutral: the app shows
whichever agent the connected bus routes to.

---

## 1. Summary

A native macOS chat app backed by a new, generic AgentBus channel, `app`.
The sidebar lists sessions. That includes the app's own sessions and every
user-started session on the bus, whichever channel it began on (Telegram,
email, Siri). You can open any of them and keep talking to the agent from
the Mac, and you can send files to the agent. The agent also works in the
background through the AgentBus scheduler and messages you in the app when
it has something to say.

The first deployment is a separate AgentBus instance on a work laptop,
running a work agent. The bus and the app run on the same machine and are
only active while the laptop is awake.

## 2. Problem

- **No neutral first-party client.** Telegram is the main chat surface, but
  it's a personal third-party account tied to one bot per agent. A work
  agent on a work laptop needs a client that doesn't route work
  conversations through a personal Telegram account.
- **Parallel conversations need workarounds.** Telegram needs a forum-topic
  supergroup for separate sessions. Even with topics, `cc-headless` runs one
  turn at a time per contact (`HeadlessInstance.enqueue` keys on
  `contactId`), so one user's conversations queue behind each other.
- **Sessions are tied to the channel they started on.** A Telegram session
  can only be continued from Telegram, and an email thread only by email.
  No single place shows every conversation with the agent.
- **Background work has nowhere good to land.** Scheduled jobs can
  `send_message` to a channel, but on a work machine there's no approved
  channel to send to.

## 3. Target user

The operator: one person running their own AgentBus instance and agent.
They work at a Mac and want a main conversation plus several
topic-specific conversations in parallel, and they want the agent to reach
them proactively.

Multiple users are out of scope. The app talks to one bus as one contact,
and serves one agent.

## 4. Usage model

This mirrors how Peggy is used on Telegram today:

- **Main conversation.** The `app` channel's default topic (`general`) is
  the main conversation, like a Telegram DM. It's the default destination
  for anything the agent sends proactively. The user occasionally runs
  `/clear` to start a fresh context.
- **Topic conversations.** "New conversation" creates an `app` thread topic
  (`thread:<hash>`, E27 thread store). Each is its own long-lived session,
  like a Telegram forum topic, and runs in parallel with Main and with each
  other.
- **Sessions from other channels.** Telegram DMs and topics, email threads,
  and Siri asks appear in the sidebar with their channel shown. The user can
  read them and reply from the app.
- **Background work.** The agent runs scheduled jobs (`schedule_message`,
  cron) in their own `sched:` sessions. When a job produces something worth
  telling the user, the agent calls `send_message` on the `app` channel.
  Main is the default, but the agent can target a specific topic session.
  These sessions don't appear in the sidebar; only their messages to the
  user do.

### Sidebar rules

- **Each session is its own sidebar item.** When `/clear` closes Main's
  session, a new Main session starts and the closed one moves to an
  "Earlier" section. The same applies to topic conversations.
- **Earlier sessions can be resumed while the agent side still has them.**
  If the underlying `claude` session (`claude_session_id`) can still be
  resumed, sending into an Earlier session reopens it with `--resume`.
  Otherwise the session is read-only, and the app says so in the composer.
- **Only the connected agent's sessions are listed.** The app serves one
  agent: the one the bus routes the `app` channel to. On a bus with several
  agents, sessions owned by other agents (`sessions.agent_id`) are hidden.
- **Only user-started sessions are listed.** Scheduler sessions (`sched:`
  topics and `system:*` senders) and journaling turns are hidden.
- Each item shows the originating channel, title (a topic name or the first
  message), last activity, unread count, and whether the agent is working.

## 5. How it fits AgentBus

```
Mac app ◀──WebSocket (localhost)──▶ bus-core: app adapter ──▶ processInbound() ──▶ pipeline ──▶ queue ──▶ cc-headless
                                            ▲       ◀── DeliveryWorker ◀── reply / send_message
                                            └── outbound transcript events for every listed session (all channels)
Mac app ──HTTP multipart (uploads)──▶ bus-core: attachments
```

| Concern | Decision |
|---|---|
| Channel | `app`, generic across agents and deployments. One agent per bus for this channel, set by `pipeline.routes` |
| Transport | WebSocket for events (messages, typing, tool-call status, approvals) and for sending, with cursor-based catch-up on reconnect. File uploads go over HTTP multipart |
| Network | Local only (`127.0.0.1`) for the MVP. Tailscale (`tailscale serve` on the adapter's path prefix, like Siri) is optional later |
| Identity | Bearer token in `contacts.<id>.platforms.app.token` (the Siri and Pebble model). It's still required on localhost, since other local processes can reach the port |
| Agent runtime | `cc-headless`, with parallel turns per conversation and a concurrency limit (§6.1, epic 1) |
| App-native sessions | Main = `app` + `general`; topics = `app` + `thread:<hash>` |
| Other-channel sessions | Continued in place: a message sent from the app joins that session's existing conversation and `claude` session, and is routed to the session's owning agent (`sessions.agent_id`) |
| Agent context | Every inbound message tells the agent which channel it arrived on and which session it belongs to (for example: via `app`, continuing a `telegram:peggy` session). The system prompt gets `app` channel guidance (full Markdown is fine) |
| Delivery | The app shows a superset of the agent's outbound messages: everything it sends to the user on any channel (Telegram, email, Siri) appears in the app in the matching session. The agent can also send to the app only, by targeting the `app` channel. A reply to a message sent from the app goes back on `app`. Messages sent while the app is closed are kept and delivered on reconnect |

## 6. MVP scope

### 6.1 Candidate epics

These are ordered by dependency. The PRD will turn them into requirements.

1. **Parallel conversations in `cc-headless`.** Serialize per conversation
   (`conversation_id`), not per contact, so turns in different sessions for
   the same user run at the same time. This covers:
   - **A concurrency limit per agent**, configurable, with a default of 5
     simultaneous `claude -p` processes:
     - User-started turns (triggered by a contact's message on any channel)
       can use at most 4 slots (the total minus the reserved slots).
     - At least 1 slot is reserved for system-started turns (scheduler
       fires, journaling, post-restart wakeups).
     - A system-started turn can also take any free slot that user-started
       turns aren't using.
     - Turns that can't get a slot wait in order, and the app shows them as
       queued.
   - `/stop` scoped to the conversation it's sent from (today it kills the
     sender's single in-flight turn).
   - Journaling turns serialized with their own conversation only.
   - Safe concurrent writes to shared memory files (see §9).

   This supersedes the backlog item "per-conversation serialization for the
   `siri` channel."
2. **`app` channel adapter and client API.** This covers:
   - token auth;
   - the WebSocket connection: sending into a session (a new app topic,
     Main, or an existing session), and receiving events with cursor-based
     catch-up after disconnect, sleep, or bus restart;
   - a copy of every agent message to the user on any channel, so the app
     shows the full set (fed from outbound transcripts, not from the other
     adapters' `send()`);
   - listing sessions and paginated history from transcripts;
   - resuming an Earlier session when its `claude_session_id` can still be
     resumed, and a read-only state when it can't;
   - multipart file upload into the existing attachments machinery
     (`persistAttachmentBuffer`, per-agent `media` config, TTL sweep), so
     the agent sees the same `[File: …]` and `[Image: …]` lines as on
     Telegram;
   - declared capabilities (typing, tool status, approvals, slash commands);
   - creating and renaming topic sessions.
3. **Cross-channel session continuation.** Let an inbound message join an
   existing session from a different channel. The session binding comes from
   the client, not from `sha256(contact, channel, topic)`. The message is
   routed to the session's owning agent, and the arrival channel is shown in
   the agent-facing header. Transcripts record both the session and the
   arrival channel. `/clear` and `/stop` from the app act on the targeted
   session.
4. **Proactive delivery to the app.** Make `send_message` on `app` with no
   topic land in Main by default. Document the scheduler-to-app pattern for
   background jobs. Store messages sent while no client is connected and
   raise a macOS notification when they're delivered. On wake, each overdue
   schedule fires once.
5. **macOS app MVP** (`apps/macos/`, SwiftUI, XcodeGen, its own
   `CLAUDE.md`). The app is self-contained and shares no code with
   `apps/ios/Peggy`. It covers:
   - setup (bus URL, which defaults to localhost, and a token in Keychain);
   - the session sidebar (§4);
   - a transcript view that renders Markdown and code;
   - a composer with slash-command autocomplete and drag-and-drop or paste
     for attachments;
   - the agent activity view (typing, tool-call trail, queued for a free
     slot) and a `/stop` button;
   - Approve/Deny for approval requests (E51);
   - notifications and a Dock badge;
   - reconnecting after sleep and wake.

### 6.2 Out of scope for the MVP

- **The agent sending files to the user.** No outbound attachments on any
  channel. This may be added later.
- Remote access. Tailscale exposure is designed for, but not built.
- An iOS target. The project may add one later, but the MVP is macOS only.
- Switching between agents in the app.
- Multiple users, or several contacts sharing a conversation.
- Showing scheduler or journaling sessions.
- Mac App Store distribution or notarized builds. The app is built locally.
- Token-level text streaming (deferred, as in E29).
- Running the bus while the laptop sleeps.

## 7. Success criteria

- The work agent on the work laptop is used through the app daily.
- Four user conversations with active turns run at the same time, with no
  cross-talk. While all four are busy, a scheduled job still starts right
  away in the reserved slot. A fifth user turn waits and shows as queued.
- A Telegram session on the personal bus can be continued from the app, and
  the agent's reply shows it knew the message came through the app.
- Every message the agent sends to the user on Telegram also appears in the
  app, in the matching session.
- A scheduled job's message reaches Main, including when the app was closed
  at the time: it's delivered on the next launch and raises a notification.
- No lost messages across app quit, laptop sleep, or bus restart.
- A file dragged into the app, up to the size limit (proposed: 25 MB), is
  readable by the agent.

## 8. Deployment picture (work laptop)

- One AgentBus instance, with its own `config.yaml`, database, and agent
  working directory. It shares nothing with the personal Peggy bus.
- `cc-headless` hosts the work agent. `pipeline.routes` sends `app` to it.
- The bus runs under pm2 or launchd at login, and the app connects to
  `127.0.0.1:<port>`.
- There are no other channels at first. The design shouldn't assume
  Telegram or email are present.

## 9. Risks and constraints

| Risk | Mitigation to explore |
|---|---|
| Parallel turns write the same memory files (daily journal, `MEMORY.md`) at the same time. | Serialize journaling turns across the agent, or add file locking or append-only daily entries. Decide in architecture |
| Parallel `claude -p` processes multiply cost, API rate-limit exposure, and laptop load. | The concurrency limit, and per-turn cost already recorded in `turn_costs` |
| Cross-channel continuation breaks the assumption that `conversation_id` is derived from the channel. `reply`, `/clear`, `/stop`, the typing endpoint, and journaling all assume it. | A dedicated epic with a full audit of channel-keyed lookups |
| Replying into a Telegram session from the app means the Telegram chat has gaps: exchanges held through the app don't appear there. | Accepted. The app is the complete view, and the agent can still choose to send to Telegram |
| The laptop sleeps with a turn in flight, or a schedule comes due while asleep. | WebSocket catch-up by cursor. Overdue schedules fire once on wake (verify current scheduler behavior in architecture) |
| Showing sessions from all channels exposes email and Telegram content in the app. | The same token is the identity; it's the same user's own data |

## 10. Decisions recorded (2026-09-29)

| Topic | Decision |
|---|---|
| Channel name | `app`, generic across agents |
| Sidebar unit | One item per session. Sessions closed by `/clear` move to "Earlier" |
| Earlier sessions | Resumable while the agent-side session still exists; read-only otherwise |
| Agents per app | One agent per app instance, set by the `app` route. Switching between agents is post-MVP |
| Branding | Agent-neutral |
| Other channels | All user-started sessions for the app's agent are listed and can be continued from the app |
| Agent awareness | The agent is told which channel each message arrived on |
| Outbound visibility | The app shows every agent message to the user on any channel, and the agent can target the app alone |
| Main conversation | `app` + `general`, the default destination for proactive messages |
| Missed schedules | An overdue schedule fires once on wake |
| Agent runtime | `cc-headless`, extended for parallel conversations |
| Concurrency | Configurable; default 5 per agent. User-started turns use at most 4. At least 1 slot is reserved for system-started turns, which can also use free user slots |
| Transport | WebSocket |
| Files | The user can send files to the agent. The agent sending files is out of scope |
| Network | Local only for the MVP. Tailscale is optional later |
| App location | New, self-contained `apps/macos/` project. No shared code with `apps/ios/Peggy`. An iOS target may be added later |

## 11. Open questions

None blocking the PRD. The architecture pass will settle how memory-file
writes are made safe under parallel turns, the WebSocket message schema,
and the attachment size limit.

## 12. Next steps

1. Write the PRD with stable FR IDs for each candidate epic in §6.1.
2. Run an architecture pass, starting with parallel `cc-headless` and
   cross-channel continuation, since those change core assumptions.
3. Create formal epics. Parallel `cc-headless` stands on its own and
   benefits the existing Telegram deployment too.

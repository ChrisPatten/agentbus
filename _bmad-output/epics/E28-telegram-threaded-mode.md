# E28 — Telegram Group Topics & Reply Context

| Field | Value |
|---|---|
| Epic ID | E28 |
| Dependencies | E27 (generic thread store — `threads` table, `src/pipeline/thread-store.ts`, shared `topicForThreadKey`). E20 (long-lived per-`conversation_id` sessions). |
| Story Count | 6 |
| Estimated Complexity | M |

---

## ⚠️ Pivot (2026-08-18): DM Threaded Mode retired, Group Topics adopted instead

This epic originally targeted Telegram's DM Threaded Mode (a per-bot BotFather
toggle that extends forum topics into 1:1 chats). Chris hand-tested it against
a throwaway bot and found that once it's on, **every message appears to
require a thread — there's no way to keep a plain non-topic default area**.
That breaks the epic's original premise (keep the DM's long-running main
conversation exactly as-is, add optional topics on top of it) and would have
forced the *existing* main session itself into a topic structure, a much
bigger UX change than intended.

Same day, Chris tested the alternative — a Telegram **group** with forum
topics — and it holds up:

- Group forum topics are a mature feature (supergroups, since ~2022), not the
  ~7-week-old private-chat Threaded Mode.
- Verified (WebFetch/WebSearch against Telegram's own Bot API docs): a
  message sent with no `message_thread_id` in a topic-enabled supergroup
  lands cleanly in the **General** topic by default. The clean non-topic
  fallback that DMs lack, groups already have.
- Live-tested end-to-end against the real `peggy` bot the same day (see
  Entry Criteria below) — group messaging to the bot is confirmed working.

**Resulting paradigm, now the design target for this epic:**

- **DMs stay exactly as today.** One long-running session per contact, no
  topics, no threading. `threaded_mode` is dropped entirely — it never ships.
- **Groups get full topic support.** A topic-enabled group is its own
  channel, distinct from any contact's DM channel. Every topic in that group
  — including its default "General" topic — is its own long-lived session
  with its own history, built on E27's generic thread store exactly as
  originally designed, just scoped to groups instead of DMs.
- Reply-to-message (quoted context, S28.5) is unaffected by this pivot — it
  was always orthogonal to thread routing and works the same in a DM or a
  group.

The rest of this document is rewritten around that paradigm. Where a story
below still resembles its original DM-oriented shape, that's because the
underlying mechanism (E27's `(channel, topic) → thread_key/metadata` store)
generalizes cleanly — chat-scoped thread keys don't care whether the chat is
a DM or a group.

---

## Epic Summary

1. **Groups become their own channel.** A message arriving from a Telegram
   group is *not* the same conversation as that sender's DM, even though it's
   the same bot and (usually) the same allowlisted sender. The adapter must
   distinguish **which chat** a message came from (`msg.chat.id`,
   `msg.chat.type`) from **who sent it** (`msg.from.id`) — a distinction the
   adapter doesn't make today, since a DM's `chat.id` and the sender have
   always been treated as interchangeable. **Decided (Chris, 2026-08-18):
   auto-routing** — the channel is derived dynamically from chat type at
   inbound time (`msg.chat.type === 'private'` → today's per-bot channel,
   unchanged; otherwise → a group-scoped channel keyed by `chat.id`), with
   **no separate per-group config entry** required. This also explicitly
   does **not** extend to routing different groups/topics to different
   underlying agents/bots — one bot instance, one agent, auto-derived
   channels only. Multi-agent routing (e.g. a different bot/persona per
   group) is out of scope for this epic and not being designed for yet.

2. **Forum topics → per-thread sessions, built entirely on E27's generic
   mechanism** — no new table. Derive `topic = thread:<hash>` via the shared
   `topicForThreadKey()` from a chat-scoped thread key
   (`${chatId}:${messageThreadId}`), let the existing
   `topic-classify`/`route-resolve` machinery give it its own
   `conversation_id` and long-lived session, and persist `{ chatId,
   messageThreadId }` through `getThread`/`upsertThread` (E27) keyed on
   `(channel, topic)` so outbound sends land back in the right chat *and*
   topic. This applies to every topic in the group, including "General" —
   there's no special-casing, since Telegram's own General-topic fallback
   already does the right thing (no thread id needed).

3. **Outbound sends must resolve chat_id from thread metadata, not just from
   the contact map.** Today's `send()` (`src/adapters/telegram.ts:329+`)
   looks up the target `chat_id` purely from `contactChatIdMap` — it assumes
   every contact has exactly one chat (their DM). That's still correct for
   DMs, but wrong for a group topic: the group's `chat_id` isn't in that map
   at all. `send()` needs to check `getThread(db, channel, topic)` first for
   `thread:`-prefixed topics (which carries the group's `chat_id` in its
   metadata, per E27) and fall back to `contactChatIdMap` only for ordinary
   DM sends.

4. **Reply-to-message is a context annotation, not session routing** (unchanged
   from the original design, generalizes to groups with zero extra work). A
   user quote-replying to a message — in a DM or a group, topic or not — is a
   conversational gesture, not a request to fork a new conversation. Inbound
   `reply_to_message` is surfaced to the agent as **quoted context only**
   (mirroring how reactions already render as `[reacted 👍 to message
   555:42]` in `formatMessagesForSampling`), and outbound replies use the
   **already-existing** `reply_to` field (bus message ID, currently accepted
   by `send_message`/`reply` but never turned into an actual Telegram reply)
   to produce a native reply quote via `reply_parameters`. This has nothing
   to do with E27's thread store — it never touches `threads` at all.

5. **Authorization needs no new mechanism.** A real open question from the
   original design ("if anyone besides Chris ever lands in the group, does
   Peggy respond, ignore, or just log context?") turns out to already be
   answered by the *existing* sender allowlist (`allowedSenderIds`, built
   from `config.contacts[*].platforms.telegram.userId`,
   `src/adapters/telegram.ts:275`) — it's sender-based, not chat-based, so it
   already gates group messages exactly like DM messages. A message from
   someone not in `allowedSenderIds` gets dropped in a group today with zero
   changes (confirmed live, see Entry Criteria). Adding a second contact to
   the allowlist (e.g. Kate) would let her post in the group under her own
   identity/session, same as it would for a DM — no group-specific
   authorization layer needed.

---

## Entry Criteria

- **E27 complete:** `threads` table and `src/pipeline/thread-store.ts`
  (`getThread`/`upsertThread`/`patchThreadMetadata`) exist and are exercised
  by the (retrofitted) email adapter.
- **Operator prerequisites (outside the codebase), all verified live against
  the real `peggy` bot on 2026-08-18:**
  1. The chat must be an actual **supergroup with Topics enabled**
     (`is_forum: true`) — a client-side group setting (Group → Edit →
     Topics), not a BotFather toggle. A small basic group auto-upgrades to a
     supergroup when this is turned on.
  2. **Group Privacy Mode must be disabled** for the bot via BotFather
     (`/mybots` → pick the bot → Bot Settings → Group Privacy → Disable) —
     by default a bot in a group only receives messages that @-mention it,
     reply to it, or are slash commands. Confirmed live: without this,
     ordinary group messages never reach AgentBus at all (not even a
     rejected/dropped log line — Telegram never delivers the update).
  3. **After toggling Privacy Mode, the bot must be removed from the group
     and re-added** for the change to take effect — flipping the BotFather
     setting alone is not enough. Confirmed live.
  4. If the agent should create topics itself (S28.4), the bot needs admin
     rights with **"Manage Topics"** specifically — stricter than the
     now-retired DM design, which needed no admin rights at all (that
     exemption was supergroup-only to begin with).
  5. A group member with "Remain Anonymous" enabled posts as
     `@GroupAnonymousBot` (fixed Telegram user id `1087968824`), not their
     own account — their real messages will be dropped as an unknown sender
     until that's turned off for them personally. Confirmed live (this is
     what the initial 2026-08-18 test hit before Privacy Mode was even
     identified as the deeper issue).
- `pipeline.route-resolve` already computes `conversation_id =
  sha256(sorted([contact_id, channel, topic]))`; `topic-classify` already
  preserves `thread:`-prefixed topics verbatim
  (`src/pipeline/stages/topic-classify.ts:26-31`).

---

## Exit Criteria

1. A message from an allowlisted contact posted in a topic-enabled Telegram
   group resolves to a channel distinct from that contact's DM channel —
   messages from the same person in their DM and in the group never share a
   `conversation_id`.
2. Within that group channel, each topic (including "General", which carries
   no `message_thread_id`) is its own long-lived session — two different
   topics resolve to two distinct `conversation_id`s, and General is not
   special-cased relative to named topics.
3. An agent reply to a message that arrived in a group topic is posted back
   into the correct chat (`chat_id`) *and* the correct topic
   (`message_thread_id`) — `send()` resolves both from E27's thread metadata
   for `thread:`-prefixed topics, not from `contactChatIdMap` alone.
4. The agent can originate a new topic in a group on its own initiative (new
   MCP tool) and reference it later (e.g. in a `schedule_message` call) via
   the `thread:<hash>` topic the tool returns. The tool verifies/requires
   "Manage Topics" admin rights and is group-only — it is not offered for DM
   channels, since DM Threaded Mode is retired.
5. A message from a sender not in `allowedSenderIds` — whether posted in the
   group directly or via an anonymous-admin identity — is dropped exactly as
   it is today, with no group-specific authorization code added.
6. A user reply-quoting any message (DM or group, topic or not) delivers a
   rendered quoted line to the agent (`[Replying to <sender>: "<quoted
   text>"]`) — **without** changing which session/topic the message routes
   to.
7. An outbound `send_message`/`reply` call that sets `reply_to` to a bus
   message ID originating from Telegram produces a native Telegram reply
   quote (via `reply_parameters`) in addition to whatever topic routing
   already applies; a stale/deleted reply target never blocks delivery
   (`allow_sending_without_reply: true`).
8. Scheduled/cron sends and direct agent-initiated sends are unaffected —
   they still default to a contact's DM `general` topic exactly as before
   this epic, unless the agent explicitly passes a group's `thread:<hash>`
   topic (verified: `src/mcp/tools/messaging.ts` hardcodes `'general'`;
   `src/scheduler/scheduler.ts` defaults to `'general'`; neither is touched
   by this epic beyond honoring an explicit topic override that already
   flows through).
9. No new database table — group-topic state lives in E27's `threads` table
   alongside email's rows, distinguished by `channel`.
10. `tsc --noEmit` clean; unit tests cover thread-key derivation/hashing, the
    `threads`-table round trip for a Telegram group row, the
    `create_telegram_topic` tool (including its admin-rights check), the
    `reply_to` → `reply_parameters` resolution path, `send()`'s
    thread-metadata-vs-contact-map chat_id resolution, and quoted-context
    rendering.
11. `docs/TELEGRAM_ADAPTER.md` gains a "Group Topics & replies" section
    (group + BotFather setup steps, the anonymous-admin gotcha, a worked
    example) that links to `docs/THREADING.md` (E27) for the shared
    mechanism, mirroring how `docs/EMAIL_ADAPTER.md`'s "Threading & sessions"
    does. No DM Threaded Mode section ships — it was never implemented.

---

## Stories

### S28.1 — Group channel identity: auto-routing, no per-group config

**User story:** As an operator, I want a topic-enabled group the bot is a
member of to become its own conversational space, distinct from any
contact's DM, without hand-registering every group in config.

**Decided (Chris, 2026-08-18): auto-routing.** Channel identity is derived
dynamically from `msg.chat.type`/`msg.chat.id` at inbound time — no static
per-group config entry, no named instance per group. This also fixes scope
at **one bot instance, one agent**: this story does not add any mechanism to
route different groups or topics to different underlying agents/bots — that
would be a separate, later epic if ever pursued, not part of this one.

**Acceptance criteria:**
1. `processUpdate` (`src/adapters/telegram.ts:703+`) inspects `msg.chat.type`:
   `'private'` → `channel = this.id` (today's behavior, unchanged); `'group'`
   / `'supergroup'` → `channel = \`${this.id}:group:${msg.chat.id}\`` (or
   equivalent stable derivation) — computed per-message, no static config,
   no lookup table of known groups.
2. `TelegramAdapterSchema` (`src/config/schema.ts:88-92`) gains no
   `threaded_mode` field (retired) and no per-group config block — the bot
   auto-detects and handles any group it's added to, with no operator
   registration step beyond the Entry Criteria prerequisites (Topics
   enabled, Privacy Mode, admin rights).
3. Explicitly out of scope: multiple agents/bots per group, per-group agent
   selection, or any config surface for either — single bot, single agent,
   auto-derived channel only.
4. `docs/TELEGRAM_ADAPTER.md` documents the group prerequisites from Entry
   Criteria (Topics enabled, Privacy Mode disabled + remove/re-add, admin +
   Manage Topics for topic creation, anonymous-admin gotcha) and states
   plainly that no group-specific config is needed beyond those.

**Complexity:** S

### S28.2 — Forum topics on the generic thread store (group-scoped)

**User story:** As a user, I want each topic in a group to be its own
conversation with the agent, the same way separate email threads are — and
as a maintainer, I want this to cost no new table.

**Acceptance criteria:**
1. `TelegramMessage` (`src/adapters/telegram.ts:98-107`) gains
   `message_thread_id?: number` and `is_topic_message?: boolean`.
2. Local `TelegramThreadMetadata { chatId: number; messageThreadId: number }`
   interface (mirrors `EmailThreadMetadata` from E27).
3. `processUpdate`: when `msg.is_topic_message && msg.message_thread_id`,
   derives `threadKey = \`${msg.chat.id}:${msg.message_thread_id}\`` (chat-
   scoped, since `message_thread_id` is only unique within a chat), computes
   `topic = topicForThreadKey(threadKey)` (E27, shared), sets it on the
   `InboundMessage` before calling `processInbound`, and calls
   `upsertThread(db, { channel, topic, threadKey, metadata: { chatId:
   msg.chat.id, messageThreadId: msg.message_thread_id } })` (E27's
   `thread-store.ts` — no new table, no new migration) using the group
   channel derived in S28.1.
4. A group message with no `message_thread_id` (posted in "General") uses
   `topic = 'general'` on the group's channel — its own session, just like a
   DM's main conversation, with no thread-store row needed (mirrors how
   `'general'` never has a thread row today).
5. No config or topic-classify changes needed beyond what already exists —
   `isThreadTopic`/`thread:` preservation is generic (E21/E27).

**Complexity:** M

### S28.3 — Outbound: reply into the correct chat and topic

**User story:** As a user, I want the agent's replies to land back in the
group and topic I was using, not somewhere else.

**Acceptance criteria:**
1. `TelegramAdapter.send()` (`src/adapters/telegram.ts:329+`): for a
   `thread:`-prefixed `envelope.topic`, calls
   `getThread<TelegramThreadMetadata>(db, channel, envelope.topic)` and uses
   the returned `metadata.chatId` as the send target (not
   `contactChatIdMap`), including `message_thread_id: metadata.messageThreadId`
   in the `sendMessage` call.
2. For `envelope.topic === 'general'` on a group channel, resolves `chat_id`
   from the channel's own group identity (the `chat.id` embedded in the
   dynamically-derived channel from S28.1) and omits `message_thread_id` —
   posts to the group's non-topic default area exactly as Telegram's own
   General-topic fallback does.
3. For a DM channel (`envelope.topic === 'general'` or otherwise, unchanged
   from today), resolves `chat_id` from `contactChatIdMap` exactly as now —
   no behavior change for DMs.
4. Test: a two-topic group conversation round-trips independently — a reply
   addressed to topic A's `conversation_id` never appears in topic B; a
   Telegram group row and an email row coexisting in `threads` under
   different `channel` values don't interfere; a DM send and a group send for
   the same underlying contact never cross-deliver.

**Complexity:** M (upgraded from the original DM-only design's **S** — now
requires branching chat_id resolution instead of reusing a single
always-correct `contactChatIdMap` lookup)

### S28.4 — Agent-originated topics: `create_telegram_topic` tool (group-only)

**User story:** As the agent, I want to start a new topic in a group on my
own initiative (e.g. "let's track the Wanda-prep stuff separately") and be
able to refer back to it later.

**Acceptance criteria:**
1. New MCP tool `create_telegram_topic` (params: `channel` — a group channel
   id as derived in S28.1 — and `name`, the topic title). Wraps Telegram's
   `createForumTopic`.
2. Rejects DM channels outright with a clear error (DM Threaded Mode is
   retired — this tool is group-only).
3. Before calling `createForumTopic`, verifies the bot has "Manage Topics"
   admin rights in that group (via `getChatMember` on the bot's own id) and
   returns a clear, actionable error naming the exact BotFather/group-admin
   step if it doesn't — this is a real, stricter prerequisite than the
   original (retired) DM design, which needed no admin rights at all.
4. On success: derives `threadKey`/`topic` the same way as S28.2 and calls
   `upsertThread` immediately (so `send()` can resolve it before any inbound
   message has arrived on it), returning `{ topic: "thread:<hash>",
   message_thread_id, name }` to the agent — the `topic` value is what the
   agent passes as `topic` on a later `schedule_message`/`send_message` call
   to target this thread on purpose.
5. Tests: tool registration/gating on chat type, the admin-rights check
   (both pass and fail paths), successful creation + `threads` row upsert.

**Complexity:** M

### S28.5 — Reply-to-message: outbound native reply + inbound context

**User story:** As a user, I want the agent's answer to visually quote the
specific message it's responding to when that's meaningful, and I want the
agent to know which message I'm quoting when I reply — in a DM or a group,
without either of these forking my conversation into a new session.

**Acceptance criteria (outbound):**
1. `reply_to` (bus message ID) already exists as an accepted parameter on
   `send_message`/`reply` (`src/mcp/tools/messaging.ts:22`) and is stored on
   the outbound envelope, but nothing currently turns it into a platform-level
   reply. The direct-enqueue handler (`POST /api/v1/messages`,
   `src/http/api.ts:533-553`) resolves `reply_to`, when present, to the
   referenced transcript's `platform_message_id` — reusing the exact lookup
   the `react_to_message` endpoint already does (`SELECT channel, metadata
   FROM transcripts WHERE message_id = ?`, `src/http/api.ts:795-798`) — and
   stashes it on the outbound envelope as
   `metadata.reply_to_platform_message_id`.
2. `TelegramAdapter.send()` checks for `metadata.reply_to_platform_message_id`
   (format `"chatId:messageId"`, the same encoding used for
   `platform_message_id` everywhere else); when present, includes
   `reply_parameters: { message_id: <parsed>, allow_sending_without_reply:
   true }` in the `sendMessage` call. `allow_sending_without_reply: true` so a
   since-deleted target message never blocks delivery.
3. If the resolved chat doesn't match the send's target chat, the reply
   parameter is dropped rather than sent to the wrong chat — this now matters
   for groups too (a stale reply target from a different topic/chat must not
   leak across).

**Acceptance criteria (inbound):**
4. `TelegramMessage` gains `reply_to_message?: { message_id: number; from?:
   TelegramUser; text?: string; caption?: string }` (minimal subset, not the
   full recursive type).
5. `processUpdate`: when present, attaches
   `metadata.quoted_message = { platform_message_id: "chatId:messageId",
   sender_name, text }` to the `InboundMessage` (`text` truncated to ~200
   chars to bound context cost). **Does not** affect `topic`/session routing
   — orthogonal to S28.2/S28.1, and never touches `threads`.
6. `formatMessagesForSampling` (`src/adapters/cc.ts:82+`, shared by both the
   polling and headless CC adapters) renders a line before the body when
   `metadata.quoted_message` is present: `[Replying to <sender_name>: "<text>"]`
   — same placement/style precedent as the existing `[reacted 👍 to message
   555:42]` reaction line.
7. Tests: `reply_to` resolves and is forwarded in both DM and group contexts;
   missing/foreign-channel `reply_to` is a no-op; quoted-message rendering
   with/without a sender name and with truncation; no regression to existing
   reaction/attachment rendering tests.

**Complexity:** M

### S28.6 — Wiring, docs, tests

**User story:** As a maintainer, I want this documented and tested
end-to-end.

**Acceptance criteria:**
1. `docs/TELEGRAM_ADAPTER.md`: new "Group Topics & replies" section covering
   the group + BotFather prerequisites (Topics enabled, Privacy Mode disabled
   + remove/re-add, Manage Topics for topic creation, the anonymous-admin
   gotcha), the `create_telegram_topic` tool, and the reply-context vs.
   thread-routing distinction — linking to `docs/THREADING.md` (E27) for the
   shared storage mechanism. No DM Threaded Mode section — retired, never
   shipped.
2. `docs/MCP_TOOLS.md` documents `create_telegram_topic` and the now-functional
   `reply_to` behavior on `send_message`/`reply`.
3. `CHANGELOG.md` entry under `[Unreleased]`.
4. All new unit tests green; `tsc --noEmit` clean.

**Complexity:** S

---

## Notes

- **Why DM Threaded Mode was dropped, not just deprioritized.** It wasn't a
  scheduling call — a live test showed it breaks the core assumption the
  original epic needed (a working non-topic default area in the DM). Groups
  don't have that problem: Telegram's own forum-topic implementation for
  groups has always had a real "General" fallback with no thread id, unlike
  the newer private-chat Threaded Mode whose behavior here is unconfirmed by
  written docs and contradicted by hands-on testing.
- **Why two features, not one.** Forum topics are Telegram's explicit,
  persistent multi-conversation primitive — the group analogue of email
  threads — so they get the full E21/E27-style session-partitioning
  treatment. A reply-quote is a much more casual, extremely common gesture
  (correcting which of several messages you meant) that happens constantly in
  ordinary chat flow; routing it into a new session every time would
  fragment normal conversations. Treating it as inbound context + outbound
  `reply_parameters` only, with zero effect on `conversation_id`, avoids that
  failure mode while still satisfying the original ask.
- **Why `chat_id` is part of the forum-topic hash.** Telegram's
  `message_thread_id` is only unique within a chat; hashing `chatId:` +
  `message_thread_id` together avoids collisions across different groups
  landing on the same topic id.
- **Why reuse `reply_to` instead of a new tool parameter.** `reply_to`
  (bus message ID) already exists on `send_message`/`reply` and is already
  stored — it's simply inert for platform-level display today. Resolving it
  server-side to a `platform_message_id` (identical lookup to
  `react_to_message`'s endpoint) means the agent never needs to know
  Telegram-specific ID formats, consistent with how `react_to_message`
  already works off bus message IDs, not platform ones.
- **Scheduled/proactive sends are untouched by design.** Both direct
  agent-initiated sends (`src/mcp/tools/messaging.ts`) and scheduled/cron
  sends (`src/scheduler/scheduler.ts`) already hardcode/default `topic:
  'general'` and never inherit a contact's "last active topic" — there is no
  such lookup in the pipeline (`conversation_id` is a pure function of the
  envelope's *current* topic, `src/pipeline/stages/route-resolve.ts:32-36`).
  So "DM stays main, groups get separate topic-scoped threads, proactive
  delivery defaults to the DM unless explicitly targeted" falls out of the
  existing architecture for free — this epic only adds group-aware
  chat/topic resolution to the Telegram adapter's inbound *and* outbound
  paths (the outbound half, S28.3, is new work the original DM-only design
  didn't need, since a DM's chat_id was always already correct).
- **Why this epic added no table even in its first draft's shape.** An
  earlier draft proposed a bespoke `telegram_threads` table mirroring
  `email_threads` directly. E27 was carved out specifically to avoid that
  duplication before it happened — see E27's summary for the reasoning. That
  reasoning is unaffected by the DM→group pivot.
- **Authorization simplification, discovered from live testing, not
  designed in advance.** The original design log for this epic (before the
  pivot) flagged group authorization as an open question. Testing the real
  sender-allowlist mechanism against a live group showed it already solves
  this for free — sender identity, not chat identity, gates processing, and
  that logic needs zero changes to extend to groups.

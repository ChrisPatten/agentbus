# E27 — Telegram Threaded Mode & Reply Context

| Field | Value |
|---|---|
| Epic ID | E27 |
| Dependencies | None blocking. Reuses machinery already complete: E20 (long-lived per-`conversation_id` sessions), E21's `thread:<hash>` topic pattern (`THREAD_TOPIC_PREFIX`/`isThreadTopic()`, `email_threads` table as the schema template). |
| Story Count | 7 |
| Estimated Complexity | M |

---

## Epic Summary

Telegram Bot API 9.3 added **Threaded Mode**: a per-bot BotFather toggle that
turns a 1:1 bot DM into a forum with topics, giving inbound messages
`message_thread_id`/`is_topic_message` and making topic-management methods
(`createForumTopic`, etc.) work in private chats. Separately, and unrelated to
Threaded Mode, Telegram has always supported **replying to a specific
message** (`reply_to_message` inbound, `reply_parameters` outbound).
`src/adapters/telegram.ts` handles neither today (confirmed: no
`message_thread_id`, `reply_to_message`, or forum fields anywhere in the
codebase).

These are two independent capabilities and this epic keeps them that way:

1. **Forum topics → per-thread sessions.** A Telegram topic is a deliberate,
   persistent, user-visible structure — the same shape as an email thread.
   E27 mirrors E21's email-thread pattern exactly: derive `topic =
   thread:<hash>` from `message_thread_id`, let the existing
   `topic-classify`/`route-resolve` machinery give it its own
   `conversation_id` and long-lived session, and persist per-thread reply
   state (`telegram_threads`, modeled on `email_threads`) so outbound sends
   land back in the right topic.

2. **Reply-to-message is a context annotation, not session routing.** A user
   quote-replying to a message on a *normal* (non-topic) chat is a
   conversational gesture — "I mean this one" — not a request to fork a new
   conversation. Conflating it with thread-derivation would fragment ordinary
   chat into disconnected sessions the first time someone reply-quotes a
   message, which is very common Telegram UI behavior. So inbound
   `reply_to_message` is surfaced to the agent as **quoted context only**
   (mirroring how reactions already render as `[reacted 👍 to message
   555:42]` in `formatMessagesForSampling`), and outbound replies use the
   **already-existing** `reply_to` field (bus message ID, currently accepted
   by `send_message`/`reply` but never turned into an actual Telegram reply)
   to produce a native reply quote via `reply_parameters`.

```yaml
adapters:
  telegram:
    peggy:
      token: ${TELEGRAM_TOKEN_PEGGY}
      threaded_mode: true   # operator has enabled Threaded Mode for this bot via BotFather
```

---

## Entry Criteria

- **Operator prerequisite (outside the codebase):** Threaded Mode must be
  turned on per bot via **BotFather → your bot → Bot Settings → Threads
  Settings → Turn on Threaded Mode**. Until that's done, Telegram never sends
  `message_thread_id`/`is_topic_message`, and `createForumTopic` fails in
  that bot's DMs. This only gates capability 1 (forum topics); capability 2
  (reply context) needs no BotFather change and works today.
- `pipeline.route-resolve` already computes `conversation_id =
  sha256(sorted([contact_id, channel, topic]))`; `topic-classify` already
  preserves `thread:`-prefixed topics verbatim (`src/pipeline/stages/topic-classify.ts:26-31`).

---

## Exit Criteria

1. With `threaded_mode: true` and BotFather Threaded Mode on, a message sent
   into a forum topic in the bot's DM lands in its own session — two
   different topics from the same contact resolve to two distinct
   `conversation_id`s, independent of the contact's `general` session.
2. An agent reply to a message that arrived in a topic is posted back into
   that same topic (correct `message_thread_id`), not the DM's default area.
3. The agent can originate a new topic on its own initiative (new MCP tool)
   and reference it later (e.g. in a `schedule_message` call) via the
   `thread:<hash>` topic the tool returns.
4. A user reply-quoting any message (topic or not) delivers a rendered quoted
   line to the agent (`[Replying to <sender>: "<quoted text>"]`) — **without**
   changing which session/topic the message routes to.
5. An outbound `send_message`/`reply` call that sets `reply_to` to a bus
   message ID originating from Telegram produces a native Telegram reply
   quote (via `reply_parameters`) in addition to whatever topic routing
   already applies; a stale/deleted reply target never blocks delivery
   (`allow_sending_without_reply: true`).
6. Scheduled/cron sends and direct agent-initiated sends are unaffected —
   they still default to the `general` topic exactly as before this epic
   (verified: `src/mcp/tools/messaging.ts` hardcodes `'general'`;
   `src/scheduler/scheduler.ts` defaults to `'general'`; neither is touched
   by this epic).
7. `tsc --noEmit` clean; unit tests cover thread-key derivation/hashing,
   `telegram_threads` upsert+lookup, the `create_telegram_topic` tool, the
   `reply_to` → `reply_parameters` resolution path, and quoted-context
   rendering.
8. `docs/TELEGRAM_ADAPTER.md` gains a "Threaded Mode & replies" section
   (BotFather setup, config, worked example) mirroring
   `docs/EMAIL_ADAPTER.md`'s "Threading & sessions".

---

## Stories

### S27.1 — Config schema: `threaded_mode` per instance

**User story:** As an operator, I want to declare that a given Telegram bot
has Threaded Mode enabled, so the adapter knows it's safe to create topics
and attach `message_thread_id` on sends.

**Acceptance criteria:**
1. `TelegramAdapterSchema` (`src/config/schema.ts:88-92`) gains `threaded_mode:
   z.boolean().default(false)`.
2. `getTelegramInstances()` (`src/config/schema.ts:563+`) carries
   `threaded_mode` through to `TelegramInstanceConfig` for both the legacy
   single-bot form and the named-record form.
3. Inbound parsing of `message_thread_id`/`is_topic_message` (S27.2) is
   feature-detected from the update itself and does **not** depend on this
   flag — it only gates outbound topic-creation (S27.4) and is documented as
   the BotFather prerequisite.
4. `docs/TELEGRAM_ADAPTER.md` documents the exact BotFather steps.

**Complexity:** S

### S27.2 — Inbound: forum-topic → thread session

**User story:** As a user, I want each topic in the bot's DM to be its own
conversation with the agent, the same way separate email threads are.

**Acceptance criteria:**
1. `TelegramMessage` (`src/adapters/telegram.ts:98-107`) gains
   `message_thread_id?: number` and `is_topic_message?: boolean`.
2. New pure helper (mirrors `topicForThreadKey` in `email-thread.ts`):
   `topicForForumThread(chatId: number, messageThreadId: number): string` —
   hashes `${chatId}:${messageThreadId}` (chat-scoped, since
   `message_thread_id` is only unique within a chat) into `thread:<hash>`.
3. `processUpdate` (`src/adapters/telegram.ts:703+`): when
   `msg.is_topic_message && msg.message_thread_id`, sets `topic:
   topicForForumThread(...)` on the `InboundMessage` before calling
   `processInbound`.
4. New migration `012_telegram_threads.sql`: `telegram_threads(channel TEXT,
   topic TEXT, chat_id INTEGER, message_thread_id INTEGER, updated_at TEXT,
   PRIMARY KEY (channel, topic))` — modeled directly on `email_threads`
   (`src/db/migrations/010_email_threads.sql`). Registered in
   `src/db/schema.ts` alongside the other migrations.
5. `processUpdate` upserts a `telegram_threads` row on every message that
   carries a `message_thread_id`.
6. No config or topic-classify changes needed beyond what already exists —
   `isThreadTopic`/`thread:` preservation is generic (E21).

**Complexity:** M

### S27.3 — Outbound: reply into the correct topic

**User story:** As a user, I want the agent's replies to land back in the
topic I was using, not the DM's default area.

**Acceptance criteria:**
1. `TelegramAdapter.send()` (`src/adapters/telegram.ts:329+`) looks up
   `telegram_threads` by `(channel: this.id, topic: envelope.topic)`; if a
   row exists, includes `message_thread_id` in the `sendMessage` call.
2. No match (including `topic === 'general'`, which never gets a
   `telegram_threads` row) → `message_thread_id` omitted, message posts to
   the DM's non-topic default area exactly as today.
3. Test: a two-topic conversation round-trips independently — a reply
   addressed to topic A's `conversation_id` never appears in topic B.

**Complexity:** S

### S27.4 — Agent-originated topics: `create_telegram_topic` tool

**User story:** As the agent, I want to start a new topic on my own
initiative (e.g. "let's track the Wanda-prep stuff separately") and be able
to refer back to it later.

**Acceptance criteria:**
1. New MCP tool `create_telegram_topic` (params: `channel` — a
   `telegram:<name>` id with `threaded_mode: true` — and `name`, the topic
   title). Wraps Telegram's `createForumTopic` (no admin rights required in
   private chats — that restriction is supergroup-only).
2. Registered only for Telegram instances with `threaded_mode: true`;
   returns a clear error naming the BotFather prerequisite otherwise.
3. On success: upserts the returned `message_thread_id` into
   `telegram_threads` immediately (so `send()` can resolve it before any
   inbound message has arrived on it) and returns `{ topic: "thread:<hash>",
   message_thread_id, name }` to the agent — the `topic` value is what the
   agent passes as `topic` on a later `schedule_message`/`send_message` call
   to target this thread on purpose.
4. Tests: tool registration gating, successful creation + `telegram_threads`
   upsert, rejection when `threaded_mode` is false.

**Complexity:** M

### S27.5 — Outbound: native reply via existing `reply_to`

**User story:** As a user, I want the agent's answer to visually quote the
specific message it's responding to, when that's meaningful (e.g. answering
one of several rapid-fire questions).

**Acceptance criteria:**
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
   true }` in the `sendMessage` call.
3. `allow_sending_without_reply: true` so a since-deleted target message
   never blocks delivery — worst case, the reply just isn't visually linked.
4. If the resolved chat doesn't match the send's target chat (shouldn't
   happen in practice, but transcripts span channels), the reply parameter is
   dropped rather than sent to the wrong chat.
5. Test: `reply_to` resolves and is forwarded; missing/foreign-channel
   `reply_to` is a no-op; `allow_sending_without_reply` is always set when a
   reply target is included.

**Complexity:** M

### S27.6 — Inbound: reply-to-message as context (not routing)

**User story:** As the agent, I want to know which prior message a reply is
about, without every reply-quote fragmenting the conversation into a new
session.

**Acceptance criteria:**
1. `TelegramMessage` gains `reply_to_message?: { message_id: number; from?:
   TelegramUser; text?: string; caption?: string }` (minimal subset, not the
   full recursive type).
2. `processUpdate`: when present, attaches
   `metadata.quoted_message = { platform_message_id: "chatId:messageId",
   sender_name, text }` to the `InboundMessage` (`text` truncated to a
   reasonable length, e.g. 200 chars, to bound context cost).
3. **Explicitly does not** affect `topic`/session routing — orthogonal to
   S27.2.
4. `formatMessagesForSampling` (`src/adapters/cc.ts:82+`, shared by both the
   polling and headless CC adapters) renders a line before the body when
   `metadata.quoted_message` is present: `[Replying to <sender_name>: "<text>"]`
   — same placement/style precedent as the existing `[reacted 👍 to message
   555:42]` reaction line.
5. Test: rendering with/without a sender name, truncation, and no regression
   to existing reaction/attachment rendering tests.

**Complexity:** S

### S27.7 — Wiring, docs, tests

**User story:** As a maintainer, I want this documented and tested
end-to-end.

**Acceptance criteria:**
1. Migration `012_telegram_threads.sql` registered in `src/db/schema.ts`.
2. `docs/TELEGRAM_ADAPTER.md`: new "Threaded Mode & replies" section covering
   the BotFather steps, `threaded_mode` config, the
   `create_telegram_topic` tool, and the reply-context vs. thread-routing
   distinction — mirroring `docs/EMAIL_ADAPTER.md`'s "Threading & sessions".
3. `docs/MCP_TOOLS.md` documents `create_telegram_topic` and the now-functional
   `reply_to` behavior on `send_message`/`reply`.
4. `CHANGELOG.md` entry under `[Unreleased]`.
5. All new unit tests green; `tsc --noEmit` clean.

**Complexity:** S

---

## Notes

- **Why two features, not one.** Forum topics are Telegram's explicit,
  persistent multi-conversation primitive — the DM analogue of email threads
  — so they get the full E21-style session-partitioning treatment. A
  reply-quote is a much more casual, extremely common gesture (correcting
  which of several messages you meant) that happens constantly in ordinary
  chat flow; routing it into a new session every time would fragment normal
  conversations. Treating it as inbound context + outbound
  `reply_parameters` only, with zero effect on `conversation_id`, avoids that
  failure mode while still satisfying the original ask ("include a reference
  to it so the agent knows which it is").
- **Why `chat_id` is part of the forum-topic hash.** Telegram's
  `message_thread_id` is only unique within a chat; hashing `chatId:` +
  `message_thread_id` together avoids collisions across different users'
  DMs landing on the same topic id.
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
  So "one main session, separate threads, with proactive delivery defaulting
  to main" falls out of the existing architecture for free; this epic only
  adds thread-derivation to the Telegram adapter's *inbound* path.

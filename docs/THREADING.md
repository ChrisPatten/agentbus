# Thread-scoped sessions (E27)

Some channels have a native notion of a **thread** — a persistent
sub-conversation distinct from the channel's main conversation (an email
thread, a Telegram forum topic, …). AgentBus gives each thread its own
long-lived session by mapping it onto a reserved topic and persisting a small
amount of per-thread reply state. This mechanism is channel-agnostic; email
(E21) is its first user, and it was generalized here specifically so a second
channel — Telegram forum topics (E28) — can adopt it with **no schema
change**.

The mechanism has three layers, two of them fully generic:

## 1. Thread-key derivation (channel-specific)

Every channel that supports threading has *some* raw, protocol-level id that
identifies a thread — this is the one piece of the mechanism that has to live
in the adapter, since only the adapter understands the channel's protocol.

- **Email** (`deriveThreadKey` in `src/adapters/email-thread.ts`): the root id
  of the `References` header, else `In-Reply-To`, else the message's own
  `Message-ID` for a brand-new thread. A forward has neither `References` nor
  `In-Reply-To`, so it always starts a new thread.
- **Telegram** (planned, E28): `${chatId}:${messageThreadId}` — `chatId` is
  included because `message_thread_id` is only unique within a chat, so two
  different groups could otherwise collide on the same topic id.

## 2. Topic mapping (generic)

`src/pipeline/types.ts` exports the shared helpers every adapter uses
identically:

- `THREAD_TOPIC_PREFIX` (`'thread:'`) — the reserved prefix that marks a topic
  as thread-scoped rather than a configured topic label.
- `isThreadTopic(topic)` — true for any `thread:`-prefixed topic.
- `topicForThreadKey(threadKey)` — hashes a thread key (sha256, truncated to
  16 hex chars) into `thread:<hash>`.

Because `conversation_id = sha256(sorted([contact_id, channel, topic]))`
(`src/pipeline/stages/route-resolve.ts`), every message that resolves to the
same `thread:<hash>` topic lands on the same `conversation_id` — the same
long-lived session — while a different thread gets a different one. Two
pipeline stages cooperate with the reserved prefix generically, with no
per-channel special-casing:

- `topic-classify` preserves any `thread:`-prefixed topic verbatim (it isn't a
  configured label, so it would otherwise be reset to `general`).
- `priority-score` doesn't award the non-general topic bonus for a `thread:`
  topic — it's a routing key, not a classification.

## 3. Storage (generic)

`src/pipeline/thread-store.ts` persists per-thread reply state in one shared
`threads` table (migration `012_threads.sql`), keyed by `(channel, topic)` —
the same pair carried through to `conversation_id`, so an adapter's `send()`
path can look a thread up from the outbound envelope alone:

```sql
CREATE TABLE threads (
  channel    TEXT NOT NULL,
  topic      TEXT NOT NULL,
  thread_key TEXT NOT NULL,
  metadata   TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (channel, topic)
);
```

`thread_key` is the raw key from layer 1, kept as a queryable top-level column
(useful for debugging). `metadata` is an opaque JSON blob — its shape is
whatever a given channel needs, typed with a local TypeScript interface at the
call site. This is a JSON blob rather than a wide table with every channel's
columns because different channels' fields share nothing structurally (email's
subject/References chain vs. Telegram's chat/thread ids); a wide table would
mean piles of NULL columns per channel and a new migration for every future
channel. Three functions cover every adapter's needs:

```ts
function getThread<M>(db, channel, topic): { threadKey: string; metadata: M; updatedAt: string } | null
function upsertThread<M>(db, { channel, topic, threadKey, metadata: M }): void
function patchThreadMetadata<M>(db, channel, topic, patch: Partial<M>): void
```

`patchThreadMetadata` shallow-merges `patch` into the existing row's metadata
and is a no-op (never creates a row) if no thread exists yet for that
`(channel, topic)`.

## Worked example: email

Email's local metadata shape (`EmailThreadMetadata` in `src/adapters/email.ts`):

```ts
interface EmailThreadMetadata {
  subject: string | null;
  lastInboundMessageId: string | null;
  referencesChain: string | null;
  contactAddress: string | null;
}
```

- On inbound mail, `processInbound` calls `upsertThread` with the derived
  `threadKey`/`topic` and the four fields needed to build a threaded reply.
- On outbound send, `send(envelope)` calls `getThread(db, channel,
  envelope.topic)` to build `In-Reply-To`/`References`/`Re:` subject/original
  `To:`, then `patchThreadMetadata` to append its own outbound `Message-ID` to
  the chain.
- No thread row exists for an agent-initiated message (the `send_email` tool),
  so `send()` takes a no-thread path instead — see
  [EMAIL_ADAPTER.md](./EMAIL_ADAPTER.md#reply-threading-state).

## Adding threading to a new adapter

1. Write a channel-specific thread-key derivation function (layer 1) — pure,
   unit-testable, no DB access.
2. Call `topicForThreadKey(threadKey)` to get the `thread:<hash>` topic; set it
   on the `InboundMessage` before calling `processInbound`.
3. Define a local metadata interface for whatever your channel needs to
   reconstruct an outbound send, and call `upsertThread`/`getThread` (from
   `src/pipeline/thread-store.ts`) — no migration required.
4. In `send()`, check `getThread(db, channel, envelope.topic)` for a
   `thread:`-prefixed topic before falling back to whatever non-threaded
   default your adapter already has.

No new table, no schema change — the `threads` table already has room for
your channel's rows alongside every other channel's, distinguished by
`channel`.

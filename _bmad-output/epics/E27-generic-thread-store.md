# E27 — Generic Thread Store

| Field | Value |
|---|---|
| Epic ID | E27 |
| Dependencies | E21 (email channel — owns the `email_threads` table and `thread:<hash>` topic pattern this epic generalizes) |
| Story Count | 6 |
| Estimated Complexity | M |

---

## Epic Summary

E21 built per-thread sessions for email: a stable thread key is derived from
`References`/`In-Reply-To`, hashed into a `thread:<hash>` topic
(`topicForThreadKey` in `src/adapters/email-thread.ts`), and per-thread reply
state is persisted in `email_threads` (`channel, topic` primary key) so a
generated reply threads correctly. E28 needs the exact same mechanism for
Telegram forum topics — a different thread-key derivation (chat_id +
`message_thread_id` instead of mail headers) but an identical shape:
`(channel, topic)` → some reply-state payload that `send()` looks up.

> **Note (2026-08-18):** E28 originally targeted Telegram DM Threaded Mode;
> it has since pivoted to **group** forum topics after DM Threaded Mode
> failed a hands-on test (see E28's pivot note). This mechanism is unaffected
> either way — a chat-scoped thread key doesn't care whether the chat is a
> DM or a group, which is exactly the point of generalizing it here.

Rather than let a second bespoke `telegram_threads` table (E28's original
draft) duplicate this pattern — and a third, fourth adapter duplicate it
again later — E27 generalizes it once:

1. **One shared module** owns the channel-agnostic pieces: `THREAD_TOPIC_PREFIX`,
   `isThreadTopic()`, and `topicForThreadKey()` (currently split between
   `src/pipeline/types.ts` and `src/adapters/email-thread.ts` for no reason
   other than that's where E21 happened to put them).
2. **One shared table**, `threads(channel, topic, thread_key, metadata JSON,
   updated_at)`, replaces `email_threads`. `channel`/`topic`/`thread_key`/
   `updated_at` are the part every channel's threading has in common;
   whatever's genuinely channel-specific (email's subject/References chain,
   Telegram's chat_id/message_thread_id, anything a future channel needs)
   lives in `metadata` as an opaque JSON blob, typed per-adapter with a local
   TypeScript interface at the call site.
3. **One shared store module**, `src/pipeline/thread-store.ts`
   (`getThread`/`upsertThread`/`patchThreadMetadata`), replaces the hand-rolled
   SQL each adapter would otherwise write against its own table.

This is a pure refactor for email — same behavior, same tests, different
storage — that clears the ground for E28 to add Telegram threading with zero
new tables.

---

## Entry Criteria

- E21 complete (it is): `email_threads`, `email-thread.ts`, and the
  `thread:<hash>` topic convention already exist and are the thing being
  generalized.

---

## Exit Criteria

1. `threads` table exists with all `email_threads` data preserved
   (backfilled by migration, verified row-for-row); `email_threads` no
   longer exists.
2. Email adapter behavior is unchanged — every existing email-thread test
   (thread continuity, References chain building, `Re:` subject, forward →
   new thread) passes unmodified against the new store.
3. `THREAD_TOPIC_PREFIX`, `isThreadTopic()`, and `topicForThreadKey()` live
   in one channel-agnostic module that `email.ts`/`email-thread.ts` and any
   future adapter (Telegram in E28) import identically — no adapter imports
   another adapter's file to get at shared logic.
4. A second adapter can persist and retrieve its own thread metadata shape
   through `getThread`/`upsertThread` with **no schema change** — proven in
   practice by E28 doing exactly that.
5. `tsc --noEmit` clean; all tests green, including new `thread-store.ts`
   unit tests (get/upsert/patch round-trip, JSON (de)serialization, two
   channels' rows coexisting in the same table without collision).
6. `docs/EMAIL_ADAPTER.md`'s "Threading & sessions" section references the
   generic `threads` table; a new short `docs/THREADING.md` documents the
   shared concept (topic derivation is generic, thread-key derivation is
   channel-specific, storage is generic) for future adapter authors to
   follow.

---

## Stories

### S27.1 — Consolidate the channel-agnostic thread helpers

**User story:** As a maintainer, I want the topic-derivation logic in one
place so a new adapter doesn't have to import another adapter's module to
use it.

**Acceptance criteria:**
1. `topicForThreadKey(threadKey: string): string` moves from
   `src/adapters/email-thread.ts` into `src/pipeline/types.ts`, alongside the
   existing `THREAD_TOPIC_PREFIX`/`isThreadTopic()` it depends on.
2. `src/adapters/email-thread.ts` re-exports it (`export { topicForThreadKey }
   from '../pipeline/types.js'`) so `email.ts` and
   `email-thread.test.ts` need no import changes.
3. No behavior change — same hash, same prefix, same output for every
   existing test input.

**Complexity:** S

### S27.2 — Migration: generic `threads` table

**User story:** As the bus, I want one thread-storage table so every channel's
reply-threading state lives in the same place.

**Acceptance criteria:**
1. New migration `012_threads.sql`: `CREATE TABLE threads (channel TEXT NOT
   NULL, topic TEXT NOT NULL, thread_key TEXT NOT NULL, metadata TEXT NOT
   NULL DEFAULT '{}', updated_at TEXT NOT NULL, PRIMARY KEY (channel,
   topic))`.
2. Same migration backfills every existing `email_threads` row into
   `threads`, packing `subject`, `last_inbound_message_id`,
   `references_chain`, `contact_address` into `metadata` via SQLite's
   `json_object(...)`, then `DROP TABLE email_threads`. Zero data loss —
   verified by a migration test that seeds `email_threads` pre-migration and
   asserts the equivalent `threads` rows post-migration.
3. Registered in `src/db/schema.ts` as version 12.

**Complexity:** M

### S27.3 — `src/pipeline/thread-store.ts`

**User story:** As an adapter author, I want simple typed functions for
reading and writing a thread's state, without writing SQL.

**Acceptance criteria:**
1. `getThread<M>(db, channel, topic): { threadKey: string; metadata: M;
   updatedAt: string } | null` — parses the `metadata` JSON column into `M`.
2. `upsertThread<M>(db, { channel, topic, threadKey, metadata: M }): void` —
   serializes `metadata` to JSON, upserts by `(channel, topic)`.
3. `patchThreadMetadata<M>(db, channel, topic, patch: Partial<M>): void` —
   reads, shallow-merges `patch` into the existing metadata, writes back; a
   no-op (does not create a row) if no thread exists yet for that
   `(channel, topic)`.
4. Unit tests: round-trip of a typed metadata shape, patch merging,
   independent rows for the same `topic` under different `channel` values,
   patch-on-missing-thread is a no-op.

**Complexity:** S

### S27.4 — Retrofit the email adapter onto the generic store

**User story:** As a maintainer, I want the email adapter's threading to use
the shared mechanism instead of its own SQL.

**Acceptance criteria:**
1. `email.ts`'s `getThread`/`upsertThread`/`appendSentMessageId`
   (`src/adapters/email.ts:574-624`) are replaced with calls to
   `getThread`/`upsertThread`/`patchThreadMetadata` from
   `src/pipeline/thread-store.ts`, using a local `EmailThreadMetadata {
   subject: string; lastInboundMessageId: string; referencesChain: string;
   contactAddress: string }` interface.
2. `appendSentMessageId` becomes a `patchThreadMetadata` call updating just
   `referencesChain`.
3. No behavior change: every existing email-thread integration test
   (`email.test.ts`/`email-thread.test.ts`, whichever cover this) passes
   without modification to its assertions — only the underlying storage
   changed.
4. Direct SQL against `email_threads` no longer exists anywhere in the
   codebase.

**Complexity:** M

### S27.5 — Docs

**User story:** As a future adapter author, I want to know how to add
threading to a new channel without reinventing it.

**Acceptance criteria:**
1. New `docs/THREADING.md`: explains the split — thread-key derivation is
   channel-specific (protocol knowledge lives in the adapter), topic mapping
   (`topicForThreadKey`) and storage (`thread-store.ts`, the `threads` table)
   are generic — with the email and Telegram (E28) derivations as worked
   examples.
2. `docs/EMAIL_ADAPTER.md`'s "Threading & sessions" section updated to
   reference `threads` instead of `email_threads`, linking to
   `docs/THREADING.md` for the general mechanism.
3. `CHANGELOG.md` entry under `[Unreleased]` noting the internal schema
   change (migration, no user-facing behavior change).

**Complexity:** S

### S27.6 — Wiring & full regression pass

**User story:** As a maintainer, I want confidence this refactor didn't
regress email threading.

**Acceptance criteria:**
1. Full test suite green; `tsc --noEmit` clean.
2. Manual/integration sanity check (or an equivalent test) confirms a live
   email thread continues correctly end-to-end after the migration runs
   against a database that has pre-existing `email_threads` rows.

**Complexity:** S

---

## Notes

- **Why `metadata` as JSON instead of a wide table with every channel's
  columns.** Email's fields (subject, References chain) and Telegram's
  (chat_id, message_thread_id) share nothing structurally — a wide table
  would mean every row has a pile of NULL columns irrelevant to its channel,
  and every new channel would require a new migration adding more nullable
  columns to a shared table. A JSON blob keyed by convention (one TS
  interface per adapter) costs a small amount of type safety (enforced at
  the call site, not the schema) in exchange for zero schema churn as
  channels are added.
- **Why `thread_key` stays a typed top-level column.** Every channel's
  threading has *some* raw key that gets hashed into the topic (email's
  Message-ID chain root, Telegram's `chatId:messageThreadId`) — useful for
  debugging and worth keeping queryable rather than buried in the JSON blob.
- **This is infrastructure, not a new user-facing feature.** Exit criteria
  are entirely about zero regression to E21's shipped behavior; the payoff
  (Telegram threading with no new table) is realized in E28.

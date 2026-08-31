# E31 — Outbound Transcript Logging

| Field | Value |
|---|---|
| Epic ID | E31 |
| Dependencies | None structurally required. Builds on the existing `transcripts` table/schema (E8) and the `conversation_registry` lookup already used by the inbound pipeline (`src/pipeline/stages/transcript-log.ts`). |
| Story Count | 5 |
| Estimated Complexity | S |

---

## Epic Summary

1. `transcripts` today only ever receives `direction: 'inbound'` rows. The
   normal inbound pipeline stage (`src/pipeline/stages/transcript-log.ts:122`)
   hard-codes `direction: 'inbound'` on every row it writes — that's the only
   place ordinary message flow gets logged. The only `direction: 'outbound'`
   writes anywhere in the codebase are a narrow special case in
   `src/http/api.ts` (~line 345) for bus-scope slash-command responses
   (`/status`, `/help`, `/stop`, etc.), which bypass the normal delivery queue
   entirely and send via `originAdapter.send()` directly.
2. The actual delivery path for the vast majority of agent output — `reply`,
   `send_message`, and `send_email` (`src/mcp/tools/index.ts`,
   `src/mcp/tools/messaging.ts`) — all funnel through the same
   `POST /api/v1/messages` enqueue endpoint (`src/http/api.ts:533`), then get
   dispatched later by `DeliveryWorker.deliver()`
   (`src/core/delivery.ts:70`), which calls `adapter.send(envelope)`. None of
   this path ever writes a `transcripts` row.
3. **Net effect**: `search_transcripts` (and any other consumer of
   `transcripts`) can find what an inbound trigger *said*, but can never
   confirm what channel, topic, or body an agent's own outbound reply
   actually used. This makes debugging routing/delivery questions (e.g. "did
   that scheduled notification really land where I asked it to?") impossible
   without external verification (screenshots, the user's own report) —
   concretely hit twice in production (2026-08-19 `send_message` topic-param
   bug investigation, 2026-08-20 scheduled-wakeup channel-routing question).
4. **Consumers are already outbound-aware, they just never receive any.**
   `src/memory/summarizer.ts` already branches on
   `t.direction === 'inbound' ? ... : '[agent]'` when building transcript
   text for session summaries — it was written expecting both directions and
   silently degrades today because outbound rows simply don't exist. This is
   a contained gap on the write side, not something requiring surgery
   elsewhere.
5. **Right insertion point**: `DeliveryWorker.deliver()`, right after a
   successful `adapter.send(envelope)` (`result.success === true`) — this is
   the one chokepoint every queue-routed outbound send passes through
   (`reply`, `send_message`, `send_email`, and scheduled-message delivery),
   and logging only on confirmed success mirrors "this was actually
   delivered," not just "was attempted."

---

## Entry Criteria

- None. Pure additive logging — no existing behavior changes, no adapter or
  MCP tool interface changes.
- The existing slash-command outbound-logging special case
  (`src/http/api.ts` ~line 345, fixed for topic-preservation in `f6ae181`)
  remains a useful reference implementation for the insert shape (columns,
  `command_response` metadata convention for E8/E9 exclusion).

---

## Exit Criteria

1. Every message a platform adapter successfully sends via
   `DeliveryWorker.deliver()` (`reply`, `send_message`, `send_email`,
   scheduled-message delivery — anything routed through the queue) produces
   a `direction: 'outbound'` row in `transcripts`, with `conversation_id`/
   `session_id` resolved the same way the inbound pipeline resolves them
   (via `conversation_registry`, keyed by contact + channel) whenever
   resolvable.
2. A message that fails delivery (dead-lettered, adapter error) does **not**
   produce a transcript row — logging happens on confirmed success only, not
   on attempt.
3. The pre-existing slash-command bypass path continues to log outbound
   correctly (already fixed in `f6ae181`) and shares the same insert helper
   as the new `DeliveryWorker` path rather than duplicating the SQL.
4. `search_transcripts` can find an agent's own past outbound message
   content (verified by a real query, not just a unit test against the
   insert).
5. No change to existing inbound behavior, MCP tool schemas, or adapter
   interfaces — this is additive logging only.

---

## Stories

### S31.1 — Shared outbound-transcript-insert helper

**User story:** As a maintainer, I want one shared function that writes a
`direction: 'outbound'` transcript row, so the delivery-worker path and the
existing slash-command path don't duplicate (and drift on) the same SQL.

**Acceptance criteria:**
1. Extract a small helper (e.g. `logOutboundTranscript(db, { messageId,
   conversationId, sessionId, channel, contactId, body, metadata })`) —
   reasonable home is alongside `transcript-log.ts` or a new
   `src/pipeline/outbound-transcript.ts`.
2. Refactor the existing slash-command insert (`src/http/api.ts` ~line 345)
   to call this helper instead of inlining its own `INSERT INTO transcripts`.
3. No behavior change to the slash-command path — same columns, same values,
   just deduplicated.

**Complexity:** S

### S31.2 — Log outbound sends in `DeliveryWorker.deliver()`

**User story:** As a maintainer, I want `reply`/`send_message`/`send_email`
(and any other queue-routed send) to write an outbound transcript row on
successful delivery, so `search_transcripts` covers both directions.

**Acceptance criteria:**
1. In `DeliveryWorker.deliver()` (`src/core/delivery.ts`), after
   `adapter.send(envelope)` returns `result.success === true`, call the
   S31.1 helper with the envelope's `channel`, `recipient` (as `contact_id`,
   stripping the `contact:` prefix same as the existing pattern in
   `api.ts`), `payload.body`, and `metadata`.
2. Resolve `conversation_id`/`session_id` via the same lookup the inbound
   pipeline uses (`conversation_registry`, keyed by contact + channel) —
   fall back to `null` for both when unresolvable (e.g. recipient isn't a
   `contact:`-prefixed platform recipient) rather than failing the send.
3. A failed/dead-lettered send (`result.success === false`, or the delivery
   `catch` block) does **not** write a transcript row.
4. Logging failures (e.g. a DB error writing the transcript row) are caught
   and logged to console, never allowed to affect delivery/ack/retry
   behavior — this is best-effort auditability, not a delivery
   correctness gate.

**Complexity:** M

### S31.3 — Metadata parity with the inbound path

**User story:** As someone debugging a routing question later, I want
outbound rows to carry enough metadata to answer "what channel/topic did
this actually use," matching what inbound rows already capture.

**Acceptance criteria:**
1. Outbound rows store `channel` and `metadata` (including `topic` if
   present on the envelope) exactly as sent — no filtering/redaction beyond
   what inbound rows already apply.
2. Reactions sent outbound (if any exist as a send path) render the same
   `[reaction:...]` placeholder convention `transcript-log.ts` already uses
   for inbound reactions, for consistency.

**Complexity:** S

### S31.4 — Tests

**User story:** As a maintainer, I want the outbound-logging behavior
covered by tests, not just verified by hand.

**Acceptance criteria:**
1. `DeliveryWorker` test: a successful send produces exactly one
   `direction: 'outbound'` transcripts row with the expected fields.
2. `DeliveryWorker` test: a dead-lettered/failed send produces **zero**
   transcript rows.
3. Slash-command path test (extend existing `inbound-commands.test.ts`):
   confirms it still logs via the shared helper post-refactor, same
   behavior as before.
4. `search_transcripts` integration test: an outbound row is findable by
   its body text.

**Complexity:** S

### S31.5 — Docs, CHANGELOG

**User story:** As a maintainer, I want this documented so future debugging
(and future epics) know both directions are captured.

**Acceptance criteria:**
1. `docs/MEMORY_MODEL.md` gains a note that `transcripts` now captures both
   directions, and where the write happens for each (`transcript-log.ts` for
   inbound, `DeliveryWorker.deliver()` + the slash-command path for
   outbound, both via the shared S31.1 helper).
2. `CHANGELOG.md` entry under `[Unreleased]`.

**Complexity:** S

---

## Notes

- **Why not log at `POST /api/v1/messages` (enqueue time) instead?** That's
  when a send is *requested*, not when it's *delivered* — an enqueued
  message can still fail, get dead-lettered, or (for `agent:`-prefixed
  recipients) never go through `DeliveryWorker` at all, since that worker
  explicitly only handles `contact:`-prefixed recipients per its own doc
  comment. Logging at `DeliveryWorker.deliver()`'s success branch mirrors
  "this was actually sent," which is the more useful signal for the
  debugging use case that motivated this epic (confirming what a scheduled
  notification or reply actually did).
- **Why this is Complexity S overall despite 5 stories**: each story is
  small and mechanical (an insert helper, one call site, tests, docs) — the
  real work was root-causing the gap and identifying the right chokepoint,
  both already done (2026-08-20, `_bmad-output/backlog.md`).
- **Origin**: promoted from a backlog idea first written 2026-08-20 while
  debugging a scheduled-message channel-routing question (Peggy could not
  verify via `search_transcripts` what channel a past outbound send actually
  used). Confirmed still unpromoted and unbuilt as of 2026-08-31.

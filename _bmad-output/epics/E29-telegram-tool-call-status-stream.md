# E29 — Telegram Live Tool-Call Status Stream

| Field | Value |
|---|---|
| Epic ID | E29 |
| Dependencies | E19/E23 (`cc-headless` adapter, per-request `claude -p` invocation), E3/E10 (Telegram adapter, message-send capability) |
| Story Count | 6 |
| Estimated Complexity | M |

---

## Epic Summary

Today, while a headless agent works on a turn, the only signal a Telegram user
sees is the persistent typing indicator (E10) — nothing about *what* the
agent is actually doing. Chris wants to see the agent's work happening live:
tool calls appearing as lines in a single evolving message, which then gets
replaced entirely by the final answer once it's ready.

This is buildable **without any new `claude` CLI flags**. `cc-headless.ts`'s
`invokeClaude()` already runs `claude -p` with `--output-format stream-json
--verbose` (`src/adapters/cc-headless.ts:192-199`) — the child process
already emits a real-time JSONL event stream, including every `tool_use`
content block, as it works. Today's handler
(`src/adapters/cc-headless.ts:229-268`) only reads this stream for three
things: the session id, whether a delivery tool (`reply`/`send_message`)
fired, and the final `result` event's text. Every other event — in
particular, every non-delivery tool call — is parsed and discarded. This
epic acts on data that already flows through the pipe; it does not change
how `claude -p` is invoked.

**What ships:**

1. As non-delivery tool calls occur during a turn, a short human-readable
   line is appended to a single Telegram message (via `editMessageText`),
   giving a live "what I'm doing" trail.
2. When the agent actually delivers its answer (`reply`/`send_message`
   fires), that same message is overwritten in one final edit with the real
   answer — the tool-call trail disappears, replaced by the clean response.
   This is *not* two messages (draft + final) — it's one message whose
   content changes over the life of the turn.
3. Tool-call summaries are extracted, not invented: `Bash` and `Agent` tool
   calls already carry a required human-readable `description` field as
   part of their own input schema — those pass through directly, zero
   synthesis. Other tools (`Read`, `Edit`, `Write`, `Grep`, `WebFetch`, etc.)
   get a small fixed per-tool-name template built from their actual
   parameters (e.g. `Read` → "📖 Reading {file_path}").
4. **Subagent internals are never shown.** An `Agent` tool call renders as a
   single collapsed line (its own `description`) — nothing about what the
   subagent does internally surfaces in the stream. This needs no extra CLI
   flag (`--forward-subagent-text` is explicitly *not* used) and keeps the
   trail readable regardless of how much work a subagent does.
5. Explicitly **out of scope for this epic** (see Notes for reasoning):
   token-level text streaming (`--include-partial-messages`), and surfacing
   thinking-trace content — both deferred pending separate verification/
   design work, not part of this build.

This is a **Telegram-only** feature. Other channels (email, BlueBubbles)
have no equivalent "edit a sent message" primitive in this codebase and are
completely unaffected — the callback this epic adds to `invokeClaude()` is a
no-op unless the outbound channel is a Telegram instance.

---

## Entry Criteria

- `cc-headless.ts`'s `invokeClaude()` exists and already parses the
  `stream-json` event stream line-by-line (it does today — no prerequisite
  work needed here, unlike E27/E28 which needed new infrastructure first).
- Telegram Bot API's `editMessageText` method is available and unaffected by
  anything in E27/E28 — this epic can be built independently of whether
  Group Topics ships, though both touch outbound `TelegramAdapter` code and
  should avoid conflicting when both are in flight.

---

## Exit Criteria

1. During a turn with at least one non-delivery tool call, the contact sees
   a single Telegram message appear after the first tool call, which then
   grows (via edits) with one line per subsequent tool call.
2. When the agent's answer is delivered, the same message is overwritten
   with the final answer text in one last edit — no separate "draft" message
   is left behind, and no duplicate final message is sent.
3. A turn with **zero** non-delivery tool calls before delivery (e.g. a fast
   reply with no research) behaves exactly as today — a single message sent
   once, no draft, no edits. This feature never adds latency or extra
   messages to the simple case.
4. `Bash` and `Agent` tool-call lines use their own `description` field
   verbatim (no reformatting). Other covered tool types render via their
   fixed template. An uncovered/unknown tool name falls back to a generic
   line ("⚙️ Running {name}") rather than being silently dropped or crashing
   the turn.
5. No subagent-internal tool call ever appears in the trail — an `Agent`
   call always renders as exactly one line, regardless of how many tool
   calls the subagent itself makes.
5a. **No status message of any kind is ever created for tool calls that
   occur after a turn's delivery tool has already fired.** A turn that
   calls `reply`/`send_message` and then continues doing work (e.g.
   Peggy's routine post-reply memory/journaling writes) produces zero
   visible trail for that later work — confirmed necessary by live testing,
   not just a nice-to-have (see Notes).
6. Rapid-fire tool calls are batched: no more than roughly one edit per
   second is sent to Telegram, even if multiple tool calls complete within
   that window — verified by a test that fires N tool-call events in quick
   succession and asserts fewer than N edit calls were made.
7. The draft message never exceeds Telegram's ~4096-character limit — once
   the accumulated trail would exceed a configured line/character budget,
   older lines are dropped from the visible text (newest-N-lines shown),
   never truncated mid-line or left to error.
8. If an edit against the draft message fails (e.g. the user deleted it, or
   Telegram rejects the edit), the final answer still reaches the user —
   falls back to sending a fresh message rather than losing the turn's
   output.
9. Non-Telegram channels (email, BlueBubbles) show zero behavior change —
   the new callback is inert for them.
10. `tsc --noEmit` clean; unit tests cover: tool-call summary formatting for
    each covered tool type and the unknown-tool fallback, the draft-message
    lifecycle (create → append → overwrite), the batching/rate-limit logic,
    the length-cap/truncation logic, and the zero-tool-call no-op path.
11. `docs/TELEGRAM_ADAPTER.md` gains a short section describing the feature,
    how tool-call summaries are derived, and the explicit non-goals (token
    streaming, thinking traces) with a pointer to why they're deferred.

---

## Stories

### S29.1 — `invokeClaude()`: tool-call event callback

**User story:** As a maintainer, I want `invokeClaude()` to notify a caller
about each non-delivery tool call as it happens, without changing what it
returns when the turn completes.

**Acceptance criteria:**
1. `invokeClaude()` (`src/adapters/cc-headless.ts:186+`) gains an optional
   callback parameter, e.g. `onToolCall?: (call: { name: string; input:
   Record<string, unknown> }) => void`.
2. In the existing `rl.on('line', ...)` handler
   (`src/adapters/cc-headless.ts:230-268`), for every `assistant` event's
   `tool_use` content block whose `name` is **not** in `DELIVERY_TOOL_NAMES`
   (the existing set used for delivery-tool detection), invoke the callback
   with the block's `name` and `input` — synchronously, in event order.
3. If no callback is provided (the parameter is omitted), behavior is
   byte-for-byte identical to today — this is purely additive.
4. The callback fires for a top-level `Agent` tool call itself (so it can be
   rendered as one line, per S29.2/S29.4) but the implementation does **not**
   add `--forward-subagent-text` and does not parse any events a subagent
   might emit — there is nothing to filter out because it's never requested.
5. **Once `deliveredViaTool` becomes true for a turn, the callback stops
   firing entirely for the remainder of that turn** — found via live testing
   (2026-08-18, see Notes): a turn routinely keeps calling tools *after*
   `reply`/`send_message` (Peggy's own post-reply memory/journaling writes
   are the common case), and those tool calls have no future delivery event
   to be overwritten by, so S29.3/S29.4's "start a fresh draft if none
   exists" behavior would otherwise spawn a second, permanently-dangling
   status message on every single turn that does any post-reply work. This
   is a hard behavioral requirement, not an optimization — without it the
   feature produces a visible bug on ordinary turns, not just an edge case.

**Complexity:** S

### S29.2 — Tool-call summary formatting

**User story:** As a user, I want each tool-call line to read like a short,
clear statement of what's happening, not raw JSON.

**Acceptance criteria:**
1. New pure function, e.g. `formatToolCallSummary(name: string, input:
   Record<string, unknown>): string`, colocated with the callback consumer.
2. `Bash` → returns `input.description` verbatim (prefixed with an emoji,
   e.g. `🐚 {description}`). `Agent` → returns `input.description` verbatim
   (e.g. `🤖 {description}`).
3. Fixed templates for at least: `Read` → `📖 Reading {file_path}`, `Edit` →
   `✏️ Editing {file_path}`, `Write` → `📝 Writing {file_path}`, `Grep` →
   `🔍 Searching for "{pattern}"`, `WebFetch` → `🌐 Fetching {url}`,
   `WebSearch` → `🔎 Searching: "{query}"`.
4. Any tool name not covered by 2–3 falls back to `⚙️ Running {name}` —
   never throws, never omits the line.
5. Unit tests: one per covered tool type (correct field extraction), the
   fallback path, and a malformed/missing-field input (e.g. `Bash` call
   somehow missing `description`) degrading to the generic fallback rather
   than crashing.

**Complexity:** S

### S29.3 — Telegram adapter: draft-message lifecycle

**User story:** As a user, I want to see one message that grows with tool
calls, not a flood of separate messages.

**Acceptance criteria:**
1. `TelegramAdapter` gains per-turn draft-message tracking (e.g. keyed by
   whatever identifies "this in-flight turn" to the adapter — the same
   identifier `invokeClaude()`'s caller already has available).
2. First tool-call summary for a turn → `sendMessage` with that one line,
   store the returned `message_id` as the turn's draft.
3. Each subsequent tool-call summary → `editMessageText` against the stored
   draft `message_id`, with the new line appended to the accumulated text.
4. Batches edits: collects tool-call lines arriving within a short window
   (~1 second) and issues at most one `editMessageText` call per window,
   per Exit Criterion 6 — not one API call per tool-call event.
5. Tests: single tool call → one send, no edits; three tool calls within one
   batching window → one send + one edit (not three edits); three tool
   calls spread across three windows → one send + two edits.

**Complexity:** M

### S29.4 — Overwrite-on-delivery

**User story:** As a user, I want the tool-call trail to disappear and be
replaced by the real answer, not sit above it.

**Acceptance criteria:**
1. When `reply`/`send_message` fires (the existing `deliveredViaTool`
   detection in `invokeClaude()`) **and** a draft message exists for this
   turn, the adapter's send path performs `editMessageText` on the draft's
   `message_id` with the final answer text, instead of `sendMessage`.
2. When `reply`/`send_message` fires and **no** draft exists (a turn with no
   qualifying tool calls before delivery), behavior is unchanged from today
   — a normal `sendMessage`, per Exit Criterion 3.
3. If the overwrite edit fails for any reason (draft message deleted by the
   user, Telegram API error), falls back to `sendMessage` for the final
   answer rather than losing it, per Exit Criterion 8.
4. Draft-message tracking for a turn is cleared once the turn's final
   delivery (success or fallback) completes — no leak across turns.
5. Tests: normal overwrite path; no-draft path (unchanged behavior);
   overwrite-fails-falls-back-to-send path.

**Complexity:** M

### S29.5 — Length cap / truncation

**User story:** As a user, I don't want the status message to error out or
get garbled on a long, tool-heavy turn.

**Acceptance criteria:**
1. Before each batched edit (S29.3), if the accumulated trail text would
   exceed a configured budget (comfortably under Telegram's ~4096-char
   limit, accounting for message overhead), older lines are dropped from
   the front, keeping only the most recent N lines that fit.
2. Truncation never cuts a line in half — it drops whole lines only.
3. Optionally, a short indicator (e.g. "… (earlier steps omitted)") appears
   at the top when truncation has occurred, so the trail doesn't look like
   it started mid-way for no reason.
4. Tests: a trail that fits needs no truncation; a trail exceeding the
   budget drops the oldest whole lines and stays under the limit.

**Complexity:** S

### S29.6 — Wiring, docs, tests

**User story:** As a maintainer, I want this documented and tested
end-to-end.

**Acceptance criteria:**
1. `docs/TELEGRAM_ADAPTER.md`: new section describing the live status
   stream, how summaries are derived (Bash/Agent pass-through vs. templated
   fallback), the batching/rate-limit and length-cap behavior, and explicit
   non-goals (token-level streaming, thinking traces) with a one-line
   pointer to why they're deferred (see Notes).
2. `CHANGELOG.md` entry under `[Unreleased]`.
3. All new unit tests green; `tsc --noEmit` clean.
4. Manual/integration sanity check: a real turn involving at least a Bash
   call, a Read call, and an Agent call, observed end-to-end against the
   real `peggy` bot, confirming the trail appears, batches sensibly, and
   gets cleanly overwritten by the final answer.
5. A second manual/integration check specifically covering S29.1's
   acceptance criterion 5: a turn that calls `reply`/`send_message` and then
   makes at least one more tool call afterward (the realistic shape being
   Peggy's own post-reply memory-log write) produces **no** second Telegram
   message — confirms the real bug found in testing (see Notes) stays fixed.

**Complexity:** S

---

## Notes

- **Real bug found via live testing, 2026-08-18 — post-delivery tool calls
  spawned a dangling second status message.** Chris tested an early build
  of this feature: after Peggy delivered her answer via `reply()`, she (per
  her own standing operating practice) continued working — reading and
  editing her daily memory-log file. Those post-reply tool calls triggered
  S29.3's "no draft exists for this turn → start a new one" path, producing
  a *second*, separate Telegram message (a tool-call trail with no final
  answer to ever overwrite it into — nothing left in the turn calls
  `reply`/`send_message` again). This isn't a rare edge case: **any turn
  where Peggy does bookkeeping after answering** — which is normal,
  expected behavior per her own memory-writing discipline — would trigger
  it. Fixed by adding S29.1's acceptance criterion 5: the callback must stop
  firing entirely once `deliveredViaTool` flips true for a turn, so nothing
  after delivery ever creates or updates a status message. This was caught
  specifically *because* it was tested against a real turn with real
  post-reply behavior rather than a synthetic "tool calls then done" test
  case — worth remembering as a reason to always test epics like this
  against a real, full-shaped turn, not just the happy path the story
  describes.
- **Why no new `claude` CLI flags.** The event stream this epic consumes
  (`tool_use` blocks in `assistant` events) is already part of the existing
  `--output-format stream-json` invocation. No flag change is needed to
  *see* top-level tool calls — only to see token-level text deltas
  (`--include-partial-messages`, explicitly out of scope) or subagent
  internals (`--forward-subagent-text`, explicitly not used).
- **Why token-level streaming is deferred, not just "later."** Telegram
  itself rate-limits message edits to roughly the range this epic's own
  batching already targets (~1/sec). Once you're batching edits at that
  cadence regardless, the practical difference between "batched token
  deltas" and "batched tool-call lines" narrows a lot — and token deltas are
  materially more fragile to parse correctly (partial tool-call-argument
  JSON mid-stream) for a benefit that may not be visible to the user anyway.
  If real usage of this epic's simpler version shows it's not enough,
  revisit token streaming as a follow-up epic with its own design.
- **Why thinking-trace surfacing is deferred.** `--forward-subagent-text`
  proves "thinking" is a real, named content-block type somewhere in this
  pipeline, but whether the *main* agent's own thinking appears the same way
  by default, and whether it's raw/summarized/omitted, is unverified against
  this exact CLI/pipeline combination. Needs a real disposable test before
  any design commits to a shape — not done as part of this epic.
- **Why subagent internals are never shown, not just "off by default."**
  Chris's explicit call: a subagent launch renders as one line
  (`input.description`) and nothing else, regardless of how much internal
  work it does. This keeps the trail short and readable on a phone screen
  even for turns that spin up multi-step subagent work, and avoids ever
  needing `--forward-subagent-text` for this epic at all.
- **Why this is Telegram-only.** `editMessageText` (or an equivalent
  "mutate a previously sent message" primitive) doesn't exist for email or
  BlueBubbles in this codebase. The `onToolCall` callback added in S29.1 is
  generic at the `cc-headless.ts` level, but only a Telegram-backed send
  path actually does anything with it — other channels simply never
  register a listener, so they see no behavior change.

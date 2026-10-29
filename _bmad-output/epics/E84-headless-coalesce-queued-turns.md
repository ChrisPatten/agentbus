# E84 — cc-headless: Coalesce Queued Messages Into One Turn

| Field | Value |
|---|---|
| Epic ID | E84 |
| Dependencies | E58 (per-conversation queue and slot limiter in `HeadlessInstance`), E71 (`splitProviderCommands`), E65 (system-only batches) |
| Story Count | 3 |
| Estimated Complexity | M |
| Status | Scoped — not started |

---

## Epic Summary

When a user sends several messages while a cc-headless turn is running, each poll acks the messages it finds and enqueues them as a separate batch behind the running turn. Messages that arrive in different polls therefore become separate turns, run one after another, each a full `claude -p --resume` cold start. The user waits through N turns and gets N replies for what they meant as one thought. `processBatch` already notes that anything arriving mid-turn "waits for the next one".

This epic merges every not-yet-started user batch for a conversation into the turn that is about to start, so all messages sent while the agent was working are delivered in one turn, in arrival order, each keeping its own `[id:...]`.

## Verified Behavior

Checked 2026-10-29 by reading `src/adapters/cc-headless.ts` and `src/adapters/message-format.ts`, and by a live test on the cc-pool adapter:

- `poll()` keeps running on `poll_interval_ms` (default 1000) during a turn. It acks every message it dequeues (limit 20), groups them by conversation, and calls `enqueue()` once per group (and once per provider command via `splitProviderCommands`).
- `enqueue()` chains each task behind the conversation's previous promise (`this.queues`), so batches from successive polls run strictly serially.
- Messages acked in the same poll are merged into one turn by `formatMessagesForSampling`.
- Comparison: on cc-pool, three messages sent two seconds apart during a long tool call were all injected into the single running turn. That is the behavior this epic brings to cc-headless.

## Design

Coalesce at turn start, not at poll time. Messages are already acked when queued, so nothing is lost or re-delivered, and the poll loop stays simple.

- Keep a per-conversation list of waiting user batches (the existing `waiting` map holds only abort controllers; extend or add a parallel structure holding the envelopes).
- When a queued user task reaches the front and acquires its slot, take every other waiting user batch for the same conversation, concatenate the envelopes in arrival order, and run a single `processBatch` over the merged list. The merged-away tasks resolve without running.
- Never merge across these boundaries: a provider command (E71) is always its own turn and splits the merge window; system-class batches (scheduled, `system:` sender, E65 system-only) stay in the system class and are not merged into a user turn; different conversations never merge.
- `/stop` on the conversation aborts the merged turn and drops the not-yet-started batches already folded into it, consistent with today's abort of the running child.
- Siri messages keep their own turn: a Siri-sourced envelope must not wait on, or be merged with, other messages (the caller is on a 20-second answer window).
- A `[tapped]` message and typed messages in one merged batch are passed through in order; the agent sees the sequence and the later message wins by position.

## Entry Criteria

- Confirm all `enqueue()` callers (poll, journaling at ~L1306 and ~L1345, provider commands) and how `waiting`, `queues`, `resumeTails` and `journalTail` interact, before changing task ownership.
- Decide whether `activity` events (`queued`/`running`) should report the merged count.

## Exit Criteria

1. Three user messages acked in three separate polls while one turn is running produce exactly one follow-up turn whose prompt contains all three, in arrival order, each with its own `[id:...]`.
2. A provider command between two ordinary messages yields three turns in order: the messages before it, the command, the messages after it.
3. Scheduled/system batches never merge into a user turn and vice versa; a Siri message is never merged.
4. `/stop` during the running turn leaves no orphan merged-away tasks, and the capacity snapshot's `waiting` count returns to zero.
5. Message ordering, delivery gating (E30) and per-conversation serialization from E58 are unchanged. Different conversations for one contact still run concurrently.
6. Docs (`CC_HEADLESS_ADAPTER.md`) and `[Unreleased]` CHANGELOG are updated.

## Stories

### S84.1 — Track waiting user batches per conversation

- Store the envelopes of each queued user batch alongside its abort controller.
- Expose a way to claim all other waiting user batches for a conversation atomically at turn start.

**Acceptance:** unit test: enqueue three user batches behind a held turn; claiming from the first returns the other two in order and empties the list.

### S84.2 — Merge at turn start

- In the queued task, after the slot is acquired, claim the waiting user batches and run one `processBatch` over the merged envelopes.
- Honor the boundaries in Design: provider commands, system class, Siri, conversation.
- Resolve merged-away tasks without running them; make sure the limiter slot and `queues` chain release correctly.

**Acceptance:** integration test with a fake `claude` child: hold turn 1, feed three single-message polls, release turn 1; exactly one further child is spawned and its prompt contains all three messages.

### S84.3 — `/stop`, activity and docs

- `/stop` aborts the merged turn and clears folded batches; activity events and `/status` reflect the true waiting count.
- Update `CC_HEADLESS_ADAPTER.md` and CHANGELOG.

**Acceptance:** `/stop` during a turn with two queued batches leaves `waiting` at 0 and spawns no further child.

## Risks

- Journaling and resume-id gates (`journalTail`, `resumeTails`) are chained per task; dropping merged-away tasks must still release their gates or later turns will hang. Mitigation: resolve each dropped task's gates in the same path, with a test that a turn after a merge still starts.
- Prompt growth if many messages queue up. Mitigation: the poll limit (20) and the cap on acked-but-unstarted batches already bound it; no extra cap needed unless tests show otherwise.

## Notes

- cc-pool already delivers mid-turn messages into the running turn (verified 2026-10-29), so no change is proposed there. An optional short hold window in the pool poller could merge messages that arrive while the pane is idle, but the gain is small and it is out of scope.
- Raised by Mr. Patten 2026-10-29: the goal is that messages sent while the agent is working are seen in a single turn rather than one turn each.

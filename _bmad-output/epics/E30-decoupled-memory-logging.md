# E30 — Decoupled Memory-Logging Agent

| Field | Value |
|---|---|
| Epic ID | E30 |
| Dependencies | None structurally required. Motivated by, and a prerequisite for, the "Interrupt in-flight turn on rapid follow-up message" backlog item (`_bmad-output/backlog.md`) — that design is only safe to build once memory-logging no longer runs inside an interruptible turn. |
| Story Count | 5 |
| Estimated Complexity | M |

---

## Epic Summary

1. Today, Peggy's per-turn memory logging (updating daily journal files,
   MEMORY.md, project/topic files) happens as ordinary tool calls inside the
   **same** `claude -p` invocation that produced the user-facing reply — the
   agent just keeps running after `reply()`/`send_message()` fires, per her
   own standing practice of always logging what happened right after
   answering. Live testing while building E29 (2026-08-18) surfaced two real
   costs of this: (a) a turn isn't actually "done" when the user sees the
   answer — post-reply tool calls kept firing E29's tool-call-status
   callback, which needed a dedicated fix (S29.1's "stop after delivery")
   just to stop a symptom, not the underlying cause; (b)
   `HeadlessInstance.enqueue()`'s per-contact serialization won't start the
   next queued message until the *whole* turn — including this trailing
   housekeeping — finishes, adding avoidable latency even though the real
   answer already went out.
2. **Move memory-logging out of the main conversational turn entirely**,
   into a separate agent/process invocation that runs after (or independent
   of) the turn that produces the reply.
3. **Firing model**: not on every single reply — most turns have nothing new
   worth logging. An **idle-debounce** (~3-5 min of conversation silence
   resets/fires the sweep) plus a **hard ceiling** (~20-30 min since the last
   sweep) so a long, uninterrupted conversation still flushes periodically
   rather than deferring indefinitely.
4. **Why debouncing is low-risk here**: sessions already resume via
   `--resume` (`cc-headless.ts`) independent of memory-file write timing — a
   delayed sweep risks brief *staleness* (memory files lag reality for a few
   minutes), not *data loss* (`search_transcripts`/`get_transcript` can
   always recover the raw conversation regardless of when or whether a sweep
   has run).
5. **Exception**: high-stakes items (financial decisions, health/medical
   facts, scheduling commitments) should still be captured immediately
   inline, not held for the debounce window — carries forward the judgment
   Peggy already applies informally today for "this needs to be logged now."
6. **Secondary benefit**: this epic is what makes the "Interrupt in-flight
   turn on rapid follow-up message" backlog item safe to build. Once
   memory-logging never runs inside the interruptible turn, an
   abort-and-combine interrupt mechanic never risks killing a file write
   mid-flight, and never hits the "nothing sensible to combine into" case
   (the real answer already went out, there's no draft left to merge a
   follow-up into).

---

## Entry Criteria

- E29 (Telegram Live Tool-Call Status Stream) live and stable — its S29.1
  "stop callback after delivery" fix is what first surfaced this problem
  concretely (2026-08-18) and is the reason the underlying cause needs
  fixing, not just the symptom it was patching.
- No new external Telegram/CLI/Bot-API prerequisites — this is pure
  `cc-headless.ts` orchestration work, no adapter-level changes.

---

## Exit Criteria

1. A normal turn's `claude -p` invocation ends at reply delivery — no tool
   calls happen after `reply()`/`send_message()` fires within that same
   process.
2. Memory-logging runs as a **separate** agent invocation (same "another
   instance of me" pattern already used for `bg_task_notify.sh` background
   tasks — a fresh `claude -p` from the `peggy-claude-code` working
   directory, naturally picking up CLAUDE.md + memory context), triggered
   independently of the reply-producing turn.
3. The sweep fires on: (a) ~3-5 min of conversation idle since the last
   inbound message, **or** (b) a hard ~20-30 min ceiling since the last
   sweep — whichever comes first. Never fires once per turn.
4. High-stakes content (financial/health/scheduling) is still captured
   immediately via a separate inline path within the reply-producing turn,
   not deferred to the debounced sweep.
5. `HeadlessInstance.enqueue()`'s per-contact queue advances to the next
   message as soon as the reply-producing turn's process exits — no longer
   blocked on trailing memory housekeeping.
6. The sweep has access to full turn context (the same conversation the
   reply-producing turn saw), even though it runs later in a separate
   process — via `get_transcript`/`search_transcripts` or equivalent, not
   just whatever the memory files looked like before the turn started.
7. If the sweep agent crashes or is killed mid-write, the underlying
   transcript is unaffected (already durable in the bus's own transcript
   store) — only the curated memory-file promotion is lost/delayed, and is
   recoverable by re-running the sweep.

---

## Stories

### S30.1 — Strip post-reply memory-logging out of the main turn

**User story:** As a maintainer, I want a turn's `claude -p` process to
actually end when the reply is delivered, so E29's "stop after delivery"
behavior enforces a real invariant instead of papering over one.

**Acceptance criteria:**
1. The system prompt / CLAUDE.md instruction for headless Peggy turns no
   longer tells the agent to log to memory immediately after replying —
   that responsibility moves entirely to S30.2's separate sweep process
   (except the S30.3 high-stakes inline exception).
2. `invokeClaude()`'s spawn mechanics are otherwise unchanged — this is a
   prompt/instruction change, not a change to the child-process spawn
   itself. The process already exits naturally once the agent stops calling
   tools; removing the instruction to keep working post-reply is what makes
   that happen sooner.

**Complexity:** S

### S30.2 — Debounced memory-sweep scheduler

**User story:** As a maintainer, I want a background mechanism that fires a
memory-logging agent invocation on conversation idle or a time ceiling, not
on every single reply.

**Acceptance criteria:**
1. Per-contact (or per-`conversation_id`) idle timer: reset on every inbound
   message; fires the sweep after ~3-5 min of silence.
2. Hard ceiling timer: fires the sweep at least every ~20-30 min regardless
   of idle state, so long uninterrupted conversations still flush
   periodically.
3. Sweep invocation spawns a fresh `claude -p` (mirrors the existing
   `bg_task_notify.sh` background-task pattern), prompted with the
   conversation's recent transcript (via `get_transcript`/
   `search_transcripts`) and instructed to update the daily journal /
   MEMORY.md / topic files exactly as Peggy does today post-reply — just
   decoupled in time and process from the turn that produced the reply.
4. Overlapping sweeps for the same contact are prevented — a sweep already
   in flight for a contact suppresses or reschedules a new trigger rather
   than running two concurrently.

**Complexity:** M

### S30.3 — High-stakes immediate-logging exception

**User story:** As Mr. Patten, I want financial decisions, health
information, and scheduling commitments captured immediately, not held for
a debounce window, so nothing time-sensitive is ever lost to a delayed
sweep.

**Acceptance criteria:**
1. The judgment already applied informally today ("this needs to be logged
   now, not later") is preserved as an explicit inline logging path
   available within the reply-producing turn itself, separate from the
   deferred sweep — this is the one exception to S30.1's "no post-reply
   logging in the main turn" rule.
2. A documented list of trigger categories qualifying for immediate inline
   logging rather than waiting on the sweep: financial decisions/
   obligations, health/medical facts, scheduling commitments, safety- or
   security-relevant account events.

**Complexity:** S

### S30.4 — Queue responsiveness: advance on reply, not on full turn completion

**User story:** As a user sending rapid follow-up messages, I want the next
message to start processing as soon as the previous turn's answer is
delivered, not after its trailing housekeeping finishes.

**Acceptance criteria:**
1. `HeadlessInstance.enqueue()`'s per-contact Promise chain resolves
   (unblocking the next queued message) at reply delivery rather than at
   process exit. In practice S30.1 collapses these to nearly the same
   moment structurally, but this criterion exists to catch anything not yet
   fully removed from the post-reply path.
2. Test: two rapid-fire messages from the same contact — message 2 begins
   processing within a small, defined threshold of message 1's reply
   delivery, not after any fixed housekeeping tail.

**Complexity:** M

### S30.5 — Docs, tests, wiring

**User story:** As a maintainer, I want this documented and tested
end-to-end.

**Acceptance criteria:**
1. `docs/CC_HEADLESS_ADAPTER.md` (or equivalent) gains a "Memory Logging"
   section describing the debounce/ceiling model, the separate-agent
   pattern, and the high-stakes inline exception.
2. Unit/integration tests: idle-debounce timing, hard-ceiling firing,
   overlap suppression, queue-advance-on-reply behavior.
3. `CHANGELOG.md` entry under `[Unreleased]`.

**Complexity:** S

---

## Notes

- **Why decouple rather than just extend the E29 fix.** S29.1's "stop the
  tool-call-status callback after delivery" fix treats the *symptom* — a
  dangling status message stops appearing — but leaves the underlying
  reality unchanged: Peggy still runs real tool calls (file reads/edits)
  after replying. That still blocks `HeadlessInstance.enqueue()`'s queue
  (S29.1 never touched that), and it's the exact risk Chris flagged
  (2026-08-18) when discussing the "Interrupt in-flight turn" backlog item:
  killing a turn mid-memory-write risks corrupting files, with nothing
  sensible left to combine a new message into since the real answer already
  went out. This epic fixes the cause; E29 only ever fixed a visible
  consequence of it.
- **Why debounce is safe, not just convenient.** See Entry/Exit Criteria —
  `--resume` session continuity plus `search_transcripts`/`get_transcript`
  means a delayed sweep risks staleness (memory files briefly lag reality),
  never data loss. This was verified against `cc-headless.ts`'s actual
  session-resumption code, not assumed.
- **Relationship to the "Interrupt in-flight turn" backlog item.** This
  epic is a prerequisite, not a duplicate or overlapping effort. Once built,
  that backlog item's own design simplifies materially — it only ever needs
  to reason about interrupting a turn that does no memory bookkeeping,
  because memory bookkeeping no longer lives inside any interruptible turn
  at all.
- **Not addressed here.** The interrupt/steering mechanism itself (a
  separate backlog item with its own protocol-level direction — see
  `backlog.md`'s "Interrupt in-flight turn" entry, 2026-08-18 update
  recommending the CLI's own `interrupt` control request over a raw
  `child.kill()`). This epic only removes the reason that mechanism would
  be unsafe to build; it doesn't implement the mechanism itself.

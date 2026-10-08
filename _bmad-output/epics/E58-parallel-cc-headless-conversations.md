# E58 — Parallel cc-headless Conversations

| Field | Value |
|---|---|
| Epic ID | E58 |
| Status | Complete (2026-09-30) |
| Dependencies | Existing `cc-headless`, E27 conversation topics, E30 delivery-gated queue advancement, scheduler and journaling dispatcher |
| Story Count | 6 |
| Estimated Complexity | L |

Source: `planning-artifacts/mac-client/product-brief.md` §6.1 and `planning-artifacts/mac-client/PRD.md` §3.1 (FR-1–FR-7), §4, §7–8. This epic can ship without the Mac client and supersedes the Siri-only per-conversation queue backlog item.

## Epic Summary

Allow one contact to have turns running in separate conversations at the same time while preserving order within each conversation. Limit the number of `claude -p` children per agent, reserve capacity for system work, scope `/stop` to one conversation, and expose queued/running state. Four user turns and one scheduled turn must be able to run concurrently under the default limit of five.

## Entry Criteria

- Confirm the current `HeadlessInstance.enqueue()` and poll-loop grouping, child-process lifetime, E30 delivery acknowledgement, and all journaling call paths before changing queue ownership.
- Record the activity bridge shape used by E59's app adapter; keep it optional for existing adapters.

## Exit Criteria

1. FR-1: messages in one `conversation_id` run in arrival order and never overlap; distinct conversations for one contact run concurrently. Delivery still gates queue advancement.
2. FR-2/3: `max_concurrent_turns` defaults to 5, `reserved_system_slots` to 1, validation requires `0 <= reserved_system_slots < max_concurrent_turns`, and classification honors scheduled/system/journaling turns. A mixed batch is a user turn.
3. The slot is held until child-process exit. The oldest eligible waiting turn starts when capacity frees; a blocked user turn cannot prevent an eligible system turn from starting.
4. FR-4/5: a waiting conversation reports `queued`, a started turn reports `running`, and `/stop` terminates only the targeted conversation's child. Other conversations remain active.
5. FR-6: journaling is ordered with its own conversation, and two journaling turns for one agent cannot overlap. The documented exception for immediate high-stakes memory writes by user turns remains explicit.
6. FR-7: `/status`, health, and structured turn logs expose running user/system counts, waiting count, limit, conversation prefix, class, wait time, and run time without message bodies.
7. Tests cover NFR-4/NFR-9, docs (`CC_HEADLESS_ADAPTER.md`, `SLASH_COMMANDS.md`, status/health API) and `[Unreleased]` CHANGELOG are updated.

## Stories

### S58.1 — Audit turn ownership and define limiter contract

Trace `enqueue()`, the poll loop's `bySender` grouping, scheduled fires, `/clear` journaling, idle/ceiling journaling, post-restart wakeups, and child cleanup. Record the shared queue/limiter interface and event ordering in this epic or an architecture artifact. Specify that system classification applies only to a wholly system batch, that a slot belongs to the spawned process until exit, and that the oldest *eligible* waiter wins. Include cancellation while waiting and process failure in the state machine.

**Acceptance:** a testable transition table covers queued → running → settled/cancelled and shows where delivery acknowledgment and process exit occur.

### S58.2 — Per-conversation serialization and reserved capacity (FR-1–FR-3)

Key the queue and poll-loop grouping by `conversation_id`. Add a per-instance limiter with the two configurable limits. Preserve message order and E30 delivery gating, release capacity on every exit path, and avoid a failed turn blocking later work. Test four user conversations plus a system turn, a fifth user waiter, a system turn using a free user slot, oldest-eligible selection, and no overlap in one conversation.

### S58.3 — Scoped cancellation and command behavior (FR-5)

Track children and waiting turns by conversation. Resolve `/stop` from the command's actual conversation, including Telegram topics; stop or remove only that turn and settle its activity state. Test a stopped topic while another topic for the same contact continues, plus an idle/queued target and late process exit. E60 will extend the target resolution to bound foreign sessions.

### S58.4 — Journaling lane (FR-6)

Send every journaling entry point through one agent-scoped lane while retaining ordering with the affected conversation. Ensure skipped, failed, and cancelled journal turns release that lane. Test two simultaneously eligible journal jobs, a user turn in another conversation, and `/clear` journaling. Document the remaining immediate user-turn memory-write race from PRD §8.

### S58.5 — Activity and observability (FR-4, FR-7)

Emit `queued`, `running`, and `idle` through an optional activity bridge keyed by conversation/session; reconcile state after cancel, crash, or restart. Extend `/status` and `GET /api/v1/health` with per-instance running user/system, waiting, and configured capacity. Log class, first eight conversation ID characters, wait duration, and run duration. E59 consumes this bridge for app events.

### S58.6 — Integration, performance, and documentation

Run the full bus test suite and type check; exercise a controlled five-child concurrency scenario and verify no cross-talk or process-count oversubscription (NFR-4/NFR-8). Update headless, slash-command, and HTTP/status docs plus CHANGELOG. Record the behavioral change to Telegram `/stop`.

## Out of Scope

- Rapid-follow-up interrupt and combine behavior from the backlog.
- File locking for immediate user-turn memory writes unless the audit finds a concrete defect that blocks safe parallel turns.
- Parallel turns inside one conversation.

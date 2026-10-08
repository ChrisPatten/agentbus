# E65 — Owner Contacts and Bus Advisories

| Field | Value |
|---|---|
| Epic ID | E65 |
| Status | Complete |
| Dependencies | E64 |
| Story Count | 4 |
| Estimated Complexity | M |

Source: pluggable-journaling design discussion, 2026-10-02 (`planning-artifacts/journaling/decisions.md`).

## Epic Summary

Give the bus a way to tell the user about important conditions through the agent. A bus advisory (for example "agent X's journaling chain can run out of options") is injected alongside the owner's next messages so the agent can relay it, or, for critical conditions, delivered proactively. This needs a new concept: per-agent **owner contacts**, the people who receive advisories. Journaling (E66) and learning (E68) are the first producers; others (hook health, pool dead-letters, startup config warnings, approval timeouts) can follow.

## Entry Criteria

- Owner contacts are used for advisories (and E68 proposals) only. They are not a trust tier for journaling eligibility or memory.
- Delivery uses the E64 `systemMessages` capability; runtimes without it fall back to direct channel delivery.

## Exit Criteria

1. Each agent can configure one or more owner contacts (channel and contact id).
2. Advisories are stored with a condition key and lifecycle `open → delivered → acknowledged → resolved`: one advisory per condition, auto-resolved when the condition clears, re-raised on recurrence.
3. `info` and `warning` advisories reach the agent in the next owner conversation in a bus-originated block that inbound message bodies cannot spoof. `critical` advisories wake the agent with a system-only turn when supported, otherwise the bus messages the owner directly on the channel.
4. The agent acknowledges with an MCP tool. Each advisory carries a remediation hint.
5. Tests cover dedup, auto-resolve, re-raise, owner-only routing, spoofing resistance, and every delivery path. Docs updated.

## Stories

### S65.1 — Owner contacts config

Add per-agent `owners: [{ channel, contact_id }]` to the config schema with validation, a lookup helper (`isOwner`, `ownerConversations(agentId)`), and docs. No behavior change beyond lookup.

### S65.2 — Advisory store and lifecycle

Migration for an `advisories` table (id, agent_id, condition_key, severity `info | warning | critical`, title, body, remediation, state, timestamps, delivery attempts). Internal API: `raise(agentId, conditionKey, …)`, which is idempotent per open condition and escalates severity in place; `resolve(agentId, conditionKey)`; `ack(id)`. Tests for dedup, escalation, auto-resolve, and re-raise after resolve.

### S65.3 — Delivery paths

- **Injection:** prepend open, undelivered `info`/`warning` advisories to the next inbound batch for an owner conversation, as a distinct bus-originated block. Inbound bodies must not be able to forge it: escape or neutralize the marker in message text, and document the format for agent `CLAUDE.md` files. Mark delivered.
- **Critical:** a system-only turn to the agent's default conversation when the runtime has `systemMessages`; otherwise send directly to the owner's channel without the agent.
- **No system-message runtimes** (for example `claude-code`): direct channel delivery for all severities.
- MCP tool `advisory_ack({ id })`.

### S65.4 — Visibility and docs

List open advisories in `/status` and `GET /api/v1/advisories?agent=…`. Add `docs/ADVISORIES.md` (lifecycle, severities, block format, how to add a producer) and an MCP tool entry in `docs/MCP_TOOLS.md`.

## Out of Scope

- Specific producers beyond a test producer. Journaling producers land in E66; others are follow-ups.
- Owner-based trust for memory or journaling (explicitly not wanted).

## Implementation Notes

Implemented 2026-10-05/06 on `feat/e64-e68-journaling`. Code: `src/core/owners.ts`, `src/core/system-block.ts`, `src/advisories/` (store, service, render, transport), `src/pipeline/stages/advisory-inject.ts`, `src/mcp/tools/advisories.ts`, migration 025. Docs: `docs/ADVISORIES.md`.

Decisions and places where the code shaped the design:

- **Config shape.** A top-level `agents:` record already existed (keyed by prefixed recipient id, holding `media`). Owners went there as `agents.<id>.owners: [{ channel, contact_id }]`, optional. E66 adds `journaling` and E67 `memory` under the same key. Validation (root `superRefine`): the contact must exist, `contact_id` is bare, no duplicate contact+channel. `owners` is optional rather than defaulted to `[]` so existing typed test configs keep compiling.
- **Owner matching is exact on channel.** A Telegram group derived from the owner's bot channel is not an owner conversation. Pool panes map to the pool id (`OwnerDirectory.logicalAgentId`). The owner's default conversation is topic `general`.
- **No runtime requirement registered.** Advisories degrade (direct delivery) rather than requiring `systemMessages`, so `collectRuntimeRequirements` stays empty. Owners on an agent that resolves to no runtime log a startup warning only.
- **Injection is a pipeline stage (slot 86)**, after pool-route-resolve and transcript-log, so it sees the leased pane id and the block never lands in transcripts. Blocks are attached per route recipient and filtered at fan-out, so an `also_notify` agent never gets another agent's advisories. Advisories are marked `delivered` when attached (the epic's "mark delivered"); if `processInbound` then drops the message (paused adapter, follow-up capture) that advisory is not re-injected. Known edge, accepted.
- **Injection gate follows the epic, not `contextInjection`.** `claude-code` could technically carry an injected block, but per the epic every runtime without `systemMessages` gets direct delivery for all severities. Any still-open advisory (including a critical whose proactive delivery failed) is injected on runtimes with `systemMessages`.
- **Critical system-only turn** goes through `processInbound` as the owner contact in the owner's default conversation with a new trusted option (`systemOnly`, `routeFilter`), not through `pool-manager`'s `notifySystem()`: that posts to channel `system`, which routes by the default rule rather than to the owning agent's conversation. The pipeline gives routing, pane leasing and session tracking for free. cc-headless treats `system_only` batches as system turn class. The placeholder body is logged to the transcript as an inbound message from the owner (flagged in metadata), which the Mac app may show in Main — open question.
- **Direct delivery** enqueues a `system:bus` → `contact:<owner>` envelope for the delivery worker (the same path agent `send_message` uses), with an adapter check up front.
- **Spoofing.** Three layers: look-alike marker neutralization in everything rendered after the blocks (bodies, quotes, file names, memory/topic context, and producer text inside blocks); the reserved metadata keys `system_blocks`/`system_only` are stripped in `processInbound` and `POST /api/v1/messages` (the agent-to-agent path could otherwise forge them); and **no HTTP route raises advisories**, so an agent with bus API access can't author block text. The "test producer" is the test suite.
- **Retries.** Proactive delivery retries from the existing 60 s maintenance tick with linear backoff, max 5 attempts per (re)open; escalation resets attempts.
- **Lifecycle storage.** A recurrence after resolve inserts a new row (history kept); a partial unique index enforces one active row per (agent, condition).

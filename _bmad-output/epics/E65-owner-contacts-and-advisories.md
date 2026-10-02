# E65 — Owner Contacts and Bus Advisories

| Field | Value |
|---|---|
| Epic ID | E65 |
| Status | Planned |
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

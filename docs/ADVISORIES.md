# Owner contacts and bus advisories

A bus advisory is a message from the bus itself, such as "agent X's journaling chain can run out of options". It reaches the agent's **owners**, the people configured to hear about problems with that agent.

## Owner contacts

Each agent lists its owners under `agents.<agent id>.owners`, next to its other per-agent settings:

```yaml
contacts:
  chris:
    id: chris
    displayName: Chris
    platforms:
      telegram: { userId: 123456789 }

agents:
  "agent:baxter":
    owners:
      - channel: telegram:baxter   # exact channel of the owner's conversation
        contact_id: chris          # a key under contacts (no "contact:" prefix)
      - channel: app
        contact_id: chris
```

- `contact_id` must name a configured contact. The bus refuses to start otherwise, and also rejects the same contact listed twice on one channel.
- `channel` is matched exactly. An owner on `telegram:baxter` is not an owner in a group derived from that bot (`telegram:baxter:group:<id>`), because other people read groups.
- For a `cc-pool` agent, configure owners under the pool's own id (`agent:peggy`). Panes (`agent:peggy-pool-2`) inherit them.
- The owner's **default conversation** with the agent is the one on that channel with topic `general` (the Mac app's Main).
- Owners receive advisories (and, later, E68 self-edit proposals). They are not a trust tier: they don't change what the agent may remember or journal.

Code: `src/core/owners.ts` (`OwnerDirectory`: `owners`, `isOwner`, `ownerConversations`, `logicalAgentId`).

## Advisory lifecycle

Advisories live in the `advisories` table (migration 025). Each one has a condition key chosen by its producer, a severity (`info`, `warning` or `critical`), a title, a body, and a required remediation hint telling the owner what to do.

```
open ──► delivered ──► acknowledged ──► resolved
  └──────────┴──────────────┴──────────────┘ (resolve from any state)
```

- **One advisory per condition.** While a condition is active (any state except `resolved`), raising it again updates the same row: `raise_count` and `last_raised_at` move, changed text is stored, and delivery state is kept.
- **Escalation in place.** Raising with a higher severity updates the row and moves it back to `open`, so it is delivered again at the new severity. A lower severity never de-escalates.
- **Auto-resolve.** The producer calls `resolve(agent, conditionKey)` when the condition clears.
- **Re-raise on recurrence.** A raise after `resolve` opens a new row, so the history of past occurrences is kept.
- **Acknowledge.** The agent calls the `advisory_ack` MCP tool once it has relayed the advisory. An agent can only acknowledge its own advisories.

Code: `src/advisories/store.ts` (`AdvisoryStore`: `raise`, `resolve`, `ack`, `markDelivered`, `recordAttempt`, `list`, `listActive`).

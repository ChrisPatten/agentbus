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

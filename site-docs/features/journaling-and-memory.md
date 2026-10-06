# Journaling and memory

After a conversation, the bus has your agent look back at it and record what's worth keeping in its memory files. This is called **journaling**. It happens silently: nothing is sent to the people in the conversation.

## When a conversation is journaled

The bus checks a conversation when:
- **it pauses**: nobody has written for the agent's `threshold_ms`;
- **it runs long**: more than `ceiling_ms` has passed since it was last journaled;
- **it ends**: you run `/clear`, or the session closes;
- **the bus stops**: conversations with something new are journaled when the bus starts again.

A conversation is journaled once it has at least `min_human_messages` (default 2) new messages from a person. Scheduled jobs, slash commands and messages between agents don't count, so a morning briefing that nobody answers isn't journaled. If you reply to it, the exchange is journaled with the briefing included for context. When a conversation ends with fewer messages, or a single message has waited a day, it's journaled anyway.

Journaling only covers what's new since the last time, so nothing is journaled twice.

## Setting it up

`cc-headless` agents journal by default. To change when and how, add a `journaling` block for the agent under [`agents`](/reference/configuration#journaling):

```yaml
agents:
  "agent:assistant":
    journaling:
      threshold_ms: { default: 1800000, telegram: 300000 }
      ceiling_ms: 14400000
```

Journaling for `cc-pool` and `claude-code` agents, the `/journal` command and more ways to journal are coming soon. Documentation for memory and agent learning is coming soon too: these features are being rebuilt.

# AgentBus — Design Spike: Routing, Slash Commands & Message Handling

**Status:** APPROVED — decisions locked
**See:** Full document archived in Cowork outputs

## Locked Decisions Summary

| # | Decision |
|---|----------|
| S1 | Message expiry configurable; error returned to sender on expiry |
| S2 | Fan-out: N independent envelopes per target channel |
| S3 | Adapter-level message transformation in send() |
| S4 | Pipeline extensible via bus.pipeline.use() priority slots |
| S5 | conversation_id = hash(contact_id + channel + topic); /resume bridges channels |
| S6 | Unknown slash commands pass through enriched to agent |
| A1 | Commands registered with adapters via registerCommands() at startup |
| A2 | Plugin loader stub for npm-based adapters (v2+) |
| A3 | Capabilities system: AdapterCapabilities interface |
| A4 | react_to_message MCP tool; tapback mapping for BlueBubbles |
| A5 | markRead called post-delivery, async non-blocking |
| A6 | /resume finds most recent session any channel, fires session_history event |

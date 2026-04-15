# AgentBus Backlog

Feature ideas and future work that hasn't been scoped into an epic yet. Promote entries here to a new epic file when prioritized.

## Ideas

### Tools component: script-backed MCP tools + macOS TCC permissions carrier
User writes a script (any language) that optionally accepts parameters and returns output, then declares it in config to expose it as an MCP tool callable by agents. The bus wraps the script, handles invocation, and returns output. Config controls which agents can call which tools (per-tool agent allowlist). Secondary role: act as a long-lived process that holds macOS TCC grants (Calendar, Contacts, Reminders, etc.) so agents can invoke sensitive system operations through it without each needing their own TCC authorization. Needs a spike covering: config schema for tool declarations, parameter passing/output capture, per-agent allowlisting, and TCC entitlement strategy.

### ~~Scheduled tasks / scheduled prompts~~ → promoted to E18 (complete 2026-04-15)

### Evaluate A2A (Agent-to-Agent) protocol adoption
Research Google's A2A protocol and assess fit for AgentBus: what it offers (agent discovery, task delegation, streaming responses), where it overlaps with current MCP+bus design, and whether to adopt it as a transport/protocol layer, expose an A2A-compatible endpoint, or skip it. Output should be a short spike doc in `_bmad-output/planning-artifacts/`.

### Multi-bot support: run multiple Telegram bots from a single AgentBus instance
Allow `adapters.telegram` to accept a list of bot configs (each with its own token, name, and contact set) so a single AgentBus process can host several distinct bots. Use case: a personal assistant bot and a purpose-specific bot (e.g. a Pokémon companion bot at `~/workspace/pokeclaudebot`) managed centrally with shared routing infrastructure. Needs a spike covering: config schema change (single object → named map or array), adapter refactor to spin up one long-poll loop per token, message tagging to track which bot received each inbound message, and routing rules that dispatch by bot identity.

<!-- Add ideas below. Format: short title, one-line description, optional notes. -->

### CC adapter: include message timestamp in agent delivery
`formatMessagesForSampling` (cc.ts) omits `envelope.timestamp`, so the agent has no temporal context for messages delivered via either channel push or the MCP tool buffer. Include the ISO timestamp in the formatted string so the agent knows when a message was sent. Relevant for reasoning about stale messages, scheduling, and time-sensitive replies.

### Telegram: implement emoji reactions via sendReaction API
Enable `canReact: true` in the Telegram adapter and implement `react(messageId, emoji)` using Telegram's `sendReaction` API. E10 already wires `react_to_message` end-to-end for adapters that support it; this just unlocks it for Telegram. Note: Telegram reactions are limited to a small set of approved emoji.

### Telegram: keep typing indicator active while agent is working
Continuously renew the `sendChatAction: typing` indicator while the agent is processing a message, so the user sees the bot is active. Telegram's typing indicator expires after ~5s, so this requires a polling loop that re-sends it until the agent posts a reply.

### Telegram: defer read receipt until agent pickup
Don't mark a Telegram message as read (send `readReceipt` / stop typing indicator) until the agent actually dequeues the message from the bus, so Telegram's UI accurately reflects pending vs. processed messages.


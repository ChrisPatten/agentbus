# AgentBus — Product Requirements Document

**Version:** 1.2
**Status:** Approved
**BMAD Phase:** 2 — Planning
**Project:** agentbus

---

## 1. Problem Statement

Personal AI agents need to communicate with their human across multiple platforms (iMessage, Telegram, Claude Code) while maintaining continuity of context across sessions. Today these are three completely separate channels with no shared memory, no unified routing, and no way to correlate conversations.

There is no existing tool that provides:
- A **pluggable transport layer** — existing solutions (Cross-Claude MCP, AgentChatBus, Claude Peers) are all tightly coupled to a single transport
- A **human-to-agent** focus — existing tools are agent-to-agent; this is about the operator reaching the agent and the agent reaching back, from wherever you are
- An **ambient memory pipeline** that captures conversational context across sessions without requiring the agent to do anything special

AgentBus solves all three.

---

## 2. Vision

> A persistent message bus running on the home server that gives an AI agent a single, unified inbox and outbox — regardless of which platform the human is using — with memory that flows automatically between sessions.

---

## 3. Goals

- G1: Deliver messages from any supported platform to a Claude Code agent reliably
- G2: Enable the agent to reply back through the same platform the message arrived on
- G3: Log all conversation transcripts automatically, without agent involvement
- G4: Summarize transcripts into session summaries that seed the next agent session with context
- G5: Expose a clean MCP tool surface so agents can interact with the bus, search memory, and log facts explicitly
- G6: Support adding new adapters without modifying bus core

---

## 4. Non-Goals (v1)

- NG1: Multi-user support — this is a single-operator system (the operator and agent)
- NG2: Authentication — Tailscale provides the network boundary; no auth in v1
- NG3: Agent-to-agent routing — the bus routes human→agent and agent→human only in v1
- NG4: Vector/semantic search — FTS5 keyword search is sufficient for v1; embeddings are a future upgrade
- NG5: Web UI or dashboard — CLI and MCP tools only in v1
- NG6: Cloud deployment — runs only
- NG7: Webhook-based Telegram — long polling is sufficient behind Tailscale

---

## 5. Users and Personas

### Chris (Human Owner)
Sends and receives messages to/from the agent across iMessage, Telegram, and Claude Code. Expects the agent to remember context from previous sessions. Does not want to think about which platform is "active." Primary success metric: the agent feels continuous, not amnesiac.

### the AI agent (Claude Code)
Receives incoming messages from Chris via the Claude Code channel adapter. Uses MCP tools to send replies, search memory, log facts, and retrieve briefings. Needs context injected at session start without having to ask for it.

### Future Agents
The bus is designed to support multiple named agents sharing the same bus infrastructure (namespaced subscriptions), but v1 has only one agent.

---

## 6. Core Concepts

### Message Envelope
Every message on the bus — regardless of origin — is wrapped in a standard envelope:

```json
{
  "id": "uuid",
  "timestamp": "iso8601",
  "channel": "telegram",
  "topic": "general",
  "sender": "user:chris",
  "recipient": "agent:claude",
  "reply_to": "msg-uuid-or-null",
  "priority": "normal",
  "payload": {
    "type": "text",
    "body": "Hey, what.s on my calendar?"
  },
  "metadata": {}
}
```

### Adapter
A pluggable component that implements a standard interface:
- `name` / `id` — unique identifier
- `send(envelope)` → delivery result
- `poll()` → inbound messages
- `start()` / `stop()` — lifecycle hooks
- `health()` → status check
- `capabilities` — static declaration of optional features supported
- `markRead?(platformMessageId)` — optional; called after delivery
- `react?(platformMessageId, reaction)` — optional; send a reaction
- `registerCommands?(commands[])` — optional; push command list to platform UI

Adapters are registered with the Adapter Registry at startup. The bus core never imports adapter implementations directly — it only talks to the registry.

### Adapter Capabilities

| Capability | Telegram | BlueBubbles | Claude Code |
|-----------|----------|-------------|-------------|
| send | ✅ | ✅ | ✅ |
| markRead | ✅ | ✅ | ✅ |
| react | ✅ | ✅ | ❌ |
| typing | ✅ | ❌ | ❌ |
| registerCommands | ✅ | ❌ | ❌ |

### Plugin System
The adapter registry supports loading adapters from npm packages at startup. V1 ships with three built-in adapters; the plugin loader interface is defined for future use.

### Channel
A named transport pathway (e.g., `claude-code-channels`, `telegram`, `bluebubbles`). Each channel maps to one adapter.

### Session
A bounded window of conversation activity. A session starts when the first message arrives after a period of inactivity, and is marked `summarized` after 15 minutes of silence.

---

## 7. MCP Tool Surface

| Tool | Signature | Description |
|------|-----------|-------------|
| `send_message` | `(channel, recipient, body, reply_to?)` | Post a message to a channel/topic |
| `receive_messages` | `(channel?, topic?, limit?)` | Poll pending messages for this agent |
| `subscribe` | `(channel, topic)` | Register interest; messages get queued |
| `list_channels` | `()` | Discover available channels and adapter health |
| `ack_message` | `(message_id)` | Mark a message processed; prevents re-delivery |
| `recall_memory` | `(query, limit?)` | FTS5 search across the memory store |
| `log_memory` | `(content, category, expires_at?)` | Agent explicitly writes a fact to memory |
| `get_session` | `(session_id?)` | Compile: session metadata + summary, key topics, decisions, open questions |
| `search_transcripts` | `(query, session_id?, platform?, since?, limit?)` | FTS5 search across raw transcripts |
| `get_session` | `(session_id)` | Return full transcript for a session |
| `list_sessions` | `(since?, limit?)` | Browse recent sessions with their summaries |
| `react_to_message` | `(message_id, reaction)` | Send a reaction emoji to a message; gracefully fails if adapter doesn't support it |

---

## 8. Adapters — Detailed Requirements

### 8.1 Claude Code Channel Adapter

**Type:** MCP server (spawned as subprocess by Claude Code via stdio)

**Inbound:** Claude Code spawns adapter over stdio → adapter polls bus HTTP API → emits `notifications/claude/channel` events → fires `context_load` event on session start with last 48h summaries

**Outbound:** Agent calls `reply` MCP tool → adapter POSTs to bus HTTP API → bus routes to originating adapter

**Constraints:** Uses `--dangerously-load-development-channels`; requires claude.ai login; keep-alive via tmux recommended

---

### 8.2 Telegram Bot Adapter

**Type:** Persistent worker process

**Inbound:** Long-polls `getUpdates` → filters by allowed sender IDs → wraps in envelope → posts to bus queue

**Outbound:** Bus delivers telegram envelope → adapter calls `sendMessage`

---

### 8.3 BlueBubbles (iMessage) Adapter

**Type:** Webhook receiver + HTTP client

**Inbound:** Registers webhook → BlueBubbles POSTs on new-message → adapter wraps in envelope → posts to bus queue

**Outbound:** Bus delivers BB envelope → adapter POSTs to `/api/v1/message/text`

---

## 9. Slash Commands

**Processing Model: Hybrid.** Bus-level commands execute immediately. Agent-level/unknown commands are enriched and routed to the agent.

### Built-in Bus Commands

| Command | Description |
|---------|-------------|
| `/status` | Bus uptime, adapter health, queue depth, last summarizer run |
| `/help` | List all registered commands |
| `/pause [adapter]` | Pause an adapter |
| `/resume` | Pull most recent session context (any channel) into current channel |
| `/sessions [limit]` | List recent sessions with summaries |
| `/replay <session_id>` | Re-inject a specific session's summary into current context |
| `/forget <memory_id>` | Mark a memory expired/superseded |
| `/subscribe <channel> <topic>` | Subscribe current contact to channel/topic |

---

## 10. Memory System

Three-layer architecture: Transcript Logger (every message) → Summarizer Pipeline (async, 15min inactivity) → Context Injector (last 48h injected at session start)

**Short-term** = ambient buffer through the pipeline. **Long-term** = files the agent maintains herself.

---

## 11. SQLite Schema

Tables: `sessions`, `transcripts` (+ FTS5), `session_summaries`, `memories` (+ FTS5), `message_queue`, `dead_letter`

WAL mode. See architecture.md for full schema.

---

## 12. HTTP API (Internal)

```
POST /api/v1/messages          — submit envelope to queue
GET  /api/v1/messages/pending  — poll pending (?agent=claude&limit=10)
POST /api/v1/messages/:id/ack  — acknowledge
GET  /api/v1/health            — bus health + adapter statuses
POST /api/v1/inbound           — webhook receiver (BlueBubbles)
```

---

## 13. Non-Functional Requirements

| Requirement | Target |
|-------------|--------|
| Message latency | < 500ms queue to delivery |
| Polling interval (CC adapter) | ~1 second |
| Summarizer latency | Non-blocking; < 30s after inactivity trigger |
| SQLite durability | WAL mode; survive crash without data loss |
| Startup time | < 2 seconds |
| Memory context budget | 2,000–3,000 tokens |
| FTS5 search | < 50ms |

---

## 14. Implementation Epics

| Epic | Title | Est. Stories |
|------|-------|--------------|
| E1 | Bus Core + SQLite Schema + Config Loader | 5 |
| E2 | Claude Code Channel Adapter | 4 |
| E3 | Telegram Adapter | 4 |
| E4 | BlueBubbles Adapter | 3 |
| E5 | Inbound Pipeline | 4 |
| E6 | Slash Command System | 3 |
| E7 | MCP Tool Surface | 5 |
| E8 | Memory — Transcript Logger + Summarizer | 4 |
| E9 | Memory — Context Injector + Recall | 3 |
| E10 | Adapter Capabilities (reactions, markRead, typing) | 3 |
| E11 | Plugin Loader + Adapter Interface | 2 |
| E12 | Operational (health, daemon mgmt, deployment) | 3 |

**Build order:** E1 → E2 → E7 → E5 → E6 → E8 → E9 → E3 → E4 → E10 → E11 → E12

---

## 15. Locked Architecture Decisions

1. **Separate daemons** — each adapter + bus core runs as independent process
2. **stdio MCP transport** — CC adapter uses stdio; connects to bus core via HTTP
3. **config.yaml + .env** — structured config + secrets separated; `${VAR}` env var refs
4. **Contact registry in config.yaml** — contacts have canonical id + platform identifiers
5. **Routing/commands/pipeline** — fully specified in design-spike-routing-commands.md

---

*AgentBus PRD v1.2 — BMAD Phase 2 complete*

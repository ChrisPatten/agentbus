# AgentBus Architecture

**Phase 3 — Architecture Document**
**Status:** Draft v1.0
**BMAD Phase:** Analysis → Planning → **Architecture** → Implementation

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Process Model](#2-process-model)
3. [Directory Structure](#3-directory-structure)
4. [Key Interfaces](#4-key-interfaces)
5. [HTTP API (Internal)](#5-http-api-internal)
6. [MCP Server (Claude Code Adapter)](#6-mcp-server-claude-code-adapter)
7. [SQLite Schema](#7-sqlite-schema)
8. [Config Loader](#8-config-loader)
9. [Inbound Pipeline](#9-inbound-pipeline)
10. [Memory System Architecture](#10-memory-system-architecture)
11. [Adapter Plugin Loader](#11-adapter-plugin-loader)
12. [Startup Sequence](#12-startup-sequence)
13. [Technology Choices](#13-technology-choices)

---

## 1. System Overview

AgentBus is a persistent TypeScript message bus server running on a Mac mini that unifies Claude Code (via MCP), Telegram, and BlueBubbles (iMessage) into a single ambient inbox/outbox for an AI agent named Peggy. Each communication channel is implemented as a separate long-running daemon process that connects to a central **bus-core** over an internal HTTP API. Inbound messages from any channel flow through an 8-stage normalization pipeline before landing in a SQLite-backed queue, where Peggy polls them via MCP tools. Outbound replies are dispatched back through the originating (or specified) adapter. A persistent memory system transcribes every conversation, summarizes inactive sessions, and injects context at session start — giving Peggy continuous ambient awareness across all channels and restarts.

### Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Mac Mini (host)                                │
│                                                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                           bus-core (pm2)                              │  │
│  │                                                                       │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌─────────────┐  ┌───────────┐  │  │
│  │  │  PipelineEng │  │  MessageQueue│  │AdapterReg.  │  │CommandReg.│  │  │
│  │  │  (8 stages)  │  │  (SQLite)    │  │             │  │           │  │  │
│  │  └──────┬───────┘  └──────┬───────┘  └──────┬──────┘  └─────┬─────┘  │  │
│  │         │                 │                  │               │        │  │
│  │  ┌──────▼─────────────────▼──────────────────▼───────────────▼──────┐ │  │
│  │  │                      Bus class (orchestrator)                     │ │  │
│  │  └──────────────────────────────┬───────────────────────────────────┘ │  │
│  │                                 │                                      │  │
│  │  ┌──────────────────────────────▼───────────────────────────────────┐ │  │
│  │  │              Fastify HTTP API  :3000                              │ │  │
│  │  │  POST /api/v1/messages        GET /api/v1/messages/pending        │ │  │
│  │  │  POST /api/v1/messages/:id/ack  POST /api/v1/inbound             │ │  │
│  │  │  GET  /api/v1/health          GET  /api/v1/adapters              │ │  │
│  │  └──────────────────────────────────────────────────────────────────┘ │  │
│  │                                                                       │  │
│  │  ┌─────────────────────────────────────────────────────────────────┐  │  │
│  │  │                   Memory System (async)                          │  │  │
│  │  │  TranscriptLogger  │  SummarizerPipeline  │  ContextInjector    │  │  │
│  │  └─────────────────────────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                   ▲ HTTP (localhost:3000)                                    │
│        ┌──────────┼──────────────────────────────┐                          │
│        │          │                              │                          │
│  ┌─────┴──────┐  ┌┴───────────────┐  ┌──────────┴──────────────────────┐   │
│  │  telegram  │  │ bluebubbles    │  │  claude-code-adapter            │   │
│  │  -adapter  │  │ -adapter       │  │  (MCP server, stdio)            │   │
│  │  (pm2)     │  │ (pm2)          │  │  spawned by Claude Code         │   │
│  └─────┬──────┘  └┬──────────┬───┘  └───────────────┬─────────────────┘   │
│        │          │          │                       │                      │
└────────┼──────────┼──────────┼───────────────────────┼──────────────────────┘
         │          │          │                       │
         ▼          ▼          ▼                       ▼
    Telegram     BlueBubbles  BlueBubbles           Claude Code
    API (HTTPS)  API (HTTP)   webhooks              (MCP stdio)
    long-poll    outbound     inbound
```

**IPC Rule:** All inter-process communication is HTTP to `localhost:3000`. Adapters never import from `bus-core`. No shared memory, no Unix sockets, no message brokers.

---

## 2. Process Model

AgentBus runs as four separate, independently managed processes.

### 2.1 bus-core

**Entry point:** `src/index.ts`
**Process manager:** pm2 (`pm2 start bus-core`)
**Role:** Central orchestrator. Owns all shared state.

Responsibilities:
- Hosts the Fastify HTTP API on `config.bus.http_port` (default 3000)
- Manages the SQLite database (message queue, transcripts, contacts, dead letters)
- Runs the 8-stage inbound pipeline for every received message
- Maintains the AdapterRegistry (tracks registered adapters and their capabilities)
- Maintains the CommandRegistry (built-in and agent-registered slash commands)
- Runs the SummarizerPipeline async daemon (timer loop)
- Dispatches outbound messages to adapters via their registered HTTP send endpoints (or direct SDK call for in-process adapters registered by name)

bus-core does **not** long-poll external APIs. It receives inbound messages via POST to `/api/v1/inbound` or `/api/v1/messages`, and dispatches outbound messages by calling adapter HTTP endpoints registered at startup.

### 2.2 telegram-adapter

**Entry point:** `src/adapters/telegram.ts` (run directly, not imported by bus-core)
**Process manager:** pm2 (`pm2 start telegram-adapter`)
**Role:** Telegram gateway. Long-polls Telegram Bot API; posts inbound to bus; receives outbound via internal HTTP.

Responsibilities:
- Authenticates with Telegram Bot API using `TELEGRAM_BOT_TOKEN`
- Long-polls `getUpdates` endpoint (or Telegram webhooks if configured)
- Transforms each Telegram update into a `MessageEnvelope` and POSTs to `POST /api/v1/messages`
- Exposes a small internal HTTP endpoint (e.g., `localhost:3001`) so bus-core can call it to send outbound Telegram messages
- Registers with bus at startup via `POST /api/v1/adapters` (or bus reads config)
- Handles retries, backoff, and error reporting for Telegram API failures

### 2.3 bluebubbles-adapter

**Entry point:** `src/adapters/bluebubbles.ts`
**Process manager:** pm2 (`pm2 start bluebubbles-adapter`)
**Role:** BlueBubbles (iMessage) gateway. Receives webhooks; sends via BlueBubbles REST API.

Responsibilities:
- Listens for inbound webhooks from BlueBubbles server (HTTP POST on configured port, e.g., `localhost:3002`)
- Transforms BlueBubbles webhook payloads into `MessageEnvelope` and POSTs to `POST /api/v1/inbound`
- Exposes an outbound send endpoint so bus-core can deliver messages back as iMessages
- Maps reaction emojis to BlueBubbles tapback integers (see §4 capabilities, A4)
- Handles media attachments as metadata fields (v2 concern, stubs in v1)

### 2.4 claude-code-adapter

**Entry point:** `src/adapters/cc.ts`
**Process manager:** Spawned by Claude Code over stdio (not pm2)
**Role:** MCP server. Provides all 12 MCP tools to Peggy's Claude Code session.

Responsibilities:
- Implements the Model Context Protocol over stdio using `@modelcontextprotocol/sdk`
- Exposes all 12 MCP tools (see §6)
- Polls `GET /api/v1/messages/pending?agent=peggy` approximately every 1 second
- On new pending messages, surfaces them via the `claude/channel` experimental capability push event
- On session start, calls `GET /api/v1/memory/summaries?hours=48` and fires a `context_load` event with the result
- Does **not** persist state; all state is in bus-core's SQLite

### 2.5 Startup Sequence (Cross-Process)

```
t=0   pm2 starts bus-core
t=1   bus-core loads config, connects SQLite, runs migrations
t=2   bus-core starts Fastify on :3000
t=3   bus-core logs "bus-core ready, awaiting adapters"

t=5   pm2 starts telegram-adapter
t=6   telegram-adapter reads config, begins Telegram long-poll
t=7   telegram-adapter registers with bus: POST /api/v1/adapters {id: "telegram", ...}

t=5   pm2 starts bluebubbles-adapter (parallel with telegram)
t=6   bluebubbles-adapter starts webhook listener on :3002
t=7   bluebubbles-adapter registers with bus: POST /api/v1/adapters {id: "bluebubbles", ...}

t=N   Claude Code spawns claude-code-adapter via stdio (on demand)
t=N+1 cc-adapter calls GET /api/v1/memory/summaries?hours=48
t=N+2 cc-adapter fires context_load channel event to Claude Code
t=N+3 cc-adapter begins polling loop (1s interval)
```

---

## 3. Directory Structure

```
agentbus/
├── src/
│   ├── index.ts                  # bus-core entry point: wires everything together
│   ├── core/
│   │   ├── bus.ts                # Bus class: top-level orchestrator
│   │   ├── pipeline.ts           # PipelineEngine: ordered middleware chain
│   │   ├── queue.ts              # MessageQueue: SQLite-backed enqueue/poll/ack
│   │   ├── registry.ts           # AdapterRegistry: track adapters + capabilities
│   │   ├── contacts.ts           # ContactRegistry: resolve platform IDs → contacts
│   │   └── commands.ts           # CommandRegistry: register + dispatch slash commands
│   ├── adapters/
│   │   ├── interface.ts          # Adapter interface, AdapterCapabilities, DeliveryResult
│   │   ├── cc.ts                 # Claude Code adapter (MCP server, stdio)
│   │   ├── telegram.ts           # Telegram adapter (standalone daemon)
│   │   └── bluebubbles.ts        # BlueBubbles adapter (standalone daemon)
│   ├── mcp/
│   │   ├── server.ts             # MCP Server instantiation + transport setup
│   │   └── tools.ts              # All 12 MCP tool definitions + handlers
│   ├── memory/
│   │   ├── transcript.ts         # TranscriptLogger: sync hot-path writer
│   │   ├── summarizer.ts         # SummarizerPipeline: async session summarizer
│   │   └── injector.ts           # ContextInjector: fires context at CC session start
│   ├── pipeline/
│   │   ├── normalize.ts          # Stage 1 (slot 10): Field normalization
│   │   ├── contact-resolve.ts    # Stage 2 (slot 20): Contact ID resolution
│   │   ├── dedup.ts              # Stage 3 (slot 30): Deduplication
│   │   ├── slash-command.ts      # Stage 4 (slot 40): Slash command detection
│   │   ├── topic.ts              # Stage 5 (slot 50): Topic classification
│   │   ├── priority.ts           # Stage 6 (slot 60): Priority scoring
│   │   ├── route.ts              # Stage 7 (slot 70): Route resolution
│   │   └── transcript-log.ts     # Stage 8 (slot 80): Transcript write
│   ├── commands/
│   │   ├── registry.ts           # Re-exports CommandRegistry from core/commands.ts
│   │   └── builtins.ts           # Built-in command implementations (/help, /status, etc.)
│   ├── config/
│   │   ├── loader.ts             # Config load: yaml → validate → env substitution
│   │   └── schema.ts             # Zod schema for full config structure
│   ├── db/
│   │   ├── client.ts             # better-sqlite3 client, WAL pragma, singleton
│   │   ├── schema.ts             # CREATE TABLE statements + migration runner
│   │   └── queries.ts            # Typed query helper functions (no raw SQL in app)
│   └── http/
│       └── api.ts                # Fastify server: all route definitions
│
├── _bmad-output/
│   ├── planning-artifacts/
│   │   ├── PRD.md
│   │   ├── design-spike-routing-commands.md
│   │   └── architecture.md       # ← this document
│   └── epics/
│       └── (sprint epic files)
│
├── config.yaml.example           # Annotated example config (committed)
├── config.yaml                   # Actual config (gitignored)
├── .env.example                  # Env var reference
├── .env                          # Secrets (gitignored)
├── sprint-status.yaml            # BMAD sprint tracker
├── CLAUDE.md                     # Claude Code project instructions + context
├── package.json
├── tsconfig.json
└── pm2.config.js                 # pm2 ecosystem file for bus-core + adapters
```

---

## 4. Key Interfaces

All interfaces are defined in `src/adapters/interface.ts` and `src/core/` files. They are the shared contract between all system components.

### 4.1 MessageEnvelope

The canonical message type. Every message in the system is represented as a `MessageEnvelope` from the moment it enters the pipeline.

```ts
interface MessageEnvelope {
  id: string;              // UUID v4, generated at normalization stage
  timestamp: string;       // ISO 8601, e.g. "2025-09-15T14:32:00.000Z"
  channel: string;         // "telegram" | "bluebubbles" | "claude-code"
  topic: string;           // "general" | "reminders" | "code" | "personal" | ...
  sender: string;          // "contact:chris" | "agent:peggy"
  recipient: string;       // "agent:peggy" | "contact:chris"
  reply_to: string | null; // id of message being replied to, or null
  priority: 'normal' | 'high' | 'urgent';
  payload: {
    type: 'text' | 'slash_command';
    body: string;           // full message text
    command?: string;       // "/remind" — only when type === 'slash_command'
    args_raw?: string;      // "tomorrow at 9am buy milk"
  };
  metadata: Record<string, unknown>; // platform-specific extras, pipeline annotations
}
```

`metadata` carries non-normalized data through the pipeline. Examples: `{ telegram_message_id: 12345, bb_guid: "abc-def", conversation_id: "hash..." }`.

### 4.2 Adapter Interface

```ts
interface Adapter {
  readonly id: string;          // "telegram" | "bluebubbles" | "claude-code"
  readonly name: string;        // Human-readable display name
  readonly capabilities: AdapterCapabilities;

  // Core lifecycle
  start(): Promise<void>;       // Begin polling / listening
  stop(): Promise<void>;        // Graceful shutdown
  health(): Promise<HealthStatus>;

  // Messaging
  send(envelope: MessageEnvelope): Promise<DeliveryResult>;
  poll?(): Promise<MessageEnvelope[]>; // Only if adapter pulls (CC adapter)

  // Optional capabilities (guard with capabilities flags)
  markRead?(platformMessageId: string): Promise<void>;
  react?(platformMessageId: string, reaction: string): Promise<void>;
  registerCommands?(commands: CommandDefinition[]): Promise<void>;
}

interface AdapterCapabilities {
  send: true;                    // All adapters must support send
  markRead?: boolean;
  react?: boolean;               // Tapbacks (BB), emoji reactions (Telegram)
  typing?: boolean;              // Typing indicators
  registerCommands?: boolean;    // Can accept slash command registration
}

interface DeliveryResult {
  success: boolean;
  platformMessageId?: string;    // Returned by platform on success
  error?: string;
  retryable?: boolean;           // True if a retry may succeed
}

interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  latencyMs?: number;
  lastActivity?: string;         // ISO 8601
  details?: Record<string, unknown>;
}
```

### 4.3 Pipeline Stage

```ts
type PipelineContext = {
  bus: Bus;
  config: AppConfig;
  db: Database;
  logger: Logger;
  abortReason?: string;          // Set when a stage returns null
};

type PipelineStage = (
  envelope: MessageEnvelope,
  ctx: PipelineContext
) => Promise<MessageEnvelope | null>;
// Returning null aborts the pipeline (message dropped or handled inline)

interface PipelineStageDefinition {
  name: string;
  slot: number;                  // Execution order: 10, 20, 30, ...
  stage: PipelineStage;
}
```

### 4.4 Bus Command

```ts
interface BusCommand {
  name: string;                  // "remind", "status", "help"
  description: string;
  pattern: RegExp;               // e.g. /^\/remind\s+(.+)$/i
  scope: 'bus' | 'agent';        // 'bus' = handled by bus; 'agent' = forwarded to Peggy
  handler: (
    args: string[],
    ctx: MessageContext
  ) => Promise<CommandResult>;
}

interface MessageContext {
  envelope: MessageEnvelope;
  adapter: Adapter;
  bus: Bus;
  db: Database;
}

interface CommandResult {
  handled: boolean;
  reply?: string;                // Sent back to sender if provided
  envelopes?: MessageEnvelope[]; // Additional messages to enqueue
}

interface CommandDefinition {
  name: string;
  description: string;
  pattern: string;               // Serialized regex for adapter registration
}
```

### 4.5 Contact

```ts
interface Contact {
  id: string;                    // Canonical: "chris", "mom", "alice"
  displayName: string;
  platforms: {
    telegram?: { userId: number; username?: string };
    bluebubbles?: { handle: string };  // Phone or email
  };
}
```

Contacts are defined in `config.yaml` and loaded into `ContactRegistry` at startup. They are not stored in SQLite — the config file is the source of truth.

### 4.6 AppConfig

```ts
interface AppConfig {
  bus: {
    http_port: number;           // Default 3000
    db_path: string;             // Path to SQLite file
    log_level: 'debug' | 'info' | 'warn' | 'error';
  };
  adapters: {
    telegram?: { token: string; poll_timeout: number; plugin?: string };
    bluebubbles?: { server_url: string; webhook_port: number; plugin?: string };
    'claude-code'?: { poll_interval_ms: number; plugin?: string };
  };
  contacts: Record<string, Contact>;
  topics: string[];              // Known topic labels
  memory: {
    summarizer_interval_ms: number;
    session_idle_threshold_ms: number;
    context_window_hours: number;
    claude_api_model: string;
  };
  pipeline: {
    stages?: string[];           // External stage module paths (v2+)
  };
}
```

---

## 5. HTTP API (Internal)

The Fastify HTTP API runs on `localhost:config.bus.http_port` (default 3000). It is **not** exposed to the public internet. All adapters communicate with bus-core through this API.

All request/response bodies are JSON. All routes return `{ ok: true, ... }` on success or `{ ok: false, error: string }` on failure. HTTP status codes follow REST conventions (200, 201, 400, 404, 500).

### 5.1 Message Routes

#### `POST /api/v1/messages`

Submit a `MessageEnvelope` to the inbound pipeline. The bus runs the full 8-stage pipeline synchronously, then enqueues the result.

**Request body:** `MessageEnvelope` (partial — `id` and `timestamp` are generated by the normalize stage if absent)

**Response (201):**
```json
{
  "ok": true,
  "id": "uuid-of-created-envelope",
  "queued": true,
  "pipeline_annotations": { "topic": "general", "priority": "normal" }
}
```

**Abort cases (200, not 4xx):**
- Duplicate detected (dedup stage): `{ "ok": true, "queued": false, "reason": "duplicate" }`
- Slash command handled inline: `{ "ok": true, "queued": false, "reason": "command_handled" }`

#### `GET /api/v1/messages/pending`

Poll for pending messages destined for a specific agent.

**Query params:**
- `agent` (required): e.g. `peggy`
- `limit` (optional, default 10, max 100)
- `topic` (optional): filter by topic

**Response (200):**
```json
{
  "ok": true,
  "messages": [ /* array of MessageEnvelope */ ],
  "count": 3
}
```

Messages are returned in FIFO order by `created_at`. Returned messages remain in `pending` state — the caller must acknowledge.

#### `POST /api/v1/messages/:id/ack`

Mark a message as delivered/processed.

**Request body:**
```json
{ "status": "delivered" | "failed", "error": "optional error string" }
```

**Response (200):**
```json
{ "ok": true, "id": "...", "status": "delivered" }
```

#### `POST /api/v1/messages/:id/dead-letter`

Force a message to dead-letter status, skipping normal retry logic.

**Request body:**
```json
{ "reason": "max_retries_exceeded" | "undeliverable" | "manual" }
```

**Response (200):**
```json
{ "ok": true, "id": "...", "dead_letter_id": "..." }
```

### 5.2 Inbound Webhook

#### `POST /api/v1/inbound`

Webhook receiver for BlueBubbles (and potentially other webhook-based sources). The adapter posts raw platform payloads here; bus-core normalizes and pipelines them.

**Request body:** Platform-specific JSON. Includes a `source` field to identify which adapter is posting.

```json
{
  "source": "bluebubbles",
  "payload": { /* raw BB webhook JSON */ }
}
```

**Response (200):**
```json
{ "ok": true, "processed": true }
```

### 5.3 Health

#### `GET /api/v1/health`

Returns the health status of bus-core and all registered adapters.

**Response (200):**
```json
{
  "ok": true,
  "bus": { "status": "healthy", "uptime_s": 3600 },
  "adapters": {
    "telegram": { "status": "healthy", "latencyMs": 120 },
    "bluebubbles": { "status": "degraded", "details": { "reason": "webhook_timeout" } }
  },
  "queue": { "pending": 2, "dead_letter": 0 }
}
```

HTTP 200 is always returned; status values within the body indicate health.

### 5.4 Adapter Management

#### `GET /api/v1/adapters`

List all registered adapters and their capabilities.

**Response (200):**
```json
{
  "ok": true,
  "adapters": [
    {
      "id": "telegram",
      "name": "Telegram",
      "status": "active",
      "capabilities": { "send": true, "react": true, "typing": true }
    }
  ]
}
```

#### `POST /api/v1/adapters/:id/pause`

Pause inbound and outbound processing for an adapter (messages accumulate in queue).

**Response (200):** `{ "ok": true, "id": "telegram", "status": "paused" }`

#### `POST /api/v1/adapters/:id/resume`

Resume a paused adapter.

**Response (200):** `{ "ok": true, "id": "telegram", "status": "active" }`

### 5.5 Memory

#### `GET /api/v1/memory/summaries`

Query session summaries (used by cc-adapter at startup for context injection).

**Query params:**
- `hours` (optional, default 48): look-back window
- `channel` (optional): filter by channel
- `contact` (optional): filter by contact id

**Response (200):**
```json
{
  "ok": true,
  "summaries": [
    {
      "session_id": "...",
      "channel": "telegram",
      "contact_id": "chris",
      "started_at": "...",
      "ended_at": "...",
      "summary": "Discussed grocery list and reminder for dentist."
    }
  ]
}
```

---

## 6. MCP Server (Claude Code Adapter)

The Claude Code adapter (`src/adapters/cc.ts` + `src/mcp/`) is a full MCP server. It is **spawned by Claude Code as a subprocess** using stdio transport — it does not run under pm2. When Claude Code starts a session with agentbus configured, it launches `tsx src/adapters/cc.ts` (or the compiled output) and communicates over stdin/stdout.

### 6.1 Server Initialization

```ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new Server(
  {
    name: 'agentbus-cc-adapter',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
      experimental: {
        'claude/channel': {},  // Push events to Claude Code
      },
    },
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
```

### 6.2 MCP Tools (All 12)

All tools communicate with bus-core's HTTP API at `localhost:config.bus.http_port`.

#### Inbox Tools

**`get_pending_messages`**
```ts
// Returns all messages in the pending queue for agent:peggy
// Input: { limit?: number; topic?: string }
// Output: { messages: MessageEnvelope[] }
```

**`acknowledge_message`**
```ts
// Mark a message as read/processed
// Input: { message_id: string; status: 'delivered' | 'failed'; error?: string }
// Output: { ok: boolean }
```

**`get_message`**
```ts
// Fetch a specific message by id (including delivered/dead-lettered)
// Input: { message_id: string }
// Output: { message: MessageEnvelope }
```

#### Reply & Outbound Tools

**`send_message`**
```ts
// Send a new message to a contact via a specified channel
// Input: {
//   recipient: string;      // "contact:chris"
//   channel: string;        // "telegram" | "bluebubbles" | "claude-code"
//   body: string;
//   topic?: string;
//   reply_to?: string;      // message_id to thread reply
//   priority?: 'normal' | 'high' | 'urgent';
// }
// Output: { ok: boolean; message_id: string }
```

**`reply_to_message`**
```ts
// Reply to a specific message (auto-resolves channel and recipient)
// Input: { message_id: string; body: string; topic?: string }
// Output: { ok: boolean; reply_id: string }
```

**`broadcast_message`**
```ts
// Send the same message to a contact across all active channels (fan-out)
// Input: { recipient: string; body: string; topic?: string }
// Output: { ok: boolean; message_ids: string[] }
```

#### Reaction & Status Tools

**`react_to_message`**
```ts
// React to a platform message (tapback for BB, emoji reaction for Telegram)
// Input: { message_id: string; reaction: string }  // reaction: "❤️" | "👍" | etc.
// Output: { ok: boolean }
// Note: Adapter maps to platform-specific reaction format (see A4)
```

**`mark_read`**
```ts
// Mark a platform message as read (calls adapter.markRead)
// Input: { message_id: string }
// Output: { ok: boolean }
```

#### Memory Tools

**`get_conversation_history`**
```ts
// Retrieve recent messages for a conversation
// Input: {
//   conversation_id?: string;
//   contact_id?: string;
//   channel?: string;
//   limit?: number;       // default 50
//   since?: string;       // ISO 8601
// }
// Output: { messages: MessageEnvelope[] }
```

**`get_session_summaries`**
```ts
// Retrieve AI-generated session summaries
// Input: { hours?: number; contact_id?: string; channel?: string }
// Output: { summaries: SessionSummary[] }
```

#### Bus Control Tools

**`get_bus_status`**
```ts
// Get current bus health and adapter statuses
// Input: {}
// Output: { bus: BusHealth; adapters: Record<string, AdapterHealth> }
```

**`resume_conversation`**
```ts
// Resume a conversation that started on a different channel (/resume equivalent)
// Input: { contact_id: string; target_channel: string }
// Output: { ok: boolean; session_id: string; history_injected: boolean }
// Note: Implements decision A6 — finds most recent session any channel,
//       fires session_history channel event to Claude Code
```

### 6.3 Polling Loop

The cc-adapter maintains a 1-second polling interval after session start:

```ts
async function startPolling(busUrl: string, server: Server) {
  const poll = async () => {
    try {
      const res = await fetch(`${busUrl}/api/v1/messages/pending?agent=peggy&limit=10`);
      const { messages } = await res.json();
      if (messages.length > 0) {
        await server.sendNotification({
          method: 'notifications/message',
          params: { messages }
        });
      }
    } catch (err) {
      // Log but don't crash — bus may be temporarily unavailable
      logger.warn('Poll failed:', err);
    }
  };
  setInterval(poll, config.adapters['claude-code'].poll_interval_ms ?? 1000);
}
```

### 6.4 Context Injection at Session Start

When the cc-adapter starts (i.e., when Claude Code spawns it), before entering the polling loop:

```ts
async function injectStartupContext(busUrl: string, server: Server) {
  const res = await fetch(`${busUrl}/api/v1/memory/summaries?hours=48`);
  const { summaries } = await res.json();
  if (summaries.length > 0) {
    await server.sendNotification({
      method: 'notifications/context_load',
      params: {
        event: 'session_start',
        summaries,
        message: `You have ${summaries.length} recent conversation summaries from the past 48 hours.`
      }
    });
  }
}
```

---

## 7. SQLite Schema

The database is managed by `better-sqlite3`. All tables are created and migrated on startup by the schema runner in `src/db/schema.ts`. WAL mode is enabled globally.

### 7.1 Global Pragmas

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

### 7.2 Tables

#### message_queue

The primary message store. All messages, regardless of status, are stored here.

```sql
CREATE TABLE IF NOT EXISTS message_queue (
  id              TEXT PRIMARY KEY,
  created_at      TEXT NOT NULL,          -- ISO 8601
  updated_at      TEXT NOT NULL,
  channel         TEXT NOT NULL,
  topic           TEXT NOT NULL,
  sender          TEXT NOT NULL,
  recipient       TEXT NOT NULL,
  reply_to        TEXT,
  priority        TEXT NOT NULL DEFAULT 'normal',
  status          TEXT NOT NULL DEFAULT 'pending',
                  -- pending | delivered | failed | dead_letter | expired
  payload         TEXT NOT NULL,          -- JSON: { type, body, command?, args_raw? }
  metadata        TEXT NOT NULL DEFAULT '{}',  -- JSON
  retry_count     INTEGER NOT NULL DEFAULT 0,
  expires_at      TEXT,                   -- ISO 8601; NULL = no expiry
  acked_at        TEXT,
  error           TEXT
);

CREATE INDEX IF NOT EXISTS idx_mq_status_recipient
  ON message_queue (status, recipient, created_at);

CREATE INDEX IF NOT EXISTS idx_mq_channel_topic
  ON message_queue (channel, topic, created_at);

CREATE INDEX IF NOT EXISTS idx_mq_expires
  ON message_queue (expires_at)
  WHERE expires_at IS NOT NULL AND status = 'pending';
```

#### dead_letter

Messages that have exhausted retries or been manually dead-lettered.

```sql
CREATE TABLE IF NOT EXISTS dead_letter (
  id                  TEXT PRIMARY KEY,
  original_message_id TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  reason              TEXT NOT NULL,
                      -- "max_retries_exceeded" | "undeliverable" | "manual" | "expired"
  retry_count         INTEGER NOT NULL DEFAULT 0,
  expires_at          TEXT,               -- When to purge from dead_letter table
  payload             TEXT NOT NULL       -- Full MessageEnvelope JSON
);

CREATE INDEX IF NOT EXISTS idx_dl_created
  ON dead_letter (created_at);
```

**Expiry flow:** A background timer in `MessageQueue` checks `message_queue` every 30 seconds for rows where `expires_at < now()` and `status = 'pending'`. Expired messages are moved to `dead_letter` with `reason = 'expired'`, and an error reply is sent to the sender (decision S1).

#### transcripts

Full message log for the memory system.

```sql
CREATE TABLE IF NOT EXISTS transcripts (
  id              TEXT PRIMARY KEY,
  message_id      TEXT NOT NULL,          -- FK to message_queue.id
  conversation_id TEXT NOT NULL,          -- hash(contact_id + channel + topic)
  session_id      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  channel         TEXT NOT NULL,
  contact_id      TEXT NOT NULL,
  direction       TEXT NOT NULL,          -- 'inbound' | 'outbound'
  body            TEXT NOT NULL,
  metadata        TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_tr_conversation
  ON transcripts (conversation_id, created_at);

CREATE INDEX IF NOT EXISTS idx_tr_session
  ON transcripts (session_id, created_at);

-- FTS5 virtual table for full-text search
CREATE VIRTUAL TABLE IF NOT EXISTS transcripts_fts
  USING fts5(body, content='transcripts', content_rowid='rowid');

-- Keep FTS in sync
CREATE TRIGGER IF NOT EXISTS transcripts_ai
  AFTER INSERT ON transcripts BEGIN
    INSERT INTO transcripts_fts (rowid, body) VALUES (new.rowid, new.body);
  END;

CREATE TRIGGER IF NOT EXISTS transcripts_ad
  AFTER DELETE ON transcripts BEGIN
    INSERT INTO transcripts_fts (transcripts_fts, rowid, body)
      VALUES ('delete', old.rowid, old.body);
  END;
```

#### sessions

A session is a contiguous conversation window. New session = gap > `config.memory.session_idle_threshold_ms`.

```sql
CREATE TABLE IF NOT EXISTS sessions (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  channel         TEXT NOT NULL,
  contact_id      TEXT NOT NULL,
  started_at      TEXT NOT NULL,
  last_activity   TEXT NOT NULL,
  ended_at        TEXT,                   -- NULL = active
  message_count   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_sess_conversation
  ON sessions (conversation_id, last_activity);

CREATE INDEX IF NOT EXISTS idx_sess_contact
  ON sessions (contact_id, last_activity);
```

#### session_summaries

AI-generated summaries of completed sessions.

```sql
CREATE TABLE IF NOT EXISTS session_summaries (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL UNIQUE,   -- FK to sessions.id
  created_at      TEXT NOT NULL,
  channel         TEXT NOT NULL,
  contact_id      TEXT NOT NULL,
  started_at      TEXT NOT NULL,
  ended_at        TEXT NOT NULL,
  summary         TEXT NOT NULL,
  model           TEXT NOT NULL,          -- Claude model used for summarization
  token_count     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_ss_contact_created
  ON session_summaries (contact_id, created_at);

CREATE INDEX IF NOT EXISTS idx_ss_session
  ON session_summaries (session_id);
```

#### conversation_registry

Tracks known conversations for cross-channel linking (decision A6: /resume).

```sql
CREATE TABLE IF NOT EXISTS conversation_registry (
  id              TEXT PRIMARY KEY,       -- hash(contact_id + channel + topic)
  contact_id      TEXT NOT NULL,
  channel         TEXT NOT NULL,
  topic           TEXT NOT NULL DEFAULT 'general',
  first_seen      TEXT NOT NULL,
  last_seen       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cr_contact
  ON conversation_registry (contact_id, last_seen);
```

### 7.3 Migration Strategy

Schema migrations are run at startup in `src/db/schema.ts`. The migration runner:

1. Checks for `schema_migrations` table (created if absent)
2. Reads all applied migrations from that table
3. Applies any pending migrations in order
4. Records each applied migration

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INTEGER PRIMARY KEY,
  applied_at  TEXT NOT NULL,
  description TEXT NOT NULL
);
```

Migrations are simple SQL strings in a versioned array — no external migration framework.

---

## 8. Config Loader

**Implementation:** `src/config/loader.ts` and `src/config/schema.ts`

The config loader runs once at startup and produces an immutable, typed `AppConfig` object. The system **fails fast** on invalid config — startup is aborted with a clear human-readable error message listing all validation failures.

### 8.1 Load Sequence

```
1. Load .env via dotenv (populates process.env)
       ↓
2. Read config.yaml from disk (path: ./config.yaml or $AGENTBUS_CONFIG)
       ↓
3. Parse YAML string → raw JS object (js-yaml)
       ↓
4. Walk all string values, replace ${VAR_NAME} with process.env.VAR_NAME
   (throws if a referenced var is undefined)
       ↓
5. Validate against Zod schema (throws ZodError with all failures on mismatch)
       ↓
6. Return typed AppConfig object
```

### 8.2 Environment Variable Substitution

```ts
function substituteEnvVars(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return obj.replace(/\$\{([^}]+)\}/g, (_, varName) => {
      const val = process.env[varName];
      if (val === undefined) {
        throw new Error(`Config references undefined env var: ${varName}`);
      }
      return val;
    });
  }
  if (Array.isArray(obj)) return obj.map(substituteEnvVars);
  if (obj && typeof obj === 'object') {
    return Object.fromEntries(
      Object.entries(obj as Record<string, unknown>).map(
        ([k, v]) => [k, substituteEnvVars(v)]
      )
    );
  }
  return obj;
}
```

### 8.3 Example config.yaml

```yaml
bus:
  http_port: 3000
  db_path: ./data/agentbus.db
  log_level: info

adapters:
  telegram:
    token: ${TELEGRAM_BOT_TOKEN}
    poll_timeout: 30
  bluebubbles:
    server_url: http://localhost:1234
    webhook_port: 3002
  claude-code:
    poll_interval_ms: 1000

contacts:
  chris:
    displayName: Chris
    platforms:
      telegram:
        userId: 123456789
        username: mrwhistler
      bluebubbles:
        handle: "+15555550100"

topics:
  - general
  - reminders
  - code
  - personal
  - errands

memory:
  summarizer_interval_ms: 60000
  session_idle_threshold_ms: 1800000   # 30 minutes
  context_window_hours: 48
  claude_api_model: claude-opus-4-5
```

### 8.4 Zod Schema (excerpt)

```ts
// src/config/schema.ts
import { z } from 'zod';

const ContactSchema = z.object({
  displayName: z.string(),
  platforms: z.object({
    telegram: z.object({ userId: z.number(), username: z.string().optional() }).optional(),
    bluebubbles: z.object({ handle: z.string() }).optional(),
  }),
});

export const AppConfigSchema = z.object({
  bus: z.object({
    http_port: z.number().int().min(1024).max(65535).default(3000),
    db_path: z.string(),
    log_level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  }),
  adapters: z.object({
    telegram: z.object({
      token: z.string().min(1),
      poll_timeout: z.number().default(30),
      plugin: z.string().optional(),
    }).optional(),
    bluebubbles: z.object({
      server_url: z.string().url(),
      webhook_port: z.number().int(),
      plugin: z.string().optional(),
    }).optional(),
    'claude-code': z.object({
      poll_interval_ms: z.number().default(1000),
      plugin: z.string().optional(),
    }).optional(),
  }),
  contacts: z.record(z.string(), ContactSchema),
  topics: z.array(z.string()).default(['general']),
  memory: z.object({
    summarizer_interval_ms: z.number().default(60000),
    session_idle_threshold_ms: z.number().default(1800000),
    context_window_hours: z.number().default(48),
    claude_api_model: z.string().default('claude-opus-4-5'),
  }),
  pipeline: z.object({
    stages: z.array(z.string()).optional(),
  }).default({}),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;
```

---

## 9. Inbound Pipeline

**Implementation:** `src/core/pipeline.ts` + `src/pipeline/*.ts`

The `PipelineEngine` processes every inbound message through a sequential chain of stages. Stages are registered with priority slots (multiples of 10), allowing custom stages to be inserted between built-ins.

A stage may:
- **Mutate and pass through:** Return modified `MessageEnvelope` → next stage runs
- **Abort:** Return `null` → pipeline halts, message is not enqueued (but may trigger inline action)

```ts
// src/core/pipeline.ts
class PipelineEngine {
  private stages: PipelineStageDefinition[] = [];

  use(def: PipelineStageDefinition): void {
    this.stages.push(def);
    this.stages.sort((a, b) => a.slot - b.slot);
  }

  async run(envelope: MessageEnvelope, ctx: PipelineContext): Promise<MessageEnvelope | null> {
    let current: MessageEnvelope | null = envelope;
    for (const { name, stage } of this.stages) {
      current = await stage(current, ctx);
      if (current === null) {
        ctx.logger.debug(`Pipeline aborted at stage: ${name}`);
        return null;
      }
    }
    return current;
  }
}
```

### Stage 1 — Normalize (slot 10)

**File:** `src/pipeline/normalize.ts`

Responsibilities:
- Assign `id` (UUID v4) if absent
- Assign `timestamp` (now ISO 8601) if absent
- Validate `channel` is a known registered adapter
- Ensure `payload.body` is a non-empty string
- Set `priority` to `'normal'` if absent
- Set `topic` to `'general'` if absent
- Set `reply_to` to `null` if absent
- Populate `metadata.raw_received_at` with performance timestamp

This stage **never** returns null — it either normalizes or throws a validation error (caught by the caller and logged).

### Stage 2 — Contact Resolve (slot 20)

**File:** `src/pipeline/contact-resolve.ts`

Responsibilities:
- Inspect `sender` field: if it contains a raw platform ID (e.g., a Telegram user ID), resolve it against `ContactRegistry` and replace with canonical `contact:{id}` format
- If contact is unknown: keep sender as `platform:{channel}:{raw_id}` (known-unknown format)
- Log unresolved contacts for potential future registration
- Populate `metadata.contact` with the resolved `Contact` object (if found)

Canonical sender format: `contact:chris` | `agent:peggy` | `platform:telegram:987654`

### Stage 3 — Dedup (slot 30)

**File:** `src/pipeline/dedup.ts`

Responsibilities:
- Compute dedup key: `hash(channel + platform_message_id + body_first_64_chars)`
- Check SQLite `message_queue` for an existing message with same dedup key within a 5-minute window
- If duplicate found: return `null` (abort pipeline silently)
- If not duplicate: store dedup key in `metadata.dedup_key`

Dedup window is configurable (default 300 seconds). This catches double-delivery from adapter retry logic.

### Stage 4 — Slash Command Detect (slot 40)

**File:** `src/pipeline/slash-command.ts`

Responsibilities:
- Check if `payload.body` starts with `/`
- If yes: attempt to match against all registered commands in `CommandRegistry`
- If **bus-scoped** command matched:
  - Execute handler inline
  - Return `null` (abort pipeline — command was handled, no need to queue)
- If **agent-scoped** command matched:
  - Set `payload.type = 'slash_command'`
  - Set `payload.command = commandName`
  - Set `payload.args_raw = rest of body`
  - **Pass through** (continue pipeline — agent handles it)
- If **no match** (decision S6):
  - Set `payload.type = 'slash_command'`
  - Set `metadata.command_unrecognized = true`
  - **Pass through** — unrecognized commands reach Peggy enriched

This design means Peggy always sees slash commands, even unregistered ones.

### Stage 5 — Topic Classify (slot 50)

**File:** `src/pipeline/topic.ts`

Responsibilities:
- If `topic` is already set and is a valid known topic: pass through unchanged
- If `topic === 'general'` (default): attempt classification based on payload body
- Classification strategy (v1): simple keyword matching against `config.topics`
- Update `envelope.topic` with classified topic
- Store confidence in `metadata.topic_confidence`

v2 option: Call a lightweight Claude API classification call (async, with timeout fallback to 'general').

### Stage 6 — Priority Score (slot 60)

**File:** `src/pipeline/priority.ts`

Responsibilities:
- If `priority` is already set to `'high'` or `'urgent'`: pass through
- Scoring heuristics (additive):
  - `+1` if sender is a priority contact (config flag)
  - `+1` if body contains urgency keywords ("urgent", "ASAP", "help", "911", etc.)
  - `+1` if it's a `/slash_command` of high-priority type
  - `+1` if it's a reply to a message Peggy sent within last 5 minutes
- Score 0 → `'normal'`; Score 1-2 → `'high'`; Score 3+ → `'urgent'`
- Update `envelope.priority`

### Stage 7 — Route Resolve (slot 70)

**File:** `src/pipeline/route.ts`

Responsibilities:
- Determine `recipient` if not set (default: `agent:peggy` for all inbound from contacts)
- For fan-out scenarios (broadcast): produce N copies of the envelope — one per target channel (decision S2). When fan-out occurs, return the **first** envelope and enqueue the remaining copies directly.
- Compute `conversation_id = sha256(contact_id + ':' + channel + ':' + topic).slice(0, 16)`
- Store `conversation_id` in `metadata.conversation_id`
- Determine or create `session_id` by checking `sessions` table for active session matching conversation_id

### Stage 8 — Transcript Log (slot 80)

**File:** `src/pipeline/transcript-log.ts`

Responsibilities:
- Write to `transcripts` table **synchronously** (better-sqlite3 sync API)
- Write happens **before** the message is enqueued to `message_queue`
- Upsert `sessions` row (update `last_activity`, increment `message_count`)
- If no active session found: create new session row
- The transcript write is on the hot path — any failure here is logged but does **not** abort the pipeline (message still gets queued)

The synchronous write ensures no transcript is ever lost even if the process crashes immediately after.

---

## 10. Memory System Architecture

The memory system has three distinct components with different timing and roles.

### 10.1 TranscriptLogger

**File:** `src/memory/transcript.ts`
**Timing:** Synchronous, on the hot path (Stage 8 of pipeline)
**Role:** Durable write of every message to `transcripts` table before it enters the queue

```
Inbound message
     │
  Pipeline...
     │
 Stage 8: TranscriptLogger.write(envelope, session)
     │    ↑ synchronous better-sqlite3 write
     │    ↑ upserts sessions row
     │
 MessageQueue.enqueue(envelope)
     │
 Response to caller
```

The logger holds no async state. It is a thin wrapper around two prepared statements:
- `INSERT INTO transcripts (...) VALUES (?)`
- `INSERT OR REPLACE INTO sessions (...) VALUES (?)`

### 10.2 SummarizerPipeline

**File:** `src/memory/summarizer.ts`
**Timing:** Async daemon, timer-driven (every `config.memory.summarizer_interval_ms`)
**Role:** Detect idle sessions and generate AI summaries

```
Timer fires (default: every 60s)
     │
 SummarizerPipeline.tick()
     │
 Query: SELECT * FROM sessions
        WHERE ended_at IS NULL
          AND last_activity < now() - session_idle_threshold
        ORDER BY last_activity ASC
     │
 For each idle session:
     │
     ├─ Mark session ended: UPDATE sessions SET ended_at = now()
     │
     ├─ Fetch transcript: SELECT body FROM transcripts WHERE session_id = ?
     │
     ├─ Call Claude API with transcript + summarization prompt
     │  (model: config.memory.claude_api_model)
     │
     └─ INSERT INTO session_summaries { session_id, summary, model, ... }
```

The summarizer runs in the bus-core process but is fully async and non-blocking. It uses the official Anthropic SDK (`@anthropic-ai/sdk`). Failures are logged and retried on the next tick.

**Summarization prompt template:**

```
The following is a conversation transcript between a user and an AI agent named Peggy.
Channel: {channel}. Contact: {displayName}.
Duration: {start} to {end} ({message_count} messages).

Summarize the key topics, decisions, tasks, and any open items in 2-4 sentences.
Focus on what Peggy would need to know to continue this conversation naturally.

Transcript:
{transcript_text}
```

### 10.3 ContextInjector

**File:** `src/memory/injector.ts`
**Timing:** Once at cc-adapter session start
**Role:** Load recent summaries and push them to Claude Code via channel event

```
cc-adapter starts (Claude Code spawns it)
     │
 ContextInjector.inject(busUrl, server)
     │
 GET /api/v1/memory/summaries?hours=48
     │
 Format summaries as structured context block
     │
 server.sendNotification({
   method: 'notifications/context_load',
   params: { event: 'session_start', summaries, context_text }
 })
     │
 Begin polling loop
```

The context_text is a human-readable summary of summaries, e.g.:

```
You have 3 recent conversation summaries from the past 48 hours:

[Telegram - Chris - 2 hours ago]
Discussed grocery list and reminder for dentist appointment on Friday.

[BlueBubbles - Chris - 8 hours ago]
Chris asked about the weather and requested a reminder for tomorrow morning.

[Telegram - Chris - 1 day ago]
Long conversation about the project planning. Key decisions: use TypeScript ESM,
deploy on Mac mini with pm2.
```

### 10.4 /resume Flow (Decision A6)

When `/resume` is detected by the cc-adapter (via the `resume_conversation` MCP tool):

```
resume_conversation({ contact_id: "chris", target_channel: "telegram" })
     │
 Query: SELECT * FROM sessions
        WHERE contact_id = 'chris'
        ORDER BY last_activity DESC
        LIMIT 1
     │
 Fetch last session's transcript (most recent N messages)
     │
 Compute new conversation_id for target channel
     │
 Fire session_history channel event with transcript
     │
 Return { ok: true, session_id, history_injected: true }
```

---

## 11. Adapter Plugin Loader

**Implementation:** `src/core/registry.ts` — `AdapterRegistry.loadFromConfig()`

The plugin loader enables future external adapter packages (npm modules) to be plugged in without modifying agentbus source. In v1, only built-in adapters are supported, but the loader stub is present.

```ts
// src/core/registry.ts

const BUILT_IN_ADAPTERS: Record<string, new (config: unknown) => Adapter> = {
  telegram: TelegramAdapter,
  bluebubbles: BlueBubblesAdapter,
  'claude-code': ClaudeCodeAdapter,
};

class AdapterRegistry {
  private adapters = new Map<string, Adapter>();

  async loadFromConfig(config: AppConfig): Promise<void> {
    for (const [id, adapterConfig] of Object.entries(config.adapters)) {
      if (!adapterConfig) continue;

      let adapter: Adapter;

      if ('plugin' in adapterConfig && adapterConfig.plugin) {
        // v2+: Dynamic import of npm package
        // Package must export a default class implementing Adapter
        const module = await import(adapterConfig.plugin);
        const AdapterClass = module.default;
        if (!AdapterClass) {
          throw new Error(`Plugin ${adapterConfig.plugin} has no default export`);
        }
        adapter = new AdapterClass(adapterConfig);
      } else {
        // v1: Built-in adapter
        const AdapterClass = BUILT_IN_ADAPTERS[id];
        if (!AdapterClass) {
          throw new Error(`Unknown built-in adapter: ${id}`);
        }
        adapter = new AdapterClass(adapterConfig);
      }

      this.register(id, adapter);
    }
  }

  register(id: string, adapter: Adapter): void {
    if (this.adapters.has(id)) {
      throw new Error(`Adapter already registered: ${id}`);
    }
    this.adapters.set(id, adapter);
  }

  get(id: string): Adapter {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new Error(`Adapter not found: ${id}`);
    return adapter;
  }

  all(): Adapter[] {
    return Array.from(this.adapters.values());
  }

  withCapability(cap: keyof AdapterCapabilities): Adapter[] {
    return this.all().filter(a => a.capabilities[cap]);
  }
}
```

**External plugin contract:** An npm package acting as an agentbus adapter must:
1. Have a default export that is a class implementing the `Adapter` interface
2. Accept a config object in its constructor (typed per-adapter, but at minimum `Record<string, unknown>`)
3. Export the `Adapter` type from its package for TypeScript consumers

---

## 12. Startup Sequence

The full bus-core startup sequence in `src/index.ts`:

```
Step 1: Load and validate config
  - dotenv.config()
  - loadConfig('./config.yaml') → AppConfig
  - On failure: print ZodError details and exit(1)

Step 2: Connect SQLite and run migrations
  - db = new Database(config.bus.db_path)
  - db.pragma('journal_mode = WAL')
  - db.pragma('foreign_keys = ON')
  - db.pragma('busy_timeout = 5000')
  - runMigrations(db)
  - On failure: print error and exit(1)

Step 3: Initialize AdapterRegistry
  - registry = new AdapterRegistry()
  - await registry.loadFromConfig(config)
  - Instantiates TelegramAdapter, BlueBubblesAdapter, ClaudeCodeAdapter per config

Step 4: Initialize PipelineEngine
  - pipeline = new PipelineEngine()
  - pipeline.use({ slot: 10, name: 'normalize',        stage: normalize })
  - pipeline.use({ slot: 20, name: 'contact-resolve',  stage: contactResolve })
  - pipeline.use({ slot: 30, name: 'dedup',            stage: dedup })
  - pipeline.use({ slot: 40, name: 'slash-command',    stage: slashCommand })
  - pipeline.use({ slot: 50, name: 'topic',            stage: topic })
  - pipeline.use({ slot: 60, name: 'priority',         stage: priority })
  - pipeline.use({ slot: 70, name: 'route',            stage: route })
  - pipeline.use({ slot: 80, name: 'transcript-log',   stage: transcriptLog })

Step 5: Initialize CommandRegistry
  - commands = new CommandRegistry()
  - registerBuiltins(commands)  // /help, /status, /pause, /resume, /ping

Step 6: Register commands with capable adapters
  - for (const adapter of registry.withCapability('registerCommands')):
      await adapter.registerCommands(commands.definitions())

Step 7: Create Bus orchestrator
  - bus = new Bus({ config, db, registry, pipeline, commands })

Step 8: Start HTTP API
  - api = buildFastifyApp(bus)
  - await api.listen({ port: config.bus.http_port, host: '127.0.0.1' })
  - logger.info(`HTTP API listening on :${config.bus.http_port}`)

Step 9: Start adapter polling / listening
  - for (const adapter of registry.all()):
      await adapter.start()
  - (Telegram adapter begins long-polling; BB adapter starts webhook listener)

Step 10: Start memory subsystems
  - transcriptLogger = new TranscriptLogger(db)
  - summarizer = new SummarizerPipeline(db, config.memory)
  - summarizer.start()  // begins timer loop

Step 11: Log ready state
  - logger.info('AgentBus ready', {
      adapters: registry.all().map(a => ({ id: a.id, status: 'active' })),
      http_port: config.bus.http_port,
      db_path: config.bus.db_path,
    })

--- (Claude Code adapter starts separately) ---

Step CC-1: Claude Code spawns `tsx src/adapters/cc.ts` via MCP config
Step CC-2: cc-adapter reads config (same config.yaml)
Step CC-3: cc-adapter instantiates MCP Server with stdio transport
Step CC-4: ContextInjector fires GET /api/v1/memory/summaries?hours=48
Step CC-5: ContextInjector sends context_load notification to Claude Code
Step CC-6: cc-adapter begins 1s polling loop
Step CC-7: cc-adapter registers MCP tools with Claude Code session
```

### Graceful Shutdown

On `SIGTERM` or `SIGINT`:

```
1. Stop accepting new HTTP requests (Fastify close)
2. Stop adapter polling loops (adapter.stop() for each)
3. Wait for in-flight pipeline runs to complete (max 5s)
4. Close SQLite connection
5. Exit 0
```

---

## 13. Technology Choices

| Concern | Choice | Rationale |
|---------|--------|-----------|
| Language | TypeScript | Type safety for complex message contracts; great IDE support |
| Module system | ESM (`"type": "module"`) | Modern Node.js standard; required by MCP SDK |
| Runtime | Node.js 20+ LTS | Stable, long-term support; good ecosystem |
| SQLite client | `better-sqlite3` | Synchronous API required for hot-path transcript writes; excellent WAL support; no event loop blocking |
| HTTP server | `fastify` | Type-first design; low overhead; JSON schema validation built-in |
| Config format | `js-yaml` + `zod` + `dotenv` | YAML for human readability; Zod for runtime validation with clear errors; dotenv for secrets |
| MCP SDK | `@modelcontextprotocol/sdk` | Official Anthropic SDK; stdio transport; tool definitions |
| Process management | `pm2` | Persistent daemons; auto-restart on crash; log management; `pm2 status` visibility |
| Dev runtime | `tsx` | No compile step; instant iteration; TypeScript support out of the box |
| Claude API | `@anthropic-ai/sdk` | Used by SummarizerPipeline for session summaries |
| Logging | `pino` | Structured JSON logs; fast; integrates with pm2 log rotation |
| Testing | `vitest` | Fast; ESM-native; good TypeScript support |
| UUID generation | `crypto.randomUUID()` | Built-in Node.js, no dependency |

### pm2 Ecosystem File

```js
// pm2.config.js
module.exports = {
  apps: [
    {
      name: 'bus-core',
      script: './src/index.ts',
      interpreter: 'tsx',
      env: { NODE_ENV: 'production' },
      restart_delay: 2000,
      max_restarts: 10,
    },
    {
      name: 'telegram-adapter',
      script: './src/adapters/telegram.ts',
      interpreter: 'tsx',
      env: { NODE_ENV: 'production' },
      restart_delay: 5000,
    },
    {
      name: 'bluebubbles-adapter',
      script: './src/adapters/bluebubbles.ts',
      interpreter: 'tsx',
      env: { NODE_ENV: 'production' },
      restart_delay: 5000,
    },
    // Note: claude-code-adapter is NOT in pm2 — it's spawned by Claude Code
  ],
};
```

### Dependency List (package.json)

```json
{
  "dependencies": {
    "@anthropic-ai/sdk": "^0.27.0",
    "@modelcontextprotocol/sdk": "^1.0.0",
    "better-sqlite3": "^9.0.0",
    "dotenv": "^16.0.0",
    "fastify": "^4.0.0",
    "js-yaml": "^4.0.0",
    "pino": "^9.0.0",
    "zod": "^3.0.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.0.0",
    "@types/js-yaml": "^4.0.0",
    "@types/node": "^20.0.0",
    "tsx": "^4.0.0",
    "typescript": "^5.0.0",
    "vitest": "^2.0.0"
  }
}
```

---

## Appendix A: Locked Design Decisions

These decisions are finalized and should not be revisited without explicit BMAD review.

| Decision | Summary |
|----------|---------|
| **S1** | Messages have `expires_at`; expiry triggers error reply to sender and dead-letter move |
| **S2** | Fan-out creates N independent envelopes (one per target channel), all going through pipeline independently |
| **S3** | Each adapter's `send()` handles platform-specific constraints (length limits, encoding); no bus-level transformation |
| **S4** | Pipeline stages registered with numeric slots (10, 20, 30...); external stages can be inserted at any slot |
| **S5** | `conversation_id = hash(contact_id + ':' + channel + ':' + topic)`; `/resume` bridges by finding last session any channel |
| **S6** | Unrecognized slash commands pass through the pipeline enriched with `metadata.command_unrecognized = true`; Peggy receives them |
| **A1** | Commands registered with capable adapters via `registerCommands()` at bus-core startup |
| **A2** | Plugin loader stub present in v1; external npm adapters supported in v2+ via dynamic import |
| **A3** | Static `AdapterCapabilities` interface; bus checks flags before calling optional methods |
| **A4** | `react_to_message` MCP tool → `adapter.react()` → platform-specific mapping (BB tapback integers, Telegram emoji reactions) |
| **A5** | `markRead` called post-delivery, async, non-blocking; failures are logged not retried |
| **A6** | `/resume` finds most recent session any channel for contact; fires `session_history` channel event to Claude Code |

---

## Appendix B: BlueBubbles Tapback Mapping

Per decision A4, the `react` capability for BlueBubbles maps emoji to tapback integer codes:

| Emoji | BlueBubbles Tapback | Description |
|-------|--------------------:|-------------|
| ❤️ | 0 | Heart |
| 👍 | 2 | Thumbs up |
| 👎 | 3 | Thumbs down |
| 😂 | 4 | Haha (laughing) |
| ‼️ | 1 | Exclamation |
| ❓ | 5 | Question mark |

Any emoji not in this map returns `DeliveryResult { success: false, error: 'Unsupported tapback' }`.

---

## Appendix C: Conversation ID Computation

```ts
import { createHash } from 'crypto';

function computeConversationId(
  contactId: string,
  channel: string,
  topic: string
): string {
  return createHash('sha256')
    .update(`${contactId}:${channel}:${topic}`)
    .digest('hex')
    .slice(0, 16);  // 16 hex chars = 64 bits, sufficient for local uniqueness
}
```

Example: `contactId="chris", channel="telegram", topic="general"` → `"a3f9c2e1b4d7f0e8"`

---

*Document generated: BMAD Phase 3 — Architecture*
*Next phase: Implementation (Epic breakdown → sprint planning → coding)*

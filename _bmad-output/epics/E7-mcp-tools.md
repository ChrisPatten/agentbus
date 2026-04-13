# E7 — MCP Tool Surface

| Field | Value |
|---|---|
| Epic ID | E7 |
| Build Order Position | 3 of 12 |
| Dependencies | E1 (SQLite, MessageQueue, AdapterRegistry), E2 (MCP server exists, tool registration pattern established) |
| Story Count | 5 |
| Estimated Complexity | M |

---

## Epic Summary

E7 implements the 8 MCP tools that the agent uses to interact with the bus, memory, and sessions. These tools are the primary API surface the agent operates through — the verbs it uses to send replies, recall memories, react to messages, and understand context. Inbound messages are always pushed by AgentBus; the agent never polls. After E7, the agent has a complete programmatic interface to AgentBus, even if the memory and session backends are only partially implemented in later epics.

---

## Entry Criteria

- E1 complete: `MessageQueue`, `AdapterRegistry`, and SQLite schema exist and are tested
- E2 complete: MCP server is initialized, tool registration pattern (`server.setRequestHandler(ListToolsRequestSchema, ...)`) is established and working for `reply`
- All 8 tool names and their input/output schemas are agreed and documented (can be a single `tools-spec.md` file)
- Bus HTTP API routes for `/api/v1/messages/*` and `/api/v1/memory/*` are at minimum stubbed

---

## Exit Criteria

- All 8 tools are registered with the MCP server and return valid MCP responses (not raw throws)
- All tool input schemas are Zod-validated; invalid arguments produce structured MCP error responses with descriptive messages
- Tools that depend on unimplemented backends (e.g., memory search before E8/E9) return a graceful "not yet available" response rather than crashing
- `react_to_message` performs a capability check and returns a clear error if the target adapter doesn't support reactions
- Integration tests demonstrate the full call chain for at least one tool per story group
- No tool leaks unformatted stack traces to the MCP client

---

## Stories

### S7.1 — Channel Discovery: `list_channels`

**User story:** As the agent, I want to know what channels are available so that I can route outbound messages and reactions to the right adapter.

**Acceptance criteria:**
- `list_channels()` calls `AdapterRegistry.list()` and returns each adapter's `id`, `channels[]`, and `capabilities` summary
- Remove `get_pending_messages` from `src/mcp/tools.ts` — it was a polling fallback that no longer fits the push model; messages are always delivered via channel notification
- Note: `receive_messages`, `ack_message`, and `subscribe` are not implemented — AgentBus always pushes inbound messages into the agent's session context via channel notification; the agent never needs to poll or subscribe

**Complexity:** XS

---

### S7.2 — Outbound Tool: `send_message`

**User story:** As the agent, I want a `send_message` tool with full routing metadata so that I can compose and deliver messages to any contact on any channel without knowing the underlying adapter implementation.

**Acceptance criteria:**
- Input schema: `{ to: string, channel: string, body: string, reply_to?: string, priority?: "low"|"normal"|"high", metadata?: Record<string, unknown> }`
- Validates that `channel` resolves to a registered adapter via `AdapterRegistry.lookupByChannel()`; returns error if channel is unknown
- Constructs an `Envelope` with `sender_id: "claude"`, `recipient_id: to`, `channel`, `body`, and optional fields, then enqueues via `MessageQueue.enqueue()`
- Returns `{ success: true, message_id: string, queued_at: string }`
- Supports `priority: "high"` which sets `priority = 100` in the queue row (normal = 50, low = 10)
- If `reply_to` is provided, validates the referenced message exists in `transcripts` before accepting

**Complexity:** S

---

### S7.3 — Memory Tools: `recall_memory`, `log_memory`, `search_transcripts`

**User story:** As the agent, I want memory tools so that I can retrieve relevant facts about contacts and conversations, explicitly record important information, and search my conversation history by topic.

**Acceptance criteria:**
- `recall_memory({ query: string, contact_id?: string, limit?: number })` runs FTS5 search on `memories_fts`, filtered optionally by `contact_id`, ordered by `confidence DESC, updated_at DESC`; returns up to `limit` (default 10) memory objects with `{ id, contact_id, content, confidence, source, updated_at }`
- `log_memory({ contact_id: string, content: string, confidence?: number, source?: string })` inserts a row into `memories` with `source="manual"` and default `confidence=0.9`; returns `{ memory_id }`
- `search_transcripts({ query: string, channel?: string, since?: string, limit?: number })` runs FTS5 search on `transcripts_fts`, returns matching transcript snippets with `{ message_id, session_id, channel, speaker, body_snippet, timestamp }`
- All three tools return empty arrays (not errors) when results are empty
- If the FTS tables don't exist yet (pre-E8 scenario), tools return `{ available: false, reason: "Memory system not yet initialized" }` instead of crashing

**Complexity:** M

---

### S7.4 — Session Tools: `get_session`, `list_sessions`

**User story:** As the agent, I want session tools so that I can receive a context briefing at the start of a conversation and enumerate past sessions for review or resumption.

**Acceptance criteria:**
- `get_session({ session_id?: string })` returns the most recent `session_summaries` row for the given session (or current session if omitted), including `summary_text`, `key_topics[]`, `decisions[]`, `open_questions[]`, `participants[]`, plus session metadata from the `sessions` row (`channel`, `started_at`, `message_count`); returns `{ available: false }` if no summary exists yet
- `list_sessions({ channel?: string, contact_id?: string, limit?: number, since?: string })` queries `sessions` with optional filters, returns array of session summaries sorted by `started_at DESC`; supports pagination via `limit` (default 20, max 100)
- `list_sessions` never returns raw SQL errors; DB errors are caught and returned as structured MCP errors
- All session tool responses include `session_id` in the top-level object for easy chaining

**Complexity:** S

---

### S7.5 — Reaction Tool: `react_to_message`

**User story:** As the agent, I want a `react_to_message` tool that sends emoji reactions to messages on supported channels so that I can acknowledge messages expressively without composing a full reply.

**Acceptance criteria:**
- Input schema: `{ message_id: string, emoji: "❤️"|"👍"|"👎"|"😂"|"‼️"|"❓" }` (normalized set matching BlueBubbles tapback mapping)
- Looks up `message_id` in `transcripts` to retrieve `channel` and `adapter_id`; returns structured error if message not found
- Checks `AdapterRegistry.lookup(adapterId).capabilities.canReact` before proceeding; if `false`, returns `{ success: false, reason: "Reactions not supported on channel: <channel>" }`
- If capability check passes, calls `adapter.react(messageId, emoji)` and returns `{ success: true, emoji, message_id }`
- If `adapter.react()` throws, catches and returns structured MCP error with `{ success: false, reason: error.message }`
- Unit test: mock adapter with `canReact: false` → verify graceful error; mock adapter with `canReact: true` → verify `react()` is called

**Complexity:** S

---

## Notes

- **Tool registration pattern:** Tools should be defined in separate files under `src/mcp/tools/` (one file per story group is reasonable), following the pattern established in `src/mcp/tools.ts`. This keeps the MCP server entry point clean.
- **Zod schemas as single source of truth:** Define each tool's Zod schema in the tool file and derive the JSON Schema from it using `zodToJsonSchema` (from `zod-to-json-schema`) for the MCP tool manifest. Don't write JSON Schema by hand.
- **Graceful degradation before E8/E9:** Memory tools are registered in E7 but back-end implementations arrive in E8/E9. The pattern for graceful degradation is: check if the backing table exists via `SELECT name FROM sqlite_master WHERE type='table' AND name=?`, return `{ available: false }` if not. This allows E7 to be fully functional as scaffolding before memory is live.
- **`react_to_message` emoji normalization:** The emoji set in the tool schema must exactly match what BlueBubbles accepts. The tapback integer mapping (`heart=0, thumbsUp=1, ...`) lives in the BlueBubbles adapter (E4), not here. E7 passes the emoji string; E4 does the translation.
- **Error response shape:** All tools should return errors as `{ content: [{ type: "text", text: "Error: ..." }], isError: true }` per MCP spec. Create a shared `toolError(message: string)` helper in E2 and import it in all E7 tool files.
- **Tool count reconciliation:** The 8 tools are: `list_channels` (S7.1), `send_message` (S7.2), `recall_memory`, `log_memory`, `search_transcripts` (S7.3), `get_session`, `list_sessions` (S7.4), `react_to_message` (S7.5). `receive_messages`, `ack_message`, and `subscribe` are omitted — AgentBus pushes messages into the session; agents never poll. The `reply` tool from E2 counts separately as part of the adapter, not the MCP tool surface.
- **Interaction model:** Inbound messages are always pushed by AgentBus into the agent's session context. Outbound responses flow from the agent through MCP tools (`reply`, `send_message`, `react_to_message`) to adapters. The agent is always triggered by AgentBus — it never polls for messages.

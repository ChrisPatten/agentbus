# E9 — Memory: Context Injector + Recall

| Field | Value |
|---|---|
| Epic ID | E9 |
| Build Order Position | 7 of 12 |
| Dependencies | E8 (memories, session_summaries tables populated; Summarizer running) |
| Story Count | 3 |
| Estimated Complexity | M |

---

## Epic Summary

E9 closes the memory loop by injecting historical context into new sessions and enabling the agent to actively recall relevant memories. Where E8 extracts and stores knowledge from past conversations, E9 surfaces that knowledge at the moment it's needed — delivering session summaries when a new Claude Code session starts and providing FTS5-powered recall tools so the agent can query the agent's memory on demand. After E9, the agent has genuine continuity: the agent knows what it has discussed before and can pick up where the agent left off.

---

## Entry Criteria

- E8 complete: `session_summaries` and `memories` tables are populated by the summarizer; FTS5 indices on `memories_fts` are active
- E7 complete: `recall_memory` and `search_transcripts` tools are registered (E9 implements their backends more fully)
- E2 complete: Claude Code adapter can receive `session_history` channel events and present them to Claude Code's context
- `AppConfig.memory.context_window_hours` is defined (default: 48), as is `context_budget_tokens` (default: 2500)

---

## Exit Criteria

- When a new Claude Code session starts, the agent automatically receives a `session_history` event containing summaries from the past 48 hours
- The context payload respects the token budget and prioritizes the most recent summaries
- `recall_memory` tool returns ranked, filtered results from `memories_fts` with FTS5 snippet highlighting
- `/resume` command finds the most recently summarized session across all channels and fires its summary into the current adapter
- All three features degrade gracefully when no relevant history exists (no crashes, helpful "no history found" responses)

---

## Stories

### S9.1 — ContextInjector

**User story:** As the agent, I want to automatically receive a session history briefing when I start a new conversation so that I have relevant context about recent interactions without having to manually ask for it.

**Acceptance criteria:**
- `ContextInjector.inject(sessionId: string, adapterId: string): Promise<void>` queries `session_summaries` for sessions where `created_at > now() - context_window_hours` ordered by `created_at DESC`
- Applies a token budget: iterates summaries from most recent to oldest, serializing each to an estimated token count; stops when cumulative count exceeds `context_budget_tokens`
- Formats the selected summaries as a structured `session_history` payload: `{ type: "session_history", sessions: [{ session_id, channel, started_at, summary, key_topics, participants }], generated_at, coverage_hours }`
- Fires the payload as a channel event to the Claude Code adapter (POSTs to `POST /api/v1/adapters/claude-code/event`) which the adapter emits as an MCP notification
- Is called by the Claude Code adapter during its startup sequence (after registering with `AdapterRegistry`) — not by bus-core proactively
- If no summaries exist in the window, fires a minimal `{ type: "session_history", sessions: [], message: "No recent session history found." }` event (does not skip the event entirely)

**Complexity:** M

---

### S9.2 — `recall_memory` Tool (Full Implementation)

**User story:** As the agent, I want the `recall_memory` tool to perform ranked full-text search across my memory store so that I can quickly surface relevant facts about a contact or topic without reading through raw transcripts.

**Acceptance criteria:**
- `recall_memory({ query: string, contact_id?: string, category?: string, limit?: number })` executes FTS5 query: `SELECT m.*, snippet(memories_fts, 0, '<b>', '</b>', '...', 15) as snippet FROM memories m JOIN memories_fts ON m.id = memories_fts.rowid WHERE memories_fts MATCH ? AND m.superseded_by IS NULL AND (m.expires_at IS NULL OR m.expires_at > datetime('now'))`
- Results are ranked by FTS5's built-in BM25 relevance score; ties are broken by `confidence DESC, updated_at DESC`
- Response includes per-result: `{ memory_id, contact_id, category, content, snippet, confidence, source, updated_at, rank_score }`
- `contact_id` filter is applied as an additional `AND m.contact_id = ?` clause; `category` filter similarly
- Returns up to `limit` results (default 10, max 50); returns empty array with `{ query, results: [], total: 0 }` shape when no matches
- Unit test: insert 5 memories for two contacts → query by contact → verify correct filtering; query by keyword → verify FTS5 match

**Complexity:** M

---

### S9.3 — `/resume` Command

**User story:** As Chris, I want a `/resume` command that finds my most recently summarized session across all channels and injects its context into my current conversation so that I can seamlessly continue where I left off without navigating through session lists.

**Acceptance criteria:**
- `/resume [session_id?]` — without argument: queries `session_summaries JOIN sessions` for the most recent row where `status = 'summarized'` across all channels, ordered by `ended_at DESC`
- With `session_id` argument: looks up that specific session's summary
- Constructs a `session_history` payload from the found session (same format as S9.1) and fires it as a channel event to the current adapter
- If the current adapter is Claude Code, the event is delivered as an MCP notification immediately
- Returns a confirmation message to the invoking channel: `"Resuming session from <channel> on <date>. Summary injected into context."`
- If no summarized session exists (or the specified `session_id` is not found / not yet summarized), returns a helpful message: `"No summarized session found. Summarization may still be in progress — try again in a moment."`
- Is registered in `CommandRegistry` with `scope: "bus"` in E6, but its handler implementation is wired in E9 when the backing data exists

**Complexity:** S

---

## Notes

- **Token budget estimation:** Without a proper tokenizer in the hot path, use a conservative heuristic: 1 token ≈ 3.5 characters for English prose. Apply a 20% safety margin. So for a 2500-token budget, stop adding summaries when cumulative character count exceeds `2500 * 3.5 * 0.8 ≈ 7000 characters`. This is fast and avoids a dependency on the Anthropic tokenizer for non-API calls.
- **`session_history` event timing:** The ContextInjector fires the event during adapter startup. This means the agent sees the history before her first user message arrives. This is the desired UX —the agent should already be oriented when Chris says "hello." Make sure the CC adapter awaits the inject call before signaling readiness.
- **FTS5 `MATCH` query syntax:** Use FTS5's standard query syntax (`query*` for prefix match, `"exact phrase"` for phrase match). Sanitize the user's input to prevent FTS5 query syntax errors: wrap in double quotes if the input contains special characters, or use `fts5_tokenize` safely. A malformed FTS5 query throws a SQLite error — catch it and return `{ results: [], error: "Invalid search query" }`.
- **`/resume` vs. `get_session`:** These are related but different. `get_session` (E7) returns summary data for the *current* session (or a specified one). `/resume` is a command that actively fires a past session's context into the conversation stream. The difference is push vs. pull.
- **Multi-channel context injection:** In E9, ContextInjector only fires to Claude Code. In a future epic, it could fire to any adapter that starts a new session. For now, keep it CC-only and document the extensibility point.
- **Privacy consideration:** The `session_history` event is sent over the MCP stdio transport, which is local to the machine. No cross-network exposure. Document this for peace of mind.

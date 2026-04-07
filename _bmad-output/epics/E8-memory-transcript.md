# E8 — Memory: Transcript Logger + Summarizer

| Field | Value |
|---|---|
| Epic ID | E8 |
| Build Order Position | 6 of 12 |
| Dependencies | E1 (SQLite, `transcripts`, `sessions`, `memories`, `session_summaries` tables), E5 (pipeline has transcript-log stage) |
| Story Count | 4 |
| Estimated Complexity | L |

---

## Epic Summary

E8 delivers the memory backbone: durable transcript logging, session lifecycle tracking, LLM-powered summarization, and the memory storage layer. After E8, every message is durably stored in a searchable transcript, sessions are automatically detected and closed, and Peggy's memories about contacts and topics are extracted from conversations and persisted for future recall. This is the system that gives Peggy continuity across sessions.

---

## Entry Criteria

- E1 complete: all 6 SQLite tables exist with correct schema (`transcripts`, `sessions`, `session_summaries`, `memories`, `message_queue`, `dead_letter`)
- E5 complete: Stage 80 (transcript-log) writes to the `transcripts` table; `session_id` is computed and attached to each message
- Claude API credentials are available in `.env` (`ANTHROPIC_API_KEY`)
- Summarization prompt and JSON extraction schema are drafted and reviewed
- `AppConfig.memory` section is defined: `inactivity_timeout_minutes`, `summary_model`, `summary_max_tokens`, `confidence_default`

---

## Exit Criteria

- Every message processed by the pipeline has a corresponding `transcripts` row with correct `session_id`, `speaker`, `channel`, `body`, and `received_at`
- Sessions are automatically marked `ended` after 15 minutes of inactivity (configurable)
- Completed sessions trigger summarization: Claude API is called, JSON is parsed, rows are written to `session_summaries` and `memories`
- `/forget <contact_id>` correctly marks memories as superseded
- Memory rows include `confidence`, `expires_at`, and `superseded_by` fields populated correctly
- Integration test: simulate a 5-message conversation → wait for inactivity timeout → verify summarizer runs → verify `session_summaries` and `memories` rows exist

---

## Stories

### S8.1 — TranscriptLogger

**User story:** As the pipeline, I want a `TranscriptLogger` that writes every processed message to the `transcripts` table with correct session assignment so that I have a complete, queryable conversation history across all channels.

**Acceptance criteria:**
- `TranscriptLogger.log(context: PipelineContext): void` inserts a row into `transcripts` with: `message_id`, `session_id`, `conversation_id`, `speaker` (sender display name or ID), `body`, `channel`, `adapter_id`, `received_at`, `metadata` (JSON-stringified extras)
- `conversation_id` is computed as `sha256(sorted([sender_id, recipient_id]).join(':') + channel)` — stable across session boundaries for the same contact pair
- Session assignment: looks up the most recent `sessions` row for `(conversation_id, channel)` where `status = 'active'`; if found and `last_message_at` is within the inactivity window, reuses it; otherwise creates a new session row
- New session creation inserts into `sessions` with `status = 'active'`, `started_at = now()`, `channel`, `participants[]` (JSON array of speaker IDs)
- `TranscriptLogger` is called from Stage 80 in the pipeline; its errors are caught and logged but do not abort the pipeline

**Complexity:** M

---

### S8.2 — Session Tracker

**User story:** As bus-core, I want a session tracker that detects inactivity and closes sessions automatically so that each conversation has a clear beginning and end that the summarizer can operate on.

**Acceptance criteria:**
- A background task runs every 60 seconds (configurable) and queries `sessions WHERE status = 'active' AND last_message_at < now() - interval`
- For each inactive session found, sets `status = 'summarize_pending'` and `ended_at = now()` in a single atomic UPDATE
- After marking sessions, triggers `Summarizer.summarize(sessionId)` for each (async, non-blocking — errors are caught and logged)
- `last_message_at` on the `sessions` row is updated by `TranscriptLogger.log()` on every new message (UPDATE sessions SET last_message_at = ? WHERE id = ?)
- The inactivity timeout is read from `AppConfig.memory.inactivity_timeout_minutes` (default: 15)
- Integration test: insert session with `last_message_at` 20 minutes ago → run tracker → verify `status = 'summarize_pending'` and summarizer was called

**Complexity:** S

---

### S8.3 — Summarizer Pipeline

**User story:** As bus-core, I want a `Summarizer` that calls the Claude API with a session's full transcript and extracts structured memories so that Peggy has rich, queryable context about past conversations without reading every transcript message.

**Acceptance criteria:**
- `Summarizer.summarize(sessionId: string): Promise<void>` fetches all `transcripts` rows for the session ordered by `received_at ASC`
- Formats the transcript as a conversation string and sends to Claude API with a system prompt that requests JSON output matching the schema: `{ summary: string, key_topics: string[], decisions: { decision: string, rationale: string }[], open_questions: string[], participants: string[], memories: { contact_id: string, content: string, confidence: number, category: string }[] }`
- Parses the JSON response; if parsing fails, logs the raw response at `error` level and marks session `status = 'summarize_failed'`
- On success: inserts/updates `session_summaries` row, inserts each memory into `memories` table (with `source = 'summarizer'`, `session_id`, `confidence` from response), marks session `status = 'summarized'`
- Uses a token budget guard: if transcript exceeds `summary_max_tokens * 0.8`, truncates to the most recent messages that fit (truncation is logged)
- If Claude API call fails (network error, rate limit), retries up to 3 times with exponential backoff; on final failure, marks session `status = 'summarize_failed'` and leaves for manual retry

**Complexity:** L

---

### S8.4 — Memory Lifecycle

**User story:** As Peggy, I want memories to have confidence scores, expiry dates, and supersession tracking so that outdated or explicitly forgotten information doesn't pollute future recall results.

**Acceptance criteria:**
- `memories` table rows include: `confidence REAL` (0.0–1.0), `expires_at TEXT` (nullable ISO timestamp), `superseded_by TEXT` (nullable — either a newer `memory_id` or a special string like `"manual_forget"`)
- `recall_memory` tool (E7) filters out memories where `expires_at < now()` or `superseded_by IS NOT NULL`
- When the summarizer inserts a new memory for a `(contact_id, category)` pair that already has an active memory, it sets `superseded_by = new_memory_id` on the old row and inserts the new one
- `/forget <contact_id>` (E6) sets `superseded_by = 'manual_forget'` and `expires_at = now()` on all active memories for that contact; returns affected count
- A background sweep (can run alongside the session tracker sweep) hard-deletes memories where `expires_at < now() - 30 days` to prevent unbounded growth
- Unit tests: insert memory → supersede → verify old memory excluded from recall; insert memory → forget → verify excluded; insert expired memory → verify sweep deletes it

**Complexity:** S

---

## Notes

- **Summarization prompt quality is critical.** Spend time on the prompt. The JSON extraction schema should be tight enough to parse reliably but flexible enough to handle varied conversation types. Use `response_format: { type: "json_object" }` in the API call to enforce JSON mode.
- **Memory `category` field:** Suggested categories: `preference`, `fact`, `decision`, `relationship`, `context`. The summarizer prompt should instruct Claude to classify each memory. This enables filtered recall (e.g., `recall_memory({ category: "preference" })`).
- **`summarize_failed` sessions:** Add a manual retry mechanism — either a `/retry-summary <session_id>` command (add to E6) or an admin API endpoint. Don't let failed sessions silently disappear.
- **Token counting before the API call:** Use `@anthropic-ai/tokenizer` or a simple character heuristic (1 token ≈ 4 chars) to guard against sending oversized transcripts. The truncation should keep the most recent messages, not the oldest, since recent context is more relevant for memory extraction.
- **`memories` table deduplication:** The supersession check in the summarizer should use `contact_id + category` as the key. If the category concept is too granular, fall back to just `contact_id` — but don't let duplicate facts accumulate.
- **Background task scheduling:** The session tracker and memory sweep are the first background tasks in the system. Use `setInterval` with a try/catch wrapper and a global error handler. Consider a simple `TaskRunner` class that manages these intervals and exposes a `stop()` method for graceful shutdown.
- **Claude API model selection:** Use a fast, cost-effective model for summarization (e.g., `claude-haiku-4-5-20251001`) unless the summary quality is inadequate. Make the model configurable via `AppConfig.memory.summary_model`.

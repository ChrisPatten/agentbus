# Memory System (E8)

The memory system gives the agent continuity across sessions. Every conversation
is durably logged, idle sessions are automatically closed, and Claude extracts
structured memories from completed sessions for future recall.

---

## Architecture Overview

```
Inbound message
      │
      ▼
Stage 80 (transcript-log)
  ├── Writes transcripts row
  ├── Creates / extends / closes session (idle threshold)
  └── Sets ctx.sessionId
      │
      ▼ (async, background)
SessionTracker (every 60s)
  ├── Detects sessions idle past threshold → sets ended_at + status='summarize_pending'
  ├── Triggers Summarizer.summarize(sessionId)
  ├── Retries status='summarize_failed' sessions (up to 3 attempts)
  └── Hard-deletes memories expired >30 days
      │
      ▼
Summarizer
  ├── Fetches transcript rows for session
  ├── Applies token budget guard (truncates oldest messages if > 80% of context)
  ├── Calls Claude API with system prompt requesting JSON SummaryResult
  ├── Writes session_summaries row
  ├── Inserts memory rows (with supersession of same contact+category)
  └── Sets session status='summarized' (or 'summarize_failed' on error)
```

---

## Database Tables

### sessions (updated in E8)

New columns added by migration 003:

| Column | Type | Description |
|--------|------|-------------|
| `status` | TEXT | `active` \| `summarize_pending` \| `summarized` \| `summarize_failed` |
| `summary_attempts` | INTEGER | Count of summarization attempts (max 3 before giving up) |

### memories

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT | UUID primary key |
| `session_id` | TEXT | Source session (nullable — manual memories have no session) |
| `contact_id` | TEXT | Contact this memory is about |
| `category` | TEXT | `preference` \| `fact` \| `plan` \| `relationship` \| `work` \| `health` \| `general` |
| `content` | TEXT | The fact itself |
| `confidence` | REAL | 0.0–1.0 score |
| `source` | TEXT | `summarizer` \| `manual` \| `system` |
| `created_at` | TEXT | ISO 8601 creation timestamp |
| `expires_at` | TEXT | Soft expiry (NULL = never expires) |
| `superseded_by` | TEXT | UUID of the newer memory, or `manual_forget`, or NULL (= active) |

Full-text search is available via the `memories_fts` virtual table.

### session_summaries

| Column | Type | Description |
|--------|------|-------------|
| `summary` | TEXT | JSON-encoded `SummaryResult` (summary, key_topics, decisions, open_questions, participants, memories) |
| `model` | TEXT | Claude model used for summarization |
| `token_count` | INTEGER | Total input + output tokens consumed |

---

## Configuration

```yaml
memory:
  summarizer_interval_ms: 60000       # How often the session tracker runs (ms)
  session_idle_threshold_ms: 1800000  # Inactivity window before closing a session (ms, default 30m)
  context_window_hours: 48            # Context window for E9 injection (hours)
  claude_api_model: claude-sonnet-4-6 # Model used for summarization
  summary_max_tokens: 8192            # Max tokens for the summarization API response
  on_session_close: ""                # Optional shell command to run when a session closes (see below)
```

### `on_session_close` hook

Run a shell command whenever a session is closed due to inactivity.
Executed via `/bin/sh -c`, so shell syntax, pipes, and `&&` chains work.

Accepts two forms:

**Global** — runs for every channel:
```yaml
memory:
  on_session_close: "tmux send-keys -t my-pane '/clear' Enter"
```

**Per-channel** — only runs for the listed channels; unlisted channels are skipped:
```yaml
memory:
  on_session_close:
    claude-code: "tmux send-keys -t pane-cc '/clear' Enter"
    telegram:    "tmux send-keys -t pane-tg '/clear' Enter"
```

The following environment variables are set for the duration of the command:

| Variable | Example |
|---|---|
| `AGENTBUS_SESSION_ID` | `a1b2c3d4-...` |
| `AGENTBUS_CHANNEL` | `claude-code` |
| `AGENTBUS_CONTACT_ID` | `contact:alice` |
| `AGENTBUS_MESSAGE_COUNT` | `12` |

Hook failures are logged but never block session closing or summarization.

Requires `ANTHROPIC_API_KEY` in `.env`. If the key is missing, the bus starts
normally but summarization is disabled (sessions are still tracked and closed).

---

## Memory Lifecycle

### Creation
Memories are created two ways:
1. **Summarizer** — automatically after a session ends (source: `summarizer`)
2. **`log_memory` MCP tool** — manually by the agent (source: `manual`)

### Supersession
When a new memory is inserted for the same `(contact_id, category)` pair, the
previous active memory is automatically superseded: `superseded_by` is set to
the new memory's ID. Only one active memory per contact+category exists at a
time.

### Recall
`recall_memory` returns only:
- Memories where `superseded_by IS NULL` (not replaced)
- Memories where `expires_at IS NULL OR expires_at > now()` (not expired)

Results are ordered by confidence DESC, then recency.

### Expiry and Forgetting
- **`/forget <contact_id>`** — sets `superseded_by = 'manual_forget'` and
  `expires_at = now()` on all active memories for that contact
- **Background sweep** — memories where `expires_at + 30 days < now()` are
  hard-deleted on each session tracker tick

---

## Slash Commands

| Command | Description |
|---------|-------------|
| `/forget <contact_id>` | Soft-expire all memories for a contact |
| `/retry-summary <session_id>` | Re-queue a failed session for summarization |

---

## MCP Tools

| Tool | Description |
|------|-------------|
| `recall_memory` | FTS search over active memories (see MCP_TOOLS.md) |
| `log_memory` | Manually insert a memory (see MCP_TOOLS.md) |

---

## Troubleshooting

### Summarization keeps failing

1. Check `ANTHROPIC_API_KEY` is set and valid
2. Check bus-core logs for `[summarizer]` errors
3. Use `/retry-summary <session_id>` to manually re-trigger after fixing the issue
4. If a session has `summary_attempts = 3`, use the command to reset it

### Memory not showing in recall

1. Check the memory isn't superseded: `SELECT * FROM memories WHERE contact_id = ?`
2. Check it isn't expired: `expires_at` should be NULL or in the future
3. Check the FTS index is up to date: restart with `--rebuild-fts`

### Session not closing

The SessionTracker closes sessions idle past `session_idle_threshold_ms`. If a
session stays open indefinitely, verify the tracker is running (check logs for
`[session-tracker]` entries every `summarizer_interval_ms`).

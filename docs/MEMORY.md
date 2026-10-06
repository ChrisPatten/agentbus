# Structured memory store (legacy, read-only)

The structured memory store kept facts extracted from completed sessions in SQLite (`memories`, `session_summaries`) and injected recent summaries into later conversations. **Since E66 it is read-only.** The Anthropic-API summarizer that filled it (`src/memory/summarizer.ts`) was removed, along with the `@anthropic-ai/sdk` dependency, and nothing writes the tables any more. Journaling replaces it: agents keep memory in their own files, updated by journal runs ([JOURNALING.md](JOURNALING.md), [MEMORY_MODEL.md](MEMORY_MODEL.md)).

What still works, over whatever rows already exist:
- **Stage 85 (memory-inject)** attaches recent session summaries for the same contact and channel as `metadata.memory_context` on the first message of a new session (format below). With no new summaries it finds less and less, and eventually nothing.
- **`recall_memory`** (MCP) and `GET /api/v1/memories/recall` search the existing memories.
- **Retention**: the session tracker hard-deletes memories whose `expires_at` is more than 30 days past.

What changed:
- **`log_memory`** stays registered but returns an error pointing at the memory files, and records nothing. `POST /api/v1/memories` returns `410`.
- **Config.** `memory.claude_api_model`, `memory.summary_max_tokens` and `memory.structured_extraction` are accepted with a deprecation warning and ignored.
- **Sessions** closed by the tracker now go straight to status `closed` (formerly `summarize_pending`, then `summarized` or `summarize_failed`). Older rows keep their status.

The tables and migrations stay in place; nothing is dropped.

## Session tracker

```
SessionTracker (every memory.summarizer_interval_ms)
  closes sessions idle past session_idle_threshold_ms (polling-adapter sessions only: claude_session_id IS NULL)
  marks sessions Stage 80 closed mid-conversation as closed
  reports every close to the journaling engine (the `close` trigger)
  runs the on_session_close hook for sessions meeting session_close_min_messages
  hard-deletes memories expired more than 30 days ago
```

## Configuration

```yaml
memory:
  summarizer_interval_ms: 60000       # session-tracker tick (also the journaling engine's)
  session_idle_threshold_ms: 1800000  # idle gap that closes a polling-adapter session
  session_close_min_messages: 0       # number, or per-channel map; sessions below it skip the hook
  on_session_close: ""                # shell command, or per-channel map
  context_window_hours: 48            # how far back memory-inject looks for summaries
  memory_inject_exclude: []           # channels that never receive injected context
```

### `on_session_close`

Runs through `/bin/sh -c` when the tracker closes an idle session. A string runs for every channel; a map runs only for the listed channels. The command receives `AGENTBUS_SESSION_ID`, `AGENTBUS_CHANNEL`, `AGENTBUS_CONTACT_ID`, and `AGENTBUS_MESSAGE_COUNT`. A hook failure is logged and never blocks closing.

```yaml
memory:
  on_session_close:
    claude-code: "tmux send-keys -t pane-cc '/clear' Enter"
```

### `session_close_min_messages`

A session must have at least this many messages before idle expiration fires the hook. `message_count` starts at 1, so a value of `1` makes every session eligible. Accepts a number or a per-channel map; unlisted channels default to 0. Channel names match exactly: `telegram` does not match `telegram:peggy`.

### `memory_inject_exclude`

Channels for which Stage 85 is skipped entirely, for agents that manage their own context.

## Tables

`sessions` gains `status` and `summary_attempts` in migration 003. New closes use `closed`; older rows may hold `summarize_pending`, `summarized` or `summarize_failed`.

| Table | Purpose |
|---|---|
| `memories` | One row per fact: `contact_id`, `category` (`preference`, `fact`, `plan`, `relationship`, `work`, `health`, `general`), `content`, `confidence`, `source`, `channel`, `expires_at`, `superseded_by` |
| `memories_fts` | FTS5 index over `memories.content` |
| `session_summaries` | One row per summarized session: JSON `summary`, `model`, `token_count` |

Recall returns only rows with `superseded_by IS NULL` and no past `expires_at`. Memories with `channel = NULL` are visible on every channel.

## Interfaces

- HTTP: `GET /api/v1/memories/recall`; `POST /api/v1/memories` returns `410` ([HTTP_API.md](HTTP_API.md#memories-legacy)).
- MCP: `recall_memory`, and `log_memory`, which now always errors ([MCP_TOOLS.md](MCP_TOOLS.md#legacy-memory-store)).

## Injected context format

When Stage 85 finds summaries, it sets `envelope.metadata.memory_context`, which the polling adapter prepends to the channel notification:

```
<memory contact="alice">
## Recent conversations
- telegram (Apr 12, 14:30 - 15:45): Discussed deployment strategy for the new API.
</memory>
```

The block is capped at 4,000 characters; the oldest summaries are dropped first. The headless adapter ignores `memory_context` because it assembles memory files into the system prompt instead.

## Troubleshooting

- **A memory does not appear in recall.** Check `superseded_by` and `expires_at` on the row. Rebuild FTS with `--rebuild-fts` if the index is stale.
- **A session never closes.** Only sessions with `claude_session_id IS NULL` close on idle. Confirm `[session-tracker]` lines appear every `summarizer_interval_ms`.
- **Forgetting a contact's memories.** `UPDATE memories SET superseded_by = 'manual_forget', expires_at = <now> WHERE contact_id = ?`.

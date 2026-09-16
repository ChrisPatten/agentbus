# Structured memory store (legacy)

The structured memory store extracts facts from completed sessions into SQLite and injects them into later conversations. It is **dormant by default**: `memory.structured_extraction` is `false`, so the summarizer writes nothing and no context is injected. The agent's own files are the memory system. See [MEMORY_MODEL.md](MEMORY_MODEL.md).

Enable it only for a persistent Claude Code session on the polling MCP adapter that has no memory files of its own. Nothing here applies to headless sessions, which are long-lived and journal to files instead.

## How it works

```
Stage 80 (transcript-log)
  writes the transcript row; creates, extends, or closes the session

SessionTracker (every memory.summarizer_interval_ms)
  closes sessions idle past session_idle_threshold_ms (polling-adapter sessions only)
  runs the on_session_close hook
  calls Summarizer.summarize() for each closed session; retries failures up to 3 times
  hard-deletes memories expired more than 30 days ago

Summarizer (only when structured_extraction is true)
  sends the transcript to the Claude API and parses a JSON SummaryResult
  writes session_summaries and memories rows; supersedes the previous memory
    for the same contact, category, and channel
  marks the session summarized or summarize_failed

Stage 85 (memory-inject)
  on the first message of a new session, attaches recent session summaries for
    the same contact and channel as metadata.memory_context
```

Requires `ANTHROPIC_API_KEY` in `.env`. Without it the bus starts, sessions still close, and summarization is skipped.

## Configuration

```yaml
memory:
  structured_extraction: false        # true enables the summarizer and injection
  summarizer_interval_ms: 60000       # session tracker tick
  session_idle_threshold_ms: 1800000  # idle gap that closes a polling-adapter session
  session_close_min_messages: 0       # number, or per-channel map; sessions below it stay open
  on_session_close: ""                # shell command, or per-channel map
  context_window_hours: 48            # how far back memory-inject looks for summaries
  claude_api_model: claude-sonnet-4-6
  summary_max_tokens: 8192
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

A session must have at least this many messages before idle expiration closes it and fires the hook. `message_count` starts at 1, so a value of `1` makes every session eligible. Accepts a number or a per-channel map; unlisted channels default to 0. Channel names match exactly: `telegram` does not match `telegram:peggy`.

### `memory_inject_exclude`

Channels for which Stage 85 is skipped entirely, for agents that manage their own context.

## Tables

`sessions` gains `status` (`active`, `summarize_pending`, `summarized`, `summarize_failed`) and `summary_attempts` in migration 003.

| Table | Purpose |
|---|---|
| `memories` | One row per extracted or manually logged fact: `contact_id`, `category` (`preference`, `fact`, `plan`, `relationship`, `work`, `health`, `general`), `content`, `confidence`, `source`, `channel`, `expires_at`, `superseded_by` |
| `memories_fts` | FTS5 index over `memories.content` |
| `session_summaries` | One row per summarized session: JSON `summary`, `model`, `token_count` |

A new memory for the same contact, category, and channel supersedes the previous one. Recall returns only rows with `superseded_by IS NULL` and no past `expires_at`. Memories with `channel = NULL` are visible on every channel.

## Interfaces

- HTTP: `GET /api/v1/memories/recall` and `POST /api/v1/memories` ([HTTP_API.md](HTTP_API.md#memories-legacy)).
- MCP: `recall_memory` and `log_memory` ([MCP_TOOLS.md](MCP_TOOLS.md#legacy-memory-store)). Both are registered on every server and marked legacy in their descriptions.

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

- **Summarization keeps failing.** Check `ANTHROPIC_API_KEY` and `[summarizer]` log lines. To retry a session by hand: `UPDATE sessions SET status = 'summarize_pending', summary_attempts = 0 WHERE id = ?`.
- **A memory does not appear in recall.** Check `superseded_by` and `expires_at` on the row. Rebuild FTS with `--rebuild-fts` if the index is stale.
- **A session never closes.** Only sessions with `claude_session_id IS NULL` close on idle. Confirm `[session-tracker]` lines appear every `summarizer_interval_ms`.
- **Forgetting a contact's memories.** `UPDATE memories SET superseded_by = 'manual_forget', expires_at = <now> WHERE contact_id = ?`.

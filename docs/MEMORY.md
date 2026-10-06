# Sessions and the `memory` config block

The `memory` block of `config.yaml` configures the session tracker. Agent memory itself lives in the agent's own files: see [AGENT_MEMORY.md](AGENT_MEMORY.md) (layout, loading, `recent.md`) and [JOURNALING.md](JOURNALING.md) (how the files get written).

## The legacy structured memory store was removed

The E8/E9 structured store (SQLite `memories`, `memories_fts`, `session_summaries`) is gone, after E66 retired the Anthropic-API summarizer that filled it. Removed with it: the `recall_memory` and `log_memory` MCP tools, `GET /api/v1/memories/recall` and `POST /api/v1/memories`, pipeline stage 85 (`memory-inject`, which put `metadata.memory_context` on a new session's first message), the session tracker's expired-memory sweep, and the `summary` object on `GET /api/v1/sessions` and `/api/v1/sessions/:id` (and the `get_session` / `list_sessions` tools). Migration 031 drops the tables; their contents are not migrated.

The config keys `memory.context_window_hours`, `memory.memory_inject_exclude`, `memory.claude_api_model`, `memory.summary_max_tokens` and `memory.structured_extraction` are ignored, with one startup warning (`RETIRED_MEMORY_KEYS`, `src/config/loader.ts`), so an old `config.yaml` still starts. `sessions.status` and `summary_attempts` stay: new closes use `closed`; older rows may hold `summarize_pending`, `summarized` or `summarize_failed`.

For a queryable, agent-managed store, use the `knowledge` table ([KNOWLEDGE_STORE.md](KNOWLEDGE_STORE.md)).

## Session tracker

```
SessionTracker (every memory.summarizer_interval_ms)
  closes sessions idle past session_idle_threshold_ms (polling-adapter sessions only: claude_session_id IS NULL)
  marks sessions Stage 80 closed mid-conversation as closed
  reports every close to the journaling engine (the `close` trigger)
  runs the on_session_close hook for sessions meeting session_close_min_messages
```

## Configuration

```yaml
memory:
  summarizer_interval_ms: 60000       # session-tracker tick (also the journaling engine's)
  session_idle_threshold_ms: 1800000  # idle gap that closes a polling-adapter session
  session_close_min_messages: 0       # number, or per-channel map; sessions below it skip the hook
  on_session_close: ""                # shell command, or per-channel map
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

## Troubleshooting

- **A session never closes.** Only sessions with `claude_session_id IS NULL` close on idle. Confirm `[session-tracker]` lines appear every `summarizer_interval_ms`.

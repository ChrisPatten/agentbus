# Memory model

How AgentBus handles memory for a single-user, single-agent personal assistant, and why the bus's structured memory store is dormant.

## The layered model

For a personal assistant, **the agent's own files are the memory system**:

- **`MEMORY.md`** — a hand-curated index of durable facts, pointers, and topic files.
- **Typed/topic files** — freeform notes the agent organizes however it likes.
- **Daily journal** — `memory/daily/YYYY-MM-DD.md`, a liberal running log the agent appends to.

These live in the agent's `working_dir`, are authored by the agent, and auto-load into every turn because every channel's `claude -p` runs in the same directory. This is richer than — and redundant with — the bus extracting structured `memories` / `session_summaries` rows.

So E20 stops the bus from trying to **be** the memory store and makes it **orchestrate** the agent's own files instead. The bus's residual memory role is **telemetry, not content**: it tracks *which* conversations are due for journaling and *when* — it never holds what the agent knows.

| Concern | Owner |
|---|---|
| Durable knowledge (facts, preferences, plans) | **The agent's files** (`MEMORY.md`, topic files, daily journal) |
| Loading those files into each turn's context | **The bus** — `assembleMemoryContext` (front-loads `MEMORY.md` + recent dailies) |
| Recent conversation continuity | **Claude Code** — the resumed `claude_session_id`, bounded by auto-compaction |
| Deciding when to capture durable knowledge | **The bus** — the journaling dispatcher fires on pause or on a hard ceiling (E30) |
| Actually writing the knowledge | **The agent** — the silent journaling turn edits its own files; high-stakes content (E30) is written inline in the reply-producing turn instead of waiting on the sweep |
| What's due for journaling and when | **The bus** — `sessions` telemetry (`last_activity`, `journal_cursor_at`, `last_journaled_at`, `claude_session_id`) and `journal_state` (E66) |

## The two pillars

1. **Headless context assembly** — an ephemeral one-shot `claude -p` can't be relied on to go read yesterday's journal on its own, so the bus assembles `MEMORY.md` + the most recent daily journal files into each turn's context. See [CC_HEADLESS_ADAPTER.md → Context assembly](./CC_HEADLESS_ADAPTER.md#context-assembly-memory-files).

2. **Journaling on pause or ceiling** — the idle threshold is repurposed from a *teardown* signal into a *journaling* signal. When a conversation pauses, the bus fires a **silent** `--resume` journaling turn: the agent reviews the conversation and updates its files, sends the user nothing, and the session stays open. A hard ceiling alongside the idle debounce makes a long, continuously-active conversation flush periodically instead of only on pause. See [CC_HEADLESS_ADAPTER.md → Memory logging](./CC_HEADLESS_ADAPTER.md#memory-logging).

   **E66.** The dispatcher is now the journaling engine (`src/journaling/engine.ts`), shared by every runtime, with per-agent journaler chains, a per-session cursor (`sessions.journal_cursor_at`), eligibility rules (`min_human_messages`, default 2) and `journal_runs` records. The E33 "sweep is a no-op bus-wide" warning is gone: a session whose agent has no journaling settings is simply not journaled, and a chain that can't run raises an advisory. Three journalers carry out a run: `system-message` (the live agent journals in its own session, on cc-pool), `cc-headless` (`claude -p --resume`, forked on cc-pool) and `script` (your executable over the bus transcript; the shipped `claude-p-journal.sh` hands it to `claude -p`). See [JOURNALING.md](JOURNALING.md).

3. **No memory work inside the reply-producing turn** — the turn that answers the user ends at `reply()`/`send_message()`; it does not keep running afterward to journal. That responsibility belongs entirely to the debounced sweep above, with one exception: financial, health, scheduling, or safety/security-relevant content is still captured immediately, inline, before the turn's process exits — see [CC_HEADLESS_ADAPTER.md → High-stakes immediate-logging exception](./CC_HEADLESS_ADAPTER.md#high-stakes-immediate-logging-exception).

## Transcripts capture both directions

Inbound rows are written by the transcript-log stage. Outbound rows — `reply`, `send_message`, `send_email`, and scheduled-message delivery — are written by `DeliveryWorker.deliver()` (`src/core/delivery.ts`) after a confirmed `adapter.send()`, and by the slash-command reply path in `src/http/api.ts`. Both use `logOutboundTranscript` (`src/pipeline/outbound-transcript.ts`). A failed or dead-lettered send never produces a row, and a send whose conversation or session cannot be resolved (no prior inbound history for that contact and channel) is skipped rather than failed. `get_transcript` and `search_transcripts` therefore show the whole conversation.

## Long-lived sessions

Headless sessions are never force-closed on idle (`ended_at` stays `NULL`); the same `claude_session_id` resumes across pauses, so the agent always picks up where it left off. Context growth is bounded by Claude Code's built-in auto-compaction (`autoCompactEnabled`, on by default in `-p` mode), not by session teardown — so leave auto-compaction on (`DISABLE_AUTO_COMPACT=1` will eventually overflow a never-idle conversation).

This is scoped to headless sessions via the `claude_session_id IS NOT NULL` discriminator — a column set only by `cc-headless`. The MCP `cc.ts` path keeps its idle teardown and `on_session_close` hook.

## Cross-channel continuity is free

Because every channel's `claude -p` runs in the same `working_dir` and auto-loads the same files, a fact the agent journaled from a Telegram conversation is already in context for a later email turn. There is **no** "widen DB recall across channels" machinery — files are the source of truth, so cross-channel continuity falls out for free.

## The structured store is read-only

The E8/E9 `memories` and `session_summaries` tables were filled by an Anthropic-API summarizer behind `memory.structured_extraction`. E66 removed the summarizer (and `@anthropic-ai/sdk`): journaling, with the reference script journaler built on `claude -p`, covers "an LLM over the bus transcript". The tables and migrations stay in place. Stage 85 still injects whatever summaries exist and `recall_memory` still reads them, but nothing writes them: `log_memory` errors and `POST /api/v1/memories` returns `410`. The old config keys load with a deprecation warning. See [MEMORY.md](MEMORY.md).

For a shared, queryable store, use the `knowledge` table instead.

The `knowledge` table (see [KNOWLEDGE_STORE.md](KNOWLEDGE_STORE.md)) is a **separate, always-on, agent-managed** store: not a revival of the read-only `memories` / `session_summaries` tables, with its own agent-defined schema rather than the fixed preference/fact/plan/etc. categories.

## See also

- [CC_HEADLESS_ADAPTER.md](./CC_HEADLESS_ADAPTER.md) — the headless adapter, long-lived sessions, context assembly, and journaling mechanics.
- [MEMORY.md](./MEMORY.md) — the read-only legacy structured memory store: tables, injection, and config.
- [JOURNALING.md](./JOURNALING.md) — how memory files get updated: triggers, journalers, `/journal`.
- [KNOWLEDGE_STORE.md](./KNOWLEDGE_STORE.md) — the new, always-on, agent-managed knowledge store (separate from both of the above).

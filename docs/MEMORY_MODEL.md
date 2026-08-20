# Memory Model (E20, extended in E30)

How AgentBus handles memory for a single-user / single-agent personal assistant (the "Peggy" model), and why the bus's structured memory store is dormant.

> **E30 changes:** journaling is no longer purely pause-triggered — a hard ceiling now fires the same sweep even during a continuously-active conversation, so memory-logging is fully decoupled from the reply-producing turn (which no longer does any post-reply tool work at all, high-stakes content excepted). See [CC_HEADLESS_ADAPTER.md → Memory Logging](./CC_HEADLESS_ADAPTER.md#memory-logging-e30).

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
| What's due for journaling and when | **The bus** — `sessions` telemetry (`last_activity`, `last_journaled_at`, `claude_session_id`) |

## The two pillars

1. **Headless context assembly** — an ephemeral one-shot `claude -p` can't be relied on to go read yesterday's journal on its own, so the bus assembles `MEMORY.md` + the most recent daily journal files into each turn's context. See [CC_HEADLESS_ADAPTER.md → Context assembly](./CC_HEADLESS_ADAPTER.md#context-assembly-memory-files-e20).

2. **Journaling on pause or ceiling** — the idle threshold is repurposed from a *teardown* signal into a *journaling* signal. When a conversation pauses, the bus fires a **silent** `--resume` journaling turn: the agent reviews the conversation and updates its files, sends the user nothing, and the session stays open. E30 adds a hard ceiling alongside the idle debounce so a long, continuously-active conversation still flushes periodically instead of only on pause. See [CC_HEADLESS_ADAPTER.md → Memory Logging](./CC_HEADLESS_ADAPTER.md#memory-logging-e30).

3. **No memory work inside the reply-producing turn (E30)** — the turn that answers the user ends at `reply()`/`send_message()`; it no longer keeps running afterward to journal. That responsibility belongs entirely to the debounced sweep above, with one exception: financial, health, scheduling, or safety/security-relevant content is still captured immediately, inline, before the turn's process exits — see [CC_HEADLESS_ADAPTER.md → High-stakes immediate-logging exception](./CC_HEADLESS_ADAPTER.md#high-stakes-immediate-logging-exception-e30).

## Long-lived sessions

Headless sessions are never force-closed on idle (`ended_at` stays `NULL`); the same `claude_session_id` resumes across pauses, so the agent always picks up where it left off. Context growth is bounded by Claude Code's built-in auto-compaction (`autoCompactEnabled`, on by default in `-p` mode), not by session teardown — so leave auto-compaction on (`DISABLE_AUTO_COMPACT=1` will eventually overflow a never-idle conversation).

This is scoped to headless sessions via the `claude_session_id IS NOT NULL` discriminator — a column set only by `cc-headless`. The MCP `cc.ts` path keeps its idle teardown and `on_session_close` hook.

## Cross-channel continuity is free

Because every channel's `claude -p` runs in the same `working_dir` and auto-loads the same files, a fact the agent journaled from a Telegram conversation is already in context for a later email turn. There is **no** "widen DB recall across channels" machinery — files are the source of truth, so cross-channel continuity falls out for free.

## Why the structured store is dormant

The E8/E9 `memories` and `session_summaries` tables (and the summarizer's Claude-API extraction) are **disabled by default** behind `memory.structured_extraction` (default `false`). When off, the bus writes neither table. The tables and migrations are **left in place** (dormant) — no destructive migration — and the `recall_memory` / `log_memory` MCP tools remain registered (marked legacy) so existing MCP-adapter deployments are unaffected.

For the single-user / single-agent file-memory model the structured store is pure duplication. It would earn its keep again when:

- **Multiple agents** need a shared, queryable knowledge base they don't all hold as files.
- **Programmatic / dashboard queries** need structured rows (filter by contact, category, confidence) rather than freeform prose.
- **Non-LLM consumers** need the data (analytics, exports) without reading Markdown.

In those cases, set `memory.structured_extraction: true` to restore the legacy summarizer behavior.

## See also

- [CC_HEADLESS_ADAPTER.md](./CC_HEADLESS_ADAPTER.md) — the headless adapter, long-lived sessions, context assembly, and journaling mechanics.
- [MEMORY.md](./MEMORY.md) — the (now dormant) structured memory system: tables, summarizer, and config.

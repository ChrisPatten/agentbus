# E20 — Journaling Memory Model & Long-Lived Sessions

| Field | Value |
|---|---|
| Epic ID | E20 |
| Dependencies | E19 (headless adapter), E19.1 (reply delivery), E8 (session-tracker, summarizer — repurposed), E9 (context injection — superseded for headless) |
| Story Count | 7 |
| Estimated Complexity | L |

---

## Epic Summary

For a single-user / single-agent personal assistant (the "Peggy" model), the
agent's own files **are** the memory system: a `MEMORY.md` index, typed durable
files, and a liberal daily journal, all agent-authored, freeform, and auto-loaded
each session because they live in one working directory. This is richer than, and
redundant with, the bus's structured `memories`/`session_summaries` extraction
(E8/E9). E20 stops the bus from trying to **be** a memory store and instead makes
it **orchestrate** the agent's own memory across a headless, per-turn `claude -p`
runtime.

Two pillars:

1. **Headless context assembly** — front-load the agent's own memory files
   (`MEMORY.md` + the most recent daily journal files) into each conversation
   turn's context. An ephemeral one-shot `claude -p` invocation cannot be relied
   on to go read yesterday's journal on its own; the bus assembles it.

2. **Journaling on pause** — repurpose the session idle threshold from a *teardown*
   signal into a *journaling* signal. When a conversation pauses (idle past a
   per-channel threshold), the bus fires a **silent** `--resume` journaling turn:
   the agent reviews the conversation and updates its own memory files, sends the
   user nothing, and the session stays open.

Sessions become **long-lived**: they are never force-closed on idle. The same
`claude_session_id` keeps resuming across pauses, so the agent always picks up
exactly where it left off. Context growth is bounded by Claude Code's built-in
auto-compaction (on by default in `-p` mode), not by session teardown. Durable
knowledge crosses channels for free, because every channel's `claude -p` runs in
the same `working_dir` and auto-loads the same files.

The bus's residual memory role is **telemetry, not content**: it tracks *which*
conversations are due for journaling and *when* — it never holds what the agent
knows. The E8 `memories`/`session_summaries` content tables are retired (left
dormant behind a flag); the summarizer is demoted to a journaling dispatcher.

**Standard terminology (use consistently):**
- **journaling** — the agent writing durable knowledge to its own memory files.
- **journaling turn** — the silent `--resume` `claude -p` invocation that triggers it.
- **journaling threshold** — the per-channel idle gap that marks a conversation paused.
- **journaling dispatcher** — the bus component (repurposed session-tracker/summarizer) that fires journaling turns and tracks their state.

---

## Entry Criteria

- E19 complete: headless adapter (`cc-headless.ts`) spawns `claude -p` per batch
  with `working_dir`, `--resume`, `--system-prompt-file`, `--mcp-config`.
- E19.1 complete: agent owns delivery via the `reply`/`send_message` tools;
  adapter watches stream-json for delivery and falls back to stdout.
- E8 operational: `SessionTracker` runs an idle-detection tick; `Summarizer`
  exists and is invoked on close. (Both are repurposed, not removed.)
- `working_dir` is configured to the agent's project directory containing its
  `CLAUDE.md` and `memory/` directory.

---

## Exit Criteria

- A Telegram conversation is **never force-closed** on idle: `ended_at` stays
  NULL, the same `claude_session_id` resumes on the next message, and the agent
  retains full continuity across the pause.
- After a per-channel journaling threshold elapses with no activity, exactly one
  **silent** journaling turn fires for that conversation: the agent updates its
  memory files and **no** outbound message reaches the user.
- Each inbound conversation turn's context includes `MEMORY.md` and the configured
  set of recent daily journal files, without the agent having to read them itself.
- The bus no longer writes the `memories` / `session_summaries` content tables
  (writes are gated off by default); the summarizer code path now dispatches
  journaling turns and records only journaling **telemetry**.
- Re-journaling does not fire repeatedly while a conversation stays idle — one
  journaling turn per pause, re-armed by new activity.
- Context for a long-lived session stays bounded across many turns via Claude
  Code auto-compaction (no overflow), with `autoCompactEnabled` assumed on.
- No regression to the MCP adapter (`cc.ts`) path, which is unaffected.

---

## Config Shape

Extend `CcHeadlessAdapterSchema` (`src/config/schema.ts`):

```yaml
adapters:
  cc-headless:
    working_dir: /Users/chrispatten/workspace/peggy-claude-code
    # ── E20: memory file assembly ──────────────────────────────────────────
    memory:
      dir: memory                  # relative to working_dir
      index_file: MEMORY.md        # always loaded into every turn
      daily_subdir: daily          # daily/YYYY-MM-DD.md
      journal_lookback_days: 3     # today + previous 2 days of journal
    # ── E20: journaling on pause ───────────────────────────────────────────
    journaling:
      enabled: true
      # per-channel idle gap that marks a conversation "paused" → journal.
      # number | { <channel>: number, default: number } (mirrors
      # memory.session_close_min_messages shape).
      threshold_ms:
        telegram: 1800000          # 30 min
        email: 86400000            # 24 h
        default: 1800000
      prompt: |
        Our conversation has paused. Review it and update your memory files
        (today's daily journal, MEMORY.md, and any relevant topic files) with
        anything durable worth remembering. Do NOT message Mr. Patten — this is
        an internal journaling turn, not a reply.
```

Notes on the shape:
- `journaling.threshold_ms` reuses the `number | Record<channel, number>` pattern
  already established by `memory.session_close_min_messages`
  (`session-tracker.ts:92`, `minMessagesForChannel`).
- `memory.dir` + `index_file` + `daily_subdir` are resolved relative to
  `working_dir`. Missing files are skipped silently (an agent without a journal
  yet still works).

---

## Stories

### S20.1 — Config Schema: Memory Assembly + Journaling

**User story:** As an operator, I want to configure where the agent's memory files
live and how long a conversation must be idle before journaling, so that each
channel journals at a cadence that matches how it is used.

**Acceptance criteria:**
- `CcHeadlessAdapterSchema` gains a `memory` object: `{ dir: z.string().default('memory'), index_file: z.string().default('MEMORY.md'), daily_subdir: z.string().default('daily'), journal_lookback_days: z.number().int().nonnegative().default(3) }`.
- `CcHeadlessAdapterSchema` gains a `journaling` object: `{ enabled: z.boolean().default(true), threshold_ms: <number | record>, prompt: z.string().default(...) }` where `threshold_ms` accepts either a positive integer or a record of channel→integer with a `default` key.
- A helper `journalingThresholdForChannel(channel)` resolves the per-channel value (flat number, channel-specific, or `default`), mirroring `minMessagesForChannel`.
- Invalid config (negative threshold, negative lookback) fails validation with a clear startup error.
- Unit tests: defaults parse; flat-number threshold resolves for any channel; per-channel map resolves specific + falls back to `default`; negative values rejected.

**Complexity:** S

---

### S20.2 — Long-Lived Sessions: Remove Idle Teardown, Resume by Conversation

**User story:** As the agent, I want my conversation context to persist across
pauses instead of resetting, so that when the user comes back after a gap I pick
up exactly where we left off.

**Acceptance criteria:**
- **Stage 80** (`transcript-log.ts`): remove the "gap > threshold → set `ended_at`,
  INSERT new session" branch (`transcript-log.ts:74-82`). On a gap, the existing
  session is **extended** (update `last_activity`, increment `message_count`), not
  torn down. `ctx.sessionCreated` is only set when there is genuinely no active
  session for the `conversation_id`.
- **SessionTracker**: `closeIdleSessions` no longer sets `ended_at`/closes sessions
  on idle (its teardown role is removed; its idle-detection role moves to the
  journaling dispatcher in S20.4). The expired-memory sweep is retained.
- **Headless resume lookup** (`cc-headless.ts:72` `getActiveSession`): key on
  `conversation_id` rather than `(contact_id, channel)`, so each email thread
  resumes its own session and a long-lived Telegram conversation resumes the same
  one. The adapter receives/derives `conversation_id` for the batch (from the
  envelope/route) and looks up `SELECT id, claude_session_id FROM sessions WHERE conversation_id = ? AND ended_at IS NULL`.
- `claude_session_id` persists on the session row across pauses and is reused on
  every subsequent turn (`--resume`).
- Email needs no hard end-of-thread: a finished thread simply goes quiet; its
  session is never force-closed (a new thread is a new `conversation_id` → new
  session automatically).
- Unit tests: two messages on one `conversation_id` separated by a gap > threshold
  → same session row, same `claude_session_id`, `ended_at` still NULL; two
  different `conversation_id`s → two sessions.

**Complexity:** M

---

### S20.3 — Headless Context Assembly from Memory Files

**User story:** As the agent, I want my `MEMORY.md` index and recent daily journal
entries already in context on every turn, so that I am oriented without spending a
turn reading files.

**Acceptance criteria:**
- A new `assembleMemoryContext(workingDir, memoryCfg, now)` reads, in order, and
  concatenates with clear file-boundary markers:
  - `<dir>/<index_file>` (e.g. `memory/MEMORY.md`) if present, and
  - the daily journal files for `now`, `now-1`, … back `journal_lookback_days-1`
    days, at `<dir>/<daily_subdir>/YYYY-MM-DD.md`, skipping any that do not exist.
- The assembled block is injected into each turn's context (prepended to the
  rendered `system_prompt`, or appended after `expandFileReferences`), replacing
  the E8/E9 memory path (`getMemories`/`getLastSummary`/`formatMemories`/
  `formatSummary`) in the headless adapter.
- Date math uses the agent's configured/local date (consistent with how daily
  files are named); no off-by-one at day boundaries.
- Missing memory directory or files degrade gracefully (empty block, no crash).
- The block is assembled fresh on every turn so an in-session journaling update is
  reflected on the next turn.
- Unit tests: index + 3 daily files present → all included in correct order; a
  missing day is skipped; missing `memory/` dir → empty block, no error;
  `journal_lookback_days: 0` → index only.

**Complexity:** M

---

### S20.4 — Journaling Dispatcher: Fire on Pause

**User story:** As the bus, I want to detect when a conversation has paused and
trigger the agent to journal it, so that durable knowledge is captured without the
user having to ask and without ending the conversation.

**Acceptance criteria:**
- The `SessionTracker` tick gains `dispatchJournaling()`: it selects active
  sessions (`ended_at IS NULL`) whose `last_activity` is older than the
  per-channel `journaling.threshold_ms` **and** that have not been journaled since
  their last activity (`last_journaled_at IS NULL OR last_journaled_at < last_activity`).
- For each such session it invokes the journaling turn (S20.5) and, on success,
  stamps `last_journaled_at = now`. One journaling turn per pause; new activity
  re-arms it (because `last_activity` advances past `last_journaled_at`).
- A new migration adds `last_journaled_at` (nullable TEXT/ISO) to `sessions`.
- Journaling respects `journaling.enabled` (false → dispatcher is a no-op).
- Dispatch is fire-and-forget with error capture: a failed journaling turn logs
  and leaves `last_journaled_at` unchanged so the next tick retries (bounded by a
  small attempt cap to avoid hot-looping on a persistently failing session).
- The dispatcher never sets `ended_at` (sessions stay long-lived).
- Unit tests: idle-past-threshold session with no prior journaling → dispatched
  once; same session on the next tick (still idle, now journaled) → not
  re-dispatched; new activity after journaling → re-armed and dispatched again;
  `enabled: false` → never dispatched; per-channel threshold honored.

**Complexity:** M

---

### S20.5 — Silent Journaling Turn in the Headless Adapter

**User story:** As the user, I want journaling to happen invisibly, so that pausing
a conversation never produces a stray "I've updated my notes" message.

**Acceptance criteria:**
- The headless adapter exposes `runJournalingTurn(conversationId)`: it looks up the
  session's `claude_session_id` and spawns `claude -p <journaling.prompt> --resume <claude_session_id> ...` with the same `working_dir`, MCP config, and assembled
  memory context as a normal turn.
- The journaling turn runs in **no-deliver mode**: any `resultText`/stdout is
  **never** delivered to the user, and the `deliveredViaTool` stdout-fallback path
  is bypassed. (Mechanism: a `deliver: false` flag through `processBatch`/delivery,
  distinct from the normal path.)
- If the agent nonetheless calls `reply`/`send_message` during a journaling turn,
  that is the agent's explicit choice and is allowed through the tool (the bus does
  not suppress tool calls) — but the adapter itself posts nothing. The journaling
  prompt instructs the agent not to message the user.
- The journaling turn updates `claude_session_id` if the resumed run reports a new
  one, keeping resume continuity intact.
- A journaling turn against a session with no `claude_session_id` yet (agent never
  spoke) is skipped (nothing to journal) and stamped as journaled.
- No typing indicator is started for a journaling turn.
- Unit tests: journaling turn with stdout result → `deliverResponse` not called;
  journaling turn that errors → logged, no outbound; missing `claude_session_id`
  → skipped, marked journaled.

**Complexity:** M

---

### S20.6 — Retire Content Memory; Demote to Journaling Telemetry

**User story:** As a maintainer, I want a single source of truth for the agent's
knowledge (its files), so that the bus's structured memory store does not drift
from or duplicate the journal.

**Acceptance criteria:**
- The `Summarizer`'s `summarize()` content path (Claude API extraction → writes to
  `memories` + `session_summaries`) is **disabled by default** behind a config flag
  (e.g. `memory.structured_extraction: false`, default false). When off, the bus
  writes neither table.
- The session status machine is repurposed/retained only as **telemetry**: the
  `last_journaled_at` column (S20.4) and existing `sessions` bookkeeping
  (`conversation_id → claude_session_id`, `last_activity`, `message_count`) are the
  bus's record of *what is due for journaling and when* — never knowledge content.
- The MCP `recall_memory` / `log_memory` tools are documented as superseded by
  direct file access in the file-memory model; they remain registered for the MCP
  adapter but are noted as no-ops/legacy for the headless file-memory path. (No
  removal in this epic — deprecation note only.)
- The `memories` / `session_summaries` tables and their migrations are **left in
  place** (dormant) so existing MCP-adapter deployments are unaffected; no
  destructive migration.
- Unit tests: with `structured_extraction: false`, a paused+journaled session
  writes no `memories`/`session_summaries` rows; with it `true`, legacy behavior is
  unchanged (regression guard for MCP deployments).

**Complexity:** M

---

### S20.7 — Docs

**User story:** As a developer, I want the memory model, journaling lifecycle, and
long-lived session behavior documented, so that operators configure it correctly
and contributors understand why the structured store is dormant.

**Acceptance criteria:**
- New `docs/MEMORY_MODEL.md` covering the layered model:
  - Files (agent-owned, freeform, auto-loaded, the source of truth) vs. the bus's
    orchestration role (assembly + journaling + telemetry, not content).
  - Why the structured `memories`/`session_summaries` store is dormant for the
    single-user/single-agent model, and when it would earn its keep again
    (multi-agent, programmatic/dashboard query, non-LLM consumers).
  - Cross-channel continuity via the shared `working_dir` (no DB recall needed).
- `docs/CC_HEADLESS_ADAPTER.md` updated with:
  - Long-lived sessions: idle does **not** tear down; resume keyed on
    `conversation_id`; auto-compaction (`autoCompactEnabled`) is the context-
    bounding mechanism (and the consequence of `DISABLE_AUTO_COMPACT=1`).
  - Context assembly: `MEMORY.md` + `journal_lookback_days` of daily files.
  - Journaling on pause: per-channel `threshold_ms`, the silent journaling turn,
    and the rule that journaling never messages the user.
  - The full `adapters.cc-headless.memory` + `.journaling` config block.
- `CHANGELOG.md` `[Unreleased]` updated (Added: journaling memory model, long-lived
  sessions, headless context assembly; Changed: idle threshold is now a journaling
  trigger, not session teardown; structured extraction off by default).
- `config.yaml.example` (if present) gains a commented `memory:` + `journaling:`
  block under `cc-headless`.

**Complexity:** S

---

## Notes

- **Terminology:** "journaling" is the standardized term across code, config, and
  docs (not "summarization" or "consolidation"). The repurposed `Summarizer`
  may keep its class name for now, but new methods/config use the journaling
  vocabulary; a later cleanup can rename the class.

- **Auto-compaction is the load-bearing assumption.** With session teardown gone,
  nothing in AgentBus bounds a long-lived `--resume` transcript — Claude Code's
  `autoCompactEnabled` (default on in `-p` mode) does. This was verified against
  the current CLI docs. If an operator sets `DISABLE_AUTO_COMPACT=1`, a
  never-idle Telegram session will eventually overflow; document this explicitly.

- **Cross-channel continuity is free, not built.** Because every channel's
  `claude -p` runs in the same `working_dir` and auto-loads the same files, a fact
  the agent journaled from a Telegram conversation is already in context for a
  later email turn. There is **no** "widen DB recall across channels" work — that
  approach was considered and dropped once files became the source of truth.

- **Journaling cadence is pause-triggered, not periodic.** A very long, never-idle
  conversation will not journal until it pauses. This is acceptable for the
  assistant use case; a future `max_journaling_interval_ms` safety valve (journal
  every N hours regardless of pause) is a possible extension, out of scope here.

- **Journaling turns add to the transcript.** The silent `--resume` turn appends an
  assistant turn to the session, so the next user turn sees both the prior
  conversation and the journaling exchange. Minor token cost; auto-compaction
  absorbs it.

- **Email is the motivating future case, not E20 scope.** Per-thread email sessions
  drop onto `conversation_id` (already handled by S20.2's resume change), and
  channel-aware formality (terse Telegram vs. complete email) is a system-prompt
  template concern enabled by the existing `channel` in `PromptContext`. Two small
  follow-ups belong to the email epic, not here:
  - **Identity:** associate an email address with a `contact_id` alongside Telegram
    in `config.contacts[*].platforms` (`platforms.email`) plus a `byEmailAddress`
    map and an `email` branch in `contact-resolve.ts`. Required so the same person
    resolves across channels and therefore shares one working-dir brain.
  - **Per-channel formality:** a template conditional on `ctx.channel`.

- **MCP adapter (`cc.ts`) is untouched.** E20 changes only the headless path and
  bus-side session/journaling behavior. The `structured_extraction` flag preserves
  legacy summarizer behavior for any MCP deployment that still wants it.

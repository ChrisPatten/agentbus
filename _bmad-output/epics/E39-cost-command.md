# E39 — `/cost` Command (Per-Agent API Cost Tracking)

| Field | Value |
|---|---|
| Epic ID | E39 |
| Dependencies | E23 (multi-instance cc-headless, for `agent_id`), E30 (S30.4 delivery/session-id persistence pattern this reuses) |
| Story Count | 5 |
| Complexity | M |

## Epic Summary

Chris asked for a `/cost` slash command that returns his day/week/month API spend "for the agent it's called for." No cost or usage tracking exists in AgentBus today — the data is computed by every `claude -p` turn already, but is discarded. This epic captures it durably and exposes it via a new bus-scope command.

**Root cause / where the data already lives**: `HeadlessInstance.invokeClaude()` (`src/adapters/cc-headless.ts:266`) spawns `claude -p --output-format stream-json --verbose --resume <id>` and parses each JSONL line via an inline `event` type that declares only `{type, session_id, result, is_error, subtype, message}` (`~line 341`). Real `claude -p` `result` events also carry `total_cost_usd`, `usage`, and `num_turns` — confirmed against a live transcript under `~/.claude/projects/-Users-chrispatten-workspace-agentbus/*.jsonl`, which contains e.g. `"total_cost_usd":0.0522612,"usage":{...},"num_turns":1`. The event type simply never declared those fields, so they're parsed and dropped on the floor every single turn.

**Where "the agent it's called for" comes from**: `sessions.agent_id` (migration 011) ties a session to a specific cc-headless instance. `/stop` (`src/commands/handlers.ts:395-421`) already has the exact resolution pattern needed: look up the sender's active session on this channel, take its `agent_id`, and if it's `NULL` (a pre-migration-011 session) fall back to the sole registered instance when there's only one. `/cost` should resolve its target agent the same way, via the same query shape, so it stays correct once multiple named cc-headless instances exist (E23) rather than hardcoding today's single-Peggy reality.

**Not the right source**: Anthropic's org-level Admin/Usage API reports at the API-key/org granularity, not per local session or agent — it can't answer "how much has *this* agent cost *this contact*." The per-turn `total_cost_usd` Claude Code already computes locally, keyed by `agent_id`, is the correct granularity for what Chris asked.

## Entry Criteria

- `sessions.agent_id` populated by cc-headless turns (already true since E11/migration 011).
- Confirmed via `ls src/db/migrations/`: next free migration number is **014** (013 was claimed by E40's `scheduled_items_stale_after_ms` on Sep 1 — the original research note assumed 013 was free; it no longer is).

## Exit Criteria

1. Every `claude -p` turn's cost/token/turn-count data is persisted to a new `turn_costs` table, keyed by `agent_id`.
2. `/cost` (bus-scope command) resolves the calling sender's agent the same way `/stop` does, sums day (since local midnight)/week (rolling 7 days)/calendar-month-to-date cost from `turn_costs`, and replies with a compact three-line summary.
3. A one-time backfill path exists for historical cost already sitting in `~/.claude/projects/*/*.jsonl` before this epic shipped, so day-1 numbers aren't all zero.
4. Tests cover: cost persistence on a successful turn, correct agent resolution (explicit `agent_id` vs. NULL-fallback, matching `/stop`'s existing test coverage shape), and `/cost`'s day/week/month arithmetic across a local-midnight boundary.
5. Docs (`docs/SLASH_COMMANDS.md`) + `CHANGELOG.md` updated.
6. Full suite green, `tsc --noEmit` clean.

## Stories

### S39.1 — Migration: `turn_costs` table
New migration `014_turn_costs.sql`: `turn_costs(id INTEGER PRIMARY KEY, agent_id TEXT, session_id TEXT, ts TEXT NOT NULL, cost_usd REAL NOT NULL, input_tokens INTEGER, output_tokens INTEGER, num_turns INTEGER)`, indexed on `(agent_id, ts)` for the day/week/month range scans `/cost` will run. `agent_id`/`session_id` nullable (mirrors `sessions.agent_id`'s own nullability for pre-migration rows) — a turn that can't be attributed to a specific agent still gets its cost recorded, just unattributed, rather than silently dropped.

### S39.2 — Capture cost/usage on the `result` event
Widen the inline `event` type in `invokeClaude()` (`cc-headless.ts:~341`) to include `total_cost_usd?: number`, `usage?: { input_tokens?: number; output_tokens?: number }`, `num_turns?: number` on the `result` branch. Thread these three values through `SpawnResult` (currently `{ claudeSessionId, resultText, deliveredViaTool, error, stoppedByUser }`) the same way `resultText`/`claudeSessionId` already flow from the `close` handler's `resolvePromise(...)` calls — capture on every resolution path (success, error, stopped), since a `result` event with `is_error: true` still typically carries partial cost data for the tokens actually spent.

### S39.3 — Persist to `turn_costs` in `runClaudeTurn`
In `runClaudeTurn()` (`cc-headless.ts:507`), after `invokeClaude()` resolves, write a `turn_costs` row via a new `recordTurnCost(db, { agentId: this.agentId, sessionId: opts.session?.id ?? null, costUsd, inputTokens, outputTokens, numTurns })` helper — same shape/placement as the existing `persistSessionId` helper right above it in the same function. Skip the insert entirely if `total_cost_usd` was never present on the result event (defensive — don't write a fabricated `0`).

### S39.4 — `/cost` command
New bus-scope command (`src/commands/cost.ts`, following the `torrent.ts` extraction pattern so it's unit-testable without `index.ts`'s startup side effects): resolves the calling agent via the exact `/stop`-style query (`SELECT agent_id FROM sessions WHERE contact_id=? AND channel=? AND ended_at IS NULL ORDER BY last_activity DESC LIMIT 1`, falling back to the sole registered instance on `NULL`/ambiguous), then three `SUM(cost_usd)` queries against `turn_costs` for: today (local midnight to now), this week (rolling 7 days), this calendar month (1st of month to now). Reply format:
```
Today: $X.XX
This week: $X.XX
This month: $X.XX
```
Registered in `index.ts` alongside `/torrent`/`/stop`.

### S39.5 — Backfill from existing `.jsonl` transcripts + tests/docs
One-time backfill script (`scripts/backfill_turn_costs.ts` or a `--backfill` flag on migration apply — implementer's call) that scans `~/.claude/projects/<encoded-working-dir>/*.jsonl` for each configured cc-headless instance's `working_dir`, extracts every `result` event's `total_cost_usd`/`usage`/`num_turns` plus its timestamp, and inserts rows into `turn_costs` — giving real historical numbers instead of a cold start at zero. Idempotency: skip a `.jsonl` line already represented (e.g. by `session_id` + timestamp uniqueness, or simplest: make the backfill a one-shot manual operator step, not something that runs automatically on every startup). Tests: S39.2/S39.3's persistence path (successful turn → row written with correct values; error turn with partial cost → still recorded; no cost data on the event → no row), S39.4's agent-resolution + day/week/month arithmetic (including a local-midnight-boundary case). `docs/SLASH_COMMANDS.md` + `CHANGELOG.md`.

## Notes

- Migration number corrected from the original research note (`013_turn_costs.sql`) to **014** — `013` was claimed by E40's `scheduled_items_stale_after_ms` migration on Sep 1, after the research for this epic was done but before this epic was written up. Always re-check `ls src/db/migrations/` immediately before writing a migration file, not just at research time — this is the second time in two days a migration number shifted between research and write-up.
- Deliberately scoped to local per-turn cost data rather than Anthropic's Admin/Usage API — see Epic Summary for why the API's granularity (org/key-level) doesn't answer "cost for the agent it's called for."
- `turn_costs.agent_id`/`session_id` nullable by design (S39.1) rather than requiring backfill or defaulting — mirrors how `sessions.agent_id` itself handles pre-migration-011 rows, so the same NULL-fallback resolution logic already proven in `/stop` and `/clear` applies here unchanged.
- No epic-level decision was made on whether `/cost` should support an optional target-agent argument (e.g. `/cost peggy` to check a different agent than the one it's called through) — out of scope for now, since Chris's ask was specifically "for the agent it's called for." Worth a follow-up if a second named agent ever goes live (E23 S23.5).

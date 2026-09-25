# E53 — Pool Model Selection (per-job models for cc-pool)

| Field | Value |
|---|---|
| Epic ID | E53 |
| Dependencies | E48 (cc-pool: `PoolManager.resolveRoute`, `PaneLauncher`, `pool_leases`), E52 (migration 020, `last_turn_ended_at`), migration 015 (`headless_model_overrides`), E14-era scheduler (`scheduled_items`) |
| Story Count | 6 |
| Estimated Complexity | M |
| Status | In progress — decisions recorded |

---

## Epic Summary

A `cc-pool` pane runs whatever model its launch line names, and today that is
one value per pool: `adapters.cc-pool.<name>.model`. When it is unset, the CLI
falls back to `~/.claude/settings.json`, which any interactive `/model` in any
Claude session rewrites. So the model behind Peggy's conversations can change
because of something typed in an unrelated terminal.

The operator wants explicit control per kind of work: Peggy's conversations on
Sonnet, cheap scheduled jobs such as Email Watch on Haiku, with no dependence on
CLI state.

E53 resolves a model for every pane launch from, in order: the scheduled
job's own `model`, an agent-scoped override, a global override, then the
pool's `model`. A job's model lives on the schedule itself, so listing
schedules shows it and it is created and deleted with the job. Agent-wide and
global overrides stay in the override store `cc-headless` already has, so both
adapters share it. E53 also gives scheduled jobs their own conversations,
because a model is fixed per Claude session and all of Peggy's schedules share
one session today.

**Stopgap already applied (2026-09-25):** `model: sonnet` is set on
`peggy-pool` and `pokeclaude-pool` in the operator's config. `--model` is passed
on every launch and `--resume`, and it outranks `settings.json`. Running
panes pick it up on their next launch.

---

## Prior Art: What Already Exists (and Where)

- `src/pool/pane.ts` `buildLaunchLine()` — adds `--model this.cfg.model` when
  set. `LaunchParams` has no model field; the model is pool-wide.
- `src/pool/pool-manager.ts` `resolveRoute(conversationId, promptContext)` —
  the single place a pane is launched or resumed for a conversation. The
  `reuse` branch returns immediately with no launch, so a model change never
  reaches an already-leased pane.
- `src/pipeline/stages/pool-route-resolve.ts` — calls `resolveRoute` with
  contact, channel, and topic only; no envelope metadata reaches the pool.
  `src/scheduler/scheduler.ts` `fireItem()` already stamps
  `metadata.schedule_id`, the hook for stamping the job's model.
- `src/adapters/model-override-loader.ts` — `resolveModelOverride(db,
  scheduleId, agentId)` over `headless_model_overrides` (migration 015):
  schedule+agent, then agent, then schedule, then global. Used only by
  `cc-headless` (`src/adapters/cc-headless.ts:345`).
- Overrides are managed via `POST/GET/DELETE /api/v1/model-overrides` and the
  `set_headless_model`, `get_headless_model`, `list_headless_model`, and
  `delete_headless_model` MCP tools (`src/mcp/tools/model-overrides.ts`).
- Known defects in that store, from `_bmad-output/maintenance-backlog.md`,
  which this epic absorbs:
  - **P0** — `POST /api/v1/model-overrides` always returns 500 (the
    `ON CONFLICT` target doesn't match the partial unique index). No override
    can be written through the API or tools today.
  - **P1** — schedule-scoped overrides never apply: `cc-headless` passes
    `scheduleId: undefined`.
  - Global overrides accumulate and can't be deleted one at a
    time.
- Conversation identity is `computeConversationId(contact, channel, topic)`
  (`src/pipeline/stages/route-resolve.ts`). All five of Peggy's active
  schedules (Memory Review, Morning Brief, Email Watch, Weekly work-log setup,
  one one-shot) fire as `system:peggy` / `system:scheduler` / topic `general`,
  so they share one conversation, one pane, and one Claude session.
- `PATCH /api/v1/schedules/:id` updates only label, `max_fires`, and status.
  An existing schedule's topic can't be changed without recreating it.

---

## Entry Criteria

- E52's migration 020 merged (E53 adds migrations 021–023; 023 alters `pool_leases`).

## Exit Criteria

- With `model: haiku` on the Email Watch schedule, an Email Watch fire launches or resumes its pane with
  `--model haiku`, while a Telegram message to Peggy on the same pool launches
  with the pool's `model`.
- Changing a job's model or an override takes effect on the next message for that
  conversation, including when its pane is already leased (see S53.5), with no
  bus-core restart.
- No pane launch depends on `~/.claude/settings.json` for its model when the
  pool sets `model`. bus-core logs a startup warning for a pool without one.
- `POST /api/v1/model-overrides` writes succeed for agent and global
  overrides, covered by an HTTP-level test.
- `cc-headless` honors a schedule's `model` too.
- Schedules can be created and patched with `model` and `topic`, and list
  output shows both.
- `/pool` and `GET /api/v1/pool` show each leased pane's model.

## Non-Goals

- Choosing a model per message inside one conversation. The model is fixed
  per Claude session; switching means a relaunch.
- Automatic model routing (classifying a message as "cheap" or "hard").
- Model control for the single persistent `claude-code` session.
- Using `/model` inside a pane to switch. It persists the choice to the
  user's `settings.json`, which is the leak this epic removes.

---

## Resolution Model

On every `bound`, `grow`, or `evict` launch, and on every `reuse` (to detect a
mismatch, S53.5), the adapter resolves:

1. The scheduled job's `model`, carried on the envelope as
   `metadata.schedule_model` (stamped by the scheduler at fire time).
2. Override matching `agent:<pool agent_id>`.
3. Global override.
4. `adapters.cc-pool.<name>.model` (or `adapters.cc-headless.model`).
5. Nothing: no `--model`, CLI default, with the startup warning.

The agent key is the pool's logical prefixed id (`agent:peggy`), not a pane
id, since pane ids are assigned per lease. This matches what `cc-headless`
already uses.

The resolved model is stored on the lease (`pool_leases.model`) so the reuse
path can compare without re-deriving what the pane was launched with.

### Interfaces (fixed so stories can proceed in parallel)

- `resolveModelOverride(db, agentId: string | null): string | null` in
  `src/adapters/model-override-loader.ts` — agent row, then global row. The
  `scheduleId` parameter is removed.
- `resolveModel(opts: { scheduleModel?: string | null; db?; agentId?;
  configModel?: string }): { model: string | undefined; source:
  'schedule' | 'agent-override' | 'global-override' | 'config' | 'cli-default' }`
  — new, same module. Both adapters call it.
- The scheduler stamps `metadata.schedule_model: string` on a fired envelope
  only when the schedule has a non-null `model`.

## Data Model

Migration `021_model_overrides.sql` (S53.1): replace `headless_model_overrides`
with `model_overrides`:

```sql
CREATE TABLE model_overrides (
  id          INTEGER PRIMARY KEY,
  agent_id    TEXT,               -- NULL = global
  model       TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_model_overrides_agent ON model_overrides (COALESCE(agent_id, ''));
```

Copy agent-only and global rows from the old table (newest wins per key),
then drop it. Schedule-scoped rows are dropped with a count logged; none exist
in the operator's database today. `priority` goes: one row per key makes it
meaningless.

Migration `022_scheduled_items_model.sql` (S53.3):

```sql
ALTER TABLE scheduled_items ADD COLUMN model TEXT;  -- NULL = no job-level model
```

Migration `023_pool_leases_model.sql` (S53.4):

```sql
ALTER TABLE pool_leases ADD COLUMN model TEXT;  -- model the current session was launched with; NULL = CLI default
```

---

## Stories

### S53.1 — Repair and generalize the override store

- Migration 021 as above; `model-override-loader.ts` gains the new
  `resolveModelOverride` signature and `resolveModel`; update
  `src/http/api.ts` routes.
- Fix the P0: `POST` upserts on the new index (agent or global). Add
  HTTP-level tests for agent and global writes, and delete of each.
- `DELETE` accepts `agent_id` or `scope=global`.
- Add adapter-neutral MCP tools `set_model_override`, `get_model_override`,
  `list_model_overrides`, `delete_model_override`. Keep the
  `*_headless_model` names as deprecated aliases for one minor release; they
  reject a `schedule_id` with a message pointing to the schedule's `model`.
- Remove the absorbed items from `maintenance-backlog.md`.

### S53.2 — Carry the schedule's model to the adapters

- `pool-route-resolve` passes `envelope.metadata.schedule_model` (if a
  non-empty string) into `resolveRoute`.
- `cc-headless` reads it from the first envelope of a batch and resolves via
  `resolveModel` (replaces the `scheduleId: undefined` TODO).

### S53.3 — Scheduled jobs: own conversation and own model

- Migration 022. `POST /api/v1/schedules` and the scheduling MCP tools accept
  `model`; `PATCH /api/v1/schedules/:id` accepts `topic` and `model` (`null`
  clears the model). List and get output include both.
- `fireItem()` stamps `metadata.schedule_model` when set.
- New recurring (`cron`) schedules created without an explicit topic default
  to `sched:<label-slug>` (D1), falling back to `sched:<id8>` with no label.
  One-shots keep `general`.
- `/schedules`-style displays (if any) show the model.

### S53.4 — Per-launch model resolution in the pool

- `LaunchParams.model?: string`; `buildLaunchLine()` uses it instead of
  `cfg.model`.
- `resolveRoute` resolves per the model above, passes it to `launch()`, and
  writes `pool_leases.model` (migration 023) in the same step as
  `confirmReady()`.
- Log the resolved model and its source (override scope or pool config) on
  each launch.
- Startup warning when a pool has no `model`.

### S53.5 — Model change on a leased pane

On `reuse`, if the resolved model differs from `pool_leases.model`:

- If the pane is between turns (`last_turn_ended_at` is later than the last
  delivered message), relaunch in place: `Ctrl-C`, then `--resume <session>`
  with the new `--model`, reusing the E48 launch path and its cold-start
  notice.
- If a turn is in flight, deliver on the current model and switch on the next
  message. Never interrupt a running turn to change the model.

### S53.6 — Observability and docs

- `/pool` and `GET /api/v1/pool` show each pane's model.
- `docs/CC_POOL_ADAPTER.md`: a Model selection section with the resolution
  order and the `settings.json` caveat.
- `docs/CC_HEADLESS_ADAPTER.md`, `docs/MCP_TOOLS.md`, `docs/HTTP_API.md`,
  `docs/SCHEDULING.md` updated for the renamed store, new tools, and schedule
  topics.
- `CHANGELOG.md` `[Unreleased]`: Added per-job pool models; Fixed override
  POST; Changed tool names (deprecated aliases).

---

## Decisions

- **D1 — Default topic for new schedules. Decided 2026-09-25: isolate.** A
  new recurring schedule created without an explicit topic defaults to
  `sched:<label-slug>`. One-shot reminders stay `general`. Existing schedules
  are moved by hand with S53.3's `PATCH`. Cost: more concurrent panes at busy
  fire times; `max_panes: 8` covers today's five schedules.
- **D2 — Mismatch on reuse. Decided 2026-09-25: apply at once.** Relaunch
  between turns, as in S53.5. Not chosen: waiting for the next natural launch,
  which could delay an override by up to `hard_idle_ms` (6 h).
- **D3 — Where a job's model lives. Decided 2026-09-25: on the schedule.**
  A `model` field on `scheduled_items`; the override store keeps only agent
  and global rows. Not chosen: schedule-scoped rows in the override store,
  which would hide the model from schedule listings and orphaned it when a job was
  recreated with a new id.

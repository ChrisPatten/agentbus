# E23 — Multi-Instance `cc-headless` Adapter

| Field | Value |
|---|---|
| Epic ID | E23 |
| Dependencies | E19 (headless adapter), E19.1 (reply delivery), E20 (journaling & long-lived sessions) |
| Story Count | 6 |
| Estimated Complexity | M |

---

## Epic Summary

`adapters.cc-headless` is currently a single top-level object: one `agent_id`,
one poll loop, one set of module-level globals in `src/adapters/cc-headless.ts`
(`AGENT_ID`, `WORKING_DIR`, `CLAUDE_MODEL`, etc.), started once from
`src/index.ts:227`. A single bus-core process can therefore run exactly one
headless agent — `peggy`. Any other agent (today, `pokeclaude`) must run on the
older `claude-code` adapter, which drives a persistent tmux/MCP session instead
of per-request `claude -p` invocations.

`adapters.telegram` and `adapters.email` already solved this shape: each
accepts either a single-instance object (legacy form) or a named record
(`{ peggy: {...}, jarvis: {...} }`), normalized by a `getXInstances(config)`
helper (`getTelegramInstances`, `getEmailInstances` in `src/config/schema.ts`)
into a flat list, with one adapter instance constructed per entry. E23 applies
the same pattern to `cc-headless` so multiple agents (`peggy`, `pokeclaude`,
and future agents) can run headless side by side in one process, each with its
own `agent_id`, `working_dir`, `system_prompt`, `memory`, and `journaling`
config — and so `pokeclaude` can retire the tmux-based `claude-code` path.

Two things beyond "just make the config a record" make this more than a
find-and-replace:

1. **Module-level singleton state.** `cc-headless.ts` holds `AGENT_ID`,
   `POLL_INTERVAL_MS`, `CLAUDE_BIN`, `CLAUDE_MODEL`, `ERROR_PASSTHROUGH`,
   `WORKING_DIR`, `busBaseUrl`, the per-contact `queues` map, `pollTimer`, and
   `shuttingDown` as module-level `let`s set once in `startHeadless()`. Two
   concurrent instances would clobber each other's globals. This needs to
   become per-instance state (factory or class), not a rearchitecture of the
   poll/spawn logic itself — the poll fetch is already agent-scoped
   (`/api/v1/messages/pending?agent=${headlessCfg.agent_id}`), so N
   independent poll loops each fetching their own agent's queue works
   unchanged once the state is instance-local.

2. **Journaling dispatch is agent-blind.** `SessionTracker.dispatchJournaling()`
   (`src/memory/session-tracker.ts:121`) selects candidate sessions purely by
   `claude_session_id IS NOT NULL` and fires a single injected
   `journalingRunner` using a single global `journaling.threshold_ms`/`enabled`
   read from `config.adapters['cc-headless']`. With two headless agents, a
   session must be routed to *its own* agent's runner and *its own*
   `journaling` config — which requires knowing which agent owns a given
   session. The `sessions` table has no such column today (only `channel`,
   `contact_id`, `conversation_id`). Same problem hits `/clear`
   (`src/commands/handlers.ts:597`), which calls a single global
   `headlessControl.journalResumeId`.

---

## Entry Criteria

- E19/E19.1 complete: `cc-headless.ts` spawns `claude -p` per batch with
  `working_dir`, `--resume`, `--system-prompt-file`, `--mcp-config`, and the
  agent owns delivery via `reply`/`send_message`.
- E20 complete: sessions are long-lived (idle never tears them down),
  `SessionTracker.dispatchJournaling()` fires silent journaling turns via an
  injected `JournalingRunner`.
- `getTelegramInstances`/`getEmailInstances` exist in `src/config/schema.ts` as
  the reference pattern for keyed multi-instance adapter config.

---

## Exit Criteria

- `config.adapters.cc-headless` accepts either the legacy single-object form
  (unchanged behavior, one instance) or a named record
  (`{ peggy: {...}, pokeclaude: {...} }`), validated the same way
  `telegram`/`email` are.
- A bus-core process configured with two `cc-headless` entries runs two
  independent poll loops, each spawning `claude -p` against its own
  `agent_id`/`working_dir`/`system_prompt`, with no shared mutable state
  between them.
- A session opened by one headless agent is journaled on pause using *that
  agent's* `journaling.threshold_ms`/`enabled` and *that agent's*
  `runJournalingTurn` — never the other agent's.
- `/clear` journals the correct agent's session when multiple headless agents
  are configured.
- `pokeclaude` runs on `cc-headless` (its own `working_dir`/`CLAUDE.md`/memory
  files), and its `pipeline.routes` entry and `telegram:pokeclaude → claude-code`
  tmux path are retired.
- The legacy single-object `cc-headless` config (e.g. `peggy`-only, as
  configured today) continues to work with no config changes required —
  existing single-agent deployments are unaffected.
- No regression to the MCP adapter (`cc.ts`)/`claude-code` path, which remains
  available for any agent not migrated to headless.

---

## Config Shape

```yaml
adapters:
  cc-headless:
    peggy:
      agent_id: peggy
      poll_interval_ms: 1000
      claude_bin: /Users/chrispatten/.local/bin/claude
      model: claude-sonnet-5
      working_dir: /Users/chrispatten/workspace/peggy-claude-code
      system_prompt: |
        You are Peggy, on {{channel}} for {{contact_id}}. ...
      memory: { dir: memory, index_file: MEMORY.md, daily_subdir: daily, journal_lookback_days: 3 }
      journaling: { enabled: true, threshold_ms: { telegram: 1800000, default: 3600000 } }
    pokeclaude:
      agent_id: pokeclaude
      poll_interval_ms: 1000
      claude_bin: /Users/chrispatten/.local/bin/claude
      model: claude-sonnet-5
      working_dir: /Users/chrispatten/workspace/pokeclaude-claude-code
      system_prompt: |
        You are pokeclaude, on {{channel}} for {{contact_id}}. ...
      memory: { dir: memory, index_file: MEMORY.md, daily_subdir: daily, journal_lookback_days: 3 }
      journaling: { enabled: true, threshold_ms: { telegram: 1800000, default: 3600000 } }
```

The legacy single-object form (today's `config.yaml`, `adapters.cc-headless:
{ agent_id: peggy, ... }` with no named key) keeps working unchanged — same
discrimination pattern as `getTelegramInstances`/`getEmailInstances`
(single-object form has the instance's own required fields at the top level;
named-record form does not).

`pipeline.routes` then targets `pokeclaude` the same way `peggy` already is:

```yaml
  - match: { channel: telegram:pokeclaude }
    target: { adapterId: cc-headless, recipientId: agent:pokeclaude }
```

---

## Stories

### S23.1 — Config Schema: Keyed `cc-headless` Instances

**User story:** As an operator, I want to declare more than one `cc-headless`
agent in `config.yaml`, so that each Telegram/email persona can run headless
without needing a second bus-core process.

**Acceptance criteria:**
- `AdaptersConfigSchema['cc-headless']` becomes
  `z.union([CcHeadlessAdapterSchema, z.record(z.string(), CcHeadlessAdapterSchema)]).optional()`
  (`src/config/schema.ts:218`), mirroring the `telegram`/`email` shape at
  lines 214–215.
- A new `CcHeadlessInstanceConfig extends CcHeadlessAdapterConfig { name: string | null }`
  type, mirroring `TelegramInstanceConfig`/`EmailInstanceConfig`.
- A new `getCcHeadlessInstances(config: AppConfig): CcHeadlessInstanceConfig[]`
  in `src/config/schema.ts`, mirroring `getTelegramInstances` (line 482):
  - Single-object form (discriminated by `system_prompt` being a string at the
    top level, the one required field) → one instance, `name: null`.
  - Named-record form → one instance per key, validated against the same
    `VALID_INSTANCE_NAME_RE` (`/^[a-z0-9_-]+$/`) used by
    `getTelegramInstances`.
  - Duplicate `agent_id` across named instances throws (mirrors the
    duplicate-token check) — `agent_id` is the key the poll fetch and
    journaling routing both scope on, so it must be unique.
- Unit tests in `src/config/schema.test.ts` mirroring the existing
  `getTelegramInstances` block: no config → `[]`; single-object form → one
  instance (`name: null`); named record → N instances; duplicate `agent_id` →
  throws; invalid instance name → throws.

**Complexity:** S

---

### S23.2 — Refactor `cc-headless.ts`: Per-Instance State Instead of Module Singleton

**User story:** As the bus, I want to run more than one headless agent
concurrently in one process without their internal state colliding, so that a
slow or failing agent never corrupts another agent's poll loop.

**Acceptance criteria:**
- The module-level `let`s in `src/adapters/cc-headless.ts` (`AGENT_ID`,
  `POLL_INTERVAL_MS`, `CLAUDE_BIN`, `CLAUDE_MODEL`, `ERROR_PASSTHROUGH`,
  `WORKING_DIR`, `busBaseUrl`, `pollTimer`, `shuttingDown`) and the per-contact
  `queues` map are moved into per-instance state (a factory function or a
  small class), so each `CcHeadlessInstanceConfig` gets its own isolated copy.
- `queues` isolation is per-instance: a slow batch for contact `chris` on
  `pokeclaude` never delays a batch for contact `chris` on `peggy` (today they
  would share one `Map<contactId, Promise>` if naively made concurrent).
- `startHeadless(db)` is replaced by (or wraps) a function that iterates
  `getCcHeadlessInstances(config)` and starts one instance per entry, returning
  a `Map<string, HeadlessHandle>` keyed by `agent:<agent_id>` instead of a
  single `HeadlessHandle | null`.
- `stopHeadless()` stops every running instance.
- The poll fetch URL, spawn args, `--resume` logic, memory-context assembly,
  and delivery/error-reply behavior are otherwise **unchanged** per instance —
  this story is a state-isolation refactor, not a behavior change.
- Unit tests: two instances with distinct `agent_id`s each poll their own
  `/api/v1/messages/pending?agent=...` URL independently (mocked fetch,
  asserted call count/args per instance); stopping one instance's poll timer
  does not clear the other's; per-instance `queues` map isolation (a pending
  promise for contact X on instance A is untouched by instance B's queue for
  the same contact X).

**Complexity:** M

---

### S23.3 — Route Journaling and `/clear` to the Owning Instance

**User story:** As the bus, I want a paused conversation to journal using the
agent that actually handled it, so that a two-agent deployment never journals
peggy's conversation with pokeclaude's runner (or vice versa) or uses the wrong
agent's journaling threshold.

**Acceptance criteria:**
- New migration `011_session_agent_id.sql`: `ALTER TABLE sessions ADD COLUMN
  agent_id TEXT` (nullable — only headless sessions get one).
- `transcript-log.ts` (Stage 80) sets `agent_id` at session-creation time: when
  the resolved route target for the batch has `adapterId === 'cc-headless'`,
  store `target.recipientId` (e.g. `agent:pokeclaude`); otherwise leave it
  `NULL`.
- `SessionTracker.setJournalingRunner(runner)` becomes
  `registerJournalingRunner(agentId: string, runner: JournalingRunner)`,
  backed by a `Map<string, JournalingRunner>` instead of the single
  `journalingRunner` field (`src/memory/session-tracker.ts:41,56`).
- `dispatchJournaling()` (`session-tracker.ts:121`) resolves each candidate
  session's `journaling.enabled`/`threshold_ms` from *that session's*
  `agent_id` (looked up via `getCcHeadlessInstances(config)`, matched on
  `agent_id`), and dispatches to the runner registered under that same
  `agent_id`. A session whose `agent_id` has no matching configured instance
  (agent removed/renamed since the session started) is skipped, not thrown.
- `headlessControl.journalResumeId` (`src/commands/handlers.ts:597`,
  `src/index.ts:232`) becomes agent-routed the same way: `/clear`'s handler
  reads the closed session's `agent_id` and dispatches to that instance's
  `journalResumeId`, not a single global function.
- Unit tests: two registered instances with different `threshold_ms` — a
  session with `agent_id = 'agent:peggy'` journals on peggy's schedule via
  peggy's runner; a session with `agent_id = 'agent:pokeclaude'` journals on
  pokeclaude's; an orphaned `agent_id` is skipped without throwing; `/clear`
  on a pokeclaude session invokes pokeclaude's `journalResumeId`, not peggy's.

**Complexity:** M

---

### S23.4 — `index.ts` Wiring for N Instances

**User story:** As an operator, I want starting bus-core to bring up every
configured `cc-headless` instance automatically, so that adding a second agent
is a config change, not a code change.

**Acceptance criteria:**
- `src/index.ts:225-234`'s single `if (config.adapters['cc-headless'])` block
  is replaced with a loop over the `Map` returned by S23.2's start function:
  for each started instance, call `sessionTracker.registerJournalingRunner`
  (S23.3) and populate the per-agent `journalResumeId` lookup used by
  `headlessControl`.
- `shutdown()` (`index.ts:200`) stops all started instances, not just one.
- The legacy single-object config form still results in exactly one instance
  starting, with identical log output/behavior to today (no regression for the
  current `peggy`-only deployment).
- Smoke test (or integration test with a fake `claude` binary) confirms two
  named `cc-headless` entries produce two independent running pollers, and a
  single-object entry produces exactly one.

**Complexity:** S

---

### S23.5 — Config Migration: `peggy` + `pokeclaude` on Headless

**User story:** As the operator, I want `pokeclaude` to run on the same
headless model as `peggy`, so I no longer need to keep its tmux pane
(`claude_pokeclaudebot`) alive for it to respond.

**Acceptance criteria:**
- `config.yaml`'s `adapters.cc-headless` becomes a named record: `peggy` keeps
  its current settings under that key; `pokeclaude` is added with its own
  `agent_id: pokeclaude`, its own `working_dir` (a project directory with its
  own `CLAUDE.md` and `memory/` — provisioned analogous to
  `peggy-claude-code`), and its own `system_prompt`.
- `pipeline.routes`' `telegram:pokeclaude` rule
  (`config.yaml:122-126`) changes from `{ adapterId: claude-code, recipientId:
  agent:pokeclaude }` to `{ adapterId: cc-headless, recipientId:
  agent:pokeclaude }`.
- `memory.on_session_close['telegram:pokeclaude']` (the tmux `/compact`
  keystroke send, `config.yaml:85`) is removed — long-lived headless sessions
  don't use `on_session_close` teardown.
- `memory.memory_inject_exclude`'s `telegram:pokeclaude` entry
  (`config.yaml:88`) is reassessed: headless agents already skip Stage 85
  DB memory-inject implicitly (they assemble context from their own memory
  files instead), so this entry becomes redundant and can be dropped once
  pokeclaude is fully off `claude-code`.
- The `claude_pokeclaudebot` tmux session is retired once the cutover is
  verified end-to-end (a Telegram message to pokeclaude gets a `claude -p`
  reply, and its memory files update via a journaling turn on pause).
- `peggy`'s behavior is unaffected by the migration (regression check).

**Complexity:** S (config + verification, no new code beyond S23.1–S23.4)

---

### S23.6 — Docs

**User story:** As a developer, I want the multi-instance config shape and
routing rules documented, so operators can add a third headless agent without
re-deriving the pattern from source.

**Acceptance criteria:**
- `docs/CC_HEADLESS_ADAPTER.md` updated with: the named-record config shape
  (mirroring how `TELEGRAM_ADAPTER.md`/`EMAIL_ADAPTER.md` document their
  multi-instance forms), the backward-compatible single-object form, and how
  journaling/`​/clear` route to the owning agent via `sessions.agent_id`.
- `config.yaml.example` gains a commented named-record example under
  `cc-headless` (peggy + a second named agent).
- `CHANGELOG.md` `[Unreleased]`: Added — multi-instance `cc-headless` adapter
  (run multiple headless agents in one bus-core process).
- A short note that `claude-code` (tmux/MCP) remains available for any agent
  not yet migrated to headless, and becomes fully optional once every
  configured agent runs headless (full retirement of the `claude-code` adapter
  is out of scope for this epic).

**Complexity:** S

---

## Notes

- **Backward compatibility is load-bearing.** The existing `peggy`-only
  `config.yaml` (single-object `cc-headless`) must keep working with zero
  config changes — S23.1/S23.2/S23.4's tests are the regression guard.

- **Per-instance `working_dir` already isolates agent memory.** Because each
  headless instance points at its own project directory, `peggy` and
  `pokeclaude` never share `MEMORY.md`/journal files even though they can run
  concurrently in the same process — no additional isolation work needed
  beyond the `queues` map fix in S23.2.

- **Pattern precedent.** `getTelegramInstances`/`getEmailInstances`
  (`src/config/schema.ts:482,536`) are the direct precedent for
  `getCcHeadlessInstances` — same discrimination approach (single-object vs.
  named-record), same instance-name validation regex, same "id suffix `null`
  for the legacy form" convention. Follow them for consistency rather than
  inventing a new shape.

- **Out of scope.** Fully retiring the `claude-code` tmux/MCP adapter is not
  part of this epic — it stays available for any agent that hasn't migrated.
  Once `pokeclaude` (S23.5) is the last non-`peggy` agent to move, a future
  cleanup can consider dropping `claude-code` entirely if nothing still
  targets it.

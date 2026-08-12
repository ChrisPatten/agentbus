# E24 — Sub-Agent Spawning

| Field | Value |
|---|---|
| Epic ID | E24 |
| Dependencies | E7 (MCP tools registration pattern), E13 (proactive channel notification), E19/E19.1 (headless `claude -p` spawn mechanics, reply delivery), E20 (memory injection, long-lived sessions), E23 (multi-instance `cc-headless`, per-agent `agent_id` concept) |
| Story Count | 8 |
| Estimated Complexity | L |

---

## Epic Summary

Today an agent's only unit of work is its own turn: one inbound message (or
journaling tick) in, one `claude -p` invocation, one reply out. There's no way
for an agent to delegate a bounded sub-task to another Claude instance and
keep going — everything happens serially, in one process, in one context
window.

E24 adds a `spawn_subagent` MCP tool (plus `get_subagent_status`,
`await_subagent`, `cancel_subagent`, `list_subagents`) that lets any agent
spawn an independent `claude -p` worker, do other things while it runs, and
find out when it's done — either synchronously within the same turn
(`await_subagent`) or via a message delivered to a later turn, the same way a
real inbound message arrives. AgentBus owns the spawned process end-to-end:
lifecycle, concurrency/timeout/cost limits, nesting depth, and cleanup on
shutdown.

Two modes are supported, both landed on after evaluating and dropping a third
(see Notes): **`same_instance`** — a fresh session with the calling agent's
own identity, template, and memory injection, for parallelizing the agent's
own work; and **`fresh_directory`** — a new session in a different,
allowlisted directory, for delegating to a differently-configured agent or
context. Every limit (concurrency, timeout, cost, model choice) resolves
through a consistent global-default + per-agent-override scheme where the
**more restrictive of the two always wins** — a per-agent override can narrow
a global default, never loosen it.

This epic is deliberately scoped to the spawning/lifecycle/completion
machinery. It reuses the existing `claude -p` spawn path (`cc-headless.ts`)
rather than inventing a new one, and reuses the existing message-queue and
notification primitives for completion delivery rather than building a new
side channel.

---

## Entry Criteria

- E19/E19.1 complete: `cc-headless.ts` spawns `claude -p` per batch with
  `working_dir`, `--resume`, `--system-prompt-file`, `--mcp-config`
  (`buildMcpConfig()`, `cc-headless.ts:104`), and the agent owns delivery via
  `reply`/`send_message`.
- E23 complete: `agent_id` is a first-class per-instance concept
  (`getCcHeadlessInstances`), and `agents:` (keyed by recipient id, e.g.
  `agent:peggy`) exists in `src/config/schema.ts:309` as the documented
  extension point for "agent-scoped settings... added here over time."
- E13 complete: `sendChannelNotification` (`src/adapters/cc.ts`, emits
  `notifications/claude/channel`) exists as the mechanism to wake a
  persistent, MCP-connected `claude-code` session between turns.
- `MessageQueue.deadLetter(messageId, reason)` (`src/core/queue.ts:220`)
  exists as the primitive to cancel a still-pending queued message.
- `claude` CLI supports `--bare`, `--max-budget-usd`, `--strict-mcp-config`,
  `--tools`/`--allowedTools`/`--disallowedTools` (verified via `claude
  --help` against the installed binary during design).

---

## Exit Criteria

- A `subagents:` top-level config block exists with global defaults:
  `enabled`, `max_concurrent_global`, `default_max_concurrent_per_agent`,
  `default_timeout_ms`, `default_max_budget_usd`, `allowed_models`,
  `allowed_working_dirs`, `max_depth` (default `2`).
- `AgentConfigSchema` (`schema.ts:309`) gains optional per-agent overrides:
  `subagent_max_concurrent`, `subagent_timeout_ms`, `subagent_max_budget_usd`,
  `allowed_models`. Resolution is **most-restrictive-wins**: for scalars,
  `effective = min(call_site ?? ∞, agent_override ?? ∞, global_default)`; for
  the model allowlist, the per-agent list (if set) must be a subset of the
  global list, and effective = `agent.allowed_models ?? subagents.allowed_models`.
  `max_concurrent_global` is a separate, independent ceiling on total in-flight
  sub-agents across all agents — checked as an AND alongside the per-agent
  cap, never merged into the min-chain.
- Five new MCP tools exist: `spawn_subagent`, `get_subagent_status`,
  `await_subagent`, `cancel_subagent`, `list_subagents` — available to
  existing full/headless tool sets (`registerAllTools`, `registerHeadlessTools`)
  and to a new, more restricted `registerSubagentTools` set used for spawned
  sub-agents themselves.
- `spawn_subagent` supports two modes:
  - `same_instance` — new session, caller's own `working_dir`/`system_prompt`
    template/memory injection (not a `--resume` fork of the caller's live
    session — see Notes on the concurrent-writer hazard this avoids).
  - `fresh_directory` — new session in a `working_dir` the caller supplies,
    validated against `subagents.allowed_working_dirs`. If the resolved
    directory matches a configured `cc-headless` instance's `working_dir`
    (realpath-exact match), the sub-agent renders through *that* instance's
    template/memory config; otherwise the caller's `prompt` is used directly
    as the task with no template, relying on `cwd`-driven `CLAUDE.md`
    auto-discovery. Either way, resource accounting (concurrency/timeout/
    budget/depth) is always attributed to the **calling** agent, never the
    instance whose template was used.
  - Passing `working_dir` with `mode: 'same_instance'` is a validation error.
  - A directory not on the allowlist ("this or any realpath-resolved
    descendant" containment, symlink-safe) is rejected at spawn time; a
    missing/unresolvable directory is a spawn-time error, never
    auto-created.
- A third, explicitly considered mode — spawning with `--bare` to ignore all
  `CLAUDE.md`/settings — is **dropped** (see Notes).
- Every sub-agent process is tracked (PID/process-group) and killed
  (SIGTERM, escalating to SIGKILL after a grace period, on the process
  *group* to catch nested children) when bus-core shuts down. Live rows are
  stamped `interrupted` **before** the kill signal goes out and before
  `closeDb()` runs.
- Nesting is capped at `subagents.max_depth` (default `2`, global only, no
  per-agent override): a depth-0 agent may spawn (depth 1), a depth-1
  sub-agent may spawn (depth 2), a depth-2 sub-agent's `spawn_subagent` call
  is rejected with a clear "max nesting depth reached" error — the tool
  remains registered and visible; it isn't removed from depth-2 agents' tool
  list. Depth is tracked authoritatively by AgentBus (via an env var carrying
  the caller's own handle into the per-invocation MCP server subprocess,
  looked up against its persisted `depth`), never self-reported by the model.
- `get_subagent_status`/`await_subagent`/`cancel_subagent`/`list_subagents`
  are scoped per calling agent: a handle spawned by a different agent is
  indistinguishable from an unknown handle (`not_found`), never leaked.
- `await_subagent` accepts multiple handles with an `any`/`all` mode and
  always returns per-handle status detail, even when the wait is satisfied by
  fewer than all handles or times out with a mixed batch.
- Model validation rejects a caller-specified model not on the effective
  allowlist; an omitted model defaults to the calling agent's own configured
  model.
- Cost budget is enforced via `claude -p --max-budget-usd <effective>`. The
  CLI's own enforcement was verified live (see Notes): it is a **soft**
  ceiling checked between turns, not a hard mid-turn cutoff, and produces a
  distinct terminal signal (`subtype: "error_max_budget_usd"`,
  `terminal_reason: "budget_exhausted"`) that AgentBus maps to a dedicated
  `budget_exceeded` status, distinct from generic `failed`.
- Completion is delivered two ways, not one:
  - **Within-turn**: the calling agent's own turn is still active, so it
    finds out via `get_subagent_status` (poll) or `await_subagent`
    (blocking, clamped by the same min-chain as the spawn timeout).
  - **Cross-turn**: a normal message envelope is enqueued (sender
    `subagent:<handle>`, body `[Sub-agent <handle> completed] <result>` or
    `[Sub-agent <handle> failed: <error>]`), which each adapter type
    surfaces via its own existing mechanism — a headless agent's next poll
    cycle spawns a `--resume` turn as it would for any pending message; a
    persistent adapter additionally gets `sendChannelNotification` fired
    right after enqueue, since it waits idle rather than polling.
  - If the calling agent already consumed the result via
    `get_subagent_status`/`await_subagent` before the queued message is
    delivered, the still-pending message is dead-lettered
    (`queue.deadLetter(id, 'consumed_via_tool')`) so a stale, confusing
    second turn never fires. A rare race against the delivery worker (the
    message already sent by the time consumption is marked) is accepted as
    low-severity — worst case one extra turn, not a correctness bug.
- A new `subagent_runs` persistence table records every spawn: handle,
  parent agent id, parent handle (nullable — enables depth lookup),
  depth, mode, working_dir, model, prompt, effective
  timeout/budget, status, result/error, actual cost, the sub-agent's own
  `claude_session_id`, and the completion message id (for the dead-letter
  check above).
- Sub-agents spawned via either mode never get `reply`, `send_message`,
  `send_email`, `react_to_message`, or the `schedule_*` tools — the calling
  agent owns all user-facing communication and decides what, if anything, a
  sub-agent's result should trigger.
- Auth is unchanged: sub-agent spawns inherit the bus-core process's
  environment exactly as existing headless spawns do
  (`cc-headless.ts:213`, `env: { ...process.env, ... }`) — no new auth
  handling in this epic (a follow-up idea — per-agent env-file auth — is
  filed in `_bmad-output/backlog.md`, out of scope here).

---

## Config Shape

```yaml
subagents:
  enabled: true
  max_concurrent_global: 10
  default_max_concurrent_per_agent: 3
  default_timeout_ms: 300000        # 5 min
  default_max_budget_usd: 1.00
  allowed_models: []                # empty = unrestricted
  allowed_working_dirs:
    - ~/workspace                   # this dir + any realpath-resolved descendant
  max_depth: 2                      # global only, no per-agent override

agents:
  agent:peggy:
    media: { download_path: /Users/chrispatten/agentbus-media/peggy, ttl_seconds: 3600 }
    subagent_max_concurrent: 5      # narrows the global default of 3 upward is NOT allowed —
                                     # effective = min(5, default_max_concurrent_per_agent) = 3
                                     # unless the global default is also raised
    subagent_timeout_ms: 600000     # 10 min — clamped down to default_timeout_ms if that's lower
    subagent_max_budget_usd: 2.00
    allowed_models: [claude-sonnet-5]   # must be a subset of subagents.allowed_models if that's non-empty
```

---

## Stories

### S24.1 — Config Schema: `subagents:` Block + Per-Agent Overrides

**User story:** As an operator, I want global defaults and per-agent
overrides for sub-agent concurrency, timeout, cost, and model allowlisting,
so that I can bound the blast radius of a feature that lets agents spawn
processes without hand-tuning every agent individually.

**Acceptance criteria:**
- New `SubagentsConfigSchema` in `src/config/schema.ts`: `enabled` (default
  `false`), `max_concurrent_global` (default `10`), `default_max_concurrent_per_agent`
  (default `3`), `default_timeout_ms` (default `300000`),
  `default_max_budget_usd` (optional — omitted means no cost ceiling),
  `allowed_models` (`string[]`, default `[]`), `allowed_working_dirs`
  (`string[]`, default `[]`), `max_depth` (default `2`). Mounted on
  `AppConfigSchema` as `subagents: SubagentsConfigSchema.prefault({})`.
- `AgentConfigSchema` (`schema.ts:309`) gains: `subagent_max_concurrent?`,
  `subagent_timeout_ms?`, `subagent_max_budget_usd?`, `allowed_models?`, all
  optional.
- A resolver helper (e.g. `resolveSubagentLimits(config, agentId, callSite)`)
  implementing the min-chain (scalars) / subset (models) rules from Exit
  Criteria, with `max_concurrent_global` exposed separately, not folded into
  the per-agent min-chain.
- `allowed_working_dirs` entries get `~`/`${VAR}` expansion for free via the
  existing `substituteEnvVars`/`expandTilde` walk in `src/config/loader.ts`
  (no new expansion code needed — confirm with a unit test that a `~/...`
  entry round-trips through config loading resolved to an absolute path).
- Unit tests: min-chain resolution (agent tighter than global, global
  tighter than agent, call-site tighter than both, all unset → global
  default); model subset validation (agent list is a superset of global →
  rejected at config-load time as invalid config, not just at spawn time);
  `allowed_working_dirs` tilde expansion.

**Complexity:** S

---

### S24.2 — Persistence: `subagent_runs` Table

**User story:** As the bus, I want every sub-agent spawn recorded durably, so
that status/result survive process restarts, depth can be computed
authoritatively, and cost/session data is available for later `get_session`-
style inspection.

**Acceptance criteria:**
- New migration adding `subagent_runs`: `handle` (PK), `parent_agent_id`,
  `parent_handle` (nullable FK to `handle`, enables depth lookup),
  `depth` (integer, `0` for a directly-caller-initiated spawn — i.e. the
  spawning agent itself has no row; depth counts *rows*, not turns),
  `mode` (`same_instance` | `fresh_directory`), `working_dir`, `model`,
  `prompt`, `effective_timeout_ms`, `effective_max_budget_usd`, `status`
  (`running` | `completed` | `failed` | `timeout` | `interrupted` |
  `budget_exceeded`), `result_text` (nullable), `error_detail` (nullable),
  `cost_usd` (nullable until terminal), `claude_session_id` (nullable),
  `completion_message_id` (nullable — set once the completion envelope is
  enqueued), `consumed_at` (nullable — set the first time
  `get_subagent_status`/`await_subagent` returns a terminal status for this
  handle), `created_at`, `started_at`, `completed_at`.
- Query helpers: insert-on-spawn; update-on-terminal (status + result/error +
  cost + `completed_at`); lookup-by-handle scoped to `parent_agent_id` (used
  by the status/await/cancel/list tools — a handle owned by a different
  agent must resolve as if it doesn't exist); lookup-depth-by-handle (walks
  `parent_handle` or just reads the stored `depth` directly, since depth is
  stamped once at insert time and never recomputed); count-running scoped to
  agent (for concurrency enforcement) and globally (for `max_concurrent_global`).
- Unit tests covering each helper, including the cross-agent scoping
  (agent B's lookup of agent A's handle returns not-found, not an error and
  not the row).

**Complexity:** S

---

### S24.3 — Spawn/Lifecycle Core: Process Tracking, Kill-on-Shutdown

**User story:** As the bus, I want every spawned sub-agent process
tracked and forcibly cleaned up on shutdown, so that a restart never leaves
orphaned `claude -p` processes running or hangs indefinitely waiting on a
wedged one.

**Acceptance criteria:**
- A shared "spawn a `claude -p` worker" function, extracted from (or
  delegating to) the spawn logic already in `HeadlessInstance` (`cc-headless.ts:213`)
  so sub-agent spawns and normal headless turns share one code path rather
  than diverging.
- A module-level (or bus-core-instance-level) registry of live sub-agent
  child processes, keyed by handle, storing the process group id.
- Children are spawned with their own process group (not attached to
  bus-core's), so killing the group also reaps any nested children a
  sub-agent's own tool use might have started.
- A new `stopSubagents()` (mirroring `stopHeadless()`) that, for every live
  entry: stamps `subagent_runs.status = 'interrupted'` in the DB, then sends
  SIGTERM to the process group, waits a configurable grace period (default a
  few seconds), then SIGKILL if still alive.
- Wired into `shutdown()` (`src/index.ts:194`) **before** `closeDb()` is
  called — status must be persisted while the DB connection is still open.
- Note in this story (and fixed as part of it, since it's the same latent
  bug): today's `HeadlessInstance.stop()` (`cc-headless.ts:577`) doesn't
  track or kill in-flight `claude -p` children at all — it only clears the
  poll timer. Extend the same process-group tracking/kill-on-shutdown
  mechanism built here to regular headless turn spawns, not just sub-agents.
- Unit/integration tests: shutdown kills a running fake-`claude` child
  (verifiable via a test double that traps SIGTERM/SIGKILL); a wedged
  child that ignores SIGTERM is SIGKILLed after the grace period; the DB
  row is `interrupted` before the process receives any signal (ordering
  assertion via mocked DB write + spy on `spawn().kill`).

**Complexity:** M

---

### S24.4 — Modes: `same_instance` and `fresh_directory`

**User story:** As an agent, I want to spawn either a parallel copy of
myself or a worker in a different, approved directory, so that I can
delegate bounded work without waiting on it serially.

**Acceptance criteria:**
- `same_instance`: spawns using the calling agent's own `working_dir`,
  `system_prompt` template, and memory assembly (`assembleMemoryContext`) —
  functionally a new turn for that agent, triggered by a spawn instead of an
  inbound message. **Not** a `--resume` of the caller's live session (two
  concurrent `claude -p --resume <same-id>` processes risk corrupting the
  shared session transcript) — always a fresh `claude_session_id`.
- `fresh_directory`: caller-supplied `working_dir` is required, resolved via
  `fs.realpathSync`, and checked against `subagents.allowed_working_dirs`
  entries (also realpath-resolved) using "equal to or a descendant of" containment.
  A directory outside the allowlist is rejected with a clear error; a
  directory that fails to resolve (doesn't exist) is a spawn-time error, not
  auto-created.
- Template resolution for `fresh_directory`: if the resolved `working_dir`
  exact-matches a configured `cc-headless` instance's `working_dir`
  (also realpath-resolved), render through that instance's
  `system_prompt`/`memory` config (same rendering path as `same_instance`,
  substituting that instance's config for the caller's own). Otherwise, the
  `prompt` field is passed directly as the task (e.g. via
  `--system-prompt`/the initial user turn) with no template, relying on
  `cwd`-driven `CLAUDE.md` auto-discovery.
- Regardless of which template (if any) is used, concurrency/timeout/
  budget/depth accounting is always attributed to the **calling** agent's
  `agent_id`, never the matched instance's.
- `mode: 'same_instance'` with a `working_dir` supplied is a validation
  error (rejected before any process spawns).
- The originally-considered third mode — spawn with `--bare` to skip
  `CLAUDE.md`/hooks/settings entirely — is explicitly **not implemented**
  (see Notes).
- Unit tests: allowlist containment (inside root, descendant of root,
  outside root, symlink pointing outside root all correctly
  accepted/rejected); template-match vs. no-match branching; the
  mode/working_dir validation error; `same_instance` never passes `--resume`
  with the caller's session id.

**Complexity:** M

---

### S24.5 — Nesting Depth Tracking and Enforcement

**User story:** As the bus, I want a hard cap on how deeply sub-agents can
spawn other sub-agents, so that a delegation chain can't runaway into
unbounded process creation.

**Acceptance criteria:**
- When a sub-agent is spawned, its handle is passed as an environment
  variable (e.g. `AGENTBUS_SUBAGENT_HANDLE`) into **both** the `claude -p`
  child's env and the per-invocation MCP server subprocess's env (the
  server spawned per `buildMcpConfig()`, `cc-headless.ts:104-119`, which is
  what actually receives the `spawn_subagent` tool call from that child).
- A normal top-level turn has no `AGENTBUS_SUBAGENT_HANDLE` set → treated as
  depth `0`.
- On a `spawn_subagent` call, the handler reads `AGENTBUS_SUBAGENT_HANDLE`
  from its own process env (if present), looks up that handle's `depth` in
  `subagent_runs`, and computes `child_depth = depth + 1` (or `1` if unset).
  If `child_depth > subagents.max_depth`, the call is rejected with a clear
  "max nesting depth reached" error — `spawn_subagent` remains a registered,
  visible tool at every depth; it is never removed from the tool list handed
  to a depth-capped agent.
- Unit tests: depth-0 spawn succeeds and creates a depth-1 row; a depth-1
  sub-agent's spawn succeeds and creates a depth-2 row; a depth-2
  sub-agent's spawn is rejected with the nesting-depth error and creates no
  row; the env var is present on the per-invocation MCP server subprocess
  for a depth-1/2 sub-agent's own tool calls (integration-level check).

**Complexity:** M

---

### S24.6 — MCP Tool Surface

**User story:** As an agent, I want `spawn_subagent`, `get_subagent_status`,
`await_subagent`, `cancel_subagent`, and `list_subagents` available as MCP
tools, so that I can actually use everything designed in S24.1–S24.5.

**Acceptance criteria:**
- `spawn_subagent({ mode, working_dir?, prompt, model?, timeout_ms?,
  max_budget_usd? }) → { handle }`. Validates: mode/working_dir consistency
  (S24.4), directory allowlist (S24.4), model against the effective
  allowlist (rejecting with a clear error; omitted `model` defaults to the
  caller's own configured model), nesting depth (S24.5), and both
  concurrency ceilings (per-agent effective cap via S24.1's resolver, and
  the separate global `max_concurrent_global`) — a cap violation is
  rejected synchronously, never queued. On success, resolves
  timeout/budget through the min-chain, inserts the `subagent_runs` row,
  and spawns via S24.3's shared spawn function.
- `get_subagent_status({ handle }) → { status, result?, error?, cost_usd? }`
  scoped to the caller's `agent_id`; a foreign or unknown handle returns
  `not_found`. The first time a terminal status is returned for a handle,
  `consumed_at` is stamped and, if `completion_message_id` is still
  pending/processing, it's dead-lettered (ties into S24.7).
- `await_subagent({ handles, mode: 'any'|'all', timeout_ms? }) →
  { satisfied, results: { [handle]: {...} } }` — blocks the tool call
  (polling the DB internally) until the mode's condition is met or
  `timeout_ms` elapses (itself clamped by the same min-chain as spawn
  timeouts), always returning per-handle detail. Same `not_found`/consumed-
  marking/dead-letter behavior as `get_subagent_status` for every handle in
  the batch.
- `cancel_subagent({ handle })` — kills that specific sub-agent's process
  group early (reusing S24.3's kill mechanics for one handle instead of
  all), marks it a distinct terminal status (e.g. `cancelled`, separate
  from `interrupted` which is shutdown-specific), and frees its concurrency
  slot immediately.
- `list_subagents()` — returns all handles + status owned by the caller's
  `agent_id` (running and terminal, perhaps time-bounded to recent ones).
- A new `registerSubagentTools(server, busBaseUrl)` function registers a
  restricted set for spawned sub-agents themselves: the five tools above,
  plus memory (`recall_memory`/`log_memory`/`search_transcripts`), session
  lookup (`get_session`/`list_sessions`), and attachment tools — explicitly
  **excluding** `reply`, `send_message`, `send_email`, `react_to_message`,
  and every `schedule_*` tool.
- The five new tools are also added to the existing `registerAllTools` and
  `registerHeadlessTools` sets (`src/mcp/tools/index.ts`), so any top-level
  agent — persistent or headless — can spawn sub-agents.
- Unit tests per tool covering validation failures, cap enforcement,
  cross-agent scoping, and the any/all `await_subagent` semantics (mixed
  completion, timeout mid-batch).

**Complexity:** L

---

### S24.7 — Completion Delivery

**User story:** As the calling agent, I want to learn a sub-agent finished
even after my own turn has ended, so that a long-running delegated task
doesn't require me to keep polling forever.

**Acceptance criteria:**
- On terminal status (success or any failure/timeout/budget/interrupted
  variant — *except* `cancelled` via `cancel_subagent`, which the caller
  already knows about by definition), a message envelope is enqueued:
  sender `subagent:<handle>`, recipient/routing targeting the calling
  agent's `agent_id`/conversation, body `[Sub-agent <handle> completed]
  <result>` or `[Sub-agent <handle> failed: <error>]` (and equivalents for
  `timeout`/`budget_exceeded`/`interrupted`). The enqueued message id is
  stored on `subagent_runs.completion_message_id`.
- No new delivery mechanism is built for headless agents — the existing
  poll loop already picks up any pending message scoped to its `agent_id`
  and spawns a `--resume` turn, exactly as it does for a real inbound
  message.
- For the persistent `claude-code` adapter, `sendChannelNotification`
  (`cc.ts`, per E13) is fired immediately after enqueue, since that adapter
  waits idle rather than polling.
- If `consumed_at` is already set on the row by the time delivery would
  happen (the caller got the result via `get_subagent_status`/`await_subagent`
  first, per S24.6), the still-pending message is dead-lettered via
  `queue.deadLetter(id, 'consumed_via_tool')` instead of delivered. The
  reverse race (message already delivered by the time consumption is
  marked) is left unguarded — accepted as a rare, low-severity case (one
  extra turn, not a correctness bug).
- Unit/integration tests: headless pickup of a completion message drives a
  `--resume` turn with the expected body framing; persistent-adapter path
  fires the notification; dead-letter fires when status is polled before
  delivery; the accepted race is *not* tested for prevention, just
  documented as known/acceptable.

**Complexity:** M

---

### S24.8 — Docs

**User story:** As a developer, I want the sub-agent spawning feature fully
documented, so that operators can configure limits and agents' own prompts
can describe the capability accurately.

**Acceptance criteria:**
- New `docs/SUBAGENTS.md` covering: the two modes and when to use each, the
  full config shape (`subagents:` block + per-agent overrides) with the
  min-chain/subset resolution rules spelled out, the five tools' schemas,
  the status enum and what each value means, the nesting depth cap, the
  restricted tool set given to spawned sub-agents, and the within-turn vs.
  cross-turn completion paths.
- `config.yaml.example` gains a commented `subagents:` block and a
  per-agent override example.
- `CHANGELOG.md` `[Unreleased]`: Added — sub-agent spawning (`spawn_subagent`,
  `get_subagent_status`, `await_subagent`, `cancel_subagent`,
  `list_subagents` MCP tools; configurable concurrency/timeout/cost/model
  limits; nesting depth cap).
- Cross-reference the backlog entry for per-agent env-file auth
  (`_bmad-output/backlog.md`) as a known follow-up, and explicitly note
  `--bare` mode was evaluated and dropped (with the reason) so a future
  reader doesn't re-propose it without context.

**Complexity:** S

---

## Notes

- **`--bare` mode was dropped.** It was evaluated in detail: `claude --help`
  confirms `--bare` skips hooks, LSP, plugin sync, attribution, auto-memory,
  and `CLAUDE.md` auto-discovery, and additionally restricts auth to
  `ANTHROPIC_API_KEY`/`apiKeyHelper` only (no OAuth/keychain) — a real
  prerequisite this deployment doesn't currently meet, since existing
  headless spawns inherit ambient OAuth/keychain auth via full `process.env`
  passthrough (`cc-headless.ts:213`). Rather than build isolated auth
  plumbing for a third mode, it was cut; `same_instance` and
  `fresh_directory` cover the real use cases.

- **Cost budget enforcement was verified live**, not assumed. A test run
  (`claude -p ... --max-budget-usd 0.05` on a 30-turn task) produced exit
  code `1` and a final stream-json `result` event with `is_error: true`,
  `subtype: "error_max_budget_usd"`, `terminal_reason: "budget_exhausted"`,
  and `total_cost_usd: 0.0522612` — i.e. actual spend overshot the
  configured cap slightly, confirming the enforcement is a **soft ceiling
  checked between turns**, not a hard mid-turn cutoff. Document this
  explicitly wherever `max_budget_usd` is surfaced so it's never treated as
  a hard spending guarantee.

- **Same-instance mode is not a session fork.** Two concurrent
  `claude -p --resume <same-id>` invocations against one session risk
  corrupting that session's on-disk transcript (same class of hazard as two
  writers to one git ref). `same_instance` mode always gets a fresh
  `claude_session_id` — it shares the caller's *configuration* (template,
  memory), not its *conversation state*.

- **An LLM agent cannot receive information mid-generation.** Every MCP
  tool call — headless or persistent, doesn't matter — is synchronous
  request/response; there's no interrupt into a live generation. This is
  why "know in the same turn" required two distinct primitives
  (`get_subagent_status` for polling, `await_subagent` for blocking) rather
  than one, and why cross-turn completion needed a genuinely different
  mechanism (message enqueue) than within-turn completion.

- **Pattern precedent.** `getTelegramInstances`/`getEmailInstances`/
  `getCcHeadlessInstances` (all in `src/config/schema.ts`) are the
  precedent for config normalization; `registerHeadlessTools` vs.
  `registerAllTools` (`src/mcp/tools/index.ts`) is the precedent for
  scoped tool sets — `registerSubagentTools` follows the same shape rather
  than inventing a new registration pattern.

- **Out of scope / follow-ups.**
  - Per-agent env-file auth (isolated `ANTHROPIC_API_KEY` per agent,
    separate from ambient OAuth/keychain) — filed in `_bmad-output/backlog.md`.
  - Surfacing `subagent_runs` through `get_session`/`list_sessions` or a new
    HTTP endpoint for operator visibility beyond the MCP tools — not
    required for agents to use the feature; worth a future pass once usage
    patterns are known.
  - `--strict-mcp-config`/`--tools` fine-tuning beyond the fixed
    `registerSubagentTools` set (e.g. a caller-specified tool subset per
    spawn) — the fixed restricted set is enough for v1; per-spawn tool
    customization can follow if a real need shows up.

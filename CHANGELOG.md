# Changelog

All notable changes to AgentBus are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Versions are tracked via `package.json` and git tags (`vX.Y.Z`), created with
`npm run release:patch|minor|major`. See [docs/VERSIONING.md](docs/VERSIONING.md).

## [Unreleased]

## [0.13.0] - 2026-09-25

### Added
- **Per-job model and dedicated conversation for scheduled jobs (E53 S53.3).**
  `scheduled_items` gains a `model` column (migration 022). `POST
  /api/v1/schedules`, `PATCH /api/v1/schedules/:id`, and the
  `schedule_message`/`update_schedule` MCP tools accept `model`; a fire stamps
  it onto the envelope as `metadata.schedule_model` for the pool/headless
  adapters to resolve. A new `update_schedule` MCP tool patches `label`,
  `topic`, `model`, `max_fires`, and `status`. Schedule list/get output and
  `/schedule list` now show `model`.
- Config-defined schedules (`config.yaml` `schedules:`) also accept an
  optional `model` field.
- **Adapter-neutral model override tools (E53 S53.1).** New MCP tools
  `set_model_override`, `get_model_override`, `list_model_overrides`, and
  `delete_model_override` manage the agent-wide and global model overrides
  shared by `cc-headless` and `cc-pool`. `resolveModel()`
  (`src/adapters/model-override-loader.ts`) resolves, in order: a fired
  schedule's own model (`metadata.schedule_model`), an agent-scoped
  override, the global override, the caller's configured model, then the
  CLI default. See
  [docs/CC_HEADLESS_ADAPTER.md](docs/CC_HEADLESS_ADAPTER.md#runtime-model-overrides).
- **Per-job models for `cc-pool` panes (E53 S53.2, S53.4, S53.5,
  S53.6).** A pane's `--model` is now resolved per launch, in order: a
  fired schedule's own model (carried as `metadata.schedule_model`), an
  agent-scoped override, a global override, then the pool's own
  `adapters.cc-pool.<name>.model` — never a bare read of `cfg.model` inside
  the launch line anymore. The resolved model is persisted to the new
  `pool_leases.model` column (migration 023) and logged on every launch. A
  model change is applied to an already-leased pane's *next* message: if the
  pane is between turns it is relaunched in place (`--resume` on the same
  Claude session, new `--model`); a turn in flight is never interrupted — the
  switch is deferred to the pane's next message. `/pool` and
  `GET /api/v1/pool` now show each pane's `model`. bus-core logs a startup
  warning for a pool with no `model` configured, since panes then silently
  inherit `~/.claude/settings.json`. See "Model selection" in
  [docs/CC_POOL_ADAPTER.md](docs/CC_POOL_ADAPTER.md#model-selection).

- **Stall watchdog for `cc-pool` panes, observe-only (E52, S52.1–S52.2).**
  A leased pane with unhandled work and a screen unchanged for
  `watchdog.stall_after_ms` (default 5 minutes) is recorded as an incident in
  the new `pane_incidents` table (migration 020), with the full screen
  snapshot kept locally. Panes with a pending approval request are excluded.
  It never sends keys and sends no alerts yet. The `/turn-ended` Stop hook now
  also records `pool_leases.last_turn_ended_at`, which is compared against
  message acks to decide what is unhandled; the migration treats messages acked
  before it as handled. New optional config: `adapters.cc-pool.watchdog`
  (`enabled`, `observe_only`, `sample_interval_ms`, `stall_after_ms`,
  `alert_contact`). See the "Stall watchdog" section of
  [docs/CC_POOL_ADAPTER.md](docs/CC_POOL_ADAPTER.md).
- **Makefile targets for pool debugging and development.** `make pool`,
  `pool-capture`, `pool-attach`, and `approvals` inspect cc-pool panes and
  approval requests; `health`, `logs-err`, and `safe-restart` cover operating
  bus-core; `test`, `test-one`, `typecheck`, and `check` cover development.
  `make restart` now waits for `/api/v1/health` and fails if the bus doesn't
  come back. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#daily-operations).
- **Answer a blocked pane's permission prompt from Telegram (E51).** When a
  `cc-pool` pane hits an interactive permission dialog, the addressed contact
  gets a Telegram DM with Approve/Deny buttons; tapping one sends `Enter` or
  `Escape` into the pane. Adds the `approval_requests` table (migration 019),
  `POST/GET /api/v1/approvals` and `POST /api/v1/approvals/:id/resolve`, the
  `interactiveApproval` adapter capability, and
  `scripts/hooks/agentbus_approval_hook.sh` (a `PermissionRequest` hook). A
  request no one answers within 15 minutes expires. No key is sent if the
  pane's dialog is already gone, its lease moved to another conversation, or
  the tapping contact isn't the one asked. Requires registering the hook in
  the pane project and relaunching its panes. See
  [docs/APPROVALS.md](docs/APPROVALS.md).
- **Agent-managed knowledge store, Phase 1 (E50).** New `knowledge` table
  (migration 018) with an FTS5 `knowledge_fts` search index, for the agent to
  store arbitrary-JSON records with an optional retrieval-cue `index_note`,
  agent-supplied tags/facets, and four temporal fields
  (`event_at`/`valid_from`/`relevant_until`/`expires_at`). Four new MCP tools:
  `write_knowledge`, `get_knowledge`, `forget_knowledge`, `search_knowledge`
  (keyword/facet/date filtering only — no embeddings or vector search in this
  phase). Each write computes and stores a `content_hash` of the record so a
  future per-turn injection path can dedupe against it without re-hashing.
  See [docs/KNOWLEDGE_STORE.md](docs/KNOWLEDGE_STORE.md).
- **Per-session context-block ledger for `cc-headless` (E49).** `cc-headless`
  no longer re-renders `{{memories}}` into the system prompt on every turn —
  the system prompt is now a frozen, cache-stable prefix. Memory files
  (`MEMORY.md`, daily journals) are hashed per-file and sent into the user
  turn only on first mention or when their content changes, tracked in a new
  `context_blocks` table (migration 017). Claude Code's own auto-compaction
  is detected via a sharp drop in a session's `turn_costs.input_tokens` and
  clears that session's ledger, since compaction invalidates what's assumed
  to already be in context. See
  [docs/CC_HEADLESS_ADAPTER.md](docs/CC_HEADLESS_ADAPTER.md).
- **Interactive Claude Code session pool (E48).** New `cc-pool` adapter type:
  a configurable pool of tmux panes (`adapters.cc-pool`, single-instance or
  named-instance form, `src/config/schema.ts`), each running its own
  interactive `claude` session paired with a per-pane `cc.ts` MCP process,
  leased to conversations on demand. A new pipeline stage
  (`pool-route-resolve`, slot 72) resolves each inbound message to a leased
  pane and rewrites the route's `recipientId` before the existing enqueue
  path runs — there is no adapter `send()` in the delivery path. `PoolManager`
  (`src/pool/`) owns lease allocation (reuse/bind/grow/evict/exhausted,
  backed by the new `pool_leases` table, migration 016), idle and hard-idle
  eviction, a parked-message queue for when every pane is busy (with a
  one-time per-conversation notice on timeout), an outbound guard that
  rejects a reply from a pane whose lease has already moved to a different
  conversation, and reconciliation (at startup and on every sweep tick) that
  adopts live panes as-is and recovers both crashed and failed-to-launch
  panes without a restart. See
  [docs/CC_POOL_ADAPTER.md](docs/CC_POOL_ADAPTER.md).
- **cc-pool observability (E48 S48.8).** `GET /api/v1/pool` (optionally
  filtered with `?pool=<agent id>`) returns pane leases and parked-queue
  depth for each configured `cc-pool` instance. A new `/pool [pool-agent-id]`
  bus command (`src/commands/pool.ts`) renders the same data as plain text.
  `/status` gains a `Pool:` section (one `pool <id>: leased/total leased[, N
  parked]` line per configured pool), omitted entirely on deployments with no
  `cc-pool` instances configured. See
  [docs/HTTP_API.md](docs/HTTP_API.md#pool) and
  [docs/SLASH_COMMANDS.md](docs/SLASH_COMMANDS.md#pool-pool-agent-id).
- **Pool-pane Claude Code hooks now tracked in this repo,
  `scripts/hooks/`.** `agentbus_stop_hook.sh` (feeds
  `POST /api/v1/pool/:agentId/turn-ended`, see above) and
  `agentbus_precompact_snapshot.sh` (a transcript-snapshot safety net for a
  pool agent's own memory system; doesn't call any AgentBus endpoint) were
  previously maintained only inside the deploying agent's own project
  directory, outside version control here — same gap as
  `agentbus_tool_status_hook.sh` below. A deployment symlinks each in and
  registers it in that project's own `.claude/settings.json`. See
  [docs/CC_POOL_ADAPTER.md#other-pool-pane-hooks](docs/CC_POOL_ADAPTER.md#other-pool-pane-hooks).
- **cc-pool: "One moment…" placeholder during a cold-starting pane launch.**
  A `bound`/`grow`/`evict` resolution blocks on the full launch sequence
  (ack handshake + readiness poll, up to 30s) before the message even
  reaches the pane — until now the user saw nothing at all during that
  wait, since the tool-status hook can't fire until the pane is already
  alive. `PoolManager.resolveRoute()` now fires a fire-and-forget
  `POST /api/v1/adapters/:channel/tool-status` with
  `{ text: "One moment…", placeholder: true }` right before launching.
  `reportToolCall` (`AdapterInstance`, `src/core/registry.ts`) gains an
  optional 5th `placeholder` argument; `TelegramAdapter` (the only adapter
  implementing it) replaces rather than appends to a placeholder draft on
  the next line posted for the same chat/topic, so "One moment…" never
  lingers once a real tool call or the final reply arrives. `reuse` never
  fires it — a reused pane has no launch latency to cover. See
  [docs/CC_POOL_ADAPTER.md#cold-start-placeholder](docs/CC_POOL_ADAPTER.md#cold-start-placeholder).

### Fixed
- **`POST /api/v1/model-overrides` no longer 500s (E53 S53.1).** The old
  `headless_model_overrides` table's unique index was partial (`WHERE
  schedule_id IS NOT NULL OR agent_id IS NOT NULL`) and excluded the global
  (all-NULL) row, so no `ON CONFLICT` target could ever match a global
  upsert and every write failed. The replacement `model_overrides` table
  (migration 021) indexes on `COALESCE(agent_id, '')`, so one conflict
  target covers both an agent-scoped and the global row. Covered by new
  HTTP-level tests in `src/http/api.test.ts`.
- **cc-pool: pane `last_activity_at` no longer goes stale during a long turn.**
  Activity was previously only bumped when a message was routed *in* to a
  pane, never when the pane's own turn finished — so a long-running reply or
  extended thinking time could look idle-eligible under `idle_evict_ms`/
  `hard_idle_ms` well before it actually was. New
  `POST /api/v1/pool/:agentId/turn-ended`, meant to be fed by a native Claude
  Code `Stop` hook on the pane's `claude` process, calls the existing (until
  now uncalled) `LeaseStore.touch()` in real time. See
  [docs/HTTP_API.md](docs/HTTP_API.md#post-apiv1poolagentidturn-ended) and
  [docs/CC_POOL_ADAPTER.md](docs/CC_POOL_ADAPTER.md#post-apiv1poolagentidturn-ended).
- **cc-pool: live tool-call status stream going silent on already-running panes
  after an unrelated message-format change.** `agentbus_tool_status_hook.sh`'s
  `UserPromptSubmit` regex required the `(topic: ...)` segment `cc.ts` started
  emitting in the topic fix above — but a pool pane's `cc.ts` subprocess only
  ever reads the format that existed when the pane launched and never
  restarts on its own, so any pane already running from before that change
  kept emitting the old, topic-less format for as long as it stayed alive.
  Against those panes the regex matched zero messages, its per-session state
  file stayed `[]` forever, and `PostToolUse` had nothing to report to —
  discovered 2026-09-20 when 4 of 5 live pool panes turned out to have gone
  completely silent this way. The regex now treats `(topic: ...)` as
  optional (falls back to `general`), matching both formats regardless of
  which one a given pane's `cc.ts` happens to be running. This script is now
  tracked in this repo at
  [`scripts/hooks/agentbus_tool_status_hook.sh`](scripts/hooks/agentbus_tool_status_hook.sh)
  — previously it existed only inside the deploying agent's own project
  directory, outside version control here. A deployment symlinks it in and
  registers it in that project's own `.claude/settings.json`. See
  [docs/CC_POOL_ADAPTER.md#live-tool-call-status-stream](docs/CC_POOL_ADAPTER.md#live-tool-call-status-stream).
- **cc-pool: launch acknowledgment and readiness-timeout defects found against
  a real `claude` CLI.** `CcPoolAdapterSchema.launch_ack_pattern`'s default
  (`'experimental'`) never appeared anywhere in the real
  `--dangerously-load-development-channels` confirmation prompt, so the ack
  handshake always falsely reported the prompt dismissed on the very first
  `Enter` without ever actually confirming it — the pane was then left
  stuck at that confirmation screen with `cc.ts` never started. The default
  is now `'loading development channels'`, matched against a real captured
  prompt. Separately, `PaneLifecycle`'s readiness-poll loop
  (`src/pool/pane.ts`) could run past its documented 30-second
  `LAUNCH_READY_TIMEOUT_MS` bound — indefinitely, if a single `/last-poll`
  check ever stalled — because the deadline was only re-checked between loop
  iterations, with nothing bounding how long one iteration's readiness check
  could take; it's now bounded so the loop reliably re-checks the deadline
  every poll interval regardless of how long any single check takes. The ack
  handshake is now bounded by the same overall deadline too, closing a gap
  where a large `launch_ack_max_attempts` could exceed the documented budget
  on its own. A third defect, found by live end-to-end verification of the
  above two fixes against the real CLI: even with the corrected pattern,
  `ackHandshake` still sent a blind `Enter` after a fixed
  `launch_ack_delay_ms` delay and treated the pattern's *absence* from
  `capture-pane` as proof the prompt had been dismissed — indistinguishable,
  from a single point-in-time check, from "the prompt simply hasn't rendered
  yet." Measured against real tmux + a real `claude` process, the prompt
  reliably takes over a second to render, well past the old 500ms default, so
  the handshake's first check almost always saw "absent" for the wrong
  reason, declared success, and never pressed `Enter` again — the real
  prompt then rendered moments later and sat there indefinitely, confirmed by
  direct reproduction (no mocks). `ackHandshake` now polls `capture-pane` for
  the prompt to actually appear before ever pressing `Enter`; `Enter` is only
  sent, and retried, once the prompt is confirmed showing.
  `launch_ack_delay_ms`'s meaning changes accordingly (total time to wait for
  the prompt to appear, not a blind pre-Enter delay) and its default is
  raised from `500` to `5000` to give real margin over the measured render
  time. See [docs/CC_POOL_ADAPTER.md](docs/CC_POOL_ADAPTER.md)'s
  Troubleshooting and Observability sections for operator-facing detail,
  including how to read `/pool`/`GET /api/v1/pool` and parked-message status
  correctly around a stuck launch.
- **cc-pool: static route config permanently corrupted by the first message
  on any route, breaking every subsequent conversation on that route.**
  `route-resolve.ts` (Stage 70) handed out `ctx.routes` entries that shared
  object identity with `config.pipeline.routes[i].target` (and
  `.also_notify[i]`) — the parsed-once config object reused for the lifetime
  of the process, not a per-envelope copy. `pool-route-resolve.ts`
  (Stage 72) assigns `route.recipientId = <resolved pane id>` directly onto
  whatever object it's handed, so on the first message matching a `cc-pool`
  route, that assignment mutated the static config's own route target in
  place: `recipientId` flipped from the pool's logical id (e.g.
  `agent:peggy`) to the concrete pane resolved for that one message (e.g.
  `agent:peggy-pool-1`), permanently, for every later envelope matching the
  same rule — including unrelated conversations. Every subsequent message on
  that route then failed pool-route-resolve's `poolManagers.get(...)` lookup
  (keyed by the logical id, which no longer appeared anywhere on the route),
  logged a "No cc-pool instance configured for recipient" error, and left the
  stale pane id untouched — silently pinning every future conversation on
  that route to the first conversation's pane, with no lease/eviction/
  parking logic ever running for them again. Found during real end-to-end
  verification of the launch-ack fix above, which had worked around it
  without noticing by restarting bus-core between runs instead of sending two
  messages through one running process. Fixed by having `route-resolve.ts`
  copy each target object (`{ ...rule.target }`, and the same for each
  `also_notify` entry) instead of sharing the config's own reference, plus
  defense in depth in `pool-route-resolve.ts`, which now replaces a route's
  array element with a fresh object rather than mutating its input in place.
  Verified against the real CLI: two different conversations sent to the
  same already-running bus-core process, on the same static route, both
  reached `leased` on their own distinct panes.
- **E29 tool-status/typing updates landing in a Telegram group's general area
  instead of the topic the user actually messaged in.** A Claude Code hook
  outside this repo (`agentbus_tool_status_hook.sh`) has no access to the
  structured `MessageEnvelope` for a turn — only the rendered prompt text —
  so it regex-parses `sender`/`channel` back out of the
  `formatMessagesForSampling` (`src/adapters/cc.ts`) output and POSTs to the
  `typing`/`tool-status` adapter endpoints. `topic` was never in that text,
  so those calls always omitted it and silently fell back to the group's
  general area, regardless of which forum topic the conversation was in.
  `formatMessagesForSampling` now includes `(topic: <topic>)` between the
  channel and the optional timestamp in each formatted message line (e.g.
  `New message from contact:alice via telegram:peggy (topic:
  thread:9cfaf60aed4358c6) at 2026-09-14T10:00 [id:msg-abc123]:`), so an
  external regex-based consumer can recover `topic` alongside `sender`/
  `channel`. `MessageEnvelope.topic` is a required field, so the segment is
  always present. Purely additive to the format; no other consumer of this
  string parses it. See [docs/CC_ADAPTER.md](docs/CC_ADAPTER.md#message-format).

### Changed
- **New recurring schedules default to their own topic (E53 S53.3, D1).** A
  `type: cron` schedule created without an explicit `topic` — via `POST
  /api/v1/schedules`, `schedule_message`, or `config.yaml` — now defaults to
  `sched:<label-slug>` (or `sched:<id8>` with no label) instead of `general`,
  so it gets its own conversation and pane rather than sharing one with
  whatever else uses `general`. One-shot (`type: once`) schedules still
  default to `general`. Existing schedules are unaffected; move one with
  `PATCH /api/v1/schedules/:id`. See the "Topic and model" section of
  [docs/SCHEDULING.md](docs/SCHEDULING.md).
- **Model override store renamed and simplified; schedule scope removed
  (E53 S53.1).** `headless_model_overrides` (migration 015) is replaced by
  `model_overrides` (migration 021): one row per agent plus one global row,
  no `priority` column. Schedule-scoped overrides are gone — a job's own
  model now lives on its schedule (`scheduled_items.model`, S53.3), not in the override store. `POST /api/v1/model-overrides` rejects
  a `schedule_id` in the body with `400`, pointing at the schedule's `model`
  field; `DELETE` now takes `agent_id` or `scope=global` in place of
  `schedule_id`/`agent_id` pairs. `set_headless_model`, `get_headless_model`,
  `list_headless_model`, and `delete_headless_model` are kept as deprecated
  aliases for `set_model_override`/`get_model_override`/
  `list_model_overrides`/`delete_model_override` and reject `schedule_id`
  the same way. Existing schedule-less overrides migrate automatically
  (newest wins per agent); schedule-scoped rows, unused in production, are
  dropped.
- `make kill` now also stops pm2's `bus-core`. Previously pm2 restarted the
  process it had just killed. `make dev` and `make debug-payloads` use the
  local `tsx` instead of `npx`.

## [0.12.0] - 2026-09-16

### Added
- **Siri channel spike (E42).** New `siri` channel adapter
  (`src/adapters/siri.ts`) and `POST /api/v1/siri/ask` /
  `GET /api/v1/siri/health` routes (`src/http/siri-routes.ts`), mounted only
  when `adapters.siri.enabled`. An ask is submitted through the normal inbound
  pipeline and the HTTP request is held open until the agent's `reply` is
  delivered to the adapter's `send()` (or `reply_timeout_ms` elapses, in which
  case the response is `status: pending` and the ask stays queued). Identity is
  a per-contact bearer token (`contacts.*.platforms.siri.token`, ≥ 16 chars,
  duplicates rejected at load), the same model as Pebble. Config schema gains
  `adapters.siri` (`reply_timeout_ms`, `max_body_bytes`, `debug_delay_ms`, plus
  the E43 keys accepted but not yet acted on). Two measurement scripts:
  `scripts/siri-gate0-latency.ts` (historical time-to-first-reply from
  transcripts) and `scripts/siri-probe.ts` (live asks with p50/p95 and a CSV).
  See [docs/SIRI_ADAPTER.md](docs/SIRI_ADAPTER.md).
- **Peggy iOS app proof of concept (E44).** New `apps/ios/Peggy` (XcodeGen
  project, Swift 6, SwiftUI, App Intents): an `Ask Peggy` App Shortcut whose
  `AskPeggyIntent` runs in the background, posts the question to the bus over
  Tailscale, and returns the reply as Siri dialog; a Settings screen for the
  bus URL, token, and wait budget with a "Test connection" check against
  `GET /api/v1/siri/health`; and XCTest coverage for every dialog outcome
  through a mocked bus client. Tokens live in `UserDefaults` for the POC
  (Keychain is E45). See `apps/ios/Peggy/README.md`.
- **Runtime model overrides for headless Claude spawns.** New
  `headless_model_overrides` table (migration
  `015_headless_model_overrides.sql`) lets an agent change which model a
  `cc-headless` spawn uses — scoped to an agent, a schedule, or global —
  without editing `config.yaml` or restarting the adapter.
  `HeadlessInstance.invokeClaude()` resolves the model via
  `resolveModelOverride()` (`src/adapters/model-override-loader.ts`) on every
  spawn, in specificity order (`schedule_id`+`agent_id` > `agent_id` >
  `schedule_id` > global), before falling back to `adapters.cc-headless.model`.
  Managed via `POST`/`GET`/`DELETE /api/v1/model-overrides` and the new
  `set_headless_model`/`get_headless_model`/`list_headless_model`/
  `delete_headless_model` MCP tools. Note: `schedule_id` is not yet threaded
  through from scheduled turns, so only agent-scoped and global overrides take
  effect today. See
  [docs/CC_HEADLESS_ADAPTER.md](docs/CC_HEADLESS_ADAPTER.md#runtime-model-overrides).
- **`/cost` command — per-agent API cost tracking (E39).** Every `claude -p`
  turn's cost/token/turn-count data (previously parsed and discarded by
  `HeadlessInstance.invokeClaude()`) is now persisted to a new `turn_costs`
  table (migration `014_turn_costs.sql`), keyed by `agent_id`. The new bus-scope
  `/cost` command resolves the calling sender's agent the same way `/stop`
  does and replies with day (since local midnight)/week (rolling 7 days)/
  calendar-month-to-date spend. A one-time, manually-run
  `scripts/backfill_turn_costs.ts` seeds historical cost from each configured
  `cc-headless` instance's existing `~/.claude/projects/*/*.jsonl` transcripts.
  See [docs/SLASH_COMMANDS.md](docs/SLASH_COMMANDS.md#cost).
- **Durable post-restart wake-up via scheduled one-shot + staleness dead-letter (E40).**
  `POST /api/v1/schedules` and the `schedule_message` MCP tool gain an optional
  `stale_after_ms` field (positive integer milliseconds, `type: 'once'` only —
  rejected with `400` on `type: 'cron'`): if a one-shot schedule is still
  unfired more than `stale_after_ms` after its `fire_at`, `Scheduler.tick()`
  marks it `status: dead_letter` instead of firing a confusingly-late message.
  Schedules without `stale_after_ms` (every existing use case) are completely
  unaffected. `scripts/safe_restart.sh` now creates one of these wake-ups
  (10s out, 45-minute staleness ceiling, targeting the channel/topic that
  triggered the restart via new `--notify-channel`/`--notify-topic` args) right
  before each restart attempt while bus-core is still confirmed healthy — this
  survives even if the script itself is killed immediately after kicking off
  the restart. The existing live `notify_peggy()` curl-to-`/api/v1/inbound`
  call remains as a belt-and-suspenders transition. See
  [docs/SCHEDULING.md](docs/SCHEDULING.md#staleness-and-dead-lettering).
- **Configurable raw webhook request logging (E38).** New `logWebhookRequest`
  helper (`src/http/webhook-log.ts`) appends one JSON line per incoming
  webhook request — success *and* rejection — to
  `<dir>/<webhook>/<YYYY-MM-DD>.jsonl`, useful for debugging a misbehaving
  proxy or unexpected device payload without needing to reproduce the issue
  live. Off by default (request bodies may contain sensitive content) and
  best-effort — a write failure is logged to the console and never affects
  the actual webhook response. Wired into the Pebble webhook via a new
  `adapters.pebble.logging: { enabled, dir }` config block (defaults:
  `enabled: false`, `dir: logs/webhooks`), logging both outcomes (auth
  failure, malformed multipart, missing/invalid fields, or a successful
  enqueue) with a machine-readable `reason`. The helper and its config shape
  are generic, not pebble-specific — any future webhook route can reuse the
  same mechanism.
- **Slash-command follow-up capture + `/torrent` completion notification (E36).**
  `CommandRegistry` gains a generic `registerFollowUp`/`consumeFollowUp`
  primitive: any bus command can ask "check the very next message from this
  sender" without building its own stateful tracking. It's keyed by
  `channel:sender`, single-shot (deletes on read whether or not it matches),
  and TTL-guarded. `processInbound` (`src/http/api.ts`) checks pending
  follow-ups on plain-text messages before the normal slash-command dispatch
  block; a match routes straight to the target command's handler and never
  reaches agent fan-out, while a miss (or expiry) falls through to the
  pipeline exactly as before. `/torrent` with no argument now asks **"What's
  the magnet link? 🧲"** and captures the next message (a 10-minute TTL)
  instead of returning a usage error — send a bare `magnet:...` link right
  after and the download starts, same as the direct-argument form. `/torrent`
  also now reports back when a download finishes (or fails, with the exit
  code and a pointer to `logs/torrents/`) in the same channel/topic it was
  started from, regardless of which form kicked it off — previously nothing
  ever reported completion for a spawn that can run anywhere from seconds to
  hours. The send-response + transcript-log logic used by all three call
  sites (normal slash dispatch, follow-up dispatch, and the out-of-band
  completion notification) is now a single shared `sendCommandResponse`
  helper in `src/http/api.ts` instead of duplicated inline logic.

### Changed
- **Documentation pass for accuracy and completeness.** `README.md`,
  `docs/HTTP_API.md`, `docs/CC_ADAPTER.md`, `docs/PLUGIN_AUTHORING.md`,
  `docs/DEPLOYMENT.md`, `docs/MEMORY.md`, and `docs/VERSIONING.md` are
  rewritten to match the code: single-process architecture with in-process
  adapters, the real route list (routes that were never built are removed),
  `POST /api/v1/messages` documented as the outbound enqueue and
  `POST /api/v1/inbound` as the pipeline entry, the polling MCP adapter's
  channel-notification mechanism, and the fact that no plugin loader exists.
  Adds `docs/README.md` as an index. Epic tags are dropped from headings
  (anchors updated here and across `docs/`), `config.yaml.example` and
  `.env.example` are aligned with the schema (BlueBubbles removed, headless
  adapter and scheduler sections added), and the homepage architecture copy
  no longer claims four separate processes.

## [0.11.0] - 2026-08-31

### Added
- **`get_transcript` MCP tool (E35).** New `GET /api/v1/sessions/:id/transcript`
  endpoint and matching `get_transcript` tool return the full, ordered
  message-by-message history for a specific session — every inbound and
  outbound row from `transcripts`, oldest first, paginated via
  `limit`/`since`/`before`. Complements `search_transcripts` (keyword-driven,
  cross-session snippets) and `get_session` (metadata + summary only) — until
  now there was no tool-level way to read a full session's transcript, only a
  raw DB query.
- **Journaling no-op warning (E33).** `SessionTracker.dispatchJournaling()`
  now logs a one-time `console.warn` when it would silently no-op bus-wide
  because zero `cc-headless` instances are configured, or none has a
  registered journaling runner, while at least one headless session is
  actually waiting on the sweep. Previously this condition (e.g. an operator
  swap away from `cc-headless`) paused journaling for every session with no
  visible symptom beyond a frozen `last_journaled_at`. Edge-triggered — fires
  once per occurrence of the condition, resets once it clears, so it doesn't
  spam logs every tick while persisting.
- **Session topic exposure (E32).** `get_session`/`list_sessions` now return
  a `topic` field (e.g. `"general"` or a Telegram forum `"thread:<hash>"`),
  resolved via a `LEFT JOIN conversation_registry` in both
  `GET /api/v1/sessions` and `GET /api/v1/sessions/:id` — no migration or
  backfill needed, since `sessions.conversation_id` and
  `conversation_registry.id` were already the same value for every existing
  session. Lets an agent target a proactive `send_message`/
  `schedule_message` at the topic a conversation is actually in instead of
  guessing.
- **Outbound transcript logging (E31).** `transcripts` now captures
  `direction: 'outbound'` rows for every message a platform adapter
  successfully delivers via `DeliveryWorker.deliver()` — `reply`,
  `send_message`, `send_email`, and scheduled-message delivery — not just
  the inbound side. Logging happens on confirmed `adapter.send()` success
  only; a failed or dead-lettered send never produces a row. Conversation
  and session are resolved via `conversation_registry`, the same lookup the
  inbound pipeline uses; an unresolvable contact/channel pair is skipped
  rather than failing the send. The pre-existing slash-command
  outbound-logging path (`src/http/api.ts`) now shares the same insert
  helper (`src/pipeline/outbound-transcript.ts`) instead of inlining its own
  SQL. `search_transcripts` can now find an agent's own past outbound
  message content. See
  [docs/MEMORY_MODEL.md](docs/MEMORY_MODEL.md#the-layered-model).
- **Decoupled memory-logging (E30).** The reply-producing `claude -p` turn no
  longer keeps running housekeeping tool calls after `reply`/`send_message`
  fires — memory-logging is now the exclusive job of the existing E20
  journaling-on-pause sweep, which gains a hard **ceiling** trigger
  (`journaling.ceiling_ms`) alongside the idle debounce so a long,
  continuously-active conversation still flushes periodically instead of only
  on pause. Overlapping sweeps for the same conversation are now suppressed.
  One documented exception: financial, health, scheduling, and
  safety/security-relevant content is still logged immediately, inline, in
  the reply-producing turn — see
  [docs/CC_HEADLESS_ADAPTER.md](docs/CC_HEADLESS_ADAPTER.md#memory-logging).

### Changed
- `send_message`'s tool description now points agents at `get_session`/
  `list_sessions` to look up a conversation's current `topic` before sending,
  instead of guessing one (docs-only, no behavior change).
- **`HeadlessInstance.enqueue()` advances on delivery, not process exit
  (E30).** The per-contact serialization queue now unblocks the next queued
  message as soon as a turn calls a delivery tool, instead of waiting for the
  whole `claude -p` process to close — so one turn's trailing housekeeping (or
  teardown latency) no longer delays a rapid-fire follow-up message.
  `claude_session_id` is now persisted to the DB as soon as it's known (the
  first stream event that carries it) rather than only at the end of the
  turn, to avoid a new conversation's rapid-fire second message reading a
  stale/null session id. See
  [docs/CC_HEADLESS_ADAPTER.md](docs/CC_HEADLESS_ADAPTER.md#per-contact-serialization).

### Fixed
- **Tool-call status Markdown escaping (E34).** `formatToolCallSummary()`
  now wraps every interpolated dynamic value (Bash/Agent `description`, Read/
  Edit/Write `file_path`, Grep `pattern`, WebFetch `url`, WebSearch `query`,
  and the tool `name` in the generic fallback) in a backtick code span
  before it reaches `TelegramAdapter`'s `parse_mode: 'Markdown'` send. A bare
  `_` in a snake_case path or identifier was previously interpolated raw,
  which Telegram parses as an emphasis delimiter — occasionally breaking
  Markdown parsing and falling back to an unformatted plain-text retry. A
  value containing a backtick is substituted with `´` so it can't terminate
  the code span early.
- **Bus-scope slash-command responses now reply in the originating Telegram
  forum topic instead of General.** The response envelope built in
  `src/http/api.ts` hardcoded `topic: 'command'`, which never matched
  `TelegramAdapter`'s `thread:<id>` topic convention, so `resolveSendTarget()`
  always fell back to the group's General topic regardless of which topic a
  command like `/stop` was run from. It now preserves the inbound envelope's
  `topic`.

### Removed
- **Vestigial slash commands.** Removed `/replay`, `/next`, `/cancel`
  (paginated transcript playback — `get_session`/`search_transcripts` are the
  better tool now) and the legacy structured-memory commands `/forget` and
  `/retry_summary` (both target the E8/E9 `memories`/summarizer store, which
  E20 turned off by default in favor of agent-owned memory files). Built-ins
  are now `/status`, `/pause`, `/resume`, `/sessions`, `/schedule`, `/clear`,
  `/stop`, `/help`.

## [0.10.0] - 2026-08-19

### Added
- **GitHub Pages homepage.** New static landing page in `site/` (pitch,
  architecture overview, feature grid, quick start), deployed automatically
  via `.github/workflows/pages.yml` on push to `main`. Version/license
  badges are live shields.io badges. Release checklist in
  [docs/VERSIONING.md](docs/VERSIONING.md) now includes a step to review the
  homepage copy; see [docs/GITHUB_PAGES.md](docs/GITHUB_PAGES.md).
- **Telegram live tool-call status stream (E29).** While a headless agent
  works on a turn, non-delivery tool calls now appear as lines in a single
  evolving Telegram message (`editMessageText`), batched to roughly one edit
  per second, which is then overwritten by the final answer once delivered —
  no separate draft/final messages, and no change to the zero-tool-call fast
  path. `Bash`/`Agent` calls use their own `description` field verbatim;
  other common tools get a small fixed template; anything else falls back to
  a generic line. Subagent internals never surface — an `Agent` call always
  renders as one line. See
  [docs/TELEGRAM_ADAPTER.md](docs/TELEGRAM_ADAPTER.md#live-tool-call-status-stream).
- **`/stop` slash command.** Cancels the sender's in-flight `claude -p` turn
  on a headless (`cc-headless`) agent — hard-kills the running child process
  with `SIGKILL` rather than waiting it out (`SIGTERM` let the CLI catch the
  interrupt and quietly re-prompt itself instead of stopping). On Telegram,
  if a live tool-call status draft is open, it's finalized in place with a
  "Stopped by user" note instead of being abandoned or silently overwritten
  — and that's the only confirmation sent, so cancelling never produces a
  duplicate "stopped" message. See
  [docs/SLASH_COMMANDS.md](docs/SLASH_COMMANDS.md#stop).
- **Telegram group forum topics & reply context (E28).** A topic-enabled
  Telegram group the bot is added to becomes its own channel
  (`telegram:group:<chatId>`), distinct from any member's DM, derived
  per-message with no static config; each forum topic within it (including
  "General") becomes its own long-lived session, built entirely on E27's
  generic thread store with no new table. Typing indicator and live
  tool-call status updates land in the specific topic being discussed, not
  just the right group — two topics active at once in the same group never
  collide. New `create_telegram_topic` MCP tool lets the agent start a topic
  on its own initiative (gated on "Manage Topics" admin rights, verified
  before creation with a clear error if missing), always as a brand-new
  session with no prior history, optionally seeded with agent-supplied
  `context` injected into the topic's first turn only; the agent references
  the topic later via the `thread:<hash>` topic the tool returns. `reply_to`
  (already accepted by `send_message`/`reply`) is now functional on
  Telegram — resolved server-side to the target message's platform ID and
  turned into a native reply quote, dropped (not blocking delivery) if the
  target chat doesn't match, the message was deleted, or the target is
  already the latest inbound message (quoting it would be redundant).
  Inbound quote-replies are surfaced to the agent as `[Replying to
  <sender>: "<text>"]` context, never forking the session. No new
  authorization mechanism — the existing sender allowlist already gates
  groups exactly like DMs. See
  [docs/TELEGRAM_ADAPTER.md](docs/TELEGRAM_ADAPTER.md#group-topics-and-replies).

### Changed
- **Generalized per-thread session storage (E27).** Email's bespoke
  `email_threads` table is replaced by a channel-agnostic `threads` table
  (migration `012_threads.sql`, zero data loss) and a shared
  `src/pipeline/thread-store.ts` module
  (`getThread`/`upsertThread`/`patchThreadMetadata`), so a future channel can
  add its own per-thread sessions with no schema change. Internal-only —
  email threading behavior is unchanged. See
  [docs/THREADING.md](docs/THREADING.md).
- **Adapter channel resolution now supports a dynamically-derived channel**
  (`AdapterInstance.ownsChannel`, E28) — outbound delivery, `react_to_message`,
  slash-command replies, pause checks, and the typing/tool-call-status
  endpoints all resolve a Telegram group channel the same way they resolve a
  DM one, with no new per-group registration.
- **`pipeline.routes`/`pipeline.relays` matching also recognizes a group
  derived from a configured channel** (`channelMatches()`, E28) — a
  `match.channel` rule written against a bot's DM channel (e.g.
  `telegram:peggy`) now also matches any group under it
  (`telegram:peggy:group:<chatId>`), so an existing route/relay config keeps
  working for groups with no changes. Fixes a bug where the very first live
  group message after this branch landed fell through to the default
  `claude-code` route instead of the configured `cc-headless` agent, since
  route-resolve previously compared channels with exact string equality.

### Fixed
- **`send_message` had no `topic` param and hard-coded `"general"` in the
  envelope (E28).** Passing a `create_telegram_topic`-returned `thread:<hash>`
  topic — as `metadata.topic` or otherwise — was silently ignored, so the
  message always landed in the group's General topic even though S28.3's
  outbound resolution (`resolveSendTarget` in `src/adapters/telegram.ts`) was
  already correctly wired to `envelope.topic`. `send_message` now accepts an
  optional `topic` (default `"general"`), documented in
  [docs/MCP_TOOLS.md](docs/MCP_TOOLS.md#send_message) alongside the existing
  `schedule_message` `topic` param it mirrors.

## [0.8.0] - 2026-08-12

### Added
- **Pebble Ring webhook channel (E25).** New `POST /api/v1/webhooks/pebble`
  receive-only ingress for the Pebble Ring Index 01's voice-memo webhook
  (`multipart/form-data`: `transcription`, `recordedAt`, `client`). The
  `Authorization: Bearer <token>` header doubles as sender identity —
  resolved directly against `contacts[*].platforms.pebble.token` — with no
  fallback for an unrecognized token (always a hard 401). See
  [docs/PEBBLE_ADAPTER.md](docs/PEBBLE_ADAPTER.md).
- **Channel relay: content-transform routing (E26).** New
  `pipeline.relays[]` config and `channel-relay` pipeline stage (Stage 25):
  a message matching a relay rule is re-submitted as a brand-new inbound
  message on a different channel, with its body rendered through a
  `{{body}}`/`{{sender}}`/`{{channel}}` template, sender preserved. Runs the
  full pipeline again on the new channel (dedup, routing, delivery); the
  original message's pipeline run is aborted. Bounded to 3 hops to guard
  against a misconfigured relay cycle. See
  [docs/CHANNEL_RELAY.md](docs/CHANNEL_RELAY.md).
- **`bus.host` config option.** bus-core's HTTP server bound `127.0.0.1`
  unconditionally; a webhook channel whose sender lives on another device
  (e.g. Pebble via a reverse proxy on a different LAN host) needs it
  reachable from outside loopback. Defaults to `127.0.0.1` (unchanged
  behavior); set to `0.0.0.0` to accept LAN connections — widening this
  exposes every other HTTP route too, so set `bus.auth_token` alongside it
  if anything besides your intended proxy path can reach the port. See
  [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#exposing-bus-core-to-a-reverse-proxy).

### Fixed
- Image/file-only Telegram messages (no caption) were silently dropped before
  reaching the agent's queue, even though the attachment downloaded
  successfully — Stage 10 (`normalize`) rejected any empty `payload.body`
  without checking `metadata.attachments`. The stage now allows an empty body
  when attachments are present, matching the guard already in place in
  `src/http/api.ts`. See [docs/ATTACHMENTS.md](docs/ATTACHMENTS.md).
- `make logs`, `make status`, and `make restart` now scope to the `bus-core`
  pm2 process (via `pm2 logs bus-core` / `pm2 describe bus-core`) instead of
  operating against the whole shared pm2 daemon, which previously mixed in
  processes and logs from unrelated projects. Note `pm2 describe` can print
  secrets from divergent shell env vars to the terminal — see
  [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#daily-operations).

## [0.7.1] - 2026-07-01

### Added
- **Multi-instance `cc-headless` adapter (E23).** `adapters.cc-headless` now
  accepts a named record — the same pattern already used by `adapters.telegram`
  and `adapters.email` — so one bus-core process can run multiple headless
  agents (e.g. `peggy` and `pokeclaude`) concurrently, each with its own
  `agent_id`, poll loop, `working_dir`, and journaling config, fully isolated
  from the others. The single-object config form still works unchanged.
  New `sessions.agent_id` column (migration 011) records which instance owns
  a session so journaling-on-pause and `/clear` route to the correct agent;
  sessions with no `agent_id` (pre-migration, or single-instance deployments)
  fall back to the sole configured instance. See
  [docs/CC_HEADLESS_ADAPTER.md](docs/CC_HEADLESS_ADAPTER.md#multi-instance-deployments).

## [0.7.0] - 2026-07-01

### Added
- **`model` config key for the `cc-headless` adapter.** `adapters.cc-headless.model`
  is passed as `--model` to `claude -p` when set, letting each headless agent
  pin its model explicitly in `config.yaml` instead of relying on the CLI
  default or a per-agent `.claude/settings.json`.
- **`error_passthrough` config key for the `cc-headless` adapter.**
  `adapters.cc-headless.error_passthrough` (default `false`), when enabled,
  appends the raw `claude -p` failure detail (exit code, stderr tail, or
  `claude reported error: ...`, truncated to 500 chars) to `error_reply`
  before delivering it to the user, instead of only logging it server-side.

## [0.6.0] - 2026-07-01

### Added
- **Inbound email attachments (E22).** The `email` adapter now downloads file
  attachments from incoming mail, reaching parity with Telegram. Real
  attachments (`Content-Disposition: attachment`) are surfaced to the agent as
  `[Image: …]` / `[File: … — name]` lines; inline HTML-embedded images
  (signature logos etc.) are persisted but kept out of the agent's context and
  exposed via a new **`fetch_attachment`** MCP tool (backed by
  `GET /api/v1/attachments/:id`) so the agent can pull one in on demand. Reuses
  the existing per-agent `media` config, `attachments` table, and TTL sweeper.
  The shared helpers (`extensionFor`, `resolveMediaConfig`, and a new
  `persistAttachmentBuffer`) moved from `telegram.ts` to a shared
  `src/media/attachments.ts` (re-exported from `telegram.ts` for compatibility).
  Outbound email attachments remain out of scope.

## [0.5.0] - 2026-06-23

### Added
- **Email channel (E21).** New in-process `email` adapter
  (`src/adapters/email.ts`) that receives mail over IMAP IDLE (push) and sends
  replies over SMTP, with defaults tuned for iCloud. Each email **thread** maps to
  its own long-lived session: a stable thread key (root of `References` /
  `In-Reply-To` / own `Message-ID`) is hashed into a reserved `thread:<hash>`
  topic, so the existing `conversation_id` machinery gives one session per thread
  and branches a forward into a new one automatically. Replies thread correctly
  (`In-Reply-To`/`References`/`Re:` subject/original `To`), backed by a new
  `email_threads` table (migration 010). Two gates protect the inbox: a sender
  **allowlist** (`contacts[*].platforms.email.address`, string or list) and an
  **anti-spoofing check** (`require_auth`, default true) that trusts a passing
  `Authentication-Results` header when present and otherwise verifies the
  message's DKIM signature against DNS via `mailauth` — necessary because some
  providers (e.g. iCloud, intra-provider) never stamp that header yet still
  DKIM-sign the mail. Multiple mailboxes run as named instances (`email:peggy`, `email:work`), like
  Telegram. "Longer, more thorough" email replies are a system-prompt concern
  keyed on `{{channel}}` (no renderer change). See `docs/EMAIL_ADAPTER.md` and
  `_bmad-output/epics/E21-email-channel.md`.
- **`send_email` MCP tool (E21).** Lets the agent start a *new* email thread to the
  user (vs. `reply`, which threads into a received message). Defaults the recipient
  to the first allowlisted address (`contacts[*].platforms.email.address`, config
  order) and accepts an explicit `to` only if it is on that allowlist — any other
  address is rejected with nothing sent. The email adapter re-checks the allowlist
  on send for a raw address as defense in depth, so the agent can never email an
  arbitrary recipient. The message is routed to the owning `contact:<id>` (the
  delivery worker only dispatches `contact:`-prefixed recipients) with the exact
  address in `metadata.email_to`. An optional `subject` (carried in
  `metadata.email_subject`) sets the subject line, defaulting to "Message from your
  assistant". Registered automatically whenever an email adapter is configured. See
  `docs/MCP_TOOLS.md`.
- **Rich-text email (E21).** Outbound mail is now sent `multipart/alternative`: the
  agent's Markdown is rendered to a styled HTML part (`src/adapters/email-render.ts`,
  via `markdown-it`) with the original Markdown kept as the plain-text fallback. GFM
  **tables** render with bordered cells, a shaded header, zebra rows, and a
  horizontal-scroll wrapper for mobile; headings, lists, blockquotes, links, inline
  code, and fenced code blocks are all styled. Renders consistently across browser,
  desktop, and mobile clients via fully inlined styles (clients strip `<style>`),
  with a `<style>` block only for dark-mode and mobile media queries, a responsive
  viewport, `color-scheme` hints, and `x-apple-disable-message-reformatting`. Raw
  HTML in the agent's text is escaped (`html: false`) — no injection surface. See
  `docs/EMAIL_ADAPTER.md`.

### Changed
- `topic-classify` now preserves reserved `thread:`-prefixed topics verbatim, and
  `priority-score` excludes them from the non-general topic bonus
  (`THREAD_TOPIC_PREFIX` in `src/pipeline/types.ts`). `contact-resolve` resolves
  email senders to contacts via a case-insensitive address map.
- No typing indicator for email channels: the headless and polling Claude Code
  adapters skip the `/typing` call for `email`/`email:*` channels (the email adapter
  reports `typing: false`, so the server already no-ops — this avoids the wasted
  round-trip).
- Inbound body handling now distinguishes replies from forwards
  (`selectInboundBody`): a threaded reply (has `In-Reply-To`/`References`) still has
  its quoted history stripped (the session holds those turns), but a new thread — a
  first-contact email or a **forward** — keeps its full body. Forwards are tagged
  `metadata.email_is_forward`.

### Fixed
- Forwarded emails no longer lose their content. The inbound body is now resolved by
  classifying the message (`resolveInboundText` + `selectInboundBody`): a forward
  (detected by a `Fwd:` subject or a forwarded-message marker, which also overrides
  any `References` a forwarding client adds) **prefers the HTML conversion** and keeps
  the full body, while a threaded reply uses the text part and strips its quoted
  history. This fixes three compounding bugs: (1) unconditional quote-stripping cut at
  the forwarded `From:`/header block and discarded the payload; (2) a forwarded
  HTML-only mail with an empty `text/plain` part yielded only the
  `[Email with no text body]` placeholder; and (3) an inline HTML forward (Apple
  Mail) whose `text/plain` part held the note + `Begin forwarded message:` headers but
  an **empty forwarded body** delivered the note and marker with nothing after it —
  the forwarded payload (including tables) now comes through via the HTML conversion.

## [0.4.0] - 2026-06-18

### Added
- `/clear` slash command: start a fresh headless session on demand. Closes the
  sender's active session on the originating channel immediately (the next
  message spawns a fresh `claude -p` with no `--resume`), then journals the
  now-closed session in the background by resuming its `claude_session_id` so the
  agent updates its memory files one last time. Channel-scoped and degrades
  gracefully when the headless adapter isn't running. New
  `HeadlessHandle.journalResumeId` hook, exposed to commands via a late-bound
  `headlessControl` holder. See `docs/SLASH_COMMANDS.md`.

### Fixed
- Telegram slash-command autocomplete now reflects the live command registry.
  The adapter registered commands only in the `default` scope, so a stale
  `all_private_chats` set (e.g. `/start, /help, /status` left by BotFather)
  permanently shadowed it in 1:1 chats and new commands never appeared.
  `registerCommands` now writes both the `default` and `all_private_chats` scopes
  and confirms against the private-chat scope on startup.
- Headless adapter (`cc-headless`) now passes `--verbose` alongside
  `--output-format stream-json`, which the Claude CLI requires in `--print`
  mode. Without it every invocation failed fast with `When using --print,
  --output-format=stream-json requires --verbose` and the agent never replied.
- Headless adapter now spawns `claude -p` with `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`,
  so the CLI's native auto-memory no longer loads `MEMORY.md` a second time on top
  of the adapter's own `{{memories}}` injection. Eliminates a duplicate
  per-turn memory block (token waste + confusion) for every headless agent.

## [0.3.0] - 2026-06-18

### Added
- Journaling memory model (E20): the agent's own files (`MEMORY.md` + daily
  journal) are the source of truth. The headless adapter assembles `MEMORY.md`
  and the configured `journal_lookback_days` of daily files into every turn's
  context (`assembleMemoryContext`, `src/adapters/memory-context.ts`), replacing
  the DB memory/summary injection. New `adapters.cc-headless.memory` config block.
- Long-lived headless sessions (E20): headless conversations are never
  force-closed on idle (`ended_at` stays `NULL`) and resume is keyed on
  `conversation_id`, so the same `claude_session_id` continues across pauses.
  Scoped to headless sessions via the `claude_session_id IS NOT NULL`
  discriminator; the MCP `cc.ts` path is unaffected. Context growth is bounded by
  Claude Code auto-compaction.
- Journaling on pause (E20): when a conversation goes idle past a per-channel
  threshold, the bus fires a silent `--resume` journaling turn that asks the
  agent to update its memory files and delivers nothing to the user
  (`SessionTracker.dispatchJournaling` + the adapter's `runJournalingTurn`). New
  `adapters.cc-headless.journaling` config block; migration 009 adds
  `sessions.last_journaled_at`. See `docs/MEMORY_MODEL.md`.

### Changed
- The session idle threshold is now a **journaling** trigger for headless
  sessions, not session teardown. (E20)
- Structured memory extraction is **off by default** (`memory.structured_extraction`,
  default `false`): the summarizer writes neither `memories` nor
  `session_summaries` unless re-enabled. The tables/migrations are left dormant
  and `recall_memory`/`log_memory` are marked legacy (not removed) so MCP-adapter
  deployments are unaffected. (E20)

## [0.2.0] - 2026-06-16

### Added
- Headless Claude Code adapter (`cc-headless`): spawns `claude -p` per message
  batch with per-contact serialization and session continuity via `--resume`
  (`sessions.claude_session_id`, migration 008). System prompt template with
  `{{variable}}` interpolation and `@path` file references; memories and last
  session summary injected directly into the system prompt. (E19)
- `AGENTBUS_TOOLS_ONLY` mode in `cc.ts` so it can serve as the MCP tool
  subprocess without running the polling loop. (E19)
- Reply control for the headless adapter: the agent delivers via the
  `reply`/`send_message` tools (interim updates + final answer) with a stdout
  fallback when no delivery tool is called. (E19.1)
- Typing indicator and configurable `error_reply` on invocation failure for the
  headless adapter; configurable `working_dir` so the agent's own `CLAUDE.md`
  auto-loads into context. (E19.1)
- Semantic-versioning workflow: `CHANGELOG.md`, `release:*` npm scripts, and the
  `/api/v1/health` endpoint now reports the version from `package.json`.

### Fixed
- Double memory injection on new headless sessions: `formatMessagesForSampling`
  gained `includeMemoryContext`; the headless path passes `false` since it
  injects memory via the system prompt. (E19.1)

## [0.1.0] - 2026-05-26

Baseline release. Core bus, pipeline, adapters, memory, scheduling.

### Added
- Bus core: config loader, SQLite client, schema + migrations, message queue,
  adapter registry. (E1)
- MCP server + HTTP API, polling Claude Code adapter, `reply` /
  `get_adapter_status` tools. (E2)
- Telegram adapter: inbound/outbound, typing indicator, reactions, attachments
  (image + document handling). (E3, E10, E17)
- In-process platform-adapter architecture with `DeliveryWorker`. (ARCH)
- Inbound processing pipeline (normalize → contact-resolve → dedup →
  slash-command → topic-classify → priority-score → route-resolve →
  transcript-log → memory-inject). (E5, E9)
- Memory subsystem: transcript logging, session tracker, summarizer, memory
  lifecycle with FTS5; channel-scoped memories and session summaries. (E8, E9)
- MCP tool suite: channels, messaging, memory, sessions, reactions, scheduling.
  (E7, E18)
- Built-in slash commands + plugin command registry. (E6)
- Scheduled messages (cron + one-shot) via background scheduler. (E18)

[Unreleased]: https://github.com/ChrisPatten/agentbus/compare/v0.13.0...HEAD
[0.13.0]: https://github.com/ChrisPatten/agentbus/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/ChrisPatten/agentbus/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/ChrisPatten/agentbus/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/ChrisPatten/agentbus/compare/v0.8.0...v0.10.0
[0.8.0]: https://github.com/ChrisPatten/agentbus/compare/v0.7.1...v0.8.0
[0.7.1]: https://github.com/ChrisPatten/agentbus/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/ChrisPatten/agentbus/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/ChrisPatten/agentbus/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/ChrisPatten/agentbus/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/ChrisPatten/agentbus/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/ChrisPatten/agentbus/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/ChrisPatten/agentbus/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/ChrisPatten/agentbus/releases/tag/v0.1.0

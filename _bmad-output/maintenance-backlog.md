# Maintenance and cleanup backlog

Findings from a full code review of `dev` at `ea82da4` (2026-09-14). Each item is
small enough to pick up on its own. Batch related items into a maintenance epic
before implementing, per `CLAUDE.md`. Check items off here as they land.

Baseline at review time: `npx tsc --noEmit` clean, `npx vitest run` 824 passing.

Priority key:

| Priority | Meaning |
|---|---|
| P0 | Broken behavior. Fix first. |
| P1 | Wrong or misleading behavior, or a real operational risk. |
| P2 | Dead code, duplication, or structure that slows every change. |
| P3 | Tooling and repository hygiene. |

Effort: S (under an hour), M (an afternoon), L (a day or more).

---

## P0: Broken behavior

- [ ] **`POST /api/v1/model-overrides` always returns 500.** (S)
  `src/http/api.ts:1461` upserts with `ON CONFLICT(schedule_id, agent_id)`, but
  the only unique index on `headless_model_overrides` is partial
  (`WHERE schedule_id IS NOT NULL OR agent_id IS NOT NULL`, migration 015).
  SQLite rejects the statement with `ON CONFLICT clause does not match any
  PRIMARY KEY or UNIQUE constraint`, so every call fails. This breaks the
  `set_headless_model` MCP tool end to end. Verified against a migrated
  in-memory database: both a scoped and a global override return
  `{"ok":false,"error":"Failed to set model override"}`.
  Fix: call `setModelOverride()` from `src/adapters/model-override-loader.ts`
  (it uses `IS ?` matching and handles NULL scopes), or add the index's
  `WHERE` clause to the conflict target and handle the global case separately.
  Add an HTTP-level test in `src/http/api.test.ts`; today the route has none
  (the tool test mocks `fetch`, the loader test never hits the route).

## P1: Correctness and operational risk

- [ ] **`dead_letter` count is always 0 in `/status` and `/api/v1/health`.** (S)
  `MessageQueue.counts()` (`src/core/queue.ts:376`) groups `message_queue.status`,
  but dead-lettered rows are moved to the separate `dead_letter` table. Count
  that table instead.

- [ ] **Delivery retry path is dead code.** (M)
  `src/core/delivery.ts:98-103` checks `retryable` and `MAX_RETRIES`, then
  dead-letters anyway. `metadata.retry_count` is never incremented and the
  `retry_count` column is never used. Either implement retry (reset to
  `pending`, bump `retry_count`, back off) or delete the branch and the
  constant, and correct the docs that promise retries.

- [ ] **`--rebuild-fts` does not exit.** (S)
  `src/index.ts:69-71` rebuilds the index and then continues normal startup.
  Docs said the process exits. Decide which behavior you want; a dedicated
  maintenance subcommand that exits is the safer choice for a pm2 deployment.

- [ ] **Schedule-scoped model overrides never apply.** (S)
  `src/adapters/cc-headless.ts:660` passes `scheduleId: undefined` (see the
  TODO). The scheduler already stamps `metadata.schedule_id` on every fired
  message, so `processBatch()` can read it from the first envelope and pass it
  through.

- [ ] **Delivered rows are never purged from `message_queue`.** (S)
  `sweepExpired()` only touches `pending` rows with an `expires_at`. Delivered
  rows accumulate forever and the `delivered` counter in `/status` grows
  without bound. Add a retention sweep (for example, delete `delivered` rows
  older than 7 days) to the maintenance timer in `src/index.ts:168`.

- [ ] **The original `envelope.timestamp` is dropped on enqueue.** (M)
  `enqueue()` never stores it and `rowToQueuedMessage()` overwrites it with
  `created_at`. Recorded-at times (Pebble memos, scheduled fires) survive only
  in `metadata`. Either persist it (new column) or document that `timestamp`
  means enqueue time.

- [ ] **Auth exemption for `/api/v1/health` is an exact string match.** (S)
  `src/http/api.ts:504` compares `req.url`, so `/api/v1/health?x=1` requires a
  token. Match on the path. While there, switch the token compare to
  `crypto.timingSafeEqual` (one line; the comment already recommends it).

- [ ] **Headless MCP config path depends on `process.cwd()` and `src/`.** (M)
  `buildMcpConfig()` (`src/adapters/cc-headless.ts:149`) points the MCP
  subprocess at `<cwd>/src/adapters/cc.js` via `npx tsx`. This breaks when
  bus-core runs from `dist/` (`npm start`) or from another directory. Resolve
  the path from `import.meta.url` and decide whether `dist/` is a supported
  run mode at all (see the run-mode item under P3).

- [ ] **Telegram username lookup in contact-resolve is unreachable.** (S)
  `src/pipeline/stages/contact-resolve.ts:63` falls back to a username map, but
  the adapter always submits the numeric user id as `sender`. Remove the map or
  make the adapter send usernames when present.

- [ ] **Global model overrides accumulate and can't be deleted individually.** (S)
  The partial unique index deliberately allows many `(NULL, NULL)` rows, but
  `DELETE /api/v1/model-overrides` rejects a request with neither id, so a
  global override can only be removed with `all=true`. Enforce one global row
  (or allow `scope=global` on delete) once the P0 item lands.

## P2: Dead code and unused surface area

- [ ] **Config fields that nothing reads.** (S)
  `bus.log_level`, `pipeline.stages`, `adapters.claude-code.sampling_max_tokens`,
  `adapters.*.plugin`, and the whole `adapters.bluebubbles` block
  (`src/config/schema.ts`). No BlueBubbles adapter exists and no plugin loader
  exists (E4 and E11 were never implemented). Remove the fields or implement
  the features; today they validate silently and mislead operators. Also drop
  `BLUEBUBBLES_PASSWORD` from `.env.example`.

- [ ] **`src/mcp/sampling-queue.ts` is unused.** (S)
  Only its test imports it. E13 shipped channel notifications instead of
  `sampling/createMessage`. Delete the module and test.

- [ ] **`model-override-loader.ts` is mostly dead and duplicated.** (S)
  Only `resolveModelOverride()` is called. `listModelOverrides`,
  `setModelOverride`, `deleteModelOverride`, and `clearAllModelOverrides`
  re-implement SQL that `src/http/api.ts:1447-1561` writes inline. Make the
  routes call the loader (this also fixes the P0 item).

- [ ] **Unused dependencies.** (S)
  `uuid` and `@types/uuid` have no importers; the code uses
  `node:crypto` `randomUUID`. Remove them.

- [ ] **Small dead exports and parameters.** (S)
  `src/index.ts:236` exports `config`, `queue`, `registry` that nothing
  imports. `createRouteResolve(config, _db)` ignores `_db`.
  `src/adapters/telegram.ts:37` re-exports `extensionFor`/`resolveMediaConfig`
  for "backwards-compatible imports" that no longer exist. `TODO(E9)` at
  `src/commands/handlers.ts:152` is stale.

- [ ] **Obsolete "table not initialized" guards.** (S)
  Migrations guarantee `scheduled_items`, `memories`, `memories_fts`, and
  `transcripts_fts` exist, yet `src/commands/handlers.ts:226,277` and
  `src/http/api.ts:760,1082,1142` still probe `sqlite_master` and return
  `available: false`. Remove the guards, the matching tool branches, and the
  doc text that describes them.

- [ ] **Hardcoded MCP server version.** (S)
  `src/mcp/server.ts:9` reports `0.1.0`. Import `VERSION` from
  `src/version.ts` (the versioning doc already says never to hardcode it).

- [ ] **Duplicated doc comment in `src/http/api.ts`.** (S)
  Lines 101-109 and 129-140 are the same `InboundSchema` comment. Keep one.

- [ ] **Zod v4 style.** (S)
  `z.ZodIssueCode.custom` in `src/config/schema.ts` is the v3 spelling; use
  `code: 'custom'`. `PipelineConfigSchema`, `priority_weights`, and
  `scheduler` pass full default objects to `.default()` that duplicate the
  inner field defaults; `.prefault({})` (already used elsewhere in the file)
  removes the duplication.

- [ ] **Rename `formatMessagesForSampling`.** (S)
  The name is a leftover from the abandoned sampling design; it formats
  channel-notification and headless prompts. `formatMessagesForDelivery`
  reads correctly.

## P2: Duplication and structure

- [ ] **Split `src/http/api.ts` (1,703 lines).** (L)
  One file holds `processInbound()`, the command dispatcher, and every route.
  Suggested split: `src/pipeline/inbound.ts` (`processInbound`,
  `sendCommandResponse`), then route modules under `src/http/routes/`
  (messages, adapters, sessions, transcripts, memories, schedules,
  model-overrides, webhooks). Adapters, the scheduler, and the relay stage
  currently import `processInbound` from the HTTP layer, which inverts the
  dependency direction; the split fixes that too.

- [ ] **Split `src/adapters/telegram.ts` (1,415 lines).** (M)
  The live tool-call draft/status stream (~200 lines) and attachment download
  (~120 lines) are self-contained and can move to sibling modules.

- [ ] **`nextCronFire` is duplicated.** (S)
  `src/scheduler/scheduler.ts:69` and the inline `await import('croner')` in
  `src/http/api.ts:1235`. Export one helper and import `croner` statically.

- [ ] **Envelope rehydration is written three times in `src/core/queue.ts`.** (S)
  `rowToQueuedMessage()`, `deadLetter()`, and `sweepExpired()` each build the
  envelope by hand. Use the helper in all three.

- [ ] **Model-override resolution logic exists in three places.** (S)
  `resolveModelOverride()`, the `ORDER BY CASE` in the GET route, and a
  client-side re-implementation in `get_headless_model`
  (`src/mcp/tools/model-overrides.ts:132-159`). Add
  `GET /api/v1/model-overrides/resolve?agent_id=&schedule_id=` backed by the
  loader and make the tool call it.

- [ ] **`HeadlessInstance.invokeClaude()` takes nine positional parameters.** (S)
  Three of them are callbacks. Convert to an options object.

- [ ] **Migrations are a hand-maintained array.** (S)
  `src/db/schema.ts:14-93` lists every file. Glob `NNN_*.sql` from the
  directory and derive the version from the filename.

- [ ] **Logging is ad hoc.** (M)
  About 150 `console.*` calls with inconsistent `[tag]` prefixes across the
  codebase, and `bus.log_level` is never applied. Adopt one logger (Fastify
  already bundles pino; the server is created with `logger: false`) with a
  child logger per module, and honor `log_level`.

- [ ] **Timestamp formats are inconsistent across tables.** (S)
  `attachments.created_at`/`expires_at` are epoch milliseconds; every other
  table uses ISO 8601 strings. Document the exception in the schema comment
  or normalize with a migration.

- [ ] **Personal environment details are baked into core code and scripts.** (M)
  `src/commands/torrent.ts:33` hardcodes
  `/Users/chrispatten/.../torrent_to_books.sh`;
  `scripts/send_direct_email.py` hardcodes an iCloud account;
  `scripts/safe_restart.sh` hardcodes `CHRIS_EMAIL`. Move paths and
  addresses to `config.yaml` or environment variables, and consider moving
  operator-specific commands and scripts to an `examples/` or private
  directory. The repository is public.

- [ ] **`cc-headless.ts` loads config at import time.** (S)
  `src/adapters/cc-headless.ts:41-42` calls `loadConfig()` as a module side
  effect, a second time per process. Pass `config` into `startHeadless()`.

- [ ] **`.env.example` and `config.yaml.example` disagree on variable names.** (S)
  The example config references `TELEGRAM_BOT_TOKEN`; the env example defines
  `TELEGRAM_BOT_TOKEN_PEGGY` and `TELEGRAM_BOT_TOKEN_POKECLAUDE`. Align them.

- [ ] **Decide the future of the legacy memory and MCP-polling subsystems.** (L)
  The E8/E9 structured store (`Summarizer`, `memories` and `session_summaries`
  tables, the `memory-inject` stage, `recall_memory`/`log_memory` tools) is
  dormant by default, and the polling MCP adapter (`src/adapters/cc.ts` without
  `AGENTBUS_TOOLS_ONLY`) is documented as legacy. Together they are roughly
  900 lines plus three tables. Either commit to keeping them (and test the
  `structured_extraction: true` path in CI) or retire them behind a
  deprecation notice and a cleanup migration.

## P3: Tooling and repository hygiene

- [ ] **No CI runs the tests.** (S)
  `.github/workflows/` contains only the Pages deploy. Add `ci.yml` that runs
  `npx tsc --noEmit` and `npx vitest run` on pull requests and pushes to
  `dev` and `main`.

- [ ] **No lint or format tooling.** (M)
  Add ESLint (typescript-eslint) and Prettier with `npm run lint`,
  `npm run format`, and `npm run typecheck` scripts. Add `engines.node` to
  `package.json` (the deployment doc says Node 20+).

- [ ] **`scripts/*.ts` are not type-checked.** (S)
  `tsconfig.json` includes only `src/`. `scripts/backfill_turn_costs.ts`
  imports from `../src` and can drift. Add a `tsconfig.scripts.json` or widen
  `include`.

- [ ] **Decide whether `dist/` is a supported run mode.** (S)
  `npm run build` and `npm start` exist, but pm2 runs `tsx src/index.ts`, the
  headless MCP config spawns `npx tsx src/...`, and `tsx` is a dev
  dependency. Either make the compiled path work or remove the `build`/`start`
  scripts and say so in the deployment doc.

- [ ] **Stale git and working-tree state.** (S)
  All 16 local feature branches are merged into `dev` and can be deleted. The
  worktree at `.claude/worktrees/e30-decoupled-memory-logging` is for a branch
  merged in PR #1; remove it with `git worktree remove`. An untracked
  `_bmad-output 2/` directory (a Finder-style duplicate) holds Siri-bridge
  epics numbered E36-E41 that collide with the real E36-E41; rename or fold
  them in. `config.yaml.bak.*` and `config.yaml.servermode.bak` in the root
  are ignored but cluttering.

- [ ] **Prune `_bmad-output/backlog.md`.** (S)
  Most entries are struck-through completed items. Move them to a "Done"
  section at the bottom or delete them so open ideas are scannable.

- [ ] **`sprint-status.yaml` is stale.** (S)
  `current_epic: E23` while E40 is complete and E41 is planned.

- [ ] **One-off scripts.** (S)
  `scripts/smoke-e27-e28.sh` and `scripts/diag-telegram-admin-rights.sh` are
  epic-specific. Generalize them into a reusable smoke test or move them to
  `scripts/archive/`.

- [ ] **Test coverage reporting.** (S)
  824 tests pass but nothing reports coverage. Enable `vitest --coverage`
  (v8) in CI so the untested `POST /api/v1/model-overrides` class of gap
  shows up.

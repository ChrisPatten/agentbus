# Changelog

All notable changes to AgentBus are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Versions are tracked via `package.json` and git tags (`vX.Y.Z`), created with
`npm run release:patch|minor|major`. See [docs/VERSIONING.md](docs/VERSIONING.md).

## [Unreleased]

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

[Unreleased]: https://github.com/ChrisPatten/agentbus/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/ChrisPatten/agentbus/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/ChrisPatten/agentbus/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/ChrisPatten/agentbus/releases/tag/v0.1.0

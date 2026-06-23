# Changelog

All notable changes to AgentBus are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Versions are tracked via `package.json` and git tags (`vX.Y.Z`), created with
`npm run release:patch|minor|major`. See [docs/VERSIONING.md](docs/VERSIONING.md).

## [Unreleased]

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

[Unreleased]: https://github.com/ChrisPatten/agentbus/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/ChrisPatten/agentbus/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/ChrisPatten/agentbus/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/ChrisPatten/agentbus/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/ChrisPatten/agentbus/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/ChrisPatten/agentbus/releases/tag/v0.1.0

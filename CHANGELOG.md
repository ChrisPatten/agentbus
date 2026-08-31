# Changelog

All notable changes to AgentBus are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Versions are tracked via `package.json` and git tags (`vX.Y.Z`), created with
`npm run release:patch|minor|major`. See [docs/VERSIONING.md](docs/VERSIONING.md).

## [Unreleased]

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

### Changed
- `send_message`'s tool description now points agents at `get_session`/
  `list_sessions` to look up a conversation's current `topic` before sending,
  instead of guessing one (docs-only, no behavior change).

### Added
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
  [docs/CC_HEADLESS_ADAPTER.md](docs/CC_HEADLESS_ADAPTER.md#memory-logging-e30).

### Changed
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
- **Bus-scope slash-command responses now reply in the originating Telegram
  forum topic instead of General.** The response envelope built in
  `src/http/api.ts` hardcoded `topic: 'command'`, which never matched
  `TelegramAdapter`'s `thread:<id>` topic convention, so `resolveSendTarget()`
  always fell back to the group's General topic regardless of which topic a
  command like `/stop` was run from. It now preserves the inbound envelope's
  `topic`.

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
  [docs/TELEGRAM_ADAPTER.md](docs/TELEGRAM_ADAPTER.md#live-tool-call-status-stream-e29).
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
  [docs/TELEGRAM_ADAPTER.md](docs/TELEGRAM_ADAPTER.md#group-topics--replies-e28).

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
  [docs/CC_HEADLESS_ADAPTER.md](docs/CC_HEADLESS_ADAPTER.md#multi-instance-deployments-e23).

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

[Unreleased]: https://github.com/ChrisPatten/agentbus/compare/v0.10.0...HEAD
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

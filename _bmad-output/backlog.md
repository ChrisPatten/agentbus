# AgentBus Backlog

Feature ideas and future work that hasn't been scoped into an epic yet. Promote entries here to a new epic file when prioritized.

## Ideas

### Tools component: script-backed MCP tools + macOS TCC permissions carrier
User writes a script (any language) that optionally accepts parameters and returns output, then declares it in config to expose it as an MCP tool callable by agents. The bus wraps the script, handles invocation, and returns output. Config controls which agents can call which tools (per-tool agent allowlist). Secondary role: act as a long-lived process that holds macOS TCC grants (Calendar, Contacts, Reminders, etc.) so agents can invoke sensitive system operations through it without each needing their own TCC authorization. Needs a spike covering: config schema for tool declarations, parameter passing/output capture, per-agent allowlisting, and TCC entitlement strategy.

### ~~Scheduled tasks / scheduled prompts~~ → promoted to E18 (complete 2026-04-15)

### Evaluate A2A (Agent-to-Agent) protocol adoption
Research Google's A2A protocol and assess fit for AgentBus: what it offers (agent discovery, task delegation, streaming responses), where it overlaps with current MCP+bus design, and whether to adopt it as a transport/protocol layer, expose an A2A-compatible endpoint, or skip it. Output should be a short spike doc in `_bmad-output/planning-artifacts/`.

### ~~Telegram file/attachment handling is inconsistent~~ → fixed 2026-05-12
All Telegram document types now download and deliver to agents as `file` attachments (rendered as `[File: path — filename]`). Screenshots arrive as photos and were already handled. Video/audio/voice/sticker remain out of scope. See commit `cbb816b`.

### ~~Multi-bot support: run multiple Telegram bots from a single AgentBus instance~~ → implemented 2026-04-16
Named `adapters.telegram` map with per-bot tokens and isolated channels; legacy flat config still works. See commit `6b9415a`.

<!-- Add ideas below. Format: short title, one-line description, optional notes. -->

### Email: strip token-heavy noise from forwarded/inbound bodies
Forwarded emails (especially HTML newsletters and receipts) carry a lot of content that costs tokens but adds no signal once converted to text: very long tracking/click-through URLs, `data:` URIs (inline base64 images/fonts), unsubscribe/preference footers, repeated whitespace, and link soup. The inbound path (`resolveInboundText` / `htmlToPlainText` in `src/adapters/email-render.ts`, plus `selectInboundBody`) currently passes the converted text through largely intact. Add a configurable cleanup pass that: truncates or drops long query-string tracking URLs (keep the host/path, strip `?utm_*`/long opaque tokens), removes `data:` URLs entirely, collapses excessive blank lines, and optionally trims known boilerplate footers (unsubscribe blocks). Keep it conservative (never drop the user's note or core forwarded content) and measure token savings on a few real forwards. Consider a per-adapter `inbound_cleanup` config toggle and a max-body-size guard.

### get_transcript MCP tool: fetch full session transcript by ID
Agent can already search transcripts (FTS5) and list/get sessions, but cannot retrieve the full ordered message history for a specific session. Add a `get_transcript` MCP tool backed by a new `GET /api/v1/sessions/:id/transcript` endpoint that returns all transcript rows for a session in chronological order. Enables the agent to pull full conversation context when a memory reference or `list_sessions` result points to a relevant prior session.

### ~~Headless Claude Code adapter (per-request `claude -p`)~~ → promoted to E19 (backlog 2026-05-26)
See `docs/CC_HEADLESS_ADAPTER.md` and E19 in `sprint-status.yaml`.

### ~~Multi-agent `cc-headless`: run every agent headless in one bus-core process~~ → promoted to E23 (backlog 2026-07-01)
See `_bmad-output/epics/E23-multi-instance-cc-headless.md`.

### Slash command cleanup: retire replay + legacy DB-memory commands
The built-in command set still carries surfaces tied to subsystems that E20 left dormant or that no longer earn their place. Prune them and tighten the registry:
- **Replay family** — `/replay`, `/next`, `/cancel` (paginated transcript playback in `src/commands/handlers.ts`, plus `playbackStates` and `paginateLines`). Rarely used; the transcript/`get_transcript` path is the better tool.
- **Legacy memory commands** — `/forget` (expires `memories` rows) and `/retry_summary` (re-queues summarization). Both target the E8/E9 structured-memory store, which E20 turned off by default (`memory.structured_extraction: false`) in favor of the agent's own files. With the DB store dormant these are vestigial for headless agents.

Scope: remove the handlers + their registrations in `createBuiltinCommands`, drop the now-dead helpers/state, prune the tests, and update `docs/SLASH_COMMANDS.md`. Decide whether to keep `/forget` behind a capability check for any remaining MCP-store deployments or delete outright. Net effect: the autocomplete menu and `/help` shrink to the commands that still matter (`/status`, `/pause`, `/resume`, `/sessions`, `/schedule`, `/clear`, `/help`).

### Relay Claude Code permission prompts to user
When Claude Code surfaces a permission prompt (tool approval request), relay it to the user via the appropriate channel so they can approve or deny without being at the terminal. See https://code.claude.com/docs/en/channels-reference#relay-permission-prompts

### ~~Inbound emoji reactions: deliver user reactions to agents~~ → complete 2026-05-12
Telegram adapter subscribes to `message_reaction_updated`; net emoji diff (added > removed) delivered as `{ type: 'reaction'; emoji; removed; target_message_id }` payload. CC adapter renders as `[reacted 👍 to message 555:42]`. Custom-emoji-only and anonymous-admin reactions are skipped. See commit message for details.

### ~~CC adapter: include message timestamp in agent delivery~~ → complete 2026-04-16
`formatMessagesForSampling` now appends ` at <ISO timestamp>` to each message header when `envelope.timestamp` is present.

### ~~Telegram: implement emoji reactions via sendReaction API~~ → complete (E10, 2026-04-13)
`react()` implemented in `TelegramAdapter`; platform_message_id encoded as `{chatId}:{messageId}`. See `sprint-status.yaml` S10.3.

### ~~Telegram: keep typing indicator active while agent is working~~ → complete (E10, 2026-04-13)
Persistent 4s-resend typing loop in `TelegramAdapter`; started on inbound, stopped on `send()`. See `sprint-status.yaml` S10.typing.

### ~~Telegram: defer read receipt until agent pickup~~ → complete (E10 fix, 2026-04-13)
Typing indicator deferred to CC adapter post-ack via `POST /api/v1/adapters/:id/typing`. See commit `9aac9a2`.


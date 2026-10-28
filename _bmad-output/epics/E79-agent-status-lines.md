# E79 — Agent Status Lines

| Field | Value |
|---|---|
| Epic ID | E79 |
| Dependencies | E29 (live tool-call status stream), E48 (cc-pool and its tool-status hook), E28 (topics) |
| Story Count | 5 |
| Estimated Complexity | M |
| Status | Implemented on feat/e79-agent-status-lines (S79.1-S79.5 code, tests and docs done; live check after safe restart and pool-pane hook reload pending) |

---

## Epic Summary

While an agent works, Telegram shows a live draft line of raw tool usage (`Running: <command>`, `Reading <path>`, tool names and arguments) before the reply. That is noisy and can expose file paths and message text. This epic replaces it with succinct 2-5 word human updates such as "Checking the calendar", "Reading your messages" and "Searching the files", and lets the agent write its own.

## Verified Behavior

Checked against the repo on 2026-10-27:
- `scripts/hooks/agentbus_tool_status_hook.sh` (UserPromptSubmit + PostToolUse) posts `/typing` and `/tool-status`; skips `reply`/`send_message` (and everything after delivery) and email channels. Peggy's project symlinks to it.
- `cc-headless.ts` posts `formatToolCallSummary` lines (E29) through `reportToolCall`; `tool-call-summary.ts` builds them from tool inputs.
- `TelegramAdapter.appendToolCallLine` appends lines to one evolving draft; a `placeholder: true` line is replaced by the next line.
- MCP tools are thin and do not know the turn's (channel, contact) pairs; the hook (state file) and cc-headless (stream parser) do.

## Design (hybrid)

- **Fixed phrases.** `scripts/hooks/tool-status-phrases.json` maps tool names to phrases: generic tools, MCP tools by prefix (with per-tool refinements for `mcp__agentbus__*`), `Bash` refined by the command's first word (`calctl`, `imsg`, `capos`, `remindctl`, `mailwatch`, `grizzly`/`bear.sh`), and a default "Working on it". The hook reads it with jq; `src/adapters/tool-status.ts` reads it for cc-headless. No tool input is ever copied into a line.
- **Replace, not append.** Phrase lines go out with `placeholder: true` (existing replace semantics), and Telegram skips an edit when the line is unchanged.
- **`status` MCP tool.** `status {text}`: sanitised, max 40 characters, max 5 words. The tool validates and returns the clean text; the observer (cc-headless stream parser / pool hook) posts it via `/tool-status` to the turn's pairs. Agent-authored status is **sticky for the rest of the turn** (turn-long, no timer) until the next `status` call; fixed phrases never overwrite it. The `status` call never produces a line of its own beyond its text, and an invalid call produces nothing and is not sticky.
- **Kept rules.** Nothing after delivery, no status on email, best-effort (never fails the tool call), `bus.auth_token` handling unchanged.
- **Switch.** `tool_status.mode: phrases | raw` (default `phrases`) for cc-headless; `AGENTBUS_TOOL_STATUS_MODE` for the pool hook, which runs in the agent's project and cannot read bus config. `raw` restores the E29 lines exactly and keeps the `status` tool silent.

## Entry Criteria

- E29 and E48 tool-status code on the working branch (confirmed present).

## Exit Criteria

- A turn that reads a file and runs `calctl` shows "Reading a file" then "Checking the calendar" in one replacing line, never a path or command.
- `status {text: "Comparing the quotes"}` shows that text and later tool calls do not change it until the turn ends or `status` is called again.
- `tool_status.mode: raw` / `AGENTBUS_TOOL_STATUS_MODE=raw` give the old output.
- Unit tests cover mapping, fallbacks, no argument leakage, `status` validation, stickiness, and the shell hook against a stub bus.

## Stories

### S79.1 — Phrase table and lookup
`tool-status-phrases.json` and `src/adapters/tool-status.ts` (`phraseForToolCall`, `sanitizeStatusText`, `TurnStatusTracker`).
**Acceptance:** every phrase is 2-5 words and at most 40 characters; unknown tools give "Working on it"; no input content appears in output.

### S79.2 — cc-headless and Telegram
cc-headless uses a per-turn tracker and sends phrase lines as `placeholder: true`; Telegram keeps replace semantics across successive transient lines and skips identical repeats.
**Acceptance:** two successive phrase lines produce one edit showing the second; an identical repeat produces none.

### S79.3 — `status` MCP tool
**Acceptance:** valid text returns the sanitised status; empty, over-long, too-wordy or non-string input is an error.

### S79.4 — Pool hook
Hook looks phrases up with jq, handles `mcp__agentbus__status`, sticky flag per session reset on UserPromptSubmit, raw mode.
**Acceptance:** stub-bus test shows phrase, Bash refinement, fallback, stickiness, silence after delivery and on email, raw mode.

### S79.5 — Config, docs, changelog
`tool_status` config, `config.yaml.example`, TELEGRAM_ADAPTER / CC_POOL_ADAPTER / CC_HEADLESS_ADAPTER / MCP_TOOLS / HTTP_API docs, CHANGELOG.

## Risks

- Pool panes keep running an old hook only if it was copied; Peggy's is a symlink, so it changes on merge. A pane started before the merge keeps its old `cc.ts` MCP server (no `status` tool) until recycled.
- Stickiness is turn-long: an agent that sets a status early and works for a long time keeps showing it. The tool description says so.
- The phrase file is resolved next to the hook's real path; a copied (not symlinked) hook needs `AGENTBUS_TOOL_STATUS_PHRASES`.

## Notes

- Out of scope: the Mac app channel (no `toolStatus` capability today), token streaming, reasoning summaries.
- Peggy-side follow-up (not an AgentBus change): CLAUDE.md guidance on when to call `status`.

# E74 — App Channel Approvals

| Field | Value |
|---|---|
| Epic ID | E74 |
| Status | Planned |
| Dependencies | E51 (approval requests), E59 (app adapter protocol v1), E62 (Mac client), E30 (headless turn lifecycle) |
| Story Count | 7 |
| Estimated Complexity | L |

Source: operator request, 2026-10-16.

## Epic Summary

Approvals (E51) reach a human only through Telegram, and only for `cc-pool` panes. The Mac app can't show them, and the agent the app talks to (`cc-headless`) can't raise them at all. This epic adds both halves: `cc-headless` becomes an approval source through Claude Code's `--permission-prompt-tool`, and the app channel becomes a notification and answer surface through a new durable `approval` event, a WebSocket decision frame, and an Approve/Deny card in the Mac transcript.

## Problems

1. **The app can't be notified.** `AppAdapter` doesn't declare `interactiveApproval`. `dispatchApproval` marks any request addressed through channel `app` as `stale` ("does not support interactiveApproval").
2. **`cc-headless` can't raise approvals.** `resolveApprovalTarget` only knows `cc-pool`. A headless turn (`claude -p`) never shows a dialog: a tool outside `--allowedTools` (today only `reply` and `send_message`) is refused outright, so app agents run without Bash, Edit, or any other gated tool.
3. **The app's event stream has no place for them.** `app_events.kind` is restricted to `message` and `session`, and the protocol has no client-to-server decision frame.
4. **The app may be closed.** An approval raised while no client is connected must still be there on reconnect, if it hasn't expired.

## Design Decisions

| Decision | Choice |
|---|---|
| Headless mechanism | `--permission-prompt-tool mcp__agentbus__approval_prompt` on user turns. Claude Code calls it with `{tool_name, input, tool_use_id}` for any tool that needs permission and expects an allow or deny JSON result. |
| How the tool waits | The tool runs in the per-turn MCP child, a separate process from bus-core. It raises the request over `POST /api/v1/approvals`, then long-polls `GET /api/v1/approvals/:id` until the row is terminal, and returns allow or deny. |
| Resolution backend | New `cc-headless` backend in `resolve.ts`: approve or deny only succeeds while the turn that raised the request is still running. Otherwise the request is `stale`. |
| Expiry | The existing 15 minutes (`APPROVAL_TIMEOUT_MS`). Expired and stale both return **deny** to the agent with a message saying nobody answered, so the turn continues instead of hanging. |
| Who is asked | The contact of the turn's session, on the session's own channel. An app session asks the app; a Telegram session asks Telegram, which `cc-headless` now gets for free. |
| Turns without a human | Journal, consolidation, and scheduler turns get no prompt tool. Gated tools stay refused, as today. |
| App event | A new durable `approval` event in the per-contact `seq` stream, so it replays after the app was closed. Each state change emits a new event for the same `approval_id`; the client keeps the latest by `approval_id`. |
| App answer | A client frame `approval_decision`, answered with an `ack`. Resolution calls the shared `resolveApproval()` with `onlyContactId` set to the authenticated contact. |
| Protocol version | Stays **1**. The event kind and frame are additive; clients must ignore unknown events. |
| Multi-channel fan-out | Not in v1. One channel per request. Telegram-as-fallback when the app is offline is an open question below. |
| "Always allow" | Not in v1. Each request is one decision for one tool call. |

## Exit Criteria

1. An app-session headless turn that needs a gated tool raises a request, the Mac app shows an Approve/Deny card in that session, and the answer unblocks the tool call with allow or deny.
2. A request raised while the app is closed is shown on reconnect with its remaining time. One that expired in the meantime shows as expired, and the agent got a deny.
3. Only the addressed contact can answer. A token for another contact gets `forbidden` and the request stays pending.
4. `/stop`, `/clear`, or a turn timeout while a request is pending marks it `stale` and removes the card's buttons.
5. Telegram sessions served by `cc-headless` get the same prompts through the existing Telegram buttons, with no Telegram code changes.
6. Journal, consolidation, and scheduler turns never raise approvals.
7. Bus tests, Mac XCTest cases, `docs/APPROVALS.md`, `docs/APP_ADAPTER.md`, `docs/CC_HEADLESS_ADAPTER.md`, `docs/HTTP_API.md`, `site-docs/features/approvals.md`, and `CHANGELOG.md` are updated. The full suite, `tsc`, `npm run docs:build`, and the Xcode build and tests pass.

## Stories

### S74.1 — Spike: permission-prompt-tool behavior

Establish, against the installed `claude` binary, what the design assumes. Write findings to `_bmad-output/planning-artifacts/mac-client/e74-permission-prompt-spike.md`.

- Exact request payload and accepted response shapes (allow with `updatedInput`, deny with `message`).
- Which tools reach the prompt tool given `--allowedTools` and the permission mode.
- Whether the MCP tool-call timeout (`MCP_TOOL_TIMEOUT`) allows a wait of 15 minutes, and what the setting must be.
- Behavior with `--resume`, parallel tool calls in one turn, and a killed child.
- Whether the turn's own timeouts or the concurrency slot logic in `cc-headless` need to account for a long wait.

Exit: the remaining stories' assumptions are confirmed or this epic is amended before S74.2 starts.

### S74.2 — `cc-headless` as an approval source

- Pass the turn's `conversation_id` to the MCP child through its environment (it already gets `AGENTBUS_AGENT_ID`).
- Add the `approval_prompt` MCP tool: raise, long-poll, return allow or deny.
- Add `--permission-prompt-tool` to user-turn spawn args only. Journal, consolidation, and scheduler turns omit it.
- `resolve-target.ts`: a `cc-headless` branch mapping `{agentId, conversationId}` to the session's `{contactId, channel}`, after checking the turn is currently running.
- `resolve.ts`: a `cc-headless` backend that returns `stale` when the turn is gone.
- Cancel path: `/stop`, `/clear`, and turn timeout mark that conversation's pending requests `stale`.
- Summary text from `tool_name` and `input`, trimmed and with obvious secrets (env assignments, tokens in URLs) masked.

### S74.3 — Configuration and policy

- `adapters.cc-headless.approvals`: `enabled` (default `false`, so existing agents behave exactly as today), `timeout_seconds` (default 900, replacing the hard-coded constant for this source), and `auto_allow` / `auto_deny` tool-name patterns checked before a human is asked.
- Config validation and `config.yaml.example`.
- A startup advisory when `enabled` is true but the agent's app or Telegram route has no contact able to answer.

### S74.4 — App adapter notification seam

- Migration: allow `approval` in `app_events.kind` (SQLite table rebuild) and add a nullable `approval_id` column.
- `AppAdapter`: set `capabilities.interactiveApproval`; `notifyApproval` records the event under the contact's counter and pushes it live to connected clients; `finalizeApproval` records and pushes the terminal state. `notify_message_id` stores the event seq.
- `readEvents` builds `approval` events from the `approval_requests` row, applying the same session-visibility rule as messages.
- Event data: `approval_id`, `session_id`, `conversation_id`, `tool_name`, `summary`, `details`, `status`, `requested_at`, `expires_at`, `resolved_by`.
- Retention: approval events follow `event_retention_days`.

### S74.5 — App protocol: decide and list

- Client frame `approval_decision {request_id, decision}`. The bus calls `resolveApproval()` with `onlyContactId` and replies `{type:"ack", status, request_id}` where `status` is `approved`, `denied`, `expired`, `stale`, `already_resolved`, `forbidden`, or `not_found`.
- After any decision made through the app, finalize immediately rather than waiting for the 60-second sweep.
- Rows answered elsewhere (Telegram, terminal, `POST /api/v1/approvals/:id/resolve`) reach the app through the sweep's `finalizeApproval`.
- `GET /api/v1/app/approvals?status=pending`, scoped to the authenticated contact, as a fallback after a `welcome.reset`.
- Update `scripts/app-client.ts` with `approve` and `deny` commands.

### S74.6 — Mac client UI

- `Protocol.swift` / `Store.swift`: decode `approval` events, keep the latest per `approval_id`, ignore unknown event kinds, rebuild after a reset using the list route.
- An approval card in the transcript of the originating session: tool name, monospaced summary, expandable details, remaining time, Approve and Deny buttons. Resolved cards collapse to a one-line outcome.
- A pending-approval badge on the session in the sidebar and a count in the Dock badge.
- A local notification with Approve and Deny actions when the app is in the background, so a decision doesn't require bringing the window forward.
- States for the in-flight decision, a lost race (already resolved or stale), and a connection drop mid-decision (retry safe, since a decision is idempotent).
- XCTest cases for decoding, latest-wins merging, expiry display, and the decision frame.

### S74.7 — Docs, tests, and live check

- `docs/APPROVALS.md` (headless source, app channel, lifecycle), `docs/APP_ADAPTER.md` (event and frame), `docs/CC_HEADLESS_ADAPTER.md`, `docs/HTTP_API.md`, `docs/MAC_CLIENT.md`.
- `site-docs/features/approvals.md` written for users, one realistic config example; `npm run docs:build`.
- `CHANGELOG.md` `[Unreleased]` entries.
- Live walkthrough on the operator's bus: app prompt, approve, deny, expire, offline replay, `/stop` while pending.

## Open Questions

1. **Telegram fallback.** Should a request raised while no app client is connected also go to Telegram, first answer wins (as self-edit proposals do)? It keeps long unattended turns moving, but it shows tool summaries on a second surface. Recommended default: no for v1, revisit after the live check.
2. **Scheduler turns.** Should an owner-addressed scheduled turn be allowed to ask? Excluded here because there's no conversation to attach the card to.
3. **Long waits and the concurrency slot.** A pending approval holds a turn slot for up to 15 minutes. S74.1 decides whether that is acceptable or the slot should be released while waiting.

## Non-Goals

- iOS Peggy client support.
- "Always allow" or per-session standing rules.
- Changing the `cc-pool` approval path, except for the shared `app` notification surface it gains for free.

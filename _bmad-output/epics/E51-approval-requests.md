# E51 — Formal Approval Requests (cross-adapter human-in-the-loop)

| Field | Value |
|---|---|
| Epic ID | E51 |
| Dependencies | E10 (adapter capabilities pattern), E29 (tool-status stream — same capability-flag/dispatch precedent), E48 (cc-pool tmux lifecycle, `sendKeys` primitive, "send-keys is lifecycle-only, never message delivery" convention) |
| Story Count | 7 |
| Estimated Complexity | M |
| Status | Implemented on `feat/e51-approval-requests`; S51.5 needs live registration in the pane project |

---

## Epic Summary

Triggered directly by the Sep 19–22 recurring incident: a `cc-pool` pane hit an
interactive "Overwrite file?" confirmation with nobody at the terminal to
answer it, and sat frozen — silently dropping every scheduled delivery routed
to it — until someone manually ran `tmux attach` and pressed a key. Claude
Code's `PermissionRequest` hook fires the instant that kind of prompt is about
to block a pane, which gives AgentBus a precise signal instead of inferring
"stuck" from N minutes of silence. E51 uses that hook as the trigger to build
a **formal, backend-agnostic approvals subsystem** into AgentBus itself,
rather than a one-off script wired to this one incident.

Three layers, matching the shape of the problem exactly:

1. **Reception** — a generic way for any backend adapter (`cc-pool` today;
   `cc-headless`, `cc`, and a future `codex-headless` per E41 tomorrow) to
   tell AgentBus "I'm blocked, a human needs to decide X."
2. **Notification** — a per-user-adapter way to put that decision in front of
   the right human on the channel they actually use (Telegram inline
   Approve/Deny buttons first; email or Siri could follow the same
   capability-flag pattern later).
3. **Resolution** — a per-backend-adapter way to carry the human's answer back
   to the thing that's actually still blocked. For `cc-pool` this is `tmux
   send-keys` into the leased pane — not a new mechanism, the same lifecycle
   primitive E48 already built and the same principle it already established
   ("send-keys is for lifecycle, never for message content" — this qualifies
   as lifecycle, since it answers an interactive dialog, not the agent's
   conversation).

**Deliberately not** having the hook itself auto-decide the permission
(`PreToolUse`'s `hookSpecificOutput.permissionDecision`) and skip the
interactive dialog entirely. Two reasons: (a) it would leave the terminal
experience of a human actually sitting at that pane unchanged only by
accident, whereas keystroke injection is *identical* to Chris pressing the
key — nothing about Claude Code's own permission semantics changes; (b) if a
human at the terminal resolves the prompt first, the Telegram-side request
just goes stale and gets cancelled for free, instead of racing an internal
auto-decision against a live keystroke.

---

## Prior Art: What Already Exists (and Where)

- `src/pool/tmux.ts` — `TmuxController.sendKeys(target, keys)` and
  `sendLine(target, line)`. Already used for pane lifecycle (launch/resume).
  This epic's resolution step reuses `sendKeys` verbatim; no new tmux
  primitive needed.
- `src/core/registry.ts` — `AdapterCapabilities` is already a per-adapter flag
  object (`toolStatus?`, `react?`, etc.) with precedent for "Telegram only
  today" flags (see the `toolStatus` doc comment citing E29). `interactiveApproval?`
  slots into this same pattern.
- `src/adapters/telegram.ts` — outbound is a thin `callTelegram(method, body)`
  wrapper over the raw Bot API (`fetch`, not a bot framework), so adding
  `reply_markup` to an outbound `sendMessage` call is a body-shape change, not
  a new dependency. Inbound polling (`inboundLoop`) currently requests
  `allowed_updates: ['message', 'message_reaction']` only — **`callback_query`
  is not handled anywhere today**; this is new surface, not a gap-fill.
- `src/http/api.ts` — `POST /api/v1/pool/:agentId/turn-ended` is the closest
  existing precedent for a small, fire-and-forget, pane-lifecycle-signal
  endpoint. E51's reception endpoint follows the same shape but is **not**
  pool-scoped in its URL, since a future non-pool backend needs to hit it too.
- `scripts/hooks/agentbus_tool_status_hook.sh` and `agentbus_stop_hook.sh`
  (peggy-claude-code repo) — the existing pattern for a Claude Code hook that
  POSTs to bus-core's REST API with the session's cached channel/contact
  context. The new `PermissionRequest` hook follows this same pattern.
- **Directly observed dialog shape** (peggy-claude-code, Sep 22 08:26 ET, live
  `tmux capture-pane` on the actual frozen `peggy-pool-1`):
  ```
  ❯ 1. Yes
    2. Yes, and switch to accept edits ... (shift+tab)
    3. No
  Esc to cancel · Tab to amend
  ```
  Option 1 was pre-highlighted (`❯`) in both real freezes seen this week. This
  is the concrete basis for the keystroke mapping in S51.4 — treated as a
  working hypothesis validated against two real occurrences, not a documented
  Claude Code contract. See Risks.

---

## Entry Criteria

- `cc-pool` adapter live (already true, per E48/E39 config as of Sep 19).
- Chris confirms Telegram is the only notification channel needed for v1
  (email/Siri approval UX is out of scope until asked for).

## Exit Criteria

- A `cc-pool` pane hitting any interactive confirmation triggers a Telegram
  message to Chris with Approve/Deny buttons within seconds of the prompt
  appearing (not inferred later from silence).
- Tapping Approve/Deny in Telegram resolves the actual pending prompt in the
  pane, indistinguishably from Chris typing it at the terminal.
- A request nobody answers within its timeout is marked `expired` and the
  underlying prompt is left exactly as Claude Code's own default behavior
  already handles an unattended prompt (no new failure mode introduced).
- `GET /api/v1/approvals` shows pending/recent requests for observability,
  mirroring `GET /api/v1/pool`.

## Non-Goals

- No `PreToolUse` auto-decision logic — the interactive dialog always still
  appears; E51 only makes answering it remote-capable. (A *separate*, simpler
  effort — expanding `additionalDirectories`/allow-rules to prevent prompts
  from firing at all for known-safe paths — already shipped ad hoc on Sep 22
  for the memory-dir case and should keep happening independently; E51 is the
  safety net for everything that pattern doesn't cover.)
- No `codex-headless` (E41) implementation. The schema and adapter interface
  are designed to not preclude it, but nothing here builds it.
- No email or Siri notification channel — Telegram only for v1.
- No general "chat with Claude about whether to approve" — buttons only, no
  free-text negotiation.

---

## Data Model

New migration `019_approval_requests.sql`:

```sql
CREATE TABLE approval_requests (
  id TEXT PRIMARY KEY,                    -- uuid
  adapter_id TEXT NOT NULL,                -- 'cc-pool' today; the backend that raised it
  agent_id TEXT NOT NULL,                  -- e.g. 'agent:peggy-pool-1' — backend-specific target
  conversation_id TEXT,                    -- the conversation this pane/session was leased to, if known
  contact_id TEXT NOT NULL,                -- who gets asked — resolved from adapter_id+agent_id at request time
  tool_name TEXT NOT NULL,                 -- e.g. 'Edit', 'Bash'
  summary TEXT NOT NULL,                   -- short human-readable description of what's being asked
  raw_context TEXT,                        -- JSON blob: tool_input, cwd, etc. — for the notification body, not re-parsed
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | denied | expired | stale
  requested_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT,                        -- contact_id who answered, or 'timeout'/'system'
  notify_channel TEXT,                     -- e.g. 'telegram:peggy:group:-100...'
  notify_message_id TEXT,                  -- platform message id, so the button message can be edited on resolution
  expires_at TEXT NOT NULL                 -- requested_at + timeout; a scheduler-style sweep (like scheduled_items) expires stale rows
);
CREATE INDEX idx_approval_requests_status ON approval_requests(status, expires_at);
```

`raw_context` deliberately stays an opaque JSON blob rather than normalized
columns — the shape of "what a backend needed approved" will differ across
`cc-pool` vs. a future `codex-headless`, and this table shouldn't need a
migration every time a new backend's payload looks slightly different.

---

## Stories

### S51.1 — Reception API: `approval_requests` table + `POST /api/v1/approvals`

- Migration `019_approval_requests.sql` per Data Model above.
- `POST /api/v1/approvals` — body: `{ adapterId, agentId, conversationId?, toolName, summary, context? }`.
  Resolves `contact_id` server-side from `adapterId`+`agentId` (for `cc-pool`,
  via the same lease-lookup `pool-manager.ts` already exposes for
  `GET /api/v1/pool`), inserts a `pending` row, and **synchronously kicks off
  the notification dispatch (S51.2)** before returning — the caller (the hook
  script) doesn't need to know or care how notification happens.
  Returns `{ id }` immediately; fire-and-forget from the hook's perspective,
  matching the `/turn-ended` precedent (no polling, no blocking the tool call).
- `GET /api/v1/approvals/:id` — current status, for the eventual resolution
  handler (S51.4) to check before acting (staleness guard).
- `GET /api/v1/approvals?status=pending` — observability, mirrors `/pool`.
- Unit tests mirror `agent-liveness.test.ts`'s shape: request → row created →
  status transitions.

### S51.2 — `AdapterCapabilities.interactiveApproval` + Dispatch Service

- Add `interactiveApproval?: boolean` to `AdapterCapabilities` (`registry.ts`),
  doc comment citing E51, same style as the existing `toolStatus` comment.
- New `AdapterInstance` optional method:
  `notifyApproval?(request: ApprovalRequest): Promise<{ channel: string; messageId: string }>`.
- A small dispatch module (`src/pool/approval-dispatch.ts` or similar) called
  from S51.1's endpoint: looks up the contact's adapter for their preferred
  channel (reuse whatever resolution the outbound pipeline already uses for a
  normal `send`), confirms `interactiveApproval` is true for it, and calls
  `notifyApproval`. If no adapter for that contact supports it, the request is
  logged as `stale` immediately with a clear reason in `raw_context` — no
  silent drop.

### S51.3 — Telegram: Inline Keyboard Notification + Callback Query Ingestion

- Outbound (`notifyApproval` implementation in `telegram.ts`): `sendMessage`
  with `reply_markup: { inline_keyboard: [[{text: 'Approve', callback_data: 'approve:<id>'}, {text: 'Deny', callback_data: 'deny:<id>'}]] }`.
  Store the returned `message_id` back onto the `approval_requests` row
  (`notify_message_id`) via S51.1's endpoint or a direct DB write — needed so
  S51.6 can edit the message to show the final state instead of leaving live
  buttons on a resolved request.
- Inbound: add `'callback_query'` to `allowed_updates` in `inboundLoop`.
  New branch in `processUpdate` for `update.callback_query`: parse
  `callback_data`, call `answerCallbackQuery` (Telegram requires this within
  a short window or the button shows a client-side error), then
  `POST /api/v1/approvals/:id/resolve` with the decision.
- **Security check, not optional**: verify `callback_query.from.id` matches
  the known Chris Telegram user id before honoring it — a forwarded message
  or a group member other than Chris tapping the button must not resolve a
  pending approval. Mirrors whatever check (if any) already gates inbound
  message processing from non-Chris senders in this group.

### S51.4 — `cc-pool` Resolution Handler

- `POST /api/v1/approvals/:id/resolve` (body: `{ decision: 'approve'|'deny', resolvedBy }`):
  - Loads the row; if already resolved/expired, no-op (idempotent — handles
    the "Chris answered at the terminal directly" race).
  - Resolves the **current** lease for `agent_id` at answer-time (not
    request-time) via `pool-manager.ts` — if the pane's lease moved to a
    different conversation since the request was raised (the exact bug this
    epic exists because of), mark `stale` instead of sending keystrokes into
    what's now someone else's turn.
  - Maps `decision` → keystroke per the S51.1 dialog-shape hypothesis:
    `approve` → `Enter` (accepts the pre-highlighted default option, observed
    both times to be the least-destructive "Yes"); `deny` → `Escape`
    (the dialog's own documented cancel key, not a numbered option — more
    robust than assuming "3. No" is always the last item).
  - `tmuxController.sendKeys(paneTarget, key)`.
  - Marks row `approved`/`denied`, `resolved_at`, `resolved_by`.
- New adapter-agnostic interface point: `AdapterInstance.resolveApproval?(agentId, decision): Promise<void>`,
  so this logic lives behind the same per-adapter seam as `notifyApproval` —
  a future `codex-headless` resolver implements its own version without
  touching the reception/notification layers.

### S51.5 — Claude Code `PermissionRequest` Hook

- New `scripts/hooks/agentbus_approval_hook.sh` in `peggy-claude-code`,
  registered under `PermissionRequest` in `.claude/settings.json` (additive —
  existing `UserPromptSubmit`/`PostToolUse`/`Stop`/`PreCompact` hooks
  untouched).
- Reads stdin JSON (`tool_name`, `tool_input`), reuses the existing cached
  channel/contact context the `UserPromptSubmit` tool-status hook already
  maintains per-session (same lookup, don't duplicate it).
- Derives `agentId` from `$AGENTBUS_AGENT_ID` (already set per-pane by E48) —
  no new plumbing needed to know which pane it's running in.
- `POST /api/v1/approvals` with a one-line `summary` built from
  `tool_name`/`tool_input` (e.g. `Edit: memory/daily/2026-09-22.md — overwrite confirmation`).
  Exits immediately, `continue: true`, no `permissionDecision` set — the
  interactive dialog proceeds exactly as it would with no hook installed.
- Pipe-test per `update-config` skill conventions before declaring done:
  synthesize a `PermissionRequest` stdin payload, confirm the POST lands.

### S51.6 — Expiry Sweep + Message-State Cleanup

- A lightweight interval (piggyback on an existing scheduler tick if one
  already runs at a suitable cadence, e.g. `scheduled_items`'s own sweep —
  check before adding a second timer) marks any `pending` row past
  `expires_at` as `expired`.
- On any terminal state (`approved`/`denied`/`expired`/`stale`), edit the
  Telegram message (`notify_message_id`) to remove the buttons and show the
  outcome in plain text — a resolved approval must never show live,
  clickable buttons that would silently no-op.
- Default timeout: propose 15 minutes (long enough Chris can see it on his
  phone without being paged like a nag; short enough a pane isn't stuck all
  day the way it was this week) — confirm with Chris, not hardcoded blind.

### S51.7 — Observability & Docs

- `docs/APPROVALS.md` following the existing `docs/CC_POOL_ADAPTER.md` /
  `docs/TELEGRAM_ADAPTER.md` style: data flow diagram (three-layer, matching
  Epic Summary), REST endpoint reference, capability flag, how to add a new
  backend's `resolveApproval`.
  updates `project_agentbus_session_architecture.md`'s open-items list once shipped.

---

## Risks and Mitigations

- **Keystroke mapping is an observed pattern, not a documented contract.**
  Only two real dialog instances back this (both "Overwrite file?" /
  permission-style confirmations with `1/2/3` + `Esc to cancel`). A dialog
  shape Claude Code hasn't shown yet (different option count, no `Esc`
  option, a free-text prompt) could make `Enter`/`Escape` do the wrong thing.
  Mitigation: S51.4 logs the exact keys sent and the `summary` alongside each
  resolution so a wrong mapping is immediately visible in the approval row,
  not silently wrong; scope v1 to the dialog types actually observed and
  widen deliberately.
- **Lease-reassignment race is exactly what caused the Sep 19–22 bug.**
  Mitigated structurally by resolving the pane target at *answer* time
  (S51.4), not caching it from the original request — the one thing the Sep
  20 partial fix (`turn-ended` hook) didn't do for the mid-turn case.
- **Telegram callback security.** An unauthenticated or misrouted
  `callback_query` resolving someone else's pending approval is a real
  concern in a group chat context — S51.3's sender-identity check is not
  optional polish.
- **A pane could still freeze on something E51 doesn't cover** (a hang with
  no interactive prompt at all — network stall, infinite loop). E51 solves
  the "blocked on an answerable question" class only; it is not a general
  liveness/watchdog system. If that's still wanted, it's a separate, smaller
  effort layered on top (e.g. `PostToolUse`/turn-duration heuristics), not
  blocked by this epic.

## Implementation notes (deviations from the plan above)

- **Hook identifies its pane by `session_id`, not `$AGENTBUS_AGENT_ID`.**
  S51.5 assumed the pane's shell has `AGENTBUS_AGENT_ID`; only the pane's MCP
  server process does (`src/pool/mcp-config.ts`). `POST /api/v1/approvals`
  therefore accepts `sessionId` and recovers the pane from
  `pool_leases.claude_session_id`, as `/turn-ended` does.
- **The hook needs no cached channel/contact context.** The server resolves
  the contact from the pane's lease, so S51.5 does not read the tool-status
  hook's per-session state.
- **Resolution checks the screen first.** S51.4 also captures the pane and
  requires the dialog footer (`Esc to cancel`) before sending a key. The
  planned "a terminal answer makes the request stale for free" did not hold on
  its own, and `Escape` on a pane that is not at a dialog interrupts its live
  turn.
- **Notification goes to the contact's DM**, not the conversation's chat, so a
  group-topic session's tool summary isn't shown to the group.
- **Only the addressed contact may answer**, enforced in `resolveApproval()`
  (`onlyContactId`), not just by the sender allow-list.
- **Resolution is shared, not an HTTP self-call.** `src/approvals/resolve.ts`
  backs both the route and the Telegram callback. There is no
  `AdapterInstance.resolveApproval`; the backend seam is `deliverDecision()`.
- **Repeat hook firings are deduplicated** per pane, tool, and summary.
- **Timeout stays 15 minutes** (`APPROVAL_TIMEOUT_MS`), pending operator
  confirmation.

## Sequencing

S51.1 → S51.2 → S51.3 and S51.4 can build in parallel once S51.2's interface
is settled (one's outbound-only, one's inbound-only) → S51.5 (hook) can be
written and tested against S51.1's endpoint independently of S51.3/S51.4 being
finished → S51.6 last, since it needs real resolved rows to clean up → S51.7
throughout, finalized last.

# Approval requests

Approval requests let a human answer a blocked agent's permission prompt from their phone. When a `cc-pool` pane hits an interactive permission dialog, AgentBus sends the addressed contact a Telegram message with **Approve** and **Deny** buttons. Tapping a button answers the dialog in the pane, the same as pressing the key at the terminal.

Without this, an unattended dialog blocks the pane indefinitely and every message routed to it is lost.

## How it works

```
pane hits a permission dialog
        │
        ▼
PermissionRequest hook            scripts/hooks/agentbus_approval_hook.sh
        │  POST /api/v1/approvals { sessionId, toolName, summary }
        ▼
Reception                         session id → pane → conversation → contact
        │  approval_requests row (status: pending)
        ▼
Notification                      adapter.notifyApproval()
        │  Telegram DM with Approve / Deny buttons
        ▼
Resolution                        tap → resolveApproval()
        │  verify a dialog is still showing, then tmux send-keys
        ▼
pane answers its dialog           row: approved | denied
```

The three layers are independent seams:

- **Reception** is backend-agnostic: any backend can raise a request. `cc-pool` is the only one wired today.
- **Notification** is per user-facing adapter, gated by the `interactiveApproval` capability. Only Telegram implements it.
- **Resolution** is per backend. For `cc-pool` it sends `Enter` (approve) or `Escape` (deny) into the leased pane.

The hook never decides. It prints nothing and exits 0, so the dialog appears and behaves as it would without the hook, and a person at the terminal can still answer it first.

## Request lifecycle

| Status | Meaning |
|---|---|
| `pending` | Waiting for an answer. |
| `approved` / `denied` | Answered. The key was sent and is recorded as `keys_sent` in `raw_context`. |
| `expired` | Nobody answered within 15 minutes. No key is sent; the dialog stays as it was. |
| `stale` | Not answerable, with the reason in `raw_context.stale_reason`. See [Staleness](#staleness). |

The sweep runs on bus-core's 60-second maintenance tick. It expires overdue requests and removes the buttons from any resolved request's Telegram message. A request that is answered after its deadline but before the sweep runs is expired at answer time instead of being sent.

### Staleness

A request becomes `stale`, and no key is sent, when any of these hold at answer time:

- No adapter can notify the contact (raised as `stale` immediately).
- The pane's lease now belongs to a different conversation.
- The pane no longer shows a permission dialog, because someone answered at the terminal or the turn moved on. Sending `Escape` to a pane that isn't at a dialog would interrupt its live turn, so the pane is checked for the dialog footer (`Esc to cancel`) before any key is sent.

Repeated hook firings for the same unanswered prompt (same pane, tool, and summary) collapse into one request and one notification.

## Telegram behavior

- The notification goes to the contact's **DM**, not the conversation's chat, so a group-topic session's tool summary isn't shown to the rest of the group.
- Only the contact the request is addressed to can answer. A tap from any other sender, including another allow-listed contact, is refused and the request stays pending.
- After an answer, the message is edited to show the outcome and the buttons are removed.
- The message is plain text. Tool summaries can contain shell commands and paths, so they're never parsed as Markdown.

## Setup

1. Symlink the hook into the pane project's `scripts/hooks/`, next to the other AgentBus hooks:

   ```bash
   ln -s /path/to/agentbus/scripts/hooks/agentbus_approval_hook.sh \
         /path/to/pane-project/scripts/hooks/agentbus_approval_hook.sh
   ```

2. Register it in that project's `.claude/settings.json`:

   ```json
   {
     "hooks": {
       "PermissionRequest": [
         { "hooks": [{ "type": "command", "command": "scripts/hooks/agentbus_approval_hook.sh" }] }
       ]
     }
   }
   ```

3. Restart the pool panes. A running pane doesn't pick up new hook settings until it relaunches.

The hook posts to `http://127.0.0.1:3000`. Edit `AGENTBUS_BASE` in the script if bus-core listens elsewhere.

The hook identifies its pane by Claude session id, not `AGENTBUS_AGENT_ID`. Only the pane's MCP server process has that variable; the shell Claude Code runs hooks in doesn't.

## HTTP API

See [HTTP_API.md](HTTP_API.md#approvals).

## Adding a backend

1. **Target resolution.** Add a branch in `src/approvals/resolve-target.ts` that maps the backend's `agentId` to `{ contactId, channel, conversationId }`.
2. **Resolution.** Add a branch in `deliverDecision()` in `src/approvals/resolve.ts` that turns a decision into whatever unblocks that backend. It must return `{ result: 'stale', reason }` rather than act when the request no longer applies.

## Adding a notification channel

Set `capabilities.interactiveApproval` on the adapter and implement `notifyApproval()` and `finalizeApproval()` from `AdapterInstance`. When a person answers, call `resolveApproval()` from `src/approvals/resolve.ts` with `onlyContactId` set to the answering contact, so an allow-listed sender can't answer someone else's request.

## Limits

- **Keystroke mapping is observed, not documented.** `Enter` for approve relies on the first option being pre-highlighted "Yes", seen in every dialog captured so far. A dialog with a different shape could be answered wrongly. The keys sent are recorded on each row so a wrong mapping is visible.
- **Permission dialogs only.** A pane that hangs with no dialog, such as a network stall, isn't detected.
- **The timeout isn't configurable.** It's `APPROVAL_TIMEOUT_MS` in `src/approvals/types.ts`.

## Troubleshooting

| Symptom | Check |
|---|---|
| No Telegram message when a pane hits a dialog | The hook is registered and the pane was relaunched afterward. `GET /api/v1/approvals` for a row. A `422` in bus-core logs means the session id matched no leased pane. |
| Row is `stale` with "does not support interactiveApproval" | The contact's session channel maps to an adapter without the capability. |
| Row is `stale` with "no permission dialog showing" | The dialog was already answered, or its wording changed. Compare `tmux capture-pane -t <pane> -p` against the `Esc to cancel` footer in `src/pool/pool-manager.ts`. |
| Tap shows "Not authorized" | The tapping account isn't the contact the request was addressed to. |

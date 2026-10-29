# E85 — `/stop` Interrupts the Turn on cc-pool

| Field | Value |
|---|---|
| Epic ID | E85 |
| Dependencies | E48 (cc-pool), E71 (`/keys`, provider forwarding), existing `/stop` in `src/commands/handlers.ts` |
| Story Count | 2 |
| Estimated Complexity | S |
| Status | Scoped — not started |

---

## Epic Summary

`/stop` only works for cc-headless. On cc-pool it answers "No active turn to stop." and never touches the tmux pane, so the user cannot cancel a running turn from chat. This epic makes `/stop` send Escape, Claude Code's interrupt key, to the pane serving the conversation.

## Verified Behavior

Checked 2026-10-29:

- `stopHandler` (`src/commands/handlers.ts`) finds the conversation's agent in `sessions`, then looks it up in `deps.headlessControl.stopTurn`, a registry populated only by cc-headless instances. A pool pane agent is never in it, so `stop` is undefined and the handler returns "No active turn to stop."
- `/keys` (`src/commands/keys.ts`) already resolves the pane for a conversation: it lists `manager.leaseStore.list(manager.poolId)` for every pool and filters on `conversation_id === computeConversationId(contactId, channel, topic)` with state not `free` or `dead`. It sends keys with tmux `send-keys` and replies with `paneSnapshotResponse`.
- Claude Code docs (commands reference, fetched 2026-10-29): the built-in `/stop` stops a background session attached through agent view, not the current turn; and a command sent while Claude is responding is queued until the turn ends. Forwarding `/stop` to the pane is therefore wrong. Escape is the interrupt.

## Design

- In `stopHandler`, when no headless runner is found, fall back to the pool: resolve the conversation's leased pane exactly as `/keys` does (extract the lookup into a shared helper rather than duplicating it), send `Escape` via the injected `TmuxExec`, wait `POOL_SETTLE_MS`, and reply with the pane snapshot, text "Sent Escape to <pane>".
- Headless behavior is unchanged and still tried first.
- Panes in state `launching` or `draining` are valid targets, as for `/keys`. A `dead` or absent lease returns "No active turn to stop."
- Do not send `C-c`: on an idle pane it can prompt to exit or end the session.
- `/stop` reaches `stopHandler` with `deps.poolManagers` already available (used elsewhere in `handlers.ts`); no new wiring beyond a tmux exec dependency.

## Entry Criteria

- Confirm `HandlerDeps` can carry `tmuxExec`/`tmuxExecRaw` the way `KeysCommandDeps` does, and where the handler is constructed in `src/index.ts`.

## Exit Criteria

1. With a pool pane leased to the conversation and a turn running, `/stop` sends exactly one `Escape` to that pane and replies with a snapshot.
2. With no lease (or a dead pane) `/stop` still answers "No active turn to stop." and sends no keys.
3. cc-headless `/stop` behaves exactly as before.
4. `/help` text and docs (`SLASH_COMMANDS.md`) describe `/stop` for both providers; `[Unreleased]` CHANGELOG updated.

## Stories

### S85.1 — Share the pane lookup

- Extract the conversation-to-pane lookup from `/keys` into a helper used by both commands.

**Acceptance:** `/keys` tests pass unchanged.

### S85.2 — Pool fallback in `/stop`

- Add the Escape fallback described in Design, with an injectable `TmuxExec` and settle delay.

**Acceptance:** tests with a fake tmux: leased pane receives `send-keys -t <pane> -- Escape` once; unleased conversation sends nothing and returns the existing message; headless runner present means tmux is never called.

## Risks

- Escape during a permission dialog or other prompt may dismiss it. Mitigation: the snapshot reply shows the pane state; this matches what `/keys Escape` does today.
- Escape pressed at the idle composer is harmless but reports "Sent Escape" even though nothing was running. Accepted; the snapshot makes it visible.

## Notes

- Raised by Mr. Patten 2026-10-29. His first suggestion, forwarding `/stop` to the pane as typed, was rejected on the docs evidence above.
- Workaround until built: `/keys Escape`.

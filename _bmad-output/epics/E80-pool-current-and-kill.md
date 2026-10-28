# E80 — /pool Shows the Serving Window, and /pool kill

| Field | Value |
|---|---|
| Epic ID | E80 |
| Dependencies | E48 (cc-pool, S48.8 `/pool`), E66 S66.9 (`clearConversation` detach pattern) |
| Story Count | 3 |
| Estimated Complexity | S |
| Status | Implemented on feat/e80-pool-current-and-kill (code and tests done; live check after safe restart pending) |

---

## Epic Summary

`/pool` lists every pane but not which one is serving the chat you are typing in, and a stuck pane can only be dealt with from tmux. This epic marks the serving pane and adds `/pool kill` to kill it so the conversation restarts on a fresh window.

## Decisions (Chris, 2026-10-27)

- `/pool kill` kills regardless of an in-flight turn. No refusal.
- The reply names the pane; with no serving pane it says so and does nothing.

## Stories

### S80.1 — Mark the serving pane

`/pool` resolves the current conversation with `commandConversationId` (honours the Mac app's bound session) and appends `◀ this chat` to the leased pane holding it. If no pane holds it, the output ends with `This chat: no pane is serving it (...)`.

### S80.2 — `PoolManager.killConversation`

Mirrors `clearConversation` (detach first: pane goes `draining`, conversation no longer owns it, so `acquire()` skips it), but always releases with `kill` regardless of `on_evict`, and leaves the `sessions` row open so the next window `--resume`s the same Claude session. Queue hygiene for a mid-turn kill:
- `processing` rows for the conversation on that pane are acked, so `recoverStuck()` cannot replay the in-flight input into the new window.
- `pending` rows for the conversation addressed to that pane are re-addressed to the parked bucket; `drainParked()` routes them to a fresh pane. They cannot leak to another conversation that later takes the pane id.
- The reply-linked lease guard (Sep 2026 stale-sender fix) refuses any late reply from the dead pane, since it no longer holds the conversation. Proactive sends are not guarded and are unaffected.

### S80.3 — `/pool kill` command, tests, docs

Handler, help text, unit tests (marker on the right pane, no pane, kill happy path, kill with no pane, kill mid-turn, next message acquires a fresh pane), CHANGELOG, `docs/SLASH_COMMANDS.md`, `docs/CC_POOL_ADAPTER.md`, site-docs.

## Risks

- Output the killed turn had not yet sent is lost; the transcript up to the last flushed message is resumed.
- Pending messages re-parked by a kill reach the new window after the next drain tick (up to 60s), so a message sent right after the kill can be delivered before an older pending one.
- A killed turn may have run tools with side effects that are half done.

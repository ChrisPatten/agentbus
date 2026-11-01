# E88 — cc-pool: Launch Fencing, Shell-Ready Typing and Orphaned tmux Server Detection

| Field | Value |
|---|---|
| Epic ID | E88 |
| Dependencies | E48 (cc-pool adapter), E54 (model-confirmation prompt), pool readiness check in `src/pool/pane.ts` |
| Story Count | 4 |
| Estimated Complexity | M |
| Status | Scoped — not started |

---

## Epic Summary

A cc-pool pane is identified to the bus only by its agent id (`peggy-pool-N`). Any process holding that id can poll, ack the pane's messages and satisfy the launcher's readiness check. On Oct 31, 2026 an orphaned tmux server still named `peggy-pool` ran five hidden `claude` sessions that did exactly that: they consumed messages meant for the visible panes and made failed relaunches look successful. Each "successful" launch then deleted its MCP config file before the shell had run `claude`, so panes 1–3 sat at a bare zsh prompt for hours.

This epic fences each pane launch with a per-launch token, so only the process from the current launch counts as ready and can take the pane's messages. It also delays typing the launch line until the shell is ready, deletes scratch files only once `claude` has really started, and detects and reports an orphaned pool tmux server at startup.

## Verified Behavior

Checked 2026-10-31 on bobafett (bus-core v0.17.0, `dev@38337e7`) via `ps`, `tmux`, the bus-core pm2 logs and `/api/v1/agents/<id>/last-poll`:

- Two tmux server processes both ran `tmux new-session -d -s peggy-pool`. The old one (pid 2088) had been up 30 days; the new one (pid 92327) started Oct 29 21:30:05. `/private/tmp/tmux-501/default` was also created Oct 29 21:30, so the old server had lost its socket and `tmux ls` reached only the new one. Why the socket was lost is unknown.
- The old server's shells still held five live `claude` processes. Their `npx tsx src/adapters/cc.js` children polled the bus with `AGENTBUS_AGENT_ID` set to `peggy-pool-1`, `peggy-pool-2`, `peggy-pool-3`, `peggy-pool-4` and `pokeclaude-pool-1`. (The agent id was read with `ps eww`.)
- `PaneManager.isReady()` (`src/pool/pane.ts`) treats the pane as ready as soon as `/last-poll` shows a `lastPollAt` at or after `launchStartedAt`, whoever made the poll. The orphans polled every second, so readiness passed at once for every relaunch of those ids.
- A launch that passes readiness deletes its `pool-mcp-*.json` in `finally` (`launchSucceeded`). Panes 1, 2 and 3 each showed the typed launch line followed by `Error: Invalid MCP configuration: MCP config file not found: …/agentbus-pool-scratch/pool-mcp-<uuid>.json`. The scratch directory was empty.
- Pane 2, Oct 31 21:53: the log shows `launching peggy-pool:2 model=claude-sonnet-5-5` at :28, then `model=claude-opus-5-5 (source=agent-override)` at :32. The pane shows the Opus launch line typed before oh-my-zsh and direnv had finished. zsh then dropped its first character (`zsh: command not found: nset`), and the retyped line hit the missing config.
- Grow-1 (`peggy-pool-4`) was stuck at Claude Code's "Loading development channels" confirmation screen, because readiness had passed on the orphan's polls.
- Watchdog lines (`stalled … 5m unhandled, screen static 5m`) for peggy-pool:2 and :3 recurred from Oct 30 to Oct 31. That fits messages going to the orphans.
- Killing pid 2088 ended all five orphans. Polls for those ids stopped at the moment of the kill. `scripts/safe_restart.sh` then brought bus-core back healthy at 21:59:51.

## Design

**Launch token (fencing).** Each `PaneManager.launch()` generates a `launchId` (UUID). It is written into the pane's MCP config as `AGENTBUS_LAUNCH_ID`, next to `AGENTBUS_AGENT_ID`. `cc.ts` sends it on every poll (header or query field). The bus records `lastPollAt` and `lastLaunchId` per agent id.

- Readiness: `isReady()` passes only when `lastLaunchId === launchId` and `lastPollAt >= launchStartedAt`.
- Message ownership: the pool tells the bus the current `launchId` for each pane agent id when the launch succeeds. The bus then answers polls carrying a different launch id with no messages and a `409`/`stale_launch` flag, and logs a warning naming the agent id and launch id once per minute. `cc.ts` exits its poll loop (and logs) when it gets `stale_launch`, so an orphan stops polling.
- Agent ids that never set a launch id (non-pool adapters) are unaffected: no token means the old behavior.

**Shell readiness before typing.** `ensureWindowExists()` returns immediately when the pane already runs a shell, even if that shell is still starting. Before every `sendCommand`, the pane should be at a prompt and settled. Two options:

- a probe: send `printf '\n__AGENTBUS_READY_<nonce>__\n'` and wait for it, or
- the existing `waitForShellSettled()` plus a check that the last captured line ends with the prompt.

Either way the check also runs on the reuse path, not only after `createWindow`.

**Scratch cleanup.** Delete the launch's MCP config and prompt files only after a readiness poll with the matching `launchId`. That proves `claude` has started and read them. Age-based pruning (24 h) stays as the backstop.

**Orphaned server detection.** At pool start and on each watchdog tick:

- List processes matching `tmux new-session -d -s <pool session>` and compare them with the server pid that `tmux display -p '#{pid}'` reaches.
- Any extra server, or any process with a pool `AGENTBUS_AGENT_ID` that does not descend from the live server, is an orphan. Log it, and notify the admin channel once per orphan pid.
- Do not kill automatically by default. A config flag `pool.kill_orphan_servers: true` lets the pool `SIGTERM` them. The token fence above already makes orphans harmless, so detection is mainly for visibility.

## Entry Criteria

- Confirm where `cc.ts` builds its poll request, and which bus route records `lastPollAt` (`src/core/runtime-resolver.ts` `getLastPollAt`, `/api/v1/agents/:id/last-poll`).
- Confirm every pool launch path goes through `PaneManager.launch()`: fixed panes, grow panes, model override relaunch (E54) and the pokeclaude pool.

## Exit Criteria

1. With a second process polling as `peggy-pool-2` using a different launch id, a relaunch of pane 2 does not pass readiness until the new `claude` polls, and the stray process receives no messages and stops polling.
2. A launch line is never typed before the shell prompt is ready. Test: a fake shell with a 3-second startup delay gets the full line intact, with no dropped first character.
3. After a launch where readiness never passes, the MCP config file still exists. After a launch that passes, it is removed.
4. Starting the pool with a second `tmux new-session -d -s peggy-pool` server running logs an orphan warning naming its pid and sends one admin notice.
5. Non-pool adapters and existing single-pane behavior are unchanged; `npm test` passes; docs (`docs/CC_POOL_ADAPTER.md` or equivalent) and the `[Unreleased]` CHANGELOG are updated.

## Stories

### S88.1 — Per-launch token on polls and readiness

- Generate `launchId` in `launch()`; add `AGENTBUS_LAUNCH_ID` to `writePaneMcpConfig` env.
- `cc.ts` sends it with each poll; the bus stores `lastLaunchId` next to `lastPollAt`.
- `isReady()` requires the matching launch id.

**Acceptance:** unit test: a `/last-poll` response with a fresh timestamp but a different launch id does not count as ready; one with the matching id does.

### S88.2 — Fence messages to the current launch

- The pool registers the current `launchId` per pane agent id on a successful launch.
- The bus returns no messages, and `stale_launch`, to polls carrying any other launch id. `cc.ts` stops polling on `stale_launch`.

**Acceptance:** integration test: two pollers share `peggy-pool-2`. Only the registered launch receives a queued message, and the other exits its poll loop within one interval.

### S88.3 — Type only into a ready shell; clean scratch only after a real start

- Run the shell-ready check before every `sendCommand` in `launch()`, including the reuse path.
- Move MCP config and prompt cleanup after a token-matched readiness pass.

**Acceptance:** test with a slow-start fake shell: the launch line arrives whole. After a forced readiness timeout the config file is still on disk.

### S88.4 — Orphaned pool server detection

- At startup and on the watchdog tick, detect extra `tmux new-session -d -s <session>` servers, and pool-agent `cc.js` processes outside the live server.
- Log and notify once per pid. Add optional `pool.kill_orphan_servers` (default false).
- Update docs and CHANGELOG, and add the troubleshooting steps to the docs.

**Acceptance:** with a second detached `tmux -L test new-session -d -s peggy-pool` running, the pool logs `orphan tmux server pid=<n>` and sends one notice. With `kill_orphan_servers: true` the process is gone after the tick.

## Risks

- The bus API changes for `cc.ts` polling. A pane started before the upgrade (no launch id) must keep working until its next relaunch. Mitigation: no-token polls fall back to the old behavior, unless a launch id is registered for that agent id.
- The prompt-detection probe could misfire on unusual prompts (oh-my-zsh themes, direnv output). Mitigation: a nonce echo probe, not a prompt regex.
- Process scanning (`ps eww`) can read only the user's own processes. That is fine on bobafett, where everything runs as one user.

## Notes

- Raised by Mr. Patten 2026-10-31 after "Peggy:2 isn't working". The live incident was cleared by killing the orphan server (pid 2088) and running `safe_restart.sh`. Runbook troubleshooting entry: `peggy-claude-code/memory/reference_peggy_runbook.md`.
- Root cause of the Oct 29 socket loss is not known. A manual `tmux kill-server` on a different socket, or deletion of `/private/tmp/tmux-501`, would both produce it. Worth noting if it recurs.

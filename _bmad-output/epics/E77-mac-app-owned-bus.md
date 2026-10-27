# E77 — Mac App Owns the Bus Process

| Field | Value |
|---|---|
| Epic ID | E77 |
| Status | Planned |
| Dependencies | E62 (Mac app MVP), E59 (app adapter), E40 (durable one-shot schedules, used by `safe_restart.sh`) |
| Story Count | 7 |
| Estimated Complexity | M |

Source: operator request, 2026-10-27. Supersedes an uncommitted Oct 5 draft (`E64-mac-app-owned-server.md` in the `agentbus-server-macos-spawn-4c3831` worktree), which was numbered before E64 was taken and never landed.

## Epic Summary

Today `bus-core` runs as an always-on pm2 process (`ecosystem.config.cjs`, `make start`, `pm2 startup`), and the Mac app only connects to it. This epic lets the Mac app spawn, supervise, and stop `bus-core` itself, so on a laptop the bus runs exactly as long as the app does. **Managed** mode, where the app owns the bus, is the default for new installs. **External** mode, where the app only connects, keeps pm2, foreground runs, and remote buses working unchanged.

In Managed mode the bus's lifetime is the app process's lifetime. Closing every window leaves the app running as a menu-bar item, so the bus keeps running too. Quitting the app shuts the bus down gracefully. If the app crashes or is force-quit, the bus notices and shuts itself down, so no orphan is left behind. A bus that exits without the app asking, whether from a crash or an agent-requested restart, is restarted with backoff. That keeps `safe_restart.sh` and `make restart` working without pm2.

## Problems

1. **An always-on daemon for an interactive tool.** On the work laptop the bus exists to serve the Mac app. Keeping it alive under pm2 with `pm2 startup` means a background process, its own log rotation, and a second tool to learn and keep healthy.
2. **Two places to look.** Whether the bus is up, why it died, and where its logs are all live in pm2, outside the app. The app can only show "Not connected".
3. **Agent restarts depend on pm2.** `scripts/safe_restart.sh` and `make restart` call `pm2 restart`. Without pm2 an agent has no way to restart its own bus after editing it.
4. **GUI launch environment.** A process started from Finder or as a login item gets launchd's minimal `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`), so `node`, `tmux`, and `claude` aren't found. A process started from a Claude Code terminal inherits `CLAUDE_CODE_*` markers, which break pool transcripts (see `INHERITED_CLAUDE_SESSION_VARS` in `src/pool/pane.ts`).

## Design Decisions

| Decision | Choice |
|---|---|
| Modes | Settings › Server › **Mode**: `Managed` (the app runs bus-core) or `External` (connect only). New installs default to Managed. An install that already has a saved app token defaults to External, so upgrading changes nothing until you switch. |
| Ownership | The bus lives exactly as long as the app process. There is no adoption of a bus left over from a previous app run, and no pidfile-based takeover: the exit-with-parent rule (next row) guarantees there is nothing to adopt. |
| Exit with parent | New opt-in env var `AGENTBUS_EXIT_WITH_PARENT=1`. The app spawns the bus with a pipe on stdin and never writes to it. When the pipe reaches EOF (the app quit, crashed, or was killed, since the kernel closes the write end), bus-core runs its existing `shutdown()`. pm2, `make dev`, and other launches don't set the variable and behave as today. `claude -p` children already use `stdio: ['ignore', …]`, so they don't hold the pipe. |
| What runs | `<checkout>/node_modules/.bin/tsx src/index.ts` with `cwd = <checkout>` and `AGENTBUS_CONFIG = <config path>`, the same command line as `ecosystem.config.cjs`, so source edits take effect on the next restart, as they do under pm2. The bus still loads `.env` itself (dotenv next to the config). The app never reads secrets. |
| Environment | Captured once per app launch from the user's login shell: `$SHELL -l -c 'env -0'` with a 5s timeout, cached for the run. If capture fails, a fallback `PATH` is used (Homebrew, `~/.local/bin`, `~/.nvm` current, `/usr/local/bin`, plus the system path). An optional **Node path** setting overrides it. `INHERITED_CLAUDE_SESSION_VARS` are stripped. `AGENTBUS_EXIT_WITH_PARENT=1` and `AGENTBUS_CONFIG` are added. |
| Logs | Appended to `~/.agentbus/logs/bus-core-out.log` and `bus-core-error.log`, the paths pm2 uses today, so existing habits and docs carry over. The app opens them in Console.app (**Show Logs**). Rotation is out of scope; see Risks. |
| Readiness | After a spawn, the app polls `GET /api/v1/health` on the configured Bus URL every 500 ms for up to 60 s. On the first success it calls `connection.reconnect()`. Server state is `Starting`, `Running`, `Restarting (n)`, `Stopped`, or `Failed: <reason>`. |
| Port conflict | Before spawning, the app probes the health endpoint. If a bus already answers (for example a pm2 bus that is still running), the app doesn't spawn a second one. It shows `Another bus is already running on <port>` with two actions, **Switch to External** and **Retry**. The app never stops a process it didn't start. |
| Restart policy | Any exit the app didn't request is restarted. If the process ran for 60 s or more, the restart is immediate. Otherwise backoff runs 1 s, 2 s, 4 s and so on up to 30 s. After 8 quick failures in a row the app stops retrying and shows `Failed` with the last lines of `bus-core-error.log`. A requested restart (from the menu, Settings, or `make restart`) does not count toward the backoff. |
| Stop | SIGTERM, then wait up to 15 s for exit (`shutdown()` gives journaling and in-flight runs a moment), then SIGKILL. Used by Quit, **Stop Server**, mode switches, and Settings changes to the checkout or config path. |
| Restart signal for scripts | While Managed mode is running, the app writes `~/.agentbus/managed.json` (`{app_pid, bus_pid, bus_url, checkout, config, started_at}`) and deletes it on stop. `make restart` and `safe_restart.sh` check this file and that `app_pid` is alive. If both hold, a restart is `kill -TERM <bus_pid>` plus the existing health poll, and the supervisor respawns the bus. A stale file (dead `app_pid`) is ignored and removed. |
| Quit | `applicationShouldTerminate` returns `.terminateLater`, stops the bus, then replies. If turns are running (the app already tracks activity), a confirmation first says `N turns are running. Quitting AgentBus stops them.` ⌘Q, the menu bar's Quit, and Settings › General › Quit all go through this path. |
| Menu bar | A `MenuBarExtra` with a status glyph (running, starting or restarting, failed, external), the unread count, and the items Open AgentBus, New Conversation, Restart Server, Show Logs, Settings…, and Quit AgentBus. When the last window closes, the activation policy switches to `.accessory` (no Dock icon). Opening any window switches back to `.regular`. External mode shows the same menu without the server items. |
| Login | The existing **Open at login** toggle (S62.7, `SMAppService.mainApp`) replaces `pm2 startup`. Starting hidden in the menu bar at login is out of scope. |
| Sandbox | The app stays unsandboxed (no App Sandbox entitlement), which spawning a checkout's toolchain requires. This epic adds no new entitlements. |
| pm2 | Stays supported as External mode. `ecosystem.config.cjs` and the pm2 Makefile targets are kept. The docs describe Managed as the laptop setup and pm2 as the always-on setup. |

## Exit Criteria

1. On a machine with pm2's `bus-core` deleted, launching the app in Managed mode starts bus-core, and the app connects within the readiness window. Telegram, email, scheduler, and cc-pool behave as they do under pm2.
2. Closing every window keeps the bus running, with the app in the menu bar and no Dock icon. ⌘Q stops the bus gracefully: the log shows `AgentBus shutting down…` and no `bus-core` or `tsx` process remains.
3. Force-quitting the app (`kill -9`) makes bus-core shut down gracefully within 5 s.
4. Killing bus-core (`kill -TERM <bus_pid>`) gets it restarted, and the app reconnects. A bus that fails on startup, for example with a broken `config.yaml`, ends in `Failed` after 8 attempts, with the error tail visible in Settings › Server.
5. Launched from Finder or at login, the spawned bus finds `node`, `tmux`, and `claude`, and its environment has no `CLAUDE_CODE_*` markers.
6. With a pm2 bus already running, Managed mode refuses to spawn a second bus and offers Switch to External.
7. In Managed mode, `make restart` and `scripts/safe_restart.sh` restart the bus through the app's supervisor, including the health poll, the E40 wake-up notice, and the rollback to `main` on failure. In External mode they still use pm2.
8. External mode behaves exactly as before this epic.
9. Vitest covers exit-with-parent. XCTest covers the launch spec, environment capture and sanitizing, restart policy, the supervisor lifecycle against a fake process, and the managed-state file. The full suite, `tsc`, the Xcode build and tests, and `npm run docs:build` pass. `docs/` and `site-docs/` are updated.

## Stories

### S77.1 — Bus: exit with parent

- `AGENTBUS_EXIT_WITH_PARENT=1` makes bus-core listen for `end` and `close` on `process.stdin` (resumed, data ignored) and call the existing `shutdown()`. Unset, stdin isn't touched.
- Log line: `[bus] parent closed stdin; shutting down`.
- Vitest: spawn bus-core (or a minimal harness around the same hook) with a piped stdin, close it, and expect a clean exit within the timeout. With the variable unset, closing stdin does nothing.
- Docs: `docs/DEPLOYMENT.md` environment table.

### S77.2 — App: `ServerLaunchSpec`

- Validate the checkout: `package.json` has `"name": "agentbus"` and `node_modules/.bin/tsx` exists. Errors name what's missing (`Run npm install in <checkout>`).
- Config path defaults to `<checkout>/config.yaml` and must exist.
- Login-shell environment capture with timeout, caching, and fallback `PATH`. Resolve `node` (the setting, else `PATH`). Strip the inherited Claude vars, using a Swift copy of `INHERITED_CLAUDE_SESSION_VARS` with a comment pointing to the TS source. Add `AGENTBUS_CONFIG` and `AGENTBUS_EXIT_WITH_PARENT`.
- Pure value type, unit-tested without spawning: argument list, cwd, environment, validation errors.

### S77.3 — App: `ServerSupervisor`

- `@MainActor @Observable` owner of one `Process`: stdin pipe held open, stdout and stderr appended to the log files, `terminationHandler` feeding the restart policy.
- Start, then a conflict probe, spawn, and readiness poll. Then `reconnect()`. Stop with SIGTERM, a 15 s timeout, and SIGKILL. Restart is stop plus start without backoff.
- Restart policy as a separate pure type (`RestartPolicy`) with tests for backoff, reset after 60 s, give-up after 8, and requested restarts not counting.
- Writes and removes `~/.agentbus/managed.json` atomically.
- Lives on `AppModel`. It starts before `connection.start()` in Managed mode, so the first connect attempt waits on readiness instead of logging failures.
- XCTest against a fake executable (a small shell script that sleeps, exits with a code, or ignores SIGTERM) for spawn, crash and restart, graceful stop, and the SIGKILL fallback.

### S77.4 — App: Quit handling and menu bar

- `NSApplicationDelegateAdaptor` with `applicationShouldTerminate` → `.terminateLater`, the running-turns confirmation, supervisor stop, then `reply(toApplicationShouldTerminate: true)`. The existing Quit commands go through `NSApp.terminate`, so they pick this up.
- `MenuBarExtra` scene with the status glyph, unread count, and items from the Design Decisions table.
- Activation policy: `.accessory` when no AgentBus window is visible, `.regular` when one opens (driven from the scenes' appear and disappear).
- `applicationShouldTerminateAfterLastWindowClosed` returns `false`.

### S77.5 — App: Settings › Server

- New tab between General and Connection: Mode picker, Checkout folder (picker plus validation message), Config file, Node path (optional), live status (state, pid, uptime, restart count, last exit reason), and the buttons Start or Stop, Restart, and Show Logs.
- Default mode rule: Managed for a fresh install, External when a saved token already exists.
- Switching mode or changing paths stops and restarts as needed and confirms first if turns are running.
- First run in Managed mode: Server tab first (checkout), then Connection (token), then the main window, matching today's Connection-first flow.

### S77.6 — Scripts: managed-aware restart

- A small shared helper (`scripts/bus_mode.sh`) reads `~/.agentbus/managed.json`, checks that `app_pid` is alive, and prints `managed <bus_pid>` or `external`.
- `make restart`: in Managed mode, `kill -TERM` the bus pid, wait for the pid to change, then run the existing health poll. `make start` and `make stop` refuse with `The AgentBus app manages bus-core; use its menu`. `make status` prints the managed state. `make logs` and `make logs-err` `tail -f` the log files.
- `safe_restart.sh`: replace `restart_bus_core()`'s pm2 call with the helper's managed path when Managed. The E40 wake-up, health poll, stash-and-checkout-`main` rollback, and direct-email fallback stay as they are. A rollback works because the supervisor respawns from the same checkout.
- `make kill` leaves an app-managed bus alone (the `pkill` pattern still matches it). Use the helper to skip it, and print why.

### S77.7 — Docs, changelog, live verification

- `docs/MAC_CLIENT.md` (Server tab, menu bar, lifecycle), `docs/DEPLOYMENT.md` (Managed vs pm2, migrating with `pm2 delete bus-core` and `pm2 unstartup`, environment capture, logs), `docs/SCHEDULING.md` and `docs/CC_POOL_ADAPTER.md` where they say "pm2 restart", and the app-channel agent guidance in `docs/APP_ADAPTER.md` ("The app can be closed") updated to say closing windows is fine and quitting the app stops the bus in Managed mode.
- `site-docs/`: `channels/mac-app.md` and `operations/deployment.md`. `CHANGELOG.md` Unreleased entries (MINOR: new mode, backward compatible).
- Live check on the work laptop: exit criteria 1–7, including a real login-item launch and an agent-run `safe_restart.sh`.

## Risks

| Risk | Mitigation |
|---|---|
| **TCC attribution moves to the app.** macOS treats the app as the "responsible process" for everything it spawns, so prompts for Documents, Desktop, Calendar, and similar now name AgentBus and the grants attach to the app's code signature. A rebuild with a different signature can reset them. | Document it in `docs/MAC_CLIENT.md`. Keep a stable development team and signing identity (`DEVELOPMENT_TEAM` in `project.yml`). It's also an upside: it lines up with the backlog's "TCC permissions carrier" idea. |
| **Login-shell capture hangs or prints noise** (interactive prompts, `compinit` warnings). | `-l` without `-i`, NUL-separated `env -0`, a 5 s timeout, and the fallback `PATH`. The Node path override is the escape hatch. |
| **The `claude` CLI auth differs under a GUI launch.** | OAuth lives in the login keychain, which is available to the user's GUI session. The live check covers a turn after a login-item launch. |
| **Logs grow without pm2's rotation.** | Same exposure as pm2 without `pm2-logrotate`. A follow-up can cap or roll the files at spawn time if they grow. |
| **The tmux server outlives the bus.** cc-pool's tmux server daemonizes, so it survives Quit. | This matches `pm2 stop` today, and pool reconciliation (E48 S48.7) adopts the panes on the next start. Documented, not changed. |
| **Laptop sleep and closed app.** Scheduled work, Telegram, and email pause while the app is quit. | This is the chosen trade-off. Docs say to keep External (pm2) for a bus that must run while the app is closed. Sleep behavior is unchanged in either mode. |

## Out of Scope

- Bundling Node and the bus inside the `.app`, notarization, and native-module (`better-sqlite3`) packaging.
- A launchd agent for the bus.
- Starting hidden in the menu bar at login.
- Managing a remote bus or several local buses from one app.
- Log rotation.

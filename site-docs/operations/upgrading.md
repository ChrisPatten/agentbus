# Upgrading

Upgrading AgentBus means downloading the new version, installing its dependencies and restarting. Your configuration, conversations and schedules carry over: the bus updates its database by itself when it starts.

## Before you upgrade

1. **Read what's changed.** The [changelog](https://github.com/ChrisPatten/agentbus/blob/main/CHANGELOG.md) lists every release, with what was added, changed, fixed and removed.
2. **Back up the database.** See [Backing up](/operations/deployment#backing-up). Database updates can't be undone, so a backup is the only way back to an older version.

## Upgrade

Run each command from the AgentBus folder:

```bash
cd ~/agentbus
```

Download the latest version:

```bash
git pull
```

Install any new or updated dependencies:

```bash
npm install
```

Restart the bus:

```bash
make restart
```

`make restart` waits until the bus reports healthy and prints `bus-core healthy`. If it doesn't, check `make logs-err`: a setting that's been renamed or removed shows up as a `Config validation failed` message.

Check the version now running:

```bash
make health
```

The `version` field shows it.

### If you use cc-pool or claude-code

Their Claude Code sessions keep running the AgentBus code they started with. Restart them after an upgrade so they pick up the new version: for `cc-pool`, close the pool's tmux session while your agent is idle (`tmux kill-session -t <tmux_session>`); for `claude-code`, exit and restart your session.

## Version numbers

AgentBus versions look like `0.14.0`: major, minor and patch.

| Change in | Means |
|---|---|
| Patch (`0.14.0` → `0.14.1`) | Bug fixes only |
| Minor (`0.14.1` → `0.15.0`) | New features, such as a channel, tool or setting |
| Major (`0.15.0` → `1.0.0`) | Changes that may need you to update your configuration |

**Before version 1.0, a minor release can also include changes that need you to update your configuration.** The changelog says so clearly when it does.

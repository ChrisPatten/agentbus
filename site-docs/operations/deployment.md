# Running AgentBus

In [Getting started](/getting-started) you ran the bus in a terminal window, where it stops as soon as you close the window. For everyday use, run it in the background instead, so it keeps going when you close Terminal, restarts itself if it crashes, and starts again when your computer restarts.

AgentBus includes everything for this. It uses **pm2**, a process manager that's installed with AgentBus, and a set of short `make` commands that drive it.

## Before you start

- Run the bus once in the foreground, as in Getting started, and check that your agent answers. Problems are much easier to see there.
- Stop that foreground copy with **Control-C**. Two copies can't run at once.
- Install `jq`, which the status commands use to format their output. With [Homebrew](https://brew.sh):

  ```bash
  brew install jq
  ```

Run every command on this page from the AgentBus folder. If you followed Getting started, go there first:

```bash
cd ~/agentbus
```

## Start in the background

```bash
make start
```

pm2 prints a table with a row for `bus-core`. When its status is `online`, the bus is running. You can close Terminal.

Check that it's healthy:

```bash
make health
```

You should see `"status": "healthy"` and each of your channels marked `"online"`.

## Everyday commands

| Command | What it does |
|---|---|
| `make status` | Shows whether the bus is running, for how long, and how often it has restarted |
| `make logs` | Shows the bus's recent output and keeps showing new lines. Press Control-C to stop watching; the bus keeps running. |
| `make logs-err` | The same, for errors only |
| `make health` | Asks the bus for its health report |
| `make restart` | Restarts the bus and waits up to 30 seconds for it to report healthy. Use this after changing `config.yaml` or `.env`. |
| `make stop` | Stops the bus and removes it from pm2 |
| `make help` | Lists every command |

**Restart after every configuration change.** The bus only reads `config.yaml` and `.env` when it starts.

If your config file isn't `config.yaml` in the AgentBus folder, add its path to any command, for example `make start AGENTBUS_CONFIG=/Users/you/agentbus-config/config.yaml`. If you changed `http_port`, add `BUS_URL=http://127.0.0.1:<port>` to `make health` and `make restart`.

## Start automatically when your computer starts

pm2 can start the bus again after a reboot. Run this once:

```bash
./node_modules/.bin/pm2 startup
```

It prints a command beginning with `sudo`. Copy that whole command, paste it into Terminal, press Return, and enter your Mac's password when asked. Then save the current process list, so pm2 knows to start the bus:

```bash
./node_modules/.bin/pm2 save
```

(`make start` also saves the list each time.) After your next restart, `make status` should show `bus-core` online.

Your agent can only answer while the computer is awake. On a Mac, prevent sleep in **System Settings › Energy** (or Battery, on a laptop) if you want it available around the clock.

## Where things are kept

| What | Where |
|---|---|
| Logs | `~/.agentbus/logs/bus-core-out.log` and `~/.agentbus/logs/bus-core-error.log` |
| Database | `bus.db_path`, usually `~/.agentbus/agentbus.db` |
| Settings and secrets | `config.yaml` and `.env` in the AgentBus folder |

### Backing up

Everything the bus knows (messages, transcripts, sessions, schedules, the knowledge store) is in the database. To back it up, stop the bus, copy the database file together with any files next to it with the same name and `-wal` or `-shm` at the end, then start it again:

```bash
make stop
```

```bash
cp ~/.agentbus/agentbus.db* ~/Documents/agentbus-backup/
```

```bash
make start
```

(Create the backup folder first with `mkdir -p ~/Documents/agentbus-backup`.) Back up `config.yaml`, `.env` and your agents' folders too.

## Reaching the bus from other devices

The bus only accepts connections from its own computer. That's the safe default, and the [Mac app](/channels/mac-app) on the same computer needs nothing more.

To reach part of the bus from your phone or another computer, expose only that part, through a tool that adds encryption:

- **Siri** uses [Tailscale](https://tailscale.com) to share just `/api/v1/siri`. See [Siri](/channels/siri#_2-make-the-bus-reachable-from-your-phone).
- **Pebble** needs a proxy that can reach the webhook. See [Pebble](/channels/pebble#make-the-bus-reachable-from-your-proxy).

Setting `bus.host: 0.0.0.0` makes **every** part of the bus reachable from your local network, and most of it has no password. Only do it on a network you trust, and prefer sharing a single path as above.

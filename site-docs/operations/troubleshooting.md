# Troubleshooting

Most problems show up in one of three places: the message the bus prints when it won't start, the [health report](/operations/monitoring#health-report), and the [logs](/operations/monitoring#logs). Start with whichever matches what you see.

To see everything the bus prints, it often helps to stop the background copy and run it in a terminal for a while:

```bash
make stop
```

```bash
npx tsx src/index.ts
```

Press Control-C to stop it, then `make start` to go back to running in the background.

## The bus won't start

| Message | Cause and fix |
|---|---|
| `Config validation failed:` and a list | Each line names a setting and the problem, such as `contacts.me.id: Contact id "Me" must match its record key "me"`. Fix those settings in `config.yaml`. |
| `Config references undefined env var: NAME` | `config.yaml` uses `${NAME}`, but `.env` has no `NAME=` line, or `.env` isn't next to `config.yaml`. |
| `Failed to read config file` | The bus can't find `config.yaml`. Run it from the AgentBus folder, or set `AGENTBUS_CONFIG`. |
| `memory: Invalid input: expected object, received undefined` | The `memory` section is missing. Add `memory: {}` to `config.yaml`. The same message for `bus` or `adapters` means that section is missing. |
| `Invalid … instance name` | Named bots, mailboxes and agents may only use lowercase letters, digits, `-` and `_`. |
| `Duplicate … token` or `Duplicate … agent_id` | Two entries share a token or agent name. Each must be unique. |
| `EADDRINUSE` | Another program, often another copy of AgentBus, is using the port. Stop it, or change `bus.http_port`. |
| `make status` shows `errored` and many restarts | The bus starts and immediately fails. Run it in a terminal (above) to see why. |

## My agent doesn't answer

Work through these in order:

1. **Is the bus running?** `make status` should show `bus-core` as `online`.
2. **Is the channel connected?** `make health` should show the channel `online`. If it's `degraded` or `unhealthy`, check its token or password, and your internet connection.
3. **Is the sender known?** The logs show `Dropped message from unknown sender <id>` for Telegram, or a dropped-mail line for email. Add or correct the contact.
4. **Is there a route?** A message that matches no route waits for the `claude-code` runtime. Check that a route matches the channel exactly: `telegram:sam` and `email:work` need their own routes.
5. **Is the channel paused?** `/status` marks paused channels. Send `/resume <channel>`.
6. **Is the agent running?** Look for your runtime's lines in the logs (`[cc-headless]` or `[pool:…]`). Check that `claude --version` works and that `working_dir` exists.

## The agent replies with an error

You receive "Sorry — I hit an error processing that" (or your own `error_reply`) when a `cc-headless` turn fails. To see why:

- look for `[cc-headless]` lines in `make logs-err`; or
- set `error_passthrough: true` under `cc-headless`, restart, and try again: the error details are added to the reply. Turn it off again afterwards.

Common causes: Claude Code isn't signed in for the user the bus runs as, `claude` isn't found (set `claude_bin` to its full path, from `which claude`), or `working_dir` doesn't exist.

## A turn seems stuck

- Send `/stop` to end the current turn (`cc-headless`).
- Send `/clear` to start the conversation afresh.
- On `cc-pool`, send `/pane` to see what the pane is showing. It may be waiting at a permission prompt; see [Approvals](/features/approvals).

## Telegram

| Problem | Fix |
|---|---|
| The bot ignores messages in a group | Turn off the bot's privacy mode in @BotFather (`/setprivacy` › Disable), then remove the bot from the group and add it again. |
| `create_telegram_topic` fails | Make the bot a group admin with **Manage Topics**. |
| Formatting looks wrong | Telegram rejected the Markdown, so the message was sent as plain text. Ask your agent to use simpler formatting. |

## Email

| Problem | Fix |
|---|---|
| Mail never reaches the agent | Check the sender is listed under a contact's `email.address`, and look for a dropped-mail line in the logs. Mail that fails sender authentication is dropped while `require_auth` is on. |
| The adapter is `unhealthy` | Wrong host, port or password. Many providers need an app-specific password. |
| Mail sent while the bus was stopped was ignored | Expected: the bus only picks up new mail. Resend it. |

## cc-pool

| Problem | Fix |
|---|---|
| `claude_bin must be an absolute path` | Use the full path from `which claude`. |
| A pane is `dead` or never becomes ready | Run `make pool-capture N=<pane>` to see its screen. If it's stuck on Claude Code's "Loading development channels" warning, check `launch_ack_pattern` matches its wording. |
| `/pool` often shows parked messages | The pool is too small. Add panes, or set `growth: dynamic`. |
| Messages wait a long time for a pane | Install the `Stop` hook, so the bus knows when a pane is really idle. See [cc-pool](/runtimes/cc-pool#optional-hooks). |

## Search finds nothing after restoring a backup

If `search_transcripts` misses messages you know exist, rebuild the search index. Stop the bus, then start it once in a terminal with:

```bash
npx tsx src/index.ts --rebuild-fts
```

When it prints `bus-core ready`, press Control-C and start the bus as usual with `make start`.

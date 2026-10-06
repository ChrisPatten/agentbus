# Configuration reference

AgentBus reads all its settings from one YAML file, `config.yaml`, when it starts. This page lists every section. The guides for each channel, runtime and feature explain the options in context, with examples.

## The basics

- **Location.** The bus reads `config.yaml` from the folder you start it in. To use another file, set the `AGENTBUS_CONFIG` environment variable to its path.
- **Secrets.** Write `${NAME}` anywhere in the file to use a value from `.env`, the file of secrets next to `config.yaml`. A `${NAME}` with no matching line in `.env` stops the bus from starting.
- **Home folder.** A value starting with `~/` means your home folder.
- **Changes need a restart.** The bus doesn't reload the file while it runs.
- **Mistakes stop the bus.** If something's wrong, the bus prints `Config validation failed:` and a line for each problem, naming the setting, and exits.

`config.yaml.example` in the AgentBus folder is a commented example of every section.

A complete file needs `bus`, `adapters` and `memory` (which may be empty, `memory: {}`). Everything else is optional.

## bus

| Option | Default | What it does |
|---|---|---|
| `db_path` | required | Where the database is kept, for example `~/.agentbus/agentbus.db`. The folder is created if needed. |
| `http_port` | `3000` | The port the bus listens on |
| `host` | `127.0.0.1` | Which network the bus listens on. `127.0.0.1` means this computer only. `0.0.0.0` opens it to your local network; see [Running AgentBus](/operations/deployment#reaching-the-bus-from-other-devices). |
| `auth_token` | none | A shared password every request (except the health check) must send as `X-Bus-Token`. See below. |
| `log_level` | `info` | Accepted, but not applied yet |

::: tip Setting `auth_token`
Put the token in `.env` (for example `BUS_TOKEN=...`) and reference it as `auth_token: ${BUS_TOKEN}`. AgentBus's own agents pick it up automatically: claude-code, cc-headless and cc-pool all send it, and cc-pool passes it to each pane as `AGENTBUS_BUS_TOKEN` so the pool hook scripts send it too.

If you use the hook scripts with a plain `claude-code` session (not cc-pool), export `AGENTBUS_BUS_TOKEN` in the shell that starts `claude`. Your own scripts and clients, such as the Mac app or `make` targets, need to send `X-Bus-Token` themselves.

Even with a token, keep `host` at `127.0.0.1` unless you need the LAN, and expose only the paths you need through a narrowly scoped proxy (such as `tailscale serve --set-path`).
:::

## adapters

One block per channel or runtime you want to run. Leave a block out to turn it off.

| Block | Guide |
|---|---|
| `telegram` | [Telegram](/channels/telegram) |
| `email` | [Email](/channels/email) |
| `app` | [Mac app](/channels/mac-app) |
| `siri` | [Siri](/channels/siri) |
| `pebble` | [Pebble](/channels/pebble) |
| `cc-headless` | [cc-headless](/runtimes/cc-headless) |
| `cc-pool` | [cc-pool](/runtimes/cc-pool) |
| `claude-code` | [claude-code](/runtimes/claude-code) |

`telegram`, `email`, `cc-headless` and `cc-pool` each accept either one block, or several named blocks:

```yaml
adapters:
  telegram:            # one bot: channel "telegram"
    token: ${TELEGRAM_BOT_TOKEN}

  email:               # several mailboxes: channels "email:personal" and "email:work"
    personal:
      imap: { user: me@icloud.com, password: ${ICLOUD_APP_PW} }
    work:
      imap: { host: imap.fastmail.com, user: me@work.example, password: ${FASTMAIL_PW} }
```

Names may use lowercase letters, digits, `-` and `_`.

## contacts

The people allowed to use your agents, keyed by a short ID. See [Contacts and routing](/concepts/contacts-and-routing).

```yaml
contacts:
  me:
    id: me                   # must match the key
    displayName: Me
    platforms:
      telegram: { userId: 987654321, username: me_on_telegram }
      email: { address: [me@example.com] }
      app: { token: ${APP_TOKEN_ME} }
      siri: { token: ${SIRI_TOKEN_ME} }
      pebble: { token: ${PEBBLE_TOKEN_ME} }
```

| Field | Rules |
|---|---|
| `telegram.userId` | A positive whole number |
| `telegram.username` | Optional |
| `email.address` | One address or a list |
| `app.token`, `siri.token` | At least 16 characters, unique across contacts |
| `pebble.token` | Unique across contacts |

## agents

Per-agent settings, keyed by the agent's full name (with quotes, because of the colon).

```yaml
agents:
  "agent:assistant":
    media:
      download_path: /Users/you/.agentbus/assistant/media
      ttl_seconds: 3600
```

| Option | Default | What it does |
|---|---|---|
| `media.download_path` | required in `media` | Full path of the folder attachments are saved to |
| `media.ttl_seconds` | `3600` | How long attachments are kept |

See [Attachments](/features/attachments).

### owners

Who hears about problems with this agent. See [Owners and advisories](/features/owners-and-advisories).

```yaml
agents:
  "agent:assistant":
    owners:
      - channel: telegram
        contact_id: me
```

| Option | What it does |
|---|---|
| `channel` | The exact channel of your conversation with the agent, for example `telegram`, `telegram:assistant` or `app` |
| `contact_id` | A key under [`contacts`](#contacts), without `contact:` |

For a `cc-pool` agent, list the owners on the pool's own name. The bus won't start if an owner isn't a configured contact.

### journaling

How and when the bus has this agent record what's worth remembering from its conversations. See [Journaling and memory](/features/journaling-and-memory).

```yaml
agents:
  "agent:assistant":
    journaling:
      chain: [system-message, cc-headless, script]
      threshold_ms: { default: 1800000, telegram: 300000 }
      ceiling_ms: 14400000
      min_human_messages: 2
      script:
        command: /Users/you/agentbus/scripts/journalers/claude-p-journal.sh
```

| Option | Default | What it does |
|---|---|---|
| `enabled` | `true` | Turn journaling on or off for this agent |
| `chain` | `[system-message, cc-headless, script]`, with `script` only when `script.command` is set | The journalers to try, in order. If one can't run, the bus tries the next. Ones the agent's runtime can't use are skipped. |
| `threshold_ms` | `1800000` (30 min) | How long a conversation must be quiet before it's journaled. A number, or one value per channel with a required `default`. |
| `ceiling_ms` | none | Journal an ongoing conversation at least this often, even if it never goes quiet |
| `min_human_messages` | `2` | How many new messages from a person a conversation needs before a pause journals it. `/clear`, the end of a session and a bus restart journal it with fewer. Content that waits more than a day is journaled anyway. |
| `timeout_ms` | `300000` (5 min) | How long one journal run may take |
| `model` | the agent's model | The model journal runs use (`cc-headless` and `script`) |
| `prompt` | a built-in instruction | What the agent is asked to do when it journals |
| `system-message.timeout_ms` | `timeout_ms` | How long the live agent has to finish; its conversation's new messages wait at most this long |
| `system-message.prompt` | `prompt` | Instruction for the live agent |
| `cc-headless.model`, `cc-headless.prompt` | `model`, `prompt` | Model and instruction for `claude -p --resume` runs |
| `script.command` | required for `script` | Your script, as a full path or relative to the agent's working folder |
| `script.args` | `[]` | Arguments passed to it |
| `script.timeout_ms` | `timeout_ms` | How long it may run before it's stopped |
| `script.env` | `{}` | Extra environment variables, on top of `PATH`, `HOME` and the `AGENTBUS_*` ones |
| `script.model` | `model` | Passed to the script as `AGENTBUS_MODEL` |

Scheduled jobs, slash commands and messages from other agents don't count toward `min_human_messages`.

The bus checks the chain when it starts. It refuses to start if none of the journalers can work with the agent's runtime. If the chain could run out of options (it doesn't end with `script`), it logs a warning and tells the agent's [owners](#owners).

For a `cc-headless` agent without this block, the older `journaling` options under `adapters.cc-headless` still apply. They're deprecated; move them here.

### memory

Where the agent's memory files are, and how much of its recent journals it sees. See [Journaling and memory](/features/journaling-and-memory).

```yaml
agents:
  "agent:assistant":
    memory:
      dir: memory
      lookback_days: 3
```

| Option | Default | What it does |
|---|---|---|
| `dir` | `memory` | The memory folder, inside the agent's working folder (or a full path) |
| `index_file` | `MEMORY.md` | The memory index, loaded at the start of every session |
| `daily_subdir` | `daily` | The folder inside `dir` with one journal file per day (`2026-10-06.md`) |
| `lookback_days` | `3` | How many days of journals go into `recent.md`, counting today. `0` leaves it empty. |
| `recent_budget_chars` | `20000` | The most characters `recent.md` may hold. The newest days are kept; older ones are cut. |
| `native` | `true` | Let Claude Code load the memory folder itself. Set `false` to have the bus add `MEMORY.md` and `recent.md` to each turn instead (`cc-headless` only). |

For a `cc-headless` agent, the older `memory` options under `adapters.cc-headless` still apply where this block doesn't set them (`journal_lookback_days` there is `lookback_days` here). They're deprecated; move them here.

## pipeline

How messages are sorted and routed.

| Option | Default | What it does |
|---|---|---|
| `routes` | `[]` | Which agent gets which messages. See [Routes](/concepts/contacts-and-routing#routes). |
| `drop_unrouted` | `false` | Discard messages no route matches, instead of queuing them for `claude-code` |
| `relays` | `[]` | Re-send matching messages on another channel. See [Channel relay](/features/channel-relay). |
| `topic_rules` | `[]` | Sort messages into topics by keyword or pattern. See [Topic rules](/concepts/conversations-and-sessions#topic-rules). |
| `dedup_window_ms` | `30000` | Identical messages from the same sender within this window are dropped |
| `urgency_keywords` | `[urgent, asap, emergency, critical]` | Words that raise a message's priority |
| `vip_contacts` | `[]` | Contact IDs whose messages get a priority boost |
| `priority_weights` | see [Priority](/concepts/contacts-and-routing#priority) | `base_score`, `topic_bonus`, `vip_sender_bonus`, `urgency_keyword_bonus` |

A route:

```yaml
- match: { channel: telegram, sender: contact:me, topic: code }   # all optional
  target: { adapterId: cc-headless, recipientId: agent:assistant }
  also_notify:                                                    # optional
    - { adapterId: cc-headless, recipientId: agent:archivist }
```

A topic rule:

```yaml
- topic: travel
  keywords: [flight, hotel]          # and/or
  pattern: "\\bitinerar(y|ies)\\b"
```

## topics

```yaml
topics: [general, code, travel]
```

The topic names your setup uses. Default `[general]`.

## schedules

Fixed scheduled prompts. See [Scheduling](/features/scheduling) for every field.

```yaml
schedules:
  - id: morning_briefing
    label: Morning briefing
    cron: "0 8 * * 1-5"
    timezone: America/New_York
    channel: telegram
    sender: contact:me
    prompt: Give me my morning briefing.
```

## scheduler

| Option | Default | What it does |
|---|---|---|
| `enabled` | `true` | Fire schedules. With `false`, schedules are still loaded but never fire. |
| `tick_interval_ms` | `30000` | How often the bus checks for due schedules |

## memory

Required, but can be empty: `memory: {}`.

| Option | Default | What it does |
|---|---|---|
| `session_idle_threshold_ms` | `1800000` (30 min) | For conversations without a resumable Claude session (such as those on `claude-code`), how long a conversation can be quiet before its session ends |
| `summarizer_interval_ms` | `60000` | How often the bus checks for idle sessions and conversations due for journaling |

`claude_api_model`, `summary_max_tokens` and `structured_extraction` belonged to the old memory store, which has been removed. They're ignored, with a warning at startup; delete them. Journaling is configured per agent, under [`agents`](#journaling). See [Journaling and memory](/features/journaling-and-memory).

## Environment variables

| Variable | What it does |
|---|---|
| `AGENTBUS_CONFIG` | Path to the config file. Default: `config.yaml` in the current folder. `.env` is read from the same folder. |
| `TELEGRAM_DEBUG_PAYLOADS` | When set to anything, logs every raw Telegram update **instead of** passing it on. For troubleshooting only: messages received in this mode are lost. |

Any other variable you reference as `${NAME}` in the config is yours to name.

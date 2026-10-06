# cc-pool

`cc-pool` runs your agent as a set of real, interactive Claude Code sessions inside tmux, and lends one to each active conversation. You get the same one-session-per-conversation model as [`cc-headless`](/runtimes/cc-headless), but every session is a live Claude Code window you can watch, attach to and type into. When a session hits a permission prompt, you can [approve it from your phone](/features/approvals).

Choose it when you want to see what your agent is doing as it works, or when your agent needs interactive Claude Code features.

## How it works

The pool is a number of **panes**: tmux windows, each able to run one Claude Code session. Panes are lent out, or **leased**, to conversations:

1. **A message arrives** for a conversation that has no pane. The bus takes a free pane, starts Claude Code in it, and resumes the conversation's Claude session if it has one. Telegram shows "One moment…" while it starts.
2. **The conversation keeps its pane.** Later messages go straight to the same pane, with no start-up delay.
3. **When every pane is busy**, the bus takes the pane that's been idle longest, if it's been idle for at least `lease.idle_evict_ms` (30 minutes by default). That conversation gives up its pane, and resumes its session in a pane later.
4. **If no pane can be freed**, the message waits ("parks"). Parked messages are retried every minute. A message that's still waiting after `lease.park_timeout_ms` (5 minutes by default) gives up: it moves to the bus's dead-letter list, and the bus posts a notice on its `system` channel. Route `channel: system` to an agent if you want to hear about these.
5. **Long-idle conversations** give up their pane after `lease.hard_idle_ms` (6 hours by default) without activity, even when nobody else needs it.

Each pane gets its own connection to the bus, so a reply always goes back to the conversation that pane is leased to.

## Before you start

You need:

- **tmux**, installed and on your `PATH`.
- **The full path to the `claude` program.** In a terminal, run:

  ```bash
  which claude
  ```

  It prints something like `/Users/you/.local/bin/claude`. Use that, not just `claude`: inside tmux, a bare `claude` can resolve to a shell alias instead of the program.
- **A working folder for the agent** with its `CLAUDE.md`, just like any Claude Code project.

## Configure it

```yaml
adapters:
  cc-pool:
    agent_id: sam
    tmux_session: sam-pool
    panes: 3
    growth: dynamic
    max_panes: 6
    claude_bin: /Users/you/.local/bin/claude
    working_dir: ~/agents/sam
    model: sonnet
    lease:
      idle_evict_ms: 1800000      # 30 minutes
      hard_idle_ms: 21600000      # 6 hours
      park_timeout_ms: 300000     # 5 minutes
    on_evict: clear

pipeline:
  routes:
    - match: { channel: telegram }
      target: { adapterId: cc-pool, recipientId: agent:sam }
```

Routes reach the pool with `adapterId: cc-pool` and `recipientId: agent:<agent_id>`. The bus picks the pane.

| Option | Default | What it does |
|---|---|---|
| `agent_id` | required | The agent's name. Routes target `agent:<agent_id>`. |
| `tmux_session` | required | The tmux session that holds the panes. Must be unique per pool. |
| `claude_bin` | required | Full path to the `claude` program. |
| `panes` | `2` | How many panes the pool has. Each pane's tmux window is created the first time it's needed. |
| `growth` | `fixed` | `fixed` keeps exactly `panes` panes. `dynamic` adds panes when all are busy, up to `max_panes`. |
| `max_panes` | same as `panes` | The upper limit for a `dynamic` pool. |
| `working_dir` | the folder you start the bus from | The folder every pane runs in. |
| `model` | Claude Code's default | The model for new sessions. See [Choosing models](/features/models). The bus warns at startup if this isn't set. |
| `system_prompt` | none | Extra instructions **appended** to Claude Code's own prompt. Panes rely on the folder's `CLAUDE.md` first. |
| `launch_args` | `[]` | Extra command-line options for every `claude` launch. |
| `pane_env` | `{}` | Extra environment variables for every pane, for example `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "50"`. |
| `lease.idle_evict_ms` | `1800000` (30 min) | How long a conversation must be idle before another conversation can take its pane. |
| `lease.hard_idle_ms` | `21600000` (6 h) | How long a conversation can be idle before its pane is released anyway. |
| `lease.park_timeout_ms` | `300000` (5 min) | How long a message waits for a pane before giving up. |
| `on_evict` | `clear` | What happens to a released pane: `clear` sends `/clear` to the session; `kill` closes the window. |
| `launch_ack_delay_ms` | `5000` | How long to watch for Claude Code's "Loading development channels" warning at start-up, which the bus confirms for you. |
| `launch_ack_max_attempts` | `3` | How many times to try confirming that warning. |
| `launch_ack_pattern` | `loading development channels` | The text that identifies the warning, in case Claude Code rewords it. |

**Don't add `--dangerously-load-development-channels` to `launch_args`.** The bus already starts every pane with the options it needs to connect.

The pool starts every session with `--permission-mode auto`. Tool permissions otherwise follow your working folder's `.claude/settings.json`.

Panes read their other MCP servers from the working folder's `.mcp.json`, so your agent has the same tools it has when you run Claude Code there yourself.

## Watching your agent

| Command | Shows |
|---|---|
| `/pool` | Each pane, whether it's free or leased, the conversation it's leased to, its model and how long it's been idle, plus the number of parked messages |
| `/pane` | A picture of your conversation's pane, as it looks right now |
| `/pane 2` or `/pane all` | A picture of pane 2, or of every pane (up to 8) |
| `/rc` | Sends `/remote-control` to your conversation's pane, so you can take it over in the Claude app |
| `/rc 2` | The same, for pane 2 |
| `/status` | Includes a line per pool: how many panes are leased and how many messages are parked |

From a terminal in the AgentBus folder, you can also attach to a pane directly. `POOL_SESSION` is your `tmux_session`:

```bash
make pool-attach N=1 POOL_SESSION=sam-pool
```

You're now looking at pane 1's Claude Code session. To leave without stopping it, press **Control-B**, then **D**.

To print what's on a pane without attaching:

```bash
make pool-capture N=1 POOL_SESSION=sam-pool
```

And to see the pool's state as data:

```bash
make pool
```

## Optional hooks

Claude Code hooks in `scripts/hooks/` in the AgentBus folder make a pool work better. Install them in your agent's working folder:

| Hook | Claude Code event | What it adds |
|---|---|---|
| `agentbus_approval_hook.sh` | `PermissionRequest` | Lets you answer permission prompts from Telegram. See [Approvals](/features/approvals). |
| `agentbus_tool_status_hook.sh` | `UserPromptSubmit` and `PostToolUse` | Telegram's "typing…" indicator and live tool list while the agent works. |
| `agentbus_journal_hook.sh` | `Stop`, `PreCompact` and `SessionEnd` | Tells the bus each time a turn finishes, so a long-running turn isn't mistaken for an idle conversation. Before the conversation's context is compacted or cleared, it saves a copy of the transcript for journaling. |
| `agentbus_stop_hook.sh` | `Stop` | The older turn-finished hook. Keep it if you already have it, or use `agentbus_journal_hook.sh` instead. |

The scripts talk to the bus at `http://127.0.0.1:3000`. The approval and tool-status hooks have this address at the top of the file; the journal and stop hooks read `AGENTBUS_URL` from the environment instead and need no editing. The scripts need `jq` and `curl`; the tool-status hook also needs `python3`.

Panes only pick up new hook settings when they next start.

## What survives a restart

Restarting the bus doesn't interrupt your conversations. tmux keeps the panes running, and when the bus starts again it picks up every pane that's still alive, with its lease. If a pane's window has disappeared, its lease is released and a notice with the pane's last screen is posted on the `system` channel; the conversation resumes its Claude session in a new pane with the next message.

Parked messages and leases are stored in the bus database and survive a restart.

## Clearing a conversation

`/clear` ends the conversation's session in the bus. While the conversation still holds its pane, that pane's Claude session keeps its context. The fresh session starts the next time the conversation is given a pane. To start fresh straight away, use the Claude Code session directly (attach to it and run `/clear` there).

`/stop` doesn't apply to pool conversations. To interrupt a pane, attach to it and press Escape.

## Things to know

- **Only conversations with a pane are fast.** A conversation's first message after it lost its pane waits for Claude Code to start, typically several seconds.
- **Scheduled jobs use panes too.** A busy pool can delay them. Use `growth: dynamic` or more panes if `/pool` often shows parked messages.
- **Changing a conversation's model restarts its pane.** If a [model override](/features/models) changes the model for a conversation that holds a pane, the pane relaunches its session with the new model between turns.
- **Grown panes live in a different tmux session.** Panes added by `growth: dynamic` are in a tmux session named after `agent_id`, not `tmux_session`. `/pool` shows each pane's exact name. `/pane` and `/rc` only accept the numbered panes.

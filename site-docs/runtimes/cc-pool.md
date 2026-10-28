# cc-pool

`cc-pool` runs your agent as a set of real, interactive Claude Code sessions inside tmux, and lends one to each active conversation. You get the same one-session-per-conversation model as [`cc-headless`](/runtimes/cc-headless), but every session is a live Claude Code window you can watch, attach to and type into. When a session hits a permission prompt, you can [approve it from your phone](/features/approvals).

Choose it when you want to see what your agent is doing as it works, or when your agent needs interactive Claude Code features.

## How it works

The pool is a number of **panes**: tmux windows, each able to run one Claude Code session. Panes are lent out, or **leased**, to conversations:

1. **A message arrives** for a conversation that has no pane. The bus takes a free pane, starts Claude Code in it, and resumes the conversation's Claude session if it has one. Telegram shows "One moment…" while it starts.
2. **The conversation keeps its pane.** Later messages go straight to the same pane, with no start-up delay.
3. **When every pane is busy**, the bus takes the pane that's been idle longest, if it's been idle for at least `lease.idle_evict_ms` (30 minutes by default). That conversation gives up its pane right away (it's journaled in the background from its saved transcript), and resumes its session in a pane later.
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
| `poll_interval_ms` | `1000` | How often each pane checks for new messages, in milliseconds. Applies to panes started after you change it. |
| `pane_env` | `{}` | Extra environment variables for every pane, for example `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "50"`. |
| `lease.idle_evict_ms` | `1800000` (30 min) | How long a conversation must be idle before another conversation can take its pane. |
| `lease.hard_idle_ms` | `21600000` (6 h) | How long a conversation can be idle before its pane is released anyway. |
| `lease.park_timeout_ms` | `300000` (5 min) | How long a message waits for a pane before giving up. |
| `on_evict` | `clear` | What happens to a released pane: `clear` sends `/clear` to the session; `kill` closes the window. Either way, when the pane is next given to a conversation, the bus starts a fresh Claude session in it for that conversation. |
| `launch_ack_max_attempts` | `3` | How many times to try confirming Claude Code's "Loading development channels" warning at start-up, which the bus confirms for you. |
| `launch_ack_pattern` | `loading development channels` | The text that identifies the warning, in case Claude Code rewords it. |
| `model_confirm_pattern` | `switch model\?` | A pattern (regular expression, ignoring case) that identifies Claude Code's "Switch model?" question when [`/model`](/features/models#with-cc-pool) switches a pane in place. Change it only if Claude Code rewords the question. |
| `launch_ack_delay_ms` | | No longer used. The bus now watches for the warning until the pane is ready. Older configs that set it still load. |

You don't need `--dangerously-load-development-channels` in `launch_args`: the bus already starts every pane with the options it needs to connect. If your `launch_args` has it anyway (older example configs added it), the bus leaves out the copy, so it's only passed once.

The pool starts every session with `--permission-mode auto`. Tool permissions otherwise follow your working folder's `.claude/settings.json`.

Panes read their other MCP servers from the working folder's `.mcp.json`, so your agent has the same tools it has when you run Claude Code there yourself.

## Watching your agent

| Command | Shows |
|---|---|
| `/pool` | Each pane, whether it's free or leased, the conversation it's leased to, its model and how long it's been idle, plus the number of parked messages. The pane serving this chat is marked `◀ this chat`. |
| `/pool kill` | Kills the window serving this chat, even mid-turn. Your next message starts on a fresh window and resumes the same session |
| `/pane` | A picture of your conversation's pane, as it looks right now |
| `/pane 2` or `/pane all` | A picture of pane 2, or of every pane (up to 8) |
| `/rc` | Sends `/remote-control` to your conversation's pane, so you can take it over in the Claude app |
| `/rc 2` | The same, for pane 2 |
| `/keys Escape` | Presses keys in your conversation's pane (`/keys @2 …` for pane 2) and shows you a picture of it |
| `/status` | Includes a line per pool: how many panes are leased and how many messages are parked |

Claude Code's own commands, such as `/compact` or `/context`, are typed into your conversation's pane when you send them from chat. See [Claude Code commands](/features/slash-commands#claude-code-commands).

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

`make pool-kill POOL_SESSION=sam-pool` ends the whole tmux session, closing every pane at once, even mid-turn. To replace just the pane serving one chat, send `/pool kill` from that chat instead.

## Optional hooks

Claude Code hooks in `scripts/hooks/` in the AgentBus folder make a pool work better. Install them in your agent's working folder:

| Hook | Claude Code event | What it adds |
|---|---|---|
| `agentbus_approval_hook.sh` | `PermissionRequest` | Lets you answer permission prompts from Telegram. See [Approvals](/features/approvals). |
| `agentbus_tool_status_hook.sh` | `UserPromptSubmit` and `PostToolUse` | Telegram's "typing…" indicator and [status line](/channels/telegram#watching-your-agent-work) while the agent works, including lines the agent sets with the `status` tool. For the older lines with tool names and details, add `AGENTBUS_TOOL_STATUS_MODE: raw` to `pane_env`. |
| `agentbus_journal_hook.sh` | `Stop`, `PreCompact` and `SessionEnd` | Tells the bus each time a turn finishes, so a long-running turn isn't mistaken for an idle conversation. Before the conversation's context is compacted or cleared, it saves a copy of the transcript for journaling. |
| `agentbus_stop_hook.sh` | `Stop` | The older turn-finished hook. Keep it if you already have it, or use `agentbus_journal_hook.sh` instead. |
| `agentbus_recent_memory_hook.sh` | `UserPromptSubmit` and `SessionStart` | Keeps a long-running pane up to date with the agent's latest journals (`memory/recent.md`): it adds only the new entries when they change, and, if the agent doesn't import `recent.md`, delivers the whole file when the pane starts. See [How memory is organized](/features/agent-memory#keeping-long-sessions-up-to-date). |

All five scripts read the bus address from `AGENTBUS_URL` (default `http://127.0.0.1:3000`), so there's nothing to edit unless your bus uses another address. If you set [`bus.auth_token`](/reference/configuration#bus), the pool gives each pane the token as `AGENTBUS_BUS_TOKEN`, and every hook sends it. The scripts need `jq` and `curl`; the tool-status hook also needs `python3`.

Panes only pick up new hook settings when they next start.

## Your main chat with the agent

Your private Telegram chat with the bot is the conversation you come back to all day, like Main in the Mac app. You can tell the bus to treat it that way, so the agent learns what was sent into it from elsewhere:

```yaml
agents:
  "agent:assistant":
    pending_context:
      channels: [telegram:assistant]   # the bot's channel; your private chat only
```

The setting is off until you list a channel. It never applies to groups, forum topics or other bots, even ones that share the same bus. Topic rules under `pipeline.topic_rules` no longer split the listed chat into separate topics.

With it on:

- **Routines that message you reach the agent.** When a scheduled routine sends you something in this chat, the agent's next turn starts with it, with its date and time, how long ago it was sent, and the name of the routine that sent it (the schedule's label, or its id). You still see the message in Telegram as usual. The agent's own replies are never fed back to it, including a reply that finishes after its pane was moved to another chat.
- **Claude Code can brief the agent without a message.** A Claude Code session of yours can call `share_context` with this channel to hand the agent a note that you never see in Telegram. See [Proactive messages](/features/proactive-messages#letting-main-know-without-a-message). It works even when the agent has no pane right now, and the note waits for your next message. Notes older than 24 hours are skipped.
- **A message that never reaches the agent leaves the context waiting.** If your message is held back because every pane is busy, or it can't be delivered, the context stays waiting for the next message. The context counts as delivered the moment the agent's pane process takes your message, which is just before Claude reads it, so if the pane crashes in that moment, that delivery's context is lost.

The limits are the same as for the Mac app's Main (`max_items`, `max_chars`, `context_ttl_ms`). Anything you set under the agent's `pending_context` applies to this chat; whatever you leave out comes from `adapters.app.pending_context`.

To send notes from a Claude Code session on another machine, point its AgentBus tools at the bus with `AGENTBUS_URL` and give it the bus token in `AGENTBUS_BUS_TOKEN`. The bus speaks plain HTTP, so reach it through an SSH tunnel or an HTTPS proxy rather than over an open network. The token in the session's own config is never sent to another host.

## What survives a restart

Restarting the bus doesn't interrupt your conversations. tmux keeps the panes running, and when the bus starts again it picks up every pane that's still alive, with its lease. If a pane's window has disappeared, its lease is released and a notice with the pane's last screen is posted on the `system` channel; the conversation resumes its Claude session in a new pane with the next message.

Parked messages and leases are stored in the bus database and survive a restart.

## Clearing a conversation

`/clear` ends the conversation's session and journals it. The conversation lets go of its pane straight away, and the pane is cleared (or closed, with `on_evict: kill`) in the background, so your next message starts a fresh Claude session.

`/stop` doesn't apply to pool conversations. To interrupt a pane, attach to it and press Escape.

## Things to know

- **Only conversations with a pane are fast.** A conversation's first message after it lost its pane waits for Claude Code to start, typically several seconds.
- **Scheduled jobs use panes too.** A busy pool can delay them. Use `growth: dynamic` or more panes if `/pool` often shows parked messages.
- **Changing a conversation's model keeps its session.** `/model` switches an idle pane in place. A [model override](/features/models#with-cc-pool) set another way relaunches the pane's session with the new model at the next message, resuming where it was.
- **Grown panes live in a different tmux session.** Panes added by `growth: dynamic` are in a tmux session named after `agent_id`, not `tmux_session`. `/pool` shows each pane's exact name. `/pane` and `/rc` only accept the numbered panes.

# Slash commands

Slash commands let you control the bus from any chat. Type a message starting with `/` on Telegram, in the Mac app, by email or through Siri, and the bus answers it directly, without involving your agent. Use them to check on things, stop a runaway turn, or start a conversation fresh.

## How they work

- **The bus answers its own commands, not the agent.** A bus command (everything listed on this page) never reaches your agent, and costs nothing. The response arrives in the same chat.
- **Commands work while a channel is paused**, so `/resume` always gets through.
- **Commands are recorded** in the conversation's transcript like any other message.
- **Other commands go to your agent's Claude Code.** On `cc-pool` and `cc-headless`, a command the bus doesn't have, such as `/compact` or `/context`, is passed on to Claude Code. See [Claude Code commands](#claude-code-commands). On other runtimes you get `Unknown command: /foo`, with a pointer to `/help`.
- **Telegram and the Mac app list the commands** as you type `/`. In Telegram groups, `/status@YourBot` works as well as `/status`.

**Every contact can use every command.** There are no per-person permissions yet, so anyone listed under `contacts` can, for example, pause a channel.

## Commands

### Everyday

| Command | What it does |
|---|---|
| `/help` | Lists every command with a short description |
| `/help <command>` | Shows how to use one command, for example `/help sessions` |
| `/status` | Shows each channel's health, how many messages are waiting, and what your agents are doing |
| `/sessions` | Lists your 10 most recent sessions, newest first, marked `[active]` or `[closed]` |
| `/sessions <channel> --limit <n>` | Only sessions on one channel, up to 50, for example `/sessions telegram --limit 20` |
| `/clear` | Ends this conversation's session and journals it. Your next message starts afresh (on `cc-pool`, in a freshly cleared pane). |
| `/stop` | Stops the agent's current turn in this conversation straight away (`cc-headless` only) |
| `/cost` | Your agent's cost today, over the last 7 days and this month (`cc-headless` only) |

### Journaling

| Command | What it does |
|---|---|
| `/journal` | When this conversation was last journaled, how many messages are waiting, and how journaling is doing for its agent |
| `/journal runs [n]` | The last `n` journal runs (default 5, up to 20): which journaler ran, the outcome, what it could see, and the cost |
| `/journal now` | Journals this conversation now, if there's anything new since the last run |
| `/journal consolidate` | Has the agent consolidate its memory now, instead of waiting for the nightly pass |
| `/feedback <text>` | Tells the agent what to do differently. The bus acknowledges it; the agent takes it into account the next time it journals this conversation. |

See [Journaling and memory](/features/journaling-and-memory).

### Schedules

| Command | What it does |
|---|---|
| `/schedule` or `/schedule list` | Lists active scheduled messages for this channel, with their next run time in the schedule's own time zone |
| `/schedule cancel <id>` | Cancels a schedule. The first few characters of the ID are enough. |

See [Scheduling](/features/scheduling).

### Channels

| Command | What it does |
|---|---|
| `/pause <adapter>` | Stops passing messages from a channel to your agents, for example `/pause telegram` or `/pause email:work`. Messages that arrive while paused are dropped. |
| `/resume <adapter>` | Starts passing that channel's messages again |

The adapter names are the ones `/status` lists. A pause lasts across restarts until you resume.

### cc-pool

| Command | What it does |
|---|---|
| `/pool` | Each pane: free or leased, its conversation, model and idle time, plus parked messages |
| `/pane` | A picture of this conversation's pane as it looks now |
| `/pane <n>` or `/pane all` | A picture of pane `n`, or every pane (up to 8) |
| `/rc` or `/rc <n>` | Sends `/remote-control` to this conversation's pane, or pane `n` |
| `/keys <key>...` | Presses keys in this conversation's pane, then shows you a picture of it, for example `/keys Escape` or `/keys Down Enter` |
| `/keys @<n> <key>...` | The same, for pane `n` |

See [cc-pool](/runtimes/cc-pool#watching-your-agent).

### Sending keys with `/keys`

Use `/keys` to answer a prompt, interrupt a turn, or type into a pane without opening a terminal. Each word is one key. Key names such as `Enter`, `Escape`, `Tab`, `Up`, `Down`, `Space`, `BSpace` and `C-c` (Ctrl-C) are pressed as keys, and any other word is typed as text, so `/keys 1` types `1`. Put text with spaces in double quotes: `/keys "yes, go ahead" Enter`. One command sends up to 20 keys.

The keys go to whatever the pane is showing, so check it with `/pane` first. `/keys` also reaches a pane that is still starting up or shutting down, but not one that has failed.

## Claude Code commands

On `cc-pool` and `cc-headless`, you can run Claude Code's own commands from chat, including skills and plugin commands:

| You type | What happens |
|---|---|
| `/status`, `/clear`, `/journal`, … | A bus command: the bus answers it, as above. Bus commands always win. |
| `/compact`, `/context`, `/model`, … | The bus has no such command, so it passes it on to Claude Code. |
| `//clear`, `//status`, … | Two slashes pass the command on to Claude Code even though the bus has one with that name. |

What you get back depends on the runtime:

| Runtime | How the command runs | What you get back |
|---|---|---|
| `cc-pool` | Typed into your conversation's pane, followed by Enter | A picture of the pane about 1.5 seconds later |
| `cc-headless` | Run as its own turn in your conversation's session, after any turn already running | The command's output, or `Ran /name.` when it prints nothing |
| `claude-code` | Not supported | `Unknown command` |

```text
You:   /compact keep the migration plan
Agent: [picture] Sent /compact keep the migration plan to peggy-pool:1

You:   /context
Agent: ## Context Usage
       Tokens: 29k / 200k (15%)
```

The command isn't passed on, and you get a one-line reason, when:

- The name isn't a command name. It must start with a letter and use only letters, digits, `_`, `-` or `:`. `/Users/me/file` gets `Unknown command`.
- The channel you sent it from is paused.
- **`cc-pool`:** no pane is leased to your conversation, the pane is showing a permission prompt, or the command spans more than one line.
- **`cc-headless`:** Claude Code doesn't offer that command in headless mode, for example `/remote-control`.

Things to know:

- **A busy pane runs the command when its turn ends.** The picture may still show the turn running. Send `/pane` to see the result later.
- **Use `/clear`, not `//clear`.** `//clear` resets Claude Code's session but keeps the bus session open, so the conversation isn't journaled.
- **Typos are passed on.** `/stauts` goes to Claude Code, which reports it as unknown.
- **Only your agent gets the command.** Other agents copied on the conversation (`also_notify`) never receive it.

## What `/clear` and `/stop` act on

Both act on **this conversation**: the chat, thread or topic you send them from. `/clear` in a Telegram forum topic clears that topic's session and leaves your DM alone. In the Mac app, they act on the session you have open, even when it's a conversation from another channel.

# Slash commands

Slash commands let you control the bus from any chat. Type a message starting with `/` on Telegram, in the Mac app, by email or through Siri, and the bus answers it directly, without involving your agent. Use them to check on things, stop a runaway turn, or start a conversation fresh.

## How they work

- **The bus answers, not the agent.** A command never reaches your agent, and costs nothing. The response arrives in the same chat.
- **Commands work while a channel is paused**, so `/resume` always gets through.
- **Commands are recorded** in the conversation's transcript like any other message.
- **Unknown commands get a reply**: `Unknown command: /foo`, with a pointer to `/help`.
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
| `/clear` | Ends this conversation's session. Your next message starts afresh. |
| `/stop` | Stops the agent's current turn in this conversation straight away (`cc-headless` only) |
| `/cost` | Your agent's cost today, over the last 7 days and this month (`cc-headless` only) |

### Schedules

| Command | What it does |
|---|---|
| `/schedule` or `/schedule list` | Lists active scheduled messages for this channel, with their next run time |
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

See [cc-pool](/runtimes/cc-pool#watching-your-agent).

## What `/clear` and `/stop` act on

Both act on **this conversation**: the chat, thread or topic you send them from. `/clear` in a Telegram forum topic clears that topic's session and leaves your DM alone. In the Mac app, they act on the session you have open, even when it's a conversation from another channel.

# Getting started

This guide takes you from nothing to a working agent you can message from Telegram. It takes about 20 minutes. You'll install AgentBus, create a Telegram bot, write a short configuration file, start the bus, and send your agent its first message.

Every step below that uses the terminal shows the exact command to type. You don't need to know anything about the terminal beforehand.

## Before you start

You need:

| What | Why |
|---|---|
| A Mac or Linux computer that stays on | AgentBus runs on your own machine. When it's asleep or off, your agent can't answer. |
| [Node.js](https://nodejs.org) 20 or later | AgentBus is a Node.js program. |
| [Claude Code](https://code.claude.com), installed and signed in | Your agent is a Claude Code session. |
| Git | To download AgentBus. On a Mac it's installed the first time you run `git` (macOS offers to install the developer tools). |
| A Telegram account | For your first channel. Other channels can be added later. |

### Using the terminal

You'll type commands into a **terminal**. On a Mac, open the **Terminal** app (press ⌘-Space, type "Terminal", press Return). Type or paste each command, then press Return to run it.

The terminal always works "in" one folder at a time, called the **current folder**. Some commands below change the current folder, so run them in order, in the same terminal window.

A path starting with `~` means "inside your home folder". For example, `~/agentbus` is a folder called `agentbus` in your home folder (`/Users/yourname/agentbus` on a Mac).

### Check that Node.js and Claude Code are installed

Run:

```bash
node --version
```

You should see a version number such as `v22.11.0`. The first number must be 20 or higher. If you see `command not found`, install Node.js from [nodejs.org](https://nodejs.org) (choose the LTS version), then close and reopen Terminal and try again.

Then run:

```bash
claude --version
```

You should see a Claude Code version number. If you've never used Claude Code on this computer, run `claude` once, sign in when it asks, then type `/exit` to leave it.

## 1. Download AgentBus

Go to your home folder:

```bash
cd ~
```

Download AgentBus into a new folder called `agentbus`:

```bash
git clone https://github.com/ChrisPatten/agentbus.git
```

Move into that folder. Every remaining command in this guide runs from here:

```bash
cd agentbus
```

## 2. Install its dependencies

```bash
npm install
```

This downloads the libraries AgentBus needs. It takes a minute or two and prints a summary ending in something like `added 250 packages`. Warnings are normal. If it ends with `npm error`, see [Troubleshooting](/operations/troubleshooting).

## 3. Create a Telegram bot

Your agent talks to you through a Telegram bot that you own.

1. In Telegram, open a chat with **@BotFather** (the official bot for making bots).
2. Send `/newbot`.
3. Choose a display name (for example "My Agent"), then a username ending in `bot` (for example `my_agent_123_bot`).
4. BotFather replies with a **token**: a long string like `123456789:AAH...`. Keep it private. Anyone with this token can control your bot.

## 4. Store your secrets in a `.env` file

AgentBus keeps secrets such as the bot token out of its main configuration file. Instead, it reads them from a small file called `.env` in the same folder as the configuration. Each line in `.env` defines an **environment variable**: a name and a value, like `TELEGRAM_BOT_TOKEN=123456789:AAH...`. The configuration file then refers to the value by name, as `${TELEGRAM_BOT_TOKEN}`.

Create your `.env` from the included template:

```bash
cp .env.example .env
```

Open it in TextEdit:

```bash
open -e .env
```

Replace the placeholder after `TELEGRAM_BOT_TOKEN=` with your bot token, with no spaces or quotes around it. Leave the other lines as they are. Save and close the file.

::: tip Files starting with a dot are hidden
Finder hides files whose names start with `.`, so you won't see `.env` there. That's expected. The `open -e` command above opens it directly.
:::

## 5. Create your agent's folder

Your agent works inside a folder of its own. Claude Code reads that folder's `CLAUDE.md` for the agent's instructions, and the agent keeps its files there.

```bash
mkdir -p ~/agentbus-agent
```

To give your agent a personality or standing instructions, create `~/agentbus-agent/CLAUDE.md` and write them there, the same way you would for any Claude Code project. You can do this later.

## 6. Write your configuration

AgentBus reads its settings from `config.yaml` in the `agentbus` folder. Create an empty file and open it:

```bash
touch config.yaml
```

```bash
open -e config.yaml
```

Paste in the following, then save:

```yaml
bus:
  http_port: 3000
  db_path: ~/.agentbus/agentbus.db

adapters:
  telegram:
    token: ${TELEGRAM_BOT_TOKEN}
  cc-headless:
    agent_id: assistant
    working_dir: ~/agentbus-agent
    system_prompt: |
      You are a helpful personal assistant talking to {{contact_id}} on {{channel}}.
      Today is {{date}}.
      Deliver every message to the user by calling the `reply` tool with the
      message id shown as [id:<id>]. Do not put your answer only in plain text.

contacts:
  me:
    id: me
    displayName: Me
    platforms:
      telegram:
        userId: 1

memory: {}

pipeline:
  routes:
    - match: { channel: telegram }
      target: { adapterId: cc-headless, recipientId: agent:assistant }
```

What this says, section by section:

- **`bus`**: the bus listens on port 3000 of this computer only, and keeps its database in `~/.agentbus/`.
- **`adapters`**: turn on the Telegram channel with your token, and run your agent with the [`cc-headless` runtime](/runtimes/cc-headless) in the folder you created.
- **`contacts`**: the people allowed to talk to your agent. Right now that's you, with a placeholder Telegram ID of `1`. You'll fix that in the next step.
- **`memory`**: required, even when empty.
- **`pipeline.routes`**: send every Telegram message to the agent called `assistant`.

::: warning Indentation matters, and TextEdit can break quotes
YAML uses spaces (never tabs) to show structure, so keep the indentation exactly as shown. If TextEdit turns straight quotes into curly ones, turn off **Edit › Substitutions › Smart Quotes** and retype them, or use a code editor such as Visual Studio Code.
:::

## 7. Find your Telegram user ID

AgentBus only answers people listed under `contacts`, and it recognizes you on Telegram by your numeric user ID. The easiest way to find yours is to let AgentBus tell you.

Start the bus:

```bash
npx tsx src/index.ts
```

After a few seconds you should see a line like:

```
AgentBus bus-core ready — HTTP 127.0.0.1:3000
```

Now, in Telegram, find your bot by its username and send it any message, such as "hi". Your agent won't answer yet. Instead, the terminal prints:

```
[telegram] Dropped message from unknown sender 987654321
```

That number is your user ID. Stop the bus by pressing **Control-C** in the terminal.

Open `config.yaml` again, replace `userId: 1` with your number (for example `userId: 987654321`), and save.

## 8. Start the bus and send your first message

Start the bus again:

```bash
npx tsx src/index.ts
```

Wait for the `bus-core ready` line, then send your bot a message in Telegram, such as "What can you do?".

Within a few seconds you'll see "typing…" in Telegram, then your agent's reply. The first reply in a conversation is slower, because Claude Code is starting up.

Keep the terminal window open: the bus runs only while that command is running. When you close the window or press Control-C, your agent stops answering.

## If something goes wrong

| What you see | What to do |
|---|---|
| `Config validation failed:` followed by a list | Each line names a setting and what's wrong with it. Fix it in `config.yaml` and start again. |
| `Config references undefined env var: TELEGRAM_BOT_TOKEN` | `.env` is missing, isn't in the `agentbus` folder, or the line is misspelled. |
| `Dropped message from unknown sender` after you set your ID | The `userId` in `config.yaml` doesn't match the number in the message, or you didn't restart the bus after saving. |
| "Sorry — I hit an error processing that. Please try again." | The agent couldn't run. Check that `claude --version` works and that `~/agentbus-agent` exists. |
| `EADDRINUSE` | Something else is using port 3000, often another copy of AgentBus. Close the other terminal window or change `http_port`. |

More in [Troubleshooting](/operations/troubleshooting).

## Next steps

- **Keep it running** in the background and restart it automatically: [Running AgentBus](/operations/deployment).
- **Add more channels**: [Email](/channels/email), the [Mac app](/channels/mac-app), [Siri](/channels/siri), [Pebble](/channels/pebble).
- **Learn the ideas** behind contacts, routes and sessions: [How AgentBus works](/concepts/how-it-works).
- **Schedule** a daily briefing: [Scheduling](/features/scheduling).

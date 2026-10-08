# Mac app

The AgentBus Mac app is a native window onto your agent. It shows every conversation you have with the agent, from every channel, with full history, and lets you continue any of them from your Mac. You can start new topics, drop in files, run slash commands, and see what your agent is working on right now.

::: warning Early release
The Mac app and its bus channel are built and tested, but haven't yet been through a full live trial. Expect rough edges. Known gaps are listed at the end of this page.
:::

## What you can do

- **Talk in Main.** Main is your default conversation with the agent in the app. Messages your agent sends to the app without naming a topic also land here.
- **Start topics.** Press ⌘N for a new topic, a separate conversation with its own session. A topic is named after its first message; rename it with ⌘R.
- **Continue conversations from other channels.** Your Telegram, email and other conversations with the same agent appear in the sidebar. Open one and reply from the Mac: the agent sees that the message came from the app, continues the same session, and answers in the app. The reply isn't copied to the other channel.
- **Pick up earlier sessions.** Ended sessions are listed under **Earlier**. If Claude still has the session's history on disk, sending a message there starts a new topic named after the original with "(resumed)" added, which continues it. Otherwise the session is read-only.
- **Send files.** Attach files with ⌘O, by dragging them onto the window, or by pasting files copied in Finder. The bus limit is 25 MB per file by default.
- **Run commands.** Type `/` to pick from the bus's [slash commands](/features/slash-commands). The **Session** menu has Stop (⌘.) and Clear Session (⇧⌘K), and **More** has Cost.
- **See what the agent is doing.** While a turn runs, the conversation shows "Working" with a timer and the tools the agent is using. If all the agent's slots are busy, it shows "Waiting for a free slot". The sidebar marks conversations that are running, queued or unread.
- **Get notified.** The app notifies you of agent messages in conversations you aren't looking at, and shows unread counts on its Dock icon. Message previews can be hidden in Settings.

**Nothing is lost while the app is closed.** The bus records every message and session change. When the app reconnects, after sleep, a network change or days away, it catches up on everything that happened.

## Set up the bus

Create a token for the app. In a terminal, run:

```bash
openssl rand -hex 24
```

Copy the line it prints, and add it to your `.env` file:

```
APP_TOKEN_ME=paste-the-token-here
```

Then turn on the app channel, give your contact the token, route the `app` channel to your agent, and give the agent a folder for uploads:

```yaml
adapters:
  app: {}

contacts:
  me:
    id: me
    displayName: Me
    platforms:
      app:
        token: ${APP_TOKEN_ME}

agents:
  "agent:assistant":
    media:
      download_path: /Users/you/.agentbus/assistant/media
      ttl_seconds: 604800        # keep uploads for 7 days

pipeline:
  routes:
    - match: { channel: app }
      target: { adapterId: cc-headless, recipientId: agent:assistant }
```

Restart the bus.

| Option | Default | What it does |
|---|---|---|
| `enabled` | `true` | Turns the channel on. Leaving out `adapters.app` turns it off. |
| `event_retention_days` | `30` | How long the bus keeps the history the app uses to catch up. An app that's been away longer reloads from scratch. |
| `max_upload_bytes` | `26214400` (25 MB) | Largest file the app can upload |
| `ping_interval_ms` | `30000` | How often the bus checks the connection is alive |

The app uses the bus's own address and port. It doesn't need anything else opened.

**The app talks to one agent:** the agent that your first matching `app` route points to, for your contact. The sidebar shows that agent's conversations on every channel.

Without a `media` folder for that agent, the app can chat but uploads are refused. Uploaded files are deleted after `ttl_seconds` (default one hour), after which the app shows them as expired.

## Install the app

The app is built from source with Xcode. You need:

- macOS 26.5 or later;
- Xcode, from the Mac App Store;
- [Homebrew](https://brew.sh), to install XcodeGen.

Install XcodeGen:

```bash
brew install xcodegen
```

Go to the app's folder inside AgentBus:

```bash
cd ~/agentbus/apps/macos/AgentBus
```

Generate the Xcode project:

```bash
xcodegen generate
```

Open it in Xcode:

```bash
open AgentBus.xcodeproj
```

In Xcode, select the **AgentBus** project, open **Signing & Capabilities**, and choose your own team (your Apple ID works). Then press **⌘R** to build and run.

## Connect the app

On first launch, the app opens **Settings › Connection**:

| Field | What to enter |
|---|---|
| Bus URL | `http://127.0.0.1:3000`, the default, when the bus runs on this Mac |
| App token | The token you put in `APP_TOKEN_ME` |
| Bus token | Leave empty |

Click **Test Connection**. It shows your contact, the agent, the number of slots and the upload limit. Once the test succeeds, the app saves the tokens in your Keychain and opens Main.

The app is meant to run on the same Mac as the bus. Any other address must use HTTPS.

## Things to know

- **Agent activity is shown for `cc-headless` agents.** With `cc-pool` or `claude-code`, the app shows messages but not the "Working" state.
- **A conversation continued from another channel** shows the agent's progress in the app only for turns you started from the app.
- **Quiet app conversations can end.** An app topic or Main that never got an agent turn (for example, a Main that has only received scheduled messages) is closed after 30 minutes and moves to Earlier.
- **Images uploaded from the Mac** reach the agent as files, which it can still open by path.

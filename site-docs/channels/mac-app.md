# Mac app

The AgentBus Mac app is a native window onto your agent. It shows every conversation you have with the agent, from every channel, with full history, and lets you continue any of them from your Mac. You can start new topics, drop in files, run slash commands, and see what your agent is working on right now.

::: warning Early release
The Mac app and its bus channel are built and tested, but haven't yet been through a full live trial. Expect rough edges. Known gaps are listed at the end of this page.
:::

## What you can do

- **Talk in Main.** Main is your default conversation with the agent in the app, and it works like a direct message thread: one conversation with all its history, always at the top of the sidebar. Messages your agent sends to the app without naming a topic land here too, one after another, even when you don't answer. See [Main](#main) below.
- **Start topics.** Press ⌘N for a new topic, a separate conversation with its own session. A topic is named after its first message; rename it with ⌘R.
- **Continue conversations from other channels.** Your Telegram, email and other conversations with the same agent appear in the sidebar. Open one and reply from the Mac: the agent sees that the message came from the app, continues the same session, and answers in the app. The reply isn't copied to the other channel.
- **Pick up earlier sessions.** Ended sessions are listed under **Earlier**. If Claude still has the session's history on disk, sending a message there starts a new topic named after the original with "(resumed)" added, which continues it. Otherwise the session is read-only.
- **Send files.** Attach files with ⌘O, by dragging them onto the window, or by pasting files copied in Finder. The bus limit is 25 MB per file by default.
- **Copy messages.** Hover over an agent's reply and click **Copy** to copy its Markdown. You can also right-click any message, yours or the agent's, and choose **Copy Message**.
- **Select text.** Drag across a whole message, including bullets, headings and quotes, and press ⌘C. Shift-click extends a selection, and double-click then drag selects word by word. A selection stops at a code block, which has its own **Copy** button.
- **Reply to part of a message.** Select the text you want to answer, then right-click and choose **Reply**, or press ⇧⌘R. The selection is added to your draft as a quote, with its bold, links, headings and lists intact, and the cursor is placed after it for your answer. Reply again to quote more, from the same message or others in the conversation. The agent receives the quote as part of your message.
- **Reply to a message.** Right-click a message, with nothing selected, and choose **Reply**. A bar above the message box shows what you're replying to; press Esc or click ✕ to cancel. The agent sees what you replied to above your message. Your sent message shows a "Replying to…" note, and clicking it jumps to the original, loading older history if needed. When the agent replies to an earlier message rather than your latest one, the app shows the quote on the agent's message too. Replying needs a bus that supports it; update the bus along with the app.
- **Run commands.** Type `/` to pick from the bus's [slash commands](/features/slash-commands). The **Session** menu has Stop (⌘.) and Clear Session (⇧⌘K), and **More** has Cost.
- **See what the agent is doing.** While a turn runs, the conversation shows "Working" with a timer and the tools the agent is using. If all the agent's slots are busy, it shows "Waiting for a free slot". The sidebar marks conversations that are running, queued or unread.
- **Get notified.** The app notifies you of agent messages in conversations you aren't looking at, and shows unread counts on its Dock icon. Message previews can be hidden in Settings.

## Main

Main keeps everything in one place. Your messages, the agent's replies, and the updates the agent sends on its own (a morning scan, a reminder from a scheduled job) all appear in Main in order, and the history never moves to **Earlier**.

**The agent catches up when you reply.** Updates can come from a scheduled routine or another agent session, not from the agent you're chatting with in Main. The next time you send a message in Main, the agent first sees every such update it hasn't seen yet, with when it was sent and who sent it, so you can simply answer "yes, move it" to a scan from this morning. To answer one update in particular, right-click it and choose **Reply**; the agent sees which one you mean.

**The agent's working memory refreshes after a quiet spell.** Behind Main, the agent runs a Claude session. After 12 hours with no messages from you and no replies from the agent, the bus journals that session and the next message you send starts a fresh one. Updates the agent sends on its own don't count as activity. The scrollback stays as it was, and a **New context** divider marks the spot, for example "New context · after 12 h idle". Messages above the divider are no longer in the agent's working context, though anything it journaled is still in its memory files.

**`/clear` works the same way.** Clearing Main starts a fresh Claude session right away and shows "New context · /clear". Main keeps its scrollback, your unread count and your draft.

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
| `main_idle_rotation_ms` | `43200000` (12 hours) | How long Main can go without a message from you or a reply from the agent before its Claude session is journaled and the next message starts a fresh one. `0` turns this off. |
| `pending_context.max_items` | `10` | The most updates the agent catches up on in one go when you reply in Main. Older ones are summarized as "N older messages omitted". |
| `pending_context.max_chars` | `4000` | How much text those updates can take up in total |

For example, to refresh Main's session after a full day of quiet instead of 12 hours, and let the agent catch up on more updates:

```yaml
adapters:
  app:
    main_idle_rotation_ms: 86400000   # 24 hours
    pending_context:
      max_items: 20
      max_chars: 8000
```

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
- **Quiet app topics can end.** An app topic that never got an agent turn is closed after 30 minutes and moves to Earlier. Main is never closed this way, so scheduled messages keep landing in the same Main.
- **Catching up needs `cc-headless`.** The agent sees updates it hasn't seen when Main runs on a `cc-headless` agent.
- **Images uploaded from the Mac** reach the agent as files, which it can still open by path.

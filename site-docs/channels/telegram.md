# Telegram

Telegram is the quickest way to reach your agent from your phone. You chat with your own Telegram bot, and your agent answers there: with formatting, reactions, a "typing…" indicator and a live view of what it's doing. In a group with topics turned on, each topic becomes its own conversation, so you can keep separate threads of work apart.

## Set it up

1. Create a bot with **@BotFather** in Telegram: send `/newbot`, choose a name and a username, and copy the token it gives you.
2. Add the token to your `.env` file:

   ```
   TELEGRAM_BOT_TOKEN=123456789:AAH...
   ```

3. Add the bot and yourself to `config.yaml`, with a route to your agent:

   ```yaml
   adapters:
     telegram:
       token: ${TELEGRAM_BOT_TOKEN}

   contacts:
     me:
       id: me
       displayName: Me
       platforms:
         telegram:
           userId: 987654321

   pipeline:
     routes:
       - match: { channel: telegram }
         target: { adapterId: cc-headless, recipientId: agent:assistant }
   ```

4. Restart the bus.

**Only listed people can use your bot.** Messages, reactions and button taps from anyone whose Telegram user ID isn't under a contact are dropped. To find a user ID, have the person message the bot: the bus log shows `Dropped message from unknown sender <id>`.

| Option | Default | What it does |
|---|---|---|
| `token` | required | The bot token from @BotFather |
| `poll_timeout` | `30` | How long, in seconds, each request to Telegram waits for new messages |
| `choice_ttl_hours` | `24` | How long [buttons](#buttons) and [share requests](#asking-you-for-a-location-contact-or-person) stay answerable |
| `send_paths` | each agent's `data/` folder and its Claude Code scratchpad | The folders your agent may [send files](#cards-files-and-rich-messages) from, as full paths |

### Several bots

To run more than one bot, for example one per agent, name them:

```yaml
adapters:
  telegram:
    sam:
      token: ${TELEGRAM_BOT_TOKEN_SAM}
    research:
      token: ${TELEGRAM_BOT_TOKEN_RESEARCH}

pipeline:
  routes:
    - match: { channel: "telegram:sam" }
      target: { adapterId: cc-headless, recipientId: agent:sam }
    - match: { channel: "telegram:research" }
      target: { adapterId: cc-headless, recipientId: agent:research }
```

Each bot's channel is `telegram:<name>`. Names may use lowercase letters, digits, `-` and `_`, and each bot needs its own token. The same contacts may use every bot.

## Direct messages

Your private chat with the bot is one [conversation](/concepts/conversations-and-sessions). It keeps its Claude session until you send `/clear`, so you can pick up a topic days later.

If your agent runs on [`cc-pool`](/runtimes/cc-pool#your-main-chat-with-the-agent), you can make this chat work like Main in the Mac app: the agent hears about routine messages sent into it, and your Claude Code sessions can brief it with notes you don't see in Telegram.

## Groups and forum topics

Add the bot to a Telegram group and it works there too, with no extra configuration:

- **The group gets its own channel**, `telegram:group:<chat id>` (or `telegram:<bot>:group:<chat id>` for a named bot). A route for `telegram` (or `telegram:<bot>`) also matches the bot's groups. To send one group to a different agent, put a route naming its exact channel first.
- **Each forum topic is its own conversation.** In a group with Topics turned on, every topic has its own session. Messages in General, or in a group without topics, form one conversation.
- **Each member has their own conversation.** Two people talking in the same topic each get their own session with the agent. Every member who talks to the bot must be a contact.

For the bot to see ordinary messages in a group (not just commands and replies to it), turn off its privacy mode: in @BotFather, send `/setprivacy`, choose your bot, and pick **Disable**. Telegram only applies the change to groups the bot joins afterwards, so remove the bot from the group and add it again.

### Creating topics

Your agent can open a new forum topic in a group with the `create_telegram_topic` tool, optionally with a note it will see when the topic's first message arrives. For this, the bot must be a group admin with the **Manage Topics** right: open the group's member list, select the bot, choose **Edit Admin Rights** and turn on **Manage Topics**.

## Replies, quotes and reactions

- **Quoting.** When you reply to a message, the agent sees the quoted text. When the agent replies to an earlier message, Telegram shows it as a quote. It skips the quote when it's answering your most recent message, to avoid clutter.
- **Reactions.** Your reactions to the agent's messages are passed to the agent. The agent can react to your messages too. Emoji that Telegram doesn't allow as reactions are sent as a plain message instead.

## Buttons

When your agent needs a decision from you, it can attach up to 8 buttons to a message. Tap one and the agent receives `[tapped] <label>` as your answer, in the same chat or topic. Typing an answer still works too.

- **Only you can answer.** A button tap from anyone other than the person the message was for is refused, and so is a second tap. Buttons stop working after 24 hours (`choice_ttl_hours`), and the bus removes them.
- **After you tap**, the message shows `You chose: <label>` and the buttons disappear. If the message has any of the special buttons below, the button you chose stays on the message instead, ticked and greyed out, and the others disappear.
- **Styled, copy and link buttons.** A button can be colored as a primary, success or danger action, copy a piece of text to your clipboard, or open a link. Copy and link buttons don't send anything back to the agent.

Some [slash commands](/features/slash-commands) use buttons too: `/model` offers a picker of models, and tapping one runs the command for you.

On other channels, the same choices arrive as a numbered list at the end of the message.

## Cards, files and rich messages

Besides ordinary text, your agent can send:

| What | What you see |
|---|---|
| A location or venue | A map card for a fixed point (not a live location) |
| A contact | A contact card you can save |
| A file or photo | The file itself, with an optional caption. Files can be up to 50 MB, photos up to 10 MB, and only from the folders in `send_paths`. |
| A rich message | Headings, real tables, sections you tap to expand, and rows of link buttons, in one message of up to 32,768 characters. Longer ones are split into parts. |

The agent can also **edit** a message it sent earlier, so a status report can update in place, and **pin** or unpin its messages. Pinning in a group needs the bot to be an admin with the **Pin Messages** right; without it, the agent is told how to fix that. Your agent can send a message **silently**, with no notification sound, or without a link preview.

If the conversation is on another channel, these arrive as plain text instead: a location as coordinates with a map link, a table as a list. Files can only be sent on Telegram.

## Asking you for a location, contact or person

Your agent can ask you to share your location, a contact, or a Telegram user. In your private chat with the bot, the request shows a one-tap button that opens Telegram's share sheet. Telegram only allows these buttons in private chats, so in a group the agent asks in words and you share from the attach (📎) menu. The agent can also ask for a typed answer, which opens Telegram's reply box.

Your answer reaches the agent as a message linked to its question, such as `[location] 51.5007, -0.1246` or `[contact] Sam Lee, +44 20 7946 0000`. Locations and contacts you share without being asked are passed on the same way.

## Watching your agent work

While your agent works, you see:

- **"typing…"**, from the moment the agent picks up your message until it replies (for up to two minutes at a time);
- **a short status line**, in a single message that changes as it goes, such as "Reading a file", "Checking the calendar" or "Searching the web". Each line replaces the previous one.

The line only ever says what kind of thing the agent is doing. File names, commands, search terms and message text are never shown. Your agent can also set the line itself, in its own words ("Comparing the quotes"), and its words stay until it changes them or the turn ends. When the agent replies, its answer replaces the status message.

The phrases come from `scripts/hooks/tool-status-phrases.json` in the AgentBus folder. Edit it to change the wording or to give your own tools and commands a phrase.

The status line is built in for `cc-headless`. For `cc-pool` and `claude-code`, install the tool-status hook described under [cc-pool](/runtimes/cc-pool#optional-hooks).

To see the tool name and its details instead, as earlier versions did, set the mode to `raw`:

```yaml
tool_status:
  mode: raw          # default: phrases
```

For `cc-pool` and `claude-code`, the hook doesn't read `config.yaml`: set `AGENTBUS_TOOL_STATUS_MODE: raw` in the pool's `pane_env` (or in the shell that starts `claude`) to match. In raw mode a long run keeps only the most recent steps, with `… (earlier steps omitted)` at the top.

`/stop` ends the current turn and leaves the status message in place with a note.

## Formatting and long messages

The agent's replies are sent with Telegram's Markdown formatting (bold, italics, code and links). If Telegram rejects the formatting, the message is resent as plain text, so nothing is lost.

Replies longer than Telegram's 4,096-character limit are split into several messages, at line breaks where possible.

## Commands

The bus registers its [slash commands](/features/slash-commands) with Telegram at startup, so typing `/` in the chat shows them with descriptions.

## Attachments

Photos and files you send are saved for your agent when you've configured a download folder. See [Attachments](/features/attachments). Voice messages, videos and stickers aren't downloaded; their caption, if any, is passed on as text.

## Things to know

- **Reactions inside a forum topic** go to the group's General conversation, not the topic's.
- **Replies that fail to send** aren't retried. They're kept in the bus's dead-letter list; see [Troubleshooting](/operations/troubleshooting).
- **Approval requests** from [`cc-pool`](/features/approvals) always arrive in your private chat with the bot, even when the conversation is in a group.

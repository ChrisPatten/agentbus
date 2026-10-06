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

## Watching your agent work

While your agent works, you see:

- **"typing…"**, from the moment the agent picks up your message until it replies (for up to two minutes at a time);
- **a live list of what it's doing**, in a single message that updates as it goes:

  ```
  📖 Reading `notes/travel.md`
  🔍 Searching for `flight confirmation`
  🌐 Fetching `https://example.com/status`
  ```

When the agent replies, its answer replaces that progress message. A long run keeps only the most recent steps, with `… (earlier steps omitted)` at the top.

The progress list is built in for `cc-headless`. For `cc-pool` and `claude-code`, install the tool-status hook described under [cc-pool](/runtimes/cc-pool#optional-hooks).

`/stop` ends the current turn and leaves the progress message in place with a note.

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

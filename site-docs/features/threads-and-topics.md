# Threads and topics

Threads and topics let you run several conversations with your agent on one channel without them bleeding into each other. Each email thread, Telegram forum topic and Mac app topic gets its own session, so the agent keeps the context of that thread and only that thread.

None of this needs configuring. The bus recognizes threads on its own.

## Where threads come from

| Channel | A new conversation starts when you… | It continues when you… |
|---|---|---|
| Email | Send a new email (not a reply), or forward one | Reply in the thread |
| Telegram | Post in a new forum topic of a group with Topics turned on | Post in the same topic |
| Mac app | Press ⌘N | Post in the same topic |

Inside the bus, each of these is a topic named `thread:` plus a short code. You'll see these names in `/sessions`, in tool results, and in the Mac app's inspector.

In a Telegram group, threads are per person: two members in the same forum topic each have their own conversation with the agent.

## Your agent can use threads too

- **Replies stay in the thread.** When your agent answers with `reply`, the answer goes to the same email thread, forum topic or app topic.
- **Starting a Telegram topic.** Your agent can open a new forum topic in a group with `create_telegram_topic`, giving it a name and, optionally, a note it will see when the first message arrives there. The bot needs the **Manage Topics** admin right. See [Telegram](/channels/telegram#creating-topics).
- **Posting into an existing thread.** With `send_message`, the agent can post to a specific topic by passing its `thread:` name. It can find thread names with `list_sessions`.

## Keyword topics

Separate from threads, [topic rules](/concepts/conversations-and-sessions#topic-rules) can sort ordinary messages into named topics such as `code` or `travel`, each with its own session. Threads are never re-sorted by topic rules.

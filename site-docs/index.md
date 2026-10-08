# What is AgentBus?

AgentBus connects the places you already chat — Telegram, email, a native Mac app, Siri on your iPhone, a Pebble Ring — to a Claude Code agent that you run on your own machine. You message your agent the way you'd message a person, and it answers in the same place, with its own files, tools and memory behind it.

Your agent gets one inbox and one outbox across all of those channels. You configure who may talk to it, which agent handles which messages, and how the agent runs. AgentBus takes care of the rest: receiving messages, keeping each conversation in its own session, delivering replies, and running scheduled work.

## The core idea

```
 Channels                    The bus                      Agents
 ─────────                   ───────                      ──────
 Telegram  ─┐                                         ┌─▶ cc-headless  (claude -p per message)
 Email     ─┤   receive ─▶ identify ─▶ route ─▶ queue ─┼─▶ cc-pool      (interactive sessions in tmux)
 Mac app   ─┤                                         └─▶ claude-code  (one shared session)
 Siri      ─┤
 Pebble    ─┘   ◀──────────── deliver replies ◀──────────── reply / send_message tools
```

- **Channels** are where messages come from and where replies go. Each channel has an adapter inside the bus that speaks its protocol.
- **The bus** is a single background program. It checks who sent each message, decides which agent should handle it, records it, and queues it.
- **Agents** are Claude Code sessions. The bus starts them for you and gives them tools such as `reply`, `send_message` and `schedule_message`, so they can answer, reach you on another channel, or set a reminder.

Everything runs on your own computer and is stored in one local database. Nothing goes through a hosted service other than the chat platforms themselves and Claude.

## Who it's for

AgentBus is for people who already use Claude Code and want a personal agent they can reach from anywhere: a phone, an email client, a watch-free voice note, or a Mac window. You don't need to write code to use it. You do need to be comfortable editing a configuration file and running a few commands, and the [Getting started](/getting-started) guide walks you through each one.

## What you can do with it

- **Chat with your agent from Telegram**, including in group forum topics where each topic is its own conversation.
- **Email your agent** and get formatted replies in the same thread.
- **Use the Mac app** to see all your conversations with the agent, from every channel, in one window.
- **Ask Siri** a question and have your agent answer it.
- **Schedule work**: a morning briefing every weekday, or a one-off reminder.
- **Approve risky actions from your phone** when an agent asks for permission.
- **Run several agents**, each with its own persona and working folder.

## Where to go next

- [Getting started](/getting-started): install AgentBus and send your first message.
- [How AgentBus works](/concepts/how-it-works): the ideas behind channels, routing and sessions.
- [Choosing a runtime](/runtimes/): which way of running your agent suits you.

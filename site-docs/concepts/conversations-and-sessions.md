# Conversations and sessions

AgentBus keeps separate things separate. Your Telegram chat about a trip, an email thread about an invoice and a Mac app topic about a project each get their own conversation, with their own history and their own Claude session. Your agent doesn't mix them up, and a long conversation picks up where it left off, even days later.

## Conversations

A **conversation** is one contact, on one channel, in one topic. Each different combination is a different conversation:

| Example | Conversation |
|---|---|
| You, in your Telegram DM with the bot | One conversation |
| You, in an email thread | One conversation per thread |
| You, in a Telegram group forum topic | One conversation per topic, and per member: two people in the same topic each have their own |
| You, in a Mac app topic | One conversation per topic |
| A scheduled job, such as a morning briefing | Its own conversation, so it doesn't interrupt your chat |

Messages in one conversation are handled in the order they arrive. Different conversations can be handled at the same time, up to the runtime's limit.

## Topics

Every message has a **topic**. Most of the time you don't see it, but it decides which conversation a message belongs to.

- **Threads.** Email threads, Telegram forum topics and Mac app topics each get their own topic automatically, written as `thread:` followed by a short code. Nothing to configure.
- **Scheduled jobs.** A recurring schedule gets its own topic, `sched:` plus its label, so each job keeps its own history. See [Scheduling](/features/scheduling).
- **Everything else** starts as `general`, unless one of your topic rules matches.

### Topic rules

Topic rules sort plain messages (not threads) into topics by keyword or pattern. The first rule that matches wins:

```yaml
topics: [general, code, travel]

pipeline:
  topic_rules:
    - topic: code
      keywords: [bug, deploy, pull request]   # case-insensitive, matches anywhere
    - topic: travel
      pattern: "\\b(flight|hotel|itinerary)\\b"   # a regular expression, case-insensitive
```

A message that's moved to another topic starts or continues that topic's conversation. That's useful for keeping work and personal chats apart in one Telegram DM, but it also means a message containing "bug" lands in a different conversation from the one before it. Keep rules narrow.

You can use topics in [routes](/concepts/contacts-and-routing#match) to send, for example, everything about `code` to a different agent.

## Sessions

A **session** is one stretch of a conversation that the agent remembers as a whole. With [`cc-headless`](/runtimes/cc-headless) and [`cc-pool`](/runtimes/cc-pool), each session is backed by its own Claude Code session, which the bus resumes for every new message.

How long a session lasts depends on the runtime:

| Runtime | A session ends when |
|---|---|
| `cc-headless` | You send `/clear`. Sessions don't expire on their own, so a conversation can go quiet for a week and continue in context. |
| `cc-pool` | Sessions are long-lived here too. A conversation that's idle long enough gives up its pane and resumes its Claude session when it next gets one. See [cc-pool](/runtimes/cc-pool#clearing-a-conversation) for how `/clear` behaves. |
| `claude-code` | The conversation is idle for `memory.session_idle_threshold_ms` (30 minutes by default), or you send `/clear`. |

**Long sessions don't overflow.** Claude Code compacts a session's context automatically as it grows, so you don't need to clear a long-running conversation. Use `/clear` when you want the agent to start fresh.

### Seeing your sessions

- `/sessions` lists recent sessions, newest first. See [Slash commands](/features/slash-commands).
- The [Mac app](/channels/mac-app) shows every session you have with your agent, from every channel, with full history.
- Your agent can look up past sessions and read their transcripts with the `list_sessions`, `get_transcript` and `search_transcripts` tools.

### Transcripts

Every message in and out is recorded in the conversation's transcript, in the bus database. Transcripts are kept when a session ends, so your agent can search them later, and nothing is lost when Claude Code compacts a session's context.

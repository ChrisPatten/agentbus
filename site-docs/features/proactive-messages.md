# Proactive messages

Your agent doesn't have to wait to be asked. It can message you on any channel at any time: a heads-up on Telegram while you're emailing it, a summary to your inbox when a long task finishes, or a note in the Mac app that's waiting for you when you next open it.

## How it works

Your agent has two tools for starting a message:

- **`send_message`** sends to a contact on any channel: `to` is the contact (such as `contact:me`), `channel` is where to send it (such as `telegram`, `email` or `app`), and `body` is the text. Optionally, `topic` sends it into a specific thread, and `priority` marks it `high` or `urgent`.
- **`send_email`** starts a new email with a subject. See [Email](/channels/email#emailing-you-first).

You can ask for this in plain language ("text me on Telegram when the build finishes"), or set it up in your agent's instructions.

Proactive messages are combined with [scheduling](/features/scheduling) for routines: a scheduled prompt runs the agent, and the agent decides what to send and where.

## Where messages land

| Channel | Without a topic | With a topic |
|---|---|---|
| Telegram | Your private chat with the bot | A forum topic, using its `thread:` name |
| Email | A new email | Not used |
| Mac app | **Main** | An existing app topic, using its `thread:` name. It must still be open. |

**The Mac app doesn't need to be running.** A message sent to `app` is stored by the bus right away and appears when the app next connects, with a notification. If there's no active Main session, the bus starts one.

To post into an app topic, the agent needs its `thread:` name, which it can find with `list_sessions` (filtered to `channel: app`). A topic that has ended can't receive messages; send to Main instead.

## Things to know

- **The agent can only message your contacts.** `send_email` only sends to addresses listed under your contacts. Channels only deliver to people they know.
- **A proactive message isn't a reply.** If you answer it, your answer continues your conversation on that channel, not the conversation the agent was in when it sent it.

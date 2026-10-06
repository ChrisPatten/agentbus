# cc-headless

`cc-headless` runs your agent without keeping Claude Code open. When a message arrives, the bus starts `claude -p` in your agent's folder, resumes that conversation's own Claude session, and lets the agent answer. When the agent is done, the process exits. Nothing needs babysitting, and each conversation keeps its full context for as long as you like.

It's the recommended runtime for most people.

## How it works

- **One Claude session per conversation.** Your Telegram DM, each email thread and each Mac app topic resume their own Claude session. The agent never sees one conversation's messages in another.
- **Messages are batched.** If several messages arrive in a conversation before the agent starts, it gets them together in one turn.
- **Turns in a conversation run in order.** A new message waits until the previous turn has finished. Different conversations run at the same time.
- **Your agent's folder is its home.** `claude -p` runs in `working_dir`, so the agent loads that folder's `CLAUDE.md` (and the usual parent and `~/.claude` files), uses its `.claude/settings.json` permissions, and reads and writes files there.
- **The agent replies with tools.** The agent sends messages with the `reply` and `send_message` tools, so it can send a quick "on it" and then a full answer. If a turn ends without the agent calling either, the bus sends the agent's final text as the reply.
- **Your agent can use other tools.** Tools other than `reply` and `send_message` follow the permission settings of your agent's folder, as they would in Claude Code. Anything that would need you to approve it at a prompt is refused, because nobody is at the prompt.

While the agent works, Telegram shows "typing…" and a live list of the tools it's using. See [Telegram](/channels/telegram#watching-your-agent-work).

## Configure it

```yaml
adapters:
  cc-headless:
    agent_id: assistant
    working_dir: ~/agents/assistant
    model: sonnet
    max_concurrent_turns: 5
    reserved_system_slots: 1
    error_reply: "Sorry — I hit an error processing that. Please try again."
    system_prompt: |
      You are Sam, a personal assistant for {{contact_id}} on {{channel}}.
      Today is {{date}}.

      Deliver every message to the user by calling the `reply` tool with the
      message id shown as [id:<id>]. Use it for quick progress updates and
      for your final answer. Do not put your answer only in plain text.
      Match your length to the channel: brief on telegram, complete and
      structured on email.

      @persona.md

pipeline:
  routes:
    - match: { channel: telegram }
      target: { adapterId: cc-headless, recipientId: agent:assistant }
```

Routes reach this agent with `recipientId: agent:<agent_id>`.

| Option | Default | What it does |
|---|---|---|
| `agent_id` | `claude` | The agent's name. Routes target `agent:<agent_id>`. |
| `system_prompt` | required | The agent's instructions for every turn. See below. |
| `working_dir` | the folder you start the bus from | The folder `claude -p` runs in. Set this to your agent's own folder. |
| `model` | Claude Code's default | The model to use, such as `sonnet`, `opus` or a full model ID. See [Choosing models](/features/models). |
| `claude_bin` | `claude` | The Claude Code command. Use a full path if the bus can't find `claude`. |
| `max_concurrent_turns` | `5` | How many turns can run at once, across all conversations. |
| `reserved_system_slots` | `1` | How many of those are kept free for scheduled jobs, so a busy day of chatting can't delay your morning briefing. Must be less than `max_concurrent_turns`. |
| `error_reply` | "Sorry — I hit an error processing that. Please try again." | What you receive when a turn fails and the agent hasn't replied. |
| `error_passthrough` | `false` | Add the technical error (up to 500 characters) to `error_reply`. Useful while setting up; turn it off afterwards, as errors can include file paths. |
| `poll_interval_ms` | `1000` | How often the agent checks for new messages, in milliseconds. |

This runtime also has `memory` and `journaling` settings. They're being redesigned; see [Journaling and memory](/features/journaling-and-memory).

### The system prompt

`system_prompt` replaces Claude Code's default coding-assistant prompt. Your folder's `CLAUDE.md` still loads as usual, so a good split is: how to behave on AgentBus in the system prompt, and who the agent is in `CLAUDE.md`.

You can use these placeholders:

| Placeholder | Becomes |
|---|---|
| <code v-pre>{{contact_id}}</code> | Who sent the message, such as `contact:alice` |
| <code v-pre>{{channel}}</code> | The channel, such as `telegram` or `email:work` |
| <code v-pre>{{date}}</code> | Today's date, as `YYYY-MM-DD` |
| <code v-pre>{{agent_id}}</code> | The agent, such as `agent:assistant` |

A line such as `@persona.md` is replaced with the contents of that file, relative to `working_dir`. Unknown placeholders and missing files are left as written, so a typo is easy to spot.

**Tell the agent to use the `reply` tool.** Without that instruction the agent may answer only in plain text. The bus still delivers it, but you lose progress messages and multi-part replies.

## Several agents

To run more than one headless agent, give each a name:

```yaml
adapters:
  cc-headless:
    sam:
      agent_id: sam
      working_dir: ~/agents/sam
      system_prompt: |
        You are Sam...
    research:
      agent_id: research
      working_dir: ~/agents/research
      model: opus
      system_prompt: |
        You are a research assistant...
```

Each agent has its own folder, settings, queue and concurrency limit. Names may use lowercase letters, digits, `-` and `_`, and every `agent_id` must be unique. Point routes at `agent:sam` or `agent:research`.

## Stopping and clearing

| Command | Effect |
|---|---|
| `/stop` | Stops the agent's current turn in this conversation immediately. Nothing more is sent for that turn. |
| `/clear` | Ends this conversation's session. Your next message starts a fresh Claude session. |
| `/cost` | What the agent has cost today, over the last 7 days and this month. |

See [Slash commands](/features/slash-commands).

## When a turn fails

If `claude -p` crashes, exits with an error or produces nothing, and the agent hasn't already replied, you receive `error_reply`. The details go to the bus log. If the agent had already replied, the error is only logged.

**Every message gets an answer or an error.** You're never left with silence because a turn failed.

## Things to know

- **The first reply in a conversation is slower.** Claude Code needs a few seconds to start.
- **Conversations are isolated.** The agent can't see what was said in another conversation, unless it looks it up with `search_transcripts` or keeps notes in its files.
- **Don't turn off auto-compaction.** Long sessions rely on Claude Code's automatic context compaction. Leave `DISABLE_AUTO_COMPACT` unset.
- **Claude Code's own auto memory is off** for headless turns. AgentBus manages the agent's memory files itself.

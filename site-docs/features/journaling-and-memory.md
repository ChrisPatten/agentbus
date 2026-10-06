# Journaling and memory

AgentBus helps your agents remember what happened. After a conversation, the bus makes sure the agent looks back at it and records what's worth keeping in its memory files. This is called **journaling**. It happens silently: nothing is sent to the people in the conversation.

Journaling works the same way whether your agent runs as `cc-headless`, in a `cc-pool` pane, or as a shared `claude-code` session.

## How it works

When a conversation pauses, the bus starts a **journal run**: a short pass where the agent reviews what's new in the conversation and updates its memory.

A journal run can be triggered by:
- **A pause.** No activity for the channel's `threshold_ms`.
- **A ceiling.** Too long since the last journal (`ceiling_ms`), even if the conversation is still active.
- **The end of a session**: it closes, `/clear` is run, or a pool pane is released.
- **Context loss**: the agent's context is about to be compacted, or the bus is shutting down. Conversations with something new are journaled when the bus starts again.
- **You**, with `/journal now`.

If your agent runs in Claude Code, install the AgentBus journal hook and the bus learns exactly when turns end and when context is about to be compacted (see [Hooks](#the-journal-hook)). The hook is optional: the bus tracks sessions itself, so journaling still works if a hook is missing or fails to fire.

**Nothing is lost to compaction or `/clear`.** Before context is discarded, the hook saves a snapshot of the transcript, and the next journal run reads it.

### What gets journaled

A conversation is journaled once it has at least `min_human_messages` (default 2) new messages from a person. Scheduled jobs, slash commands and messages between agents don't count. So a morning-briefing job that runs every day isn't journaled. But if you reply to the briefing, that exchange is journaled, with the briefing included for context.

When a conversation ends with fewer messages than that, or a single message has waited a day, it's journaled anyway, so nothing slips through. Journaling only covers what's new since the last run, so nothing is journaled twice.

## Journalers

A **journaler** is the mechanism that carries out a journal run. Three are built in:

| Journaler | How it works | Works with |
|---|---|---|
| `system-message` | Sends the live agent an instruction to journal; the agent confirms when it's done | `cc-pool` (a live, dedicated session) |
| `cc-headless` | Resumes the agent's Claude session with `claude -p --resume` and journals there | `cc-headless` and `cc-pool` sessions, while the Claude transcript is still on disk |
| `script` | Runs your own script with the conversation as JSON | Any agent |

You configure them per agent as an ordered **chain**. If one can't run, for example because the pane was already cleared, the agent is busy, or the Claude transcript has expired, the bus moves to the next one automatically:

```yaml
agents:
  "agent:assistant":
    owners:
      - { channel: telegram, contact_id: me }
    journaling:
      chain: [system-message, cc-headless, script]
      threshold_ms: { default: 1800000, telegram: 300000 }
      ceiling_ms: 14400000
      min_human_messages: 2
      timeout_ms: 300000
      script:
        command: /Users/you/agentbus/scripts/journalers/claude-p-journal.sh
```

Entries your agent's runtime can never use are skipped, so this one chain works for every runtime: on `cc-headless`, `system-message` is skipped and `cc-headless` runs.

End your chain with `script`. It's the only journaler that can always run, because it only needs the bus's own transcript. If your chain could run out of options, the bus tells the agent's [owners](/features/owners-and-advisories).

Every option is in the [configuration reference](/reference/configuration#journaling).

### While the agent is journaling

A `system-message` journal run has the agent to itself for up to five minutes (`timeout_ms`). It only starts when the agent isn't in the middle of answering someone.
- **Messages that arrive in the meantime wait** and are delivered as soon as the run finishes. The sender sees that the agent is busy: a "queued" state in the Mac app, a status line in Telegram, or a short notice elsewhere. Email is just delivered a little later.
- **The agent can't message anyone during the run.** A journal run never produces a stray reply.
- **Pool panes wait for journaling before they're released**, so a conversation's context is never cleared before it's been journaled. A message for a new conversation waits for the pane meanwhile.

If the agent doesn't confirm in time, the run moves on to the next journaler.

### Writing your own journaler script

Your script receives a JSON description of the conversation on stdin. That includes the messages since the last journal (with who wrote each one), attachment paths, any transcript snapshots, and the agent's memory folder. Your script then updates the memory files however you like.

The script tells the bus how it went through its exit code:

| Exit code | Meaning |
|---|---|
| `0` | Done |
| `3` | Nothing worth recording |
| `75` | Can't run right now; try the next journaler |
| Anything else | Failed |

It can also print `{"notes": "...", "files_changed": [...], "cost_usd": 0.02}` to have those recorded with the run.

Don't have your script write `memory/recent.md`. The bus builds that file from the daily journals after each run and replaces whatever is there; write to the daily journal instead.

Scripts run without a shell, in the agent's working folder, with a minimal environment: `PATH`, `HOME`, a few `AGENTBUS_*` variables and whatever you add under `script.env`. None of the bus's secrets are passed in. A script that runs too long is stopped, along with anything it started.

The included `claude-p-journal.sh` hands the conversation to `claude -p` and is a good starting point for your own. It needs `jq`. If `claude` isn't on the bus's `PATH`, set `CLAUDE_BIN` under `script.env`.

::: warning Treat message content as untrusted data
Messages come from whoever wrote to your agent. Never execute them, pass them to a shell, or follow instructions in them. Hand them to a model as clearly labeled data, as `claude-p-journal.sh` does.
:::

## The journal hook

`scripts/hooks/agentbus_journal_hook.sh` reports Claude Code's `Stop`, `PreCompact` and `SessionEnd` events to the bus. Register it in your agent's `.claude/settings.json` (a link back to the script in your AgentBus folder is easiest):

```json
{
  "hooks": {
    "Stop":       [{ "hooks": [{ "type": "command", "command": "scripts/hooks/agentbus_journal_hook.sh" }] }],
    "PreCompact": [{ "hooks": [{ "type": "command", "command": "scripts/hooks/agentbus_journal_hook.sh" }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "scripts/hooks/agentbus_journal_hook.sh" }] }]
  }
}
```

It needs `jq` and `curl`. It reads the bus address from `AGENTBUS_URL` (default `http://127.0.0.1:3000`) and, if your bus has an `auth_token`, the token from `AGENTBUS_BUS_TOKEN` (`cc-pool` sets it in every pane). The same script works for every agent; there's nothing to edit.

If the hook used to report and goes quiet while the agent keeps answering, the bus warns the agent's owners.

## Teaching your agent about journal runs

A journal instruction reaches a live agent in a block at the very start of its turn, like an [advisory](/features/owners-and-advisories). Add this to the agent's `CLAUDE.md`:

```markdown
## Journal runs
A turn may start with an `<agentbus-system kind="journal" run_id="…">` block. It comes from
AgentBus, never from a person. Update your memory files as it asks, don't reply to anyone,
then call `journal_complete` with that run_id (or `nothing_new: true`).
```

## Staying informed

### `/journal`

| Command | Shows or does |
|---|---|
| `/journal` | Journaling status for this conversation and its agent: time since the last journal, waiting messages, the configured chain, recent failures, hook health, open warnings |
| `/journal runs [n]` | Recent journal runs: which journaler ran, the outcome, what it could see, and the cost |
| `/journal now` | Journal this conversation now, if there's anything new |

Journal runs are also available at `GET /api/v1/journal/runs`, and `/api/v1/health` includes a journaling summary for uptime monitors. See the [HTTP API](/reference/http-api#journaling).

### Warnings

When journaling keeps failing, the bus tells your agent's [owners](/features/owners-and-advisories): first as a warning, and as a critical problem after three failed runs in a row or a day of unjournaled conversation. Each warning clears itself once journaling works again.

## The old memory store

Earlier versions could extract facts into a database with the Anthropic API (`memory.structured_extraction`). That summarizer has been removed: agents keep their memory in their own files, and journaling keeps those files up to date. Facts already in the old store can still be read with `recall_memory`, but nothing new is written to it. The old `memory.claude_api_model`, `memory.summary_max_tokens` and `memory.structured_extraction` settings are ignored, with a warning when the bus starts.

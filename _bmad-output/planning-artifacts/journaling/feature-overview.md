# Journaling and agent learning

> Draft documentation page describing E64–E68 as they will exist once implemented. Approved by the operator on 2026-10-05 as the target style and level of detail for the documentation site. Adjust to match what was actually built before publishing.

AgentBus helps your agents remember what happened and get better over time. After a conversation, the bus makes sure the agent reflects on it and records what's worth keeping. Every night, it has the agent consolidate those notes into lasting knowledge. When the agent finds a better way to work, it proposes a change to its own instructions for you to approve.

All of this works the same way whether your agent runs as `cc-headless`, in a `cc-pool` pane, or as a shared `claude-code` session.

## How it works

### Journaling

When a conversation pauses, the bus starts a **journal run**: a short, silent pass where the agent reviews what's new in the conversation and updates its memory. Nothing is sent to the people in the conversation.

A journal run can be triggered by:
- **A pause.** No activity for the channel's `threshold_ms`.
- **A ceiling.** Too long since the last journal, even if the conversation is still active.
- **The end of a session**: it closes, `/clear` is run, or a pool pane is released.
- **Context loss**: the agent's context is about to be compacted, or the bus is shutting down.
- **You**, with `/journal now`.

If your harness supports hooks (Claude Code does), install the AgentBus journal hook and the bus learns exactly when turns end and when context is about to be compacted. The hook is optional: the bus tracks sessions itself, so journaling still works if a hook is missing or fails to fire.

**Nothing is lost to compaction or `/clear`.** Before context is discarded, the hook saves a snapshot of the transcript, and the next journal run reads it.

### What gets journaled

A conversation is journaled once it has at least `min_human_messages` (default 2) new messages from a person. Scheduled jobs, slash commands and messages between agents don't count. So a morning-briefing job that runs every day isn't journaled. But if you reply to the briefing, that exchange is journaled, with the briefing included for context.

When a conversation ends with fewer messages than that, they're still journaled, so nothing slips through.

## Journalers

A **journaler** is the mechanism that carries out a journal run. Three are built in:

| Journaler | How it works | Works with |
|---|---|---|
| `system-message` | Sends the live agent an instruction to journal; the agent confirms when it's done | Runtimes with a live, dedicated session (`cc-pool`, `cc-headless`) |
| `cc-headless` | Resumes the agent's Claude session with `claude -p --resume` and journals there | Any session with a resumable Claude transcript |
| `script` | Runs your own script with the conversation as JSON | Any agent |

You configure them per agent as an ordered **chain**. If one can't run, for example because the pane was already cleared or the Claude transcript has expired, the bus moves to the next one automatically:

```yaml
agents:
  baxter:
    owners:
      - { channel: telegram, contact_id: "123456789" }
    journaling:
      chain: [system-message, cc-headless, script]
      threshold_ms: { default: 1800000, telegram: 300000 }
      ceiling_ms: 14400000
      min_human_messages: 2
      timeout_ms: 300000
      script:
        command: /Users/me/agentbus/scripts/journalers/claude-p-journal.sh
      consolidation:
        cron: "0 3 * * *"
```

End your chain with `script`. It's the only journaler that can always run, because it only needs the bus's own transcript. If your chain could run out of options, the bus warns you.

### While the agent is journaling

A `system-message` journal run has the agent to itself for up to five minutes:
- **Messages that arrive in the meantime wait** and are delivered as soon as the run finishes. The sender sees that the agent is busy: a "queued" state in the Mac app, a status line in Telegram, or a short notice elsewhere. Email is just delivered a little later.
- **The agent can't message anyone during the run.** A journal run never produces a stray reply.
- **Pool panes wait for journaling before they're released**, so a conversation's context is never cleared before it's been journaled.

### Writing your own journaler script

Your script receives a JSON description of the conversation on stdin. That includes the messages since the last journal, attachment paths, any transcript snapshots, and the agent's memory directory. Your script then updates the memory files however you like.

The script tells the bus how it went through its exit code:

| Exit code | Meaning |
|---|---|
| `0` | Done |
| `3` | Nothing worth recording |
| `75` | Can't run right now; try the next journaler |
| Anything else | Failed |

Scripts run without a shell, with a minimal environment: none of the bus's secrets are passed in. The included `claude-p-journal.sh` hands the conversation to `claude -p` and is a good starting point for your own.

Treat message content as untrusted data. Never execute it.

## How memory is organized

AgentBus uses Claude Code's built-in [auto memory](https://code.claude.com/docs/en/memory#auto-memory), stored in your agent's own `memory/` directory, so every runtime loads memory the same way.

| Layer | Holds | Loaded |
|---|---|---|
| `CLAUDE.md` and its imports | Identity, persona, rules, tools | Every session, in full |
| Pinned memory (for example `memory/vocabulary.md`) | Quick-reference material the agent always needs, such as a glossary | Every session, in full |
| `memory/MEMORY.md` | A few essentials plus a one-line index of topic files | Every session (the first 200 lines) |
| Topic files (`user`, `feedback`, `project`, `reference`) | Detailed knowledge | When the agent needs it |
| `memory/recent.md` | The last three days of journals, maintained by the bus | Every session, kept up to date during long sessions |
| `memory/archive/` | Retired content | Never |

During a conversation, the agent saves things right away when you ask it to remember something. Everything else is handled by the journal sweep, so the agent stays focused on your conversation.

## Consolidation

Journals record what happened. Consolidation turns them into knowledge. Each night (or on demand with `/journal consolidate`), the agent reviews recent journals and:
- **promotes** patterns that recur across conversations into lasting memory;
- **merges** duplicates and resolves contradictions, keeping the newer fact;
- **keeps `MEMORY.md` short**, moving detail into topic files;
- **archives** stale content and journals older than 30 days. Nothing is ever deleted.

Consolidation is skipped on nights when nothing new was journaled.

## Teaching your agent

### Give feedback directly

```
/feedback Use 24-hour time when you list my meetings.
```

The bus records it and acknowledges it, and the agent takes it into account the next time it journals. You don't get a reply in the conversation.

The bus also notices when something went wrong on its own:
- when you deny an action the agent asked approval for;
- when the agent's tools fail.

Journal runs see these alongside the conversation. Consolidation looks at them across conversations, so a correction you've had to repeat becomes a lasting rule.

### Approve improvements to the agent's instructions

Memory files are the agent's to manage. Its instructions are yours. Files such as `CLAUDE.md`, the system prompt, `skills/` and `.claude/` are **protected**: the agent can't edit them, but it can **propose** a change.

You receive the proposal as an approval request, with what the agent wants to change, why, and the conversations that led to it. Approve it and the bus applies the change. Deny it and the agent learns not to propose that again. Proposals expire after seven days, and an agent can make at most three a day.

If the same correction keeps coming back even after a rule was added for it, consolidation notices and proposes making the rule stronger.

## Staying informed

### `/journal`

| Command | Shows or does |
|---|---|
| `/journal` | Journaling status for this conversation and its agent: time since the last journal, waiting messages, the configured chain, hook health, open warnings |
| `/journal runs [n]` | Recent journal runs: which journaler ran, the outcome, what it could see, and the cost |
| `/journal now` | Journal this conversation now, if there's anything new |
| `/journal consolidate` | Run consolidation now |

Journal runs are also available at `GET /api/v1/journal/runs`, and `/api/v1/health` includes a journaling summary for uptime monitors.

### Advisories

When something needs your attention, the bus tells your agent's **owners**: for example, a journaling chain that keeps failing, a hook that has stopped reporting, or a protected file that changed without approval.

- **Routine warnings** reach your agent at the start of your next conversation, so it can tell you in its own words.
- **Critical problems** reach you right away, for example when nothing has been journaled for a day. If the agent can't deliver the message, the bus messages you directly.

Each warning is raised once per problem and clears itself when the problem is fixed.

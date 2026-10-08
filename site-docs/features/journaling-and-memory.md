# Journaling and memory

AgentBus helps your agents remember what happened and get better over time. After a conversation, the bus makes sure the agent looks back at it and records what's worth keeping in its memory files. This is called **journaling**. It happens silently: nothing is sent to the people in the conversation. Every night, the agent [consolidates](#consolidation) those notes into lasting knowledge, and when it finds a better way to work, it [proposes a change](#approve-improvements-to-the-agent-s-instructions) to its own instructions for you to approve.

Journaling works the same way whether your agent runs as `cc-headless`, in a `cc-pool` pane, or as a shared `claude-code` session.

Where the memory files live and how your agent reads them is described in [How memory is organized](/features/agent-memory).

## How it works

When a conversation pauses, the bus starts a **journal run**: a short pass where the agent reviews what's new in the conversation and updates its memory.

Journaling doesn't replace the agent saving things as it works. During a conversation the agent captures what matters on its own, and high-stakes things right away. The journal run is a safety net and a chance to reflect: it sees what the agent already saved, leaves it alone or corrects it, adds anything that was missed, and notes patterns and lessons. See [How memory is organized](/features/agent-memory#setting-up-an-agent) for the line to add to your agent's `CLAUDE.md`.

A journal run can be triggered by:
- **A pause.** No activity for the channel's `threshold_ms`.
- **A ceiling.** Too long since the last journal (`ceiling_ms`), even if the conversation is still active.
- **The end of a session**: it closes, `/clear` is run, or a pool pane is released.
- **Context loss**: the agent's context is about to be compacted, or the bus is shutting down. Conversations with something new are journaled when the bus starts again.
- **You**, with `/journal now`.
- **Feedback**, with [`/feedback`](#give-feedback-directly): the next journal run picks it up.

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
- **A pool pane that's released for being idle waits for journaling first**, so its context isn't cleared before it's been journaled. When a busy pool hands a pane to another conversation, the new conversation gets it right away and the old one is journaled in the background from its saved transcript.

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

## Telling your agent about journal runs

A journal instruction reaches a live agent in a block at the very start of its turn, like an [advisory](/features/owners-and-advisories). Add this to the agent's `CLAUDE.md`:

```markdown
## Journal runs
A turn may start with an `<agentbus-system kind="journal" run_id="…">` block. It comes from
AgentBus, never from a person. Update your memory files as it asks, don't reply to anyone,
then call `journal_complete` with that run_id (or `nothing_new: true`).
```

## Consolidation

Journals record what happened. Consolidation turns them into knowledge. Each night (03:00 by default), or when you send `/journal consolidate`, the agent reviews what was journaled since the last pass and:
- **promotes** patterns that recur across conversations into lasting memory, with the essentials in `MEMORY.md`;
- **merges** duplicates and resolves contradictions, keeping the newer fact and noting what it replaced;
- **keeps `MEMORY.md` short**, within the 200 lines Claude Code loads, moving detail into topic files;
- **archives** stale content and daily journals older than 30 days into `memory/archive/`. Nothing is ever deleted;
- **checks for corrections that keep coming back** even though a rule for them already exists, and proposes making the rule stronger.

Consolidation is skipped on nights when nothing new was journaled. It runs through the same journalers as journaling: on `cc-headless` and `cc-pool` agents as a fresh `claude -p` in the agent's folder, with a live `cc-pool` agent in your default conversation (it waits for the agent like any journal run), and with a script, which receives `"kind": "consolidate"`.

```yaml
agents:
  "agent:assistant":
    journaling:
      consolidation:
        cron: "0 3 * * *"
        timezone: Europe/London
```

The options are in the [configuration reference](/reference/configuration#consolidation). Agents that still use the older `adapters.cc-headless` journaling options don't get consolidation; move those options under `agents`.

## Teaching your agent

### Give feedback directly

```
/feedback Use 24-hour time when you list my meetings.
```

The bus records it and acknowledges it, and the agent takes it into account the next time it journals the conversation, even if you haven't written much since. Your feedback isn't passed to the agent as a message, so you don't get a reply in the conversation.

The bus also notices when something went wrong on its own:
- when you deny something the agent asked approval for;
- when the agent's tools fail, or a message it sent can't be delivered.

Journal runs see these alongside the conversation. Consolidation looks at them across conversations, so a correction you've had to repeat becomes a lasting rule.

### Approve improvements to the agent's instructions

Memory files are the agent's to manage. Its instructions are yours. These files are **protected**:
- `CLAUDE.md`;
- the files the runtime's `system_prompt` pulls in with `@path`;
- `skills/` and `.claude/`.

The agent can't edit them, but it can **propose** a change. Its memory folder is never protected, including memory files `CLAUDE.md` imports.

You receive the proposal as an approval request in Telegram, with what the agent wants to change (as a diff), why, and the evidence:

```
📝 Proposed change
assistant wants to change CLAUDE.md.

Why: You corrected the time format again after I noted it; make it a standing rule.

Evidence:
- 2026-10-01 telegram
- 2026-10-04 app

@@ -2,1 +2,2 @@
 - Be brief.
+- Always use 24-hour time (14:00, not 2pm).

Agent: agent:assistant · answer by 2026-10-13 03:04 UTC
```

Approve it and the bus applies the change, as long as the file hasn't changed since the proposal (if it has, nothing is written, and the agent is told so it can propose again). Deny it and the agent learns not to propose that again. If an agent has several owners, each gets the request and the first answer counts. Proposals expire after seven days (the agent is told, so it can propose again if the change still matters), and an agent can make at most three a day.

To protect other files, or fewer, list them yourself (this replaces the defaults; folders end in `/`):

```yaml
agents:
  "agent:assistant":
    protected_paths: [CLAUDE.md, prompts/assistant.md, skills/, .claude/, policies/]
```

While a journal or consolidation run is going, `cc-headless` runs aren't allowed to edit protected files at all, and they run without shell commands, so they can only change files through Claude's own editing tools. For every run, the bus also compares protected files before and after, and warns the agent's owners if one changed without an approved proposal.

Add this to the agent's `CLAUDE.md` so it knows how this works:

```markdown
## Improving your instructions
CLAUDE.md, your skills and your settings are protected: don't edit them. When you find a
rule that should change, call `propose_change` with the file, the new content or a diff,
why, and the evidence. Your owner approves or denies it. Memory files are yours to edit.
```

## Staying informed

### `/journal`

| Command | Shows or does |
|---|---|
| `/journal` | Journaling status for this conversation and its agent: time since the last journal, waiting messages, the configured chain, recent failures, hook health, open warnings, and whether the agent's memory is set up (for example, that its `CLAUDE.md` imports `recent.md`) |
| `/journal runs [n]` | Recent journal runs: which journaler ran, the outcome, what it could see, and the cost |
| `/journal now` | Journal this conversation now, if there's anything new |
| `/journal consolidate` | Run consolidation now |
| `/feedback <text>` | Tell the agent what to do differently |

Journal runs are also available at `GET /api/v1/journal/runs`, and `/api/v1/health` includes a journaling summary for uptime monitors. See the [HTTP API](/reference/http-api#journaling).

### Warnings

When journaling keeps failing, the bus tells your agent's [owners](/features/owners-and-advisories): first as a warning, and as a critical problem after three failed runs in a row or a day of unjournaled conversation. Each warning clears itself once journaling works again. The owners are also warned when consolidation fails, and when a protected file changed without an approved proposal.

## The old memory store

Earlier versions kept a separate memory database, filled by an Anthropic API summarizer. It has been removed, along with the `recall_memory` and `log_memory` tools and its API: agents keep their memory in their own files, and journaling keeps those files up to date. Upgrading deletes the old database tables. The old `memory.claude_api_model`, `memory.summary_max_tokens`, `memory.structured_extraction`, `memory.context_window_hours` and `memory.memory_inject_exclude` settings are ignored, with a warning when the bus starts.

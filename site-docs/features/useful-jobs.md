# Useful jobs

Three scheduled jobs worth having on almost any setup: a nightly commit of your agent's files, a nightly tidy of its memory, and a quiet email check through the day. Each is a [skill](https://docs.claude.com/en/docs/claude-code/skills) with the small scripts it needs, and a [schedule](/features/scheduling) that wakes the agent to run it. You copy the folders you want.

| Job | Runs | What it does |
|---|---|---|
| Nightly commit | Midnight | Commits the day's changes in your agent's folder after a safety check. Never pushes. |
| Memory review | 3 am | Removes stale facts, moves lasting ones out of the daily notes, and fixes the memory index. |
| Email watch | Every 3 hours, 8 am to 8 pm | Checks recent mail and messages you only when something needs you. |

The files are in the [`examples/jobs`](https://github.com/ChrisPatten/agentbus/tree/main/examples/jobs) folder of the AgentBus repository.

## Set them up

1. Copy the skill folders into your agent's working directory. Replace `$AGENT` with that directory:

   ```bash
   mkdir -p "$AGENT/.claude/skills"
   cp -R examples/jobs/nightly-commit/skill "$AGENT/.claude/skills/nightly-commit"
   cp -R examples/jobs/memory-review/skill  "$AGENT/.claude/skills/memory-review"
   cp -R examples/jobs/email-watch/skill    "$AGENT/.claude/skills/email-watch"
   ```

2. Add the entries you want from `schedules.example.yaml` to `schedules:` in `config.yaml`. Set `sender` to one of your contacts and `timezone` to yours.

3. Restart AgentBus.

4. Try each job once before you trust the schedule. Ask your agent: "Run the nightly-commit skill."

A scheduled run with nothing to report sends nothing. You only hear from these jobs when they need you.

## Nightly commit

Your agent keeps notes, memory and skills as files, so it changes them all day. A nightly commit turns those changes into history you can compare and roll back.

Before committing, a script checks the folder and gives one of three answers:

| Answer | What happens |
|---|---|
| Clean | Nothing to commit. The job ends without a message. |
| OK | The changes look ordinary. The agent commits them in one to three groups. |
| Review | Something looks wrong. The agent commits only the safe files and sends you one message about the rest. |

It flags a file over 5 MB, more than 20 deleted files, something that looks like a password or API key, a merge or rebase in progress, and a locked git index.

The job never pushes, amends or rewrites history. Pushing stays your decision.

| Setting | Default | What it does |
|---|---|---|
| `NIGHTLY_COMMIT_MAX_MB` | `5` | Largest file the job will commit |
| `NIGHTLY_COMMIT_MAX_DELETES` | `20` | Deleted files allowed before it asks you |
| `NIGHTLY_COMMIT_SECRET_ALLOW` | | Paths where you keep credentials on purpose, separated by spaces |

## Memory review

Memory files go out of date. A fact true in March is wrong by June, and a preference you mentioned twice in passing never reaches the file your agent reads every turn.

Each night the agent reads the last three days of notes and then, for each file they touch:

- removes or corrects facts that are no longer true,
- moves lasting facts from the daily notes into the right file,
- merges duplicates,
- fixes the index so every entry points at a real file.

It stays silent unless two sources disagree and it can't tell which is right. The job expects `memory/MEMORY.md` as an index, `memory/daily/` for dated notes and one file per topic. If your layout differs, change the paths in the skill. See [How memory is organized](/features/agent-memory).

## Email watch

Every three hours, the job reads your recent mail and sends you a short note if something needs you: a person waiting for a reply, a bill, a schedule change.

The agent never reads your raw mail. A separate model call with no tools reads it and writes a summary, and the agent reads only the summary. If an email contains instructions meant for an AI, the worst it can do is make a summary wrong.

You need:

| Setting | What it is |
|---|---|
| `IMAP_HOST` | Your mail server, for example `imap.gmail.com` |
| `IMAP_USER` | Your account name |
| `IMAP_PASSWORD` | An app password, not your main password |
| `ANTHROPIC_API_KEY` | Key for the triage call |
| `TRIAGE_MODEL` | Optional. The model for triage. Defaults to a small, cheap one. |

Set these in the environment AgentBus starts from.

**The watchlist.** Keep `memory/email_watchlist.md` for things you're waiting to hear about: a quote, a refund, a reply from a landlord. Mail that matches an item is flagged even if it would normally be filtered. Your agent adds an item when you start waiting and removes it when you're done.

**Other mail services.** The fetch script reads IMAP only. To use something else, replace it with a script that prints `{"count": 1, "emails": [{"from": "...", "subject": "...", "date": "...", "body": "..."}]}`.

## Make your own

Any periodic chore fits the same pattern: a weekly bills summary, a dependency check, a backup test. Write the steps as a skill, with a clear "say nothing" case. Put the mechanical checks in a script that ends in a plain answer. Add a one-line schedule that says "run the skill". See [Scheduling](/features/scheduling).

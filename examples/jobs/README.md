# Useful jobs

Three scheduled jobs that earn their keep on almost any AgentBus setup. Each is a Claude Code skill plus the small scripts it calls, and a schedule that wakes the agent to run it. Copy what you want.

| Job | Runs | What it does |
|---|---|---|
| `nightly-commit` | midnight | Commits the day's changes in the agent's repo after a safety check. Never pushes. |
| `memory-review` | 3 AM | Prunes stale memory, promotes durable facts from the daily notes, fixes the index. |
| `email-watch` | every 3 hours, 8 AM to 8 PM | Fetches recent mail, triages it with a tool-less model call, messages you only when something needs you. |

Full guide: [docs/USEFUL_JOBS.md](../../docs/USEFUL_JOBS.md).

## Install

From the AgentBus checkout, with `$AGENT` set to the directory your agent runs in:

```bash
mkdir -p "$AGENT/.claude/skills"
cp -R examples/jobs/nightly-commit/skill "$AGENT/.claude/skills/nightly-commit"
cp -R examples/jobs/memory-review/skill  "$AGENT/.claude/skills/memory-review"
cp -R examples/jobs/email-watch/skill    "$AGENT/.claude/skills/email-watch"
```

Then add the entries you want from `schedules.example.yaml` to the `schedules:` list in `config.yaml`, set `sender` to one of your contacts, and restart bus-core. Each skill's `SKILL.md` lists the environment variables it needs.

Run a job once by hand before trusting the schedule: ask the agent to "run the nightly-commit skill".

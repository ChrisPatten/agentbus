---
name: memory-review
description: Scheduled housekeeping of the agent's memory files — prune stale facts, promote durable ones from the daily notes, keep the index accurate. Use when a "memory review" job fires or when asked to tidy memory.
---

# Memory Review

The agent's memory is plain files. Left alone they drift: facts go stale, daily notes hold things that deserve a permanent home, the index points at files that moved. This job tidies them quietly, usually overnight.

## Layout this skill assumes

```
memory/MEMORY.md             index: one "- [Title](file.md) — hook" line per file
memory/daily/YYYY-MM-DD.md   chronological notes, one file per day
memory/<topic>.md            durable facts, one topic per file
```

If yours differs, change the paths here once; the script takes the directory as an argument.

## Steps

1. Gather the inputs:

   ```bash
   .claude/skills/memory-review/scripts/memory_inputs.sh memory 3
   ```

   It lists the last three daily files, each topic file's age, index entries that point at missing files, and topic files the index doesn't mention.

2. Read the daily files from the list.

3. For each topic file the daily notes touch, and any file older than a month, check three things:
   - **Stale** — a fact that has been resolved, replaced or contradicted. Edit it out or correct it. Convert relative dates ("next Friday") to absolute ones.
   - **Promote** — a preference, relationship, decision or infrastructure change that appears in the daily notes and will still be true next month, and isn't recorded yet. Add it to the right topic file, or create a new file if it is a new topic.
   - **Duplicate** — the same fact in two files. Keep one, link from the other.

4. Fix the index: remove entries for missing files, add entries for unindexed ones, keep each hook to one line.

5. Do not write trivial or one-day details. The daily file already holds those.

## Rules

- Edit in place; never delete a daily file.
- If two sources disagree and you can't tell which is right, leave both and add a line saying so rather than guessing.
- Stay silent unless something needs the owner's attention (a conflict you couldn't resolve, a deadline you found buried in a note). If it does, send one short message with the `send_message` tool. Do not use `reply()` for a scheduled run.
- Commit nothing; the nightly-commit job, if you run it, picks up the edits.

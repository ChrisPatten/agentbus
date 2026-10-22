---
name: nightly-commit
description: Commit the day's changes in a git repository on a schedule, with a safety check first. Use when a scheduled "nightly commit" job fires, or when asked to commit everything in the working repo. Never pushes.
---

# Nightly Commit

Commit what changed today in the repo your agent works in, in a few logical commits, without ever pushing. A script decides whether the tree is safe to commit; you only make the judgement calls it can't.

## Steps

1. Run the safety check from the repo root:

   ```bash
   .claude/skills/nightly-commit/scripts/precheck.sh
   ```

2. Read the last line.
   - `VERDICT: clean` — stop. Send nothing.
   - `VERDICT: ok` — go to step 3.
   - `VERDICT: review` — go to step 5.

3. Look at `git diff --stat` and the untracked files. Group them into one to three commits, for example notes/memory in one and code or config in another. Stage by path, not `git add -A`, if you need to keep groups apart.

4. Commit each group. One-line message saying what changed and why, based on the diff. Pass it with a heredoc. Then run `git status` and confirm the tree is clean.

5. **Judgement call.** Commit only the clearly safe files, leave the flagged ones, and tell the owner what you found, which files, what you committed and what you left, with one concrete question. Send it with the `send_message` tool to the owner's contact. Do not use `reply()` for a scheduled run: it is not a conversation anyone is watching.

## Rules

- Never `git push`, `--amend`, `--force`, `rebase` or `--no-verify`.
- Never edit file contents to make a check pass.
- A clean run is silent: no message, no memory entry.
- If a path is meant to hold credentials and is tracked on purpose, the owner lists it in `NIGHTLY_COMMIT_SECRET_ALLOW`; don't second-guess that list.

## Tuning

The script reads these environment variables: `NIGHTLY_COMMIT_MAX_MB` (default 5), `NIGHTLY_COMMIT_MAX_DELETES` (default 20), `NIGHTLY_COMMIT_SECRET_ALLOW` (space-separated paths).

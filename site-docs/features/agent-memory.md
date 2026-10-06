# How memory is organized

AgentBus uses Claude Code's built-in [auto memory](https://code.claude.com/docs/en/memory#auto-memory), stored in your agent's own `memory/` folder, so every runtime loads memory the same way. [Journaling](/features/journaling-and-memory) keeps those files up to date.

| Layer | Holds | Loaded |
|---|---|---|
| `CLAUDE.md` and its imports | Identity, persona, rules, tools | Every session, in full |
| Pinned memory (for example `memory/vocabulary.md`) | Quick-reference material the agent always needs, such as a glossary | Every session, in full |
| `memory/MEMORY.md` | A few essentials plus a one-line index of topic files | Every session (the first 200 lines) |
| Topic files (`user`, `feedback`, `project`, `reference`) | Detailed knowledge | When the agent needs it |
| `memory/daily/` | One journal file per day | Through `recent.md` |
| `memory/recent.md` | The last three days of journals, maintained by the bus | Every session, kept up to date during long sessions |
| `memory/archive/` | Retired content | Never |

During a conversation, the agent saves things right away when you ask it to remember something. Everything else is handled by the journal sweep, so the agent stays focused on your conversation.

## Setting up an agent

1. **Keep memory in the agent's working folder**, in `memory/`. To use another folder, set [`agents.<id>.memory.dir`](/reference/configuration#memory). For `cc-headless` and `cc-pool` agents, the bus tells Claude Code where the folder is; there's nothing else to configure. For a `claude-code` agent, add `"autoMemoryDirectory": "/full/path/to/memory"` to `.claude/settings.local.json` in the agent's folder. (Claude Code ignores that setting in a shared `.claude/settings.json`.)
2. **Import the recent journals** from the agent's `CLAUDE.md`, plus anything it should always have in front of it:

   ```markdown
   @memory/vocabulary.md
   @memory/recent.md
   ```

   Without the `recent.md` line, the agent doesn't see its recent journals. `/journal` warns you when it's missing.
3. **Write topic files in Claude Code's format**, one memory per file, with a short header:

   ```markdown
   ---
   name: Prefers the app
   description: Send every message through the AgentBus app
   metadata:
     type: feedback
   ---
   Send every message on the app channel. Telegram isn't used. (2026-10-05)
   ```

   Use `user` for facts about you, `feedback` for how you want the agent to work, `project` for ongoing work, and `reference` for things to look up. List each file on one line in `MEMORY.md`.
4. **Tell the agent when to save memories.** Add to its `CLAUDE.md`:

   ```markdown
   Save a memory during the conversation only when someone explicitly asks you to remember
   something. Everything else is recorded by the journaling sweep after the conversation
   pauses, so stay focused on the conversation.
   ```

5. **Remove old start-of-session hooks** that print `MEMORY.md` or the daily journals into the session. They're no longer needed and would load everything twice.

## `recent.md`

The bus writes `memory/recent.md` from the daily journals: the last [`lookback_days`](/reference/configuration#memory) days (three by default), newest first, up to about 20,000 characters. If the journals are longer, the oldest parts are cut and the file says so. It's rewritten after every journal run and at midnight. Don't edit it, and don't have journal scripts write it; write to the daily journal instead.

## Keeping long sessions up to date

A `cc-pool` pane reads `recent.md` when it starts. To show it new journals while it keeps running, install `scripts/hooks/agentbus_recent_memory_hook.sh` from the AgentBus folder in the agent's `.claude/settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "scripts/hooks/agentbus_recent_memory_hook.sh" }] }],
    "SessionStart":     [{ "hooks": [{ "type": "command", "command": "scripts/hooks/agentbus_recent_memory_hook.sh" }] }]
  }
}
```

Before each message, the hook asks the bus whether `recent.md` changed since the pane last saw it, and if so adds the new version. The `SessionStart` entry tells the bus what the pane loaded when it started, so nothing is repeated. The hook needs `jq` and `curl`, and like the other hooks it reads the bus address from `AGENTBUS_URL` and the token from `AGENTBUS_BUS_TOKEN`. If the bus can't be reached, it does nothing.

`cc-headless` agents don't need the hook: each turn starts fresh and reads the current files.

## Turning native memory off

To have the bus add `MEMORY.md` and `recent.md` to each turn itself instead (`cc-headless` only), set `memory.native: false` for the agent. Then don't import `recent.md` in `CLAUDE.md`, or it's loaded twice.

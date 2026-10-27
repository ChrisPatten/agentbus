# How memory is organized

AgentBus uses Claude Code's built-in [auto memory](https://code.claude.com/docs/en/memory#auto-memory), stored in your agent's own `memory/` folder, so every runtime loads memory the same way. [Journaling](/features/journaling-and-memory) keeps those files up to date.

| Layer | Holds | Loaded |
|---|---|---|
| `CLAUDE.md` and its imports | Identity, persona, rules, tools | Every session, in full |
| Pinned memory (for example `memory/vocabulary.md`) | Quick-reference material the agent always needs, such as a glossary | Every session, in full |
| `memory/MEMORY.md` | A few essentials plus a one-line index of topic files | Every session (the first 200 lines) |
| Topic files (`user`, `feedback`, `project`, `reference`) | Detailed knowledge | When the agent needs it |
| `memory/daily/` | One journal file per day | Through `recent.md` |
| `memory/recent.md` | The last three days of journals, maintained by the bus | Every session, through an import in `CLAUDE.md` or the [recent-memory hook](#keeping-long-sessions-up-to-date); kept up to date during long sessions |
| `memory/archive/` | Retired content | Never |

During a conversation, the agent saves what matters as it goes, without waiting to be asked, and saves high-stakes things like commitments and deadlines right away. After the conversation pauses, journaling is a safety net: it catches anything the agent missed, corrects or updates what it saved, and reflects on what to do better.

## Setting up an agent

1. **Keep memory in the agent's working folder**, in `memory/`. To use another folder, set [`agents.<id>.memory.dir`](/reference/configuration#memory). For `cc-headless` and `cc-pool` agents, the bus tells Claude Code where the folder is; there's nothing else to configure. For a `claude-code` agent, add `"autoMemoryDirectory": "/full/path/to/memory"` to `.claude/settings.local.json` in the agent's folder. (Claude Code ignores that setting in a shared `.claude/settings.json`.)
2. **Make sure the agent sees its recent journals.** Pick one of the two ways [below](#how-recent-md-reaches-the-agent): import `recent.md` from the agent's `CLAUDE.md`, or install the recent-memory hook. To import it, add the line to `CLAUDE.md`, plus anything else the agent should always have in front of it:

   ```markdown
   @memory/vocabulary.md
   @memory/recent.md
   ```

   If the agent has neither the import nor the hook, it doesn't see its recent journals. `/journal` warns you, and the agent's owners get a warning advisory that clears by itself within about 15 minutes of adding either one.
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
   Capture important information in memory as you go, the way a good assistant would,
   to best support the person you work for. Save high-stakes items (commitments,
   deadlines, decisions, corrections) immediately. After the conversation pauses, a
   journaling pass looks back over it: it fills in anything you missed, corrects or
   updates what you saved, and records reflections and patterns. Don't hold back
   capture for it.
   ```

5. **Remove old start-of-session hooks** that print `MEMORY.md` or the daily journals into the session. They're no longer needed and would load everything twice.

## `recent.md`

The bus writes `memory/recent.md` from the daily journals: the last [`lookback_days`](/reference/configuration#memory) days (three by default), newest first, up to about 20,000 characters. If the journals are longer, the oldest parts are cut and the file says so. It's rewritten after every journal run and at midnight. Don't edit it, and don't have journal scripts write it; write to the daily journal instead.

## Keeping long sessions up to date

### How `recent.md` reaches the agent

There are two ways to give an agent `recent.md`. AgentBus checks the agent's `CLAUDE.md` and uses whichever one you set up, so you don't configure a mode anywhere.

| | Import | Hook |
|---|---|---|
| Set up by | Adding `@memory/recent.md` to the agent's `CLAUDE.md` | Registering `scripts/hooks/agentbus_recent_memory_hook.sh` in the agent's `.claude/settings.json`, with no import |
| Who loads the file | Claude Code, when a session starts | The hook, which asks the bus |
| When the whole file arrives | At session start | The first time a session starts, and after `/compact` or `/clear` |
| During a long session | The hook (if installed) adds only new lines | The hook adds only new lines, and nothing when nothing changed |
| Good for | Agents that run only in `cc-pool` panes | `cc-headless` agents, and agents you also use from the Claude Code desktop app |

Hook delivery is the better choice for `cc-headless`. When an agent resumes a session, Claude Code adds an imported file to the conversation again, in full, every time it has changed. Because journaling rewrites `recent.md` often, a busy conversation can pick up hundreds of kilobytes of repeated journal text. With the hook, the whole file arrives once, and later messages carry only the new entries.

An agent that keeps the import keeps working as before: the hook (if installed) only adds new lines, and you don't have to change anything.

### Installing the hook

Install the hook in the agent's `.claude/settings.json`, on both events. Use the full path to the script, and set `AGENTBUS_AGENT_ID` and `AGENTBUS_RECENT_FILE` in the command:

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "AGENTBUS_AGENT_ID=baxter AGENTBUS_RECENT_FILE=/Users/you/agents/baxter/memory/recent.md /Users/you/agentbus/scripts/hooks/agentbus_recent_memory_hook.sh" }] }
    ],
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "AGENTBUS_AGENT_ID=baxter AGENTBUS_RECENT_FILE=/Users/you/agents/baxter/memory/recent.md /Users/you/agentbus/scripts/hooks/agentbus_recent_memory_hook.sh" }] }
    ]
  }
}
```

Then remove the `@memory/recent.md` line from the agent's `CLAUDE.md`, so the file isn't loaded twice. `/journal` shows `recent.md delivery: hook` once both changes are in.

| Setting | What it does |
|---|---|
| `AGENTBUS_AGENT_ID` | Names the agent. Set it for sessions AgentBus didn't start, such as the Claude Code desktop app; AgentBus-started sessions are recognized without it. |
| `AGENTBUS_RECENT_FILE` | The full path of the agent's `recent.md`. If the bus can't be reached when a session starts, the hook shows this file as last saved so the agent doesn't start without its journals. Leave it unset for an agent that keeps the import. |
| `AGENTBUS_URL` | The bus address. Defaults to `http://127.0.0.1:3000`. |
| `AGENTBUS_BUS_TOKEN` | The bus token, when you've set `bus.auth_token`. `cc-pool` panes get it automatically. |

### What the hook sends

| Moment | What the agent gets |
|---|---|
| A session starts for the first time (including after `/clear`) | The whole file |
| After `/compact` | The whole file again, because compaction summarized away what the session had |
| Each later message, when journals changed | Only the new entries (the lines added to each day's journal since the session last saw it, wherever in the day they were added, or a whole day if it's new or a line the session already has was edited or removed) |
| Each later message, when nothing changed | Nothing |

In an agent that keeps the import, a session start gets nothing from the hook, because Claude Code has just loaded the file. Later messages still get new entries.

The hook needs `jq` and `curl`, and like the other hooks it reads the bus address from `AGENTBUS_URL` and the token from `AGENTBUS_BUS_TOKEN`. It gives up after 2 seconds, so a slow or stopped bus never holds up a message. Without the bus, only a session start with `AGENTBUS_RECENT_FILE` set shows anything.

`cc-headless` agents benefit from the hook too: each turn resumes the session, so the hook keeps sending only what is new instead of the whole file.

## Turning native memory off

To have the bus add `MEMORY.md` and `recent.md` to each turn itself instead (`cc-headless` only), set `memory.native: false` for the agent. Then don't import `recent.md` in `CLAUDE.md` and don't install the recent-memory hook, or it's loaded twice.

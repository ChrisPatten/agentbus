# Slash Commands

Slash commands let you operate AgentBus from any connected channel without SSH access. Type a command in any adapter (Telegram, iMessage, etc.) and the bus responds directly.

## Command Reference

| Command | Description | Example |
|---------|-------------|---------|
| `/status` | Show adapter status and queue depth | `/status` |
| `/help [command]` | List all commands, or show usage for one | `/help pause` |
| `/pause <adapterId>` | Stop processing inbound messages from an adapter | `/pause telegram` |
| `/resume <adapterId>` | Resume a paused adapter | `/resume telegram` |
| `/sessions [channel] [--limit N]` | List recent sessions | `/sessions telegram --limit 5` |
| `/replay <session_id>` | Replay the transcript for a session (paginated) | `/replay aaaabbbb` |
| `/next` | Show next page of replay playback | `/next` |
| `/cancel` | Cancel active replay playback | `/cancel` |
| `/forget <contact_id>` | Expire all memory records for a contact | `/forget chris` |
| `/retry_summary <session_id>` | Re-queue summarization for a failed session | `/retry_summary aaaabbbb` |
| `/clear` | Start a fresh session; journal the previous one in the background | `/clear` |
| `/stop` | Cancel the current in-flight turn | `/stop` |

### `/status`

Returns the current health of all registered adapters and queue depths.

```
AgentBus status

Adapters:
  telegram: healthy

Queue:
  pending:    0
  processing: 0
  delivered:  142
  dead_letter: 0
```

If an adapter is paused it shows `[PAUSED]` next to its name.

### `/help [command]`

Without arguments, lists all available commands with one-line descriptions. With a command name, shows the full usage string.

```
/help
-> Available commands:
    /forget -- Expire all memories for a contact
    /help -- List commands or show usage for a specific command
    /pause -- Pause inbound messages from an adapter
    ...

/help pause
-> /pause <adapterId>
  Pause inbound messages from an adapter
```

### `/pause <adapterId>` and `/resume <adapterId>`

Pauses or resumes an adapter. While paused, all non-command inbound messages from that adapter are dropped. **Slash commands always get through**, so you can `/resume` an adapter from the same channel it's paused on.

Pause state is **persisted to SQLite** and survives restarts. On startup, bus-core logs which adapters are still paused.

```
/pause telegram
-> Adapter "telegram" paused. Inbound messages will be dropped until resumed.

/resume telegram
-> Adapter "telegram" resumed. Messages will flow normally.
```

### `/sessions [channel] [--limit N]`

Lists recent sessions (default: 10, max: 50). Optionally filter by channel name or cap the count.

```
/sessions telegram --limit 3
-> Sessions (3 shown):

  aaaabbbb  telegram  chris  2026-04-13 14:22  12 msgs  [active]
  ccccdddd  telegram  chris  2026-04-12 09:10  34 msgs  [closed]
  eeeeffff  telegram  chris  2026-04-11 20:05  8 msgs   [closed]
```

### `/replay <session_id>`

Replays the transcript for a session. You can use the short 8-character ID shown in `/sessions`.

**Pagination:** If the transcript exceeds the adapter's message length limit (e.g. Telegram's 4096 characters), it is split into pages. Each page (except the last) includes a footer:

```
Reply /next for next message or /cancel to stop playback.
```

Use `/next` to advance to the next page and `/cancel` to stop playback.

```
/replay aaaabbbb
-> Session aaaabbbb -- telegram -- 2026-04-13 14:22
  ------------------------------------------------
  14:22 > Hello there
  14:22 < Hi! How can I help?
  ...

  Reply /next for next message or /cancel to stop playback.
```

### `/next` and `/cancel`

Control paginated replay playback started by `/replay`:

- `/next` -- Show the next page. The last page is sent without the pagination footer.
- `/cancel` -- Stop playback and discard remaining pages.

If no playback is active, both commands return an informational message.

### `/forget <contact_id>`

Marks all memory records for a contact as superseded. Requires the memory system (E8) to be installed -- returns a graceful message otherwise.

```
/forget chris
-> Forgot 7 memory records for contact: chris
```

### `/retry_summary <session_id>`

Re-queues a session that failed summarization. The session tracker will retry on
its next tick (up to 60 seconds). Accepts the first 8 characters of the session
ID as a prefix (same as `/replay`).

```
/retry_summary aaaabbbb
-> Session aaaabbbb queued for re-summarization. The tracker will retry on the next tick (up to 60s).
```

If the session is not in `summarize_failed` status:
```
/retry_summary aaaabbbb
-> Session aaaabbbb is not in a failed state (status: summarized).
```

See [MEMORY.md](./MEMORY.md) for troubleshooting summarization failures.

### `/clear`

The `/clear` equivalent for headless (`cc-headless`) agents: start a fresh context window. It closes your current active session **on the channel you send it from**, so your next message spawns a brand-new `claude -p` with no `--resume`. The close is immediate — there is no window where a follow-up re-attaches to the old session.

The previous session is **not discarded**: after closing it, the bus fires a silent background journaling turn (resuming the old `claude_session_id`) so the agent reviews the conversation one last time and updates its memory files before the context is left behind. Nothing is delivered to the user from that turn. Because journaling resumes the underlying claude session by id and writes to the agent's memory *files*, it works correctly even though the DB session row is already closed.

```
/clear
-> Context cleared -- your next message starts a fresh session. Journaling the previous session in the background.
```

Scope and edge cases:

- **Channel-scoped.** `/clear` only closes the active session for your contact on the originating channel. A Telegram `/clear` leaves a `system:peggy` (scheduler) session untouched, and vice versa.
- **Nothing to clear.** If you have no active session with a live `claude_session_id` on that channel, it replies `No active session to clear` and does nothing.
- **Headless not running.** On an MCP-only deployment the session is still closed, but there is no background memory pass (the reply says so).

This command is most useful for headless agents (see [CC_HEADLESS_ADAPTER.md](./CC_HEADLESS_ADAPTER.md)); the journaling step is a no-op pass-through when the headless adapter isn't running.

### `/stop`

Cancels the sender's in-flight `claude -p` turn for a headless (`cc-headless`) agent — useful when a turn is stuck, taking far longer than expected, or you simply want to interrupt it. Resolves the owning headless instance the same way `/clear` does (by the active session's `agent_id`, falling back to the sole registered instance for sessions that predate `agent_id` tracking), then kills that instance's in-flight child process for the sender with `SIGKILL`.

**Hard stop, not a graceful interrupt.** `SIGTERM` is deliberately not used: `claude`'s own interrupt handling treats a catchable signal as "wrap up," which in practice caused it to silently re-prompt itself with a bare "Continue from where you left off" instead of actually stopping — the opposite of what `/stop` is for. `SIGKILL` cannot be caught, so the whole turn dies outright. The user decides what happens next, not the agent.

If nothing is running for the sender, or the headless adapter isn't running at all:
```
/stop
-> No active turn to stop.
```

**Telegram-only side effect:** if the source channel is Telegram and a live tool-call status draft is open (see [TELEGRAM_ADAPTER.md](./TELEGRAM_ADAPTER.md#live-tool-call-status-stream-e29)), `/stop` appends a "Stopped by user" line to it and finalizes it in place — the message persists in the chat as-is rather than being silently abandoned or later overwritten. **That finalized line is the only confirmation you get** — `/stop` sends no separate reply in this case, to avoid showing the same "stopped" information twice. On any other channel (or when no draft was open, e.g. the turn hadn't made a tool call yet), `/stop` falls back to a plain text confirmation instead:
```
/stop
-> Stopped the current turn.
```

**No result is delivered for a stopped turn.** Once killed, the turn does not fall back to the configured `error_reply` — the cancellation confirmation (finalized draft, or the fallback message above) is the only feedback. On Telegram, the persistent typing indicator is also stopped immediately as part of cancelling — it does not keep blinking for its usual 2-minute safety timeout after the turn has already been killed.

**Reaches journaling turns too.** A silent background journaling turn (fired on session close, or by `/clear`) runs through the same per-contact queue as normal turns, so a stuck journaling turn blocks new messages exactly like a stuck normal turn would. `/stop` can cancel either kind — it doesn't matter which one is currently occupying the contact's turn slot.

---

## How Command Dispatch Works

Commands are intercepted **after the full pipeline runs** (including transcript logging at Stage 80). This means:

1. The slash command message is logged to transcripts just like any regular message.
2. The bus looks up the command name in the `CommandRegistry`.
3. For `scope: "bus"` commands, the handler runs and the response is sent directly via the originating adapter -- **bypassing the outbound queue entirely**.
4. For `scope: "agent"` commands, the message is enqueued for fan-out to the agent. The agent receives it with `payload.type: "slash_command"` and should check `payload.command` + `payload.args_raw`.
5. For unknown commands, a friendly error is returned the same way.
6. Command responses are logged to transcripts with `metadata.command_response: true` so the memory system (E8/E9) can exclude them from summarization.

### Telegram Group Chats

Telegram sends commands with a `@botname` suffix in group chats (e.g. `/status@MyBot`). The slash command parser strips this suffix automatically, so commands work identically in private chats and groups.

### Plugin Security

Command handlers receive a **read-only database wrapper** (`SafeDatabase`) via `ctx.db`. This wrapper exposes only `.prepare().get()` and `.prepare().all()` -- write operations (`.run()`, `.exec()`) are not available. Built-in commands that need write access (e.g. `/forget`, `/pause`) use the real database handle through their internal dependency injection.

---

## Adding Custom Commands (Plugin API)

Any code with access to the `CommandRegistry` instance can register additional commands:

```typescript
import type { CommandDefinition } from './commands/registry.js';

const myCommand: CommandDefinition = {
  name: 'ping',
  description: 'Responds with pong',
  usage: '/ping',
  scope: 'bus',
  handler: async (_args, ctx) => {
    // ctx.db is read-only (SafeDatabase) -- only .get() and .all() available
    return { body: 'pong' };
  },
};

commandRegistry.register(myCommand);
```

The registry throws if a command name is already taken, preventing accidental overwrites. Custom commands appear in `/help` automatically.

---

## Adapter Autocomplete

At startup, bus-core calls `registerCommands()` on each adapter that declares `capabilities.registerCommands: true`. The Telegram adapter uses Telegram's `setMyCommands` API, which displays commands as autocomplete suggestions in the chat input. BlueBubbles (E4) will no-op gracefully when it's implemented.

**Telegram command scopes.** Telegram picks a chat's command menu by scope precedence (`chat` > `all_private_chats` > `all_group_chats` > `default`). The adapter writes the list to **both** the `default` and `all_private_chats` scopes — writing only `default` lets a stale `all_private_chats` set (often `/start, /help, /status` from BotFather) permanently shadow the live list in 1:1 chats. See [TELEGRAM_ADAPTER.md](./TELEGRAM_ADAPTER.md#slash-commands).

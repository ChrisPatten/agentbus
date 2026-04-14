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
| `/replay <session_id>` | Replay the transcript for a session | `/replay aaaabbbb` |
| `/forget <contact_id>` | Expire all memory records for a contact | `/forget chris` |

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
→ Available commands:
    /forget — Expire all memories for a contact
    /help — List commands or show usage for a specific command
    /pause — Pause inbound messages from an adapter
    ...

/help pause
→ /pause <adapterId>
  Pause inbound messages from an adapter
```

### `/pause <adapterId>` and `/resume <adapterId>`

Pauses or resumes an adapter. While paused, all non-command inbound messages from that adapter are dropped. **Slash commands always get through**, so you can `/resume` an adapter from the same channel it's paused on.

The pause state lives in memory — it resets if bus-core restarts.

```
/pause telegram
→ Adapter "telegram" paused. Inbound messages will be dropped until resumed.

/resume telegram
→ Adapter "telegram" resumed. Messages will flow normally.
```

### `/sessions [channel] [--limit N]`

Lists recent sessions (default: 10). Optionally filter by channel name or cap the count.

```
/sessions telegram --limit 3
→ Sessions (3 shown):

  aaaabbbb  telegram  chris  2026-04-13 14:22  12 msgs  [active]
  ccccdddd  telegram  chris  2026-04-12 09:10  34 msgs  [closed]
  eeeeffff  telegram  chris  2026-04-11 20:05  8 msgs   [closed]
```

### `/replay <session_id>`

Replays the transcript for a session. You can use the short 8-character ID shown in `/sessions`.

```
/replay aaaabbbb
→ Session aaaabbbb — telegram — 2026-04-13 14:22
  ────────────────────────────────────────────────
  14:22 > Hello there
  14:22 < Hi! How can I help?
  ...
```

### `/forget <contact_id>`

Marks all memory records for a contact as superseded. Requires the memory system (E8) to be installed — returns a graceful message otherwise.

```
/forget chris
→ Forgot 7 memory records for contact: chris
```

---

## How Command Dispatch Works

Commands are intercepted **after the full pipeline runs** (including transcript logging at Stage 80). This means:

1. The slash command message is logged to transcripts just like any regular message.
2. The bus looks up the command name in the `CommandRegistry`.
3. For `scope: "bus"` commands, the handler runs and the response is sent directly via the originating adapter — **bypassing the outbound queue entirely**.
4. For unknown commands, a friendly error is returned the same way.
5. Command responses are logged to transcripts with `metadata.command_response: true` so the memory system (E8/E9) can exclude them from summarization.

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
  handler: async (_args, _ctx) => ({ body: 'pong' }),
};

commandRegistry.register(myCommand);
```

The registry throws if a command name is already taken, preventing accidental overwrites. Custom commands appear in `/help` automatically.

---

## Adapter Autocomplete

At startup, bus-core calls `registerCommands()` on each adapter that declares `capabilities.registerCommands: true`. The Telegram adapter uses Telegram's `setMyCommands` API, which displays commands as autocomplete suggestions in the chat input. BlueBubbles (E4) will no-op gracefully when it's implemented.

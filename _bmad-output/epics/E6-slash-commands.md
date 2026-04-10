# E6 — Slash Command System

| Field | Value |
|---|---|
| Epic ID | E6 |
| Build Order Position | 5 of 12 |
| Dependencies | E5 (pipeline with slash-command detect stage, transcript-log stage) |
| Story Count | 3 |
| Estimated Complexity | S |

---

## Epic Summary

E6 builds the command dispatch layer that sits on top of the pipeline's slash-command detection. When Stage 40 flags a message as a slash command, E6's `CommandRegistry` intercepts it before queue delivery and dispatches to the appropriate handler — either a built-in bus command or an agent-space command handled by the agent. After E6, the operator can type `/status`, `/help`, `/pause`, and other commands from any connected channel and get structured responses routed back through the bus.

---

## Entry Criteria

- E5 complete: pipeline runs, Stage 40 sets `context.isSlashCommand = true` and `context.slashCommand = { name, args[] }` on matching messages
- The post-pipeline dispatch point in the bus HTTP handler is identified (where the handler checks `context.isSlashCommand` and branches)
- The list of 8 built-in commands and their expected behaviors is agreed (see S6.2)
- Adapter capability `registerCommands` is defined in the `AdapterInstance` interface (can be done alongside E11 or stubbed here)

---

## Exit Criteria

- All 8 built-in commands return correct responses when invoked from any channel
- `/help` lists all registered commands with their descriptions
- Unknown commands return a friendly error message (not a crash)
- `CommandRegistry.register()` prevents duplicate command names
- At startup, bus-core pushes command metadata to adapters that support `registerCommands()`
- Commands that depend on later epics (e.g., `/resume` depending on E9, `/forget` depending on E8) return `{ available: false, reason: "..." }` gracefully when invoked before their backing system is ready

---

## Stories

### S6.1 — CommandRegistry

**User story:** As bus-core, I want a `CommandRegistry` that maps slash command names to handler functions with metadata so that I can add, discover, and dispatch commands without hardcoded switch statements.

**Acceptance criteria:**
- `CommandRegistry` exposes `register(command: CommandDefinition): void` where `CommandDefinition` = `{ name: string, description: string, usage: string, scope: "bus"|"agent", handler: CommandHandler }`
- `scope: "bus"` means the bus handles the command directly and responds; `scope: "agent"` means the command is forwarded to the agent via a channel event instead of being handled locally
- `lookup(name: string): CommandDefinition | undefined` supports both exact match (`/status`) and prefix match (`/session list`)
- `register()` throws if a command name is already registered (prevents accidental overwrites)
- `list(): CommandDefinition[]` returns all registered commands sorted alphabetically by name
- `CommandHandler` type: `(args: string[], context: SlashCommandContext) => Promise<CommandResponse>` where `CommandResponse = { body: string, metadata?: Record<string, unknown> }`

**Complexity:** S

---

### S6.2 — Built-in Bus Commands

**User story:** As Chris, I want to use slash commands from any connected channel to check system status, manage adapter pausing, review sessions, and control memory so that I can operate AgentBus without needing SSH access to the the host machine.

**Acceptance criteria:**

All 8 commands are registered with `scope: "bus"` and implement the behaviors below:

- `/status` — calls `GET /api/v1/health` (E12), formats and returns adapter status, queue depth, and last summarizer run timestamp; falls back to inline registry check if health API not yet available
- `/help [command?]` — without argument: lists all commands with one-line descriptions; with argument: returns full `usage` string for that command
- `/pause <adapterId>` — calls `AdapterRegistry.lookup(adapterId)` and sets an internal `paused` flag; while paused, pipeline drops inbound messages from that adapter with reason `"adapter_paused"`; returns confirmation
- `/resume <adapterId>` — clears the `paused` flag; returns confirmation; also checks for most recent summarized session and offers to fire a context briefing (delegates to E9's `/resume` logic when available)
- `/sessions [channel?] [--limit N]` — calls `list_sessions` query, returns formatted table of recent sessions with ID, channel, start time, and summary status
- `/replay <session_id>` — retrieves transcript for session from `transcripts` table, formats as a condensed conversation replay, sends back as a multi-part message (split at 4000 chars if needed)
- `/forget <contact_id>` — marks all `memories` rows for `contact_id` as `superseded_by = "manual_forget"` and sets `expires_at = now()`; returns count of affected memories; requires E8 to be fully effective
- `/subscribe <channel>` — registers the invoking contact as subscribed to notifications on the given channel; stores in a `subscriptions` table (add to schema migration if not present)

Each command returns a human-readable response string routed back through the originating adapter and channel.

**Complexity:** M

---

### S6.3 — Adapter Command Registration

**User story:** As a channel user, I want slash commands to appear as native autocomplete options in my messaging app so that I can discover and use commands without memorizing them.

**Acceptance criteria:**
- `AdapterInstance` interface includes optional method `registerCommands?(commands: CommandManifest[]): Promise<void>` where `CommandManifest = { name: string, description: string }`
- At bus-core startup (after all adapters are registered), bus iterates `AdapterRegistry.list()` and calls `registerCommands()` on each adapter that declares it
- `CommandManifest[]` sent to each adapter contains only the commands relevant to that adapter's scope (excludes agent-scope commands unless adapter config opts in)
- If `registerCommands()` throws or times out (5s), the error is logged as a warning and startup continues — command registration failure is non-fatal
- Telegram adapter (E3) uses `setMyCommands` Bot API call as its `registerCommands()` implementation
- BlueBubbles adapter (E4) logs a warning that native command registration is not supported and no-ops gracefully

**Complexity:** S

---

## Notes

- **Command dispatch point in the pipeline:** After Stage 80 (transcript-log), the bus HTTP inbound handler checks `context.isSlashCommand`. If true, it calls `CommandRegistry.lookup(context.slashCommand.name)` and dispatches. The response is routed back through the originating adapter — do not enqueue it as a normal message (it bypasses the outbound pipeline).
- **`/pause` and the pipeline:** Implementing adapter pausing inside the pipeline (Stage 10 or a new Stage 5) is cleaner than checking in each adapter. The pipeline checks an `AdapterPauseRegistry` (a simple `Set<string>`) before Stage 10 and aborts early if the adapter is paused.
- **`/replay` size management:** Transcripts can be long. Implement a simple character-count splitter; send multiple messages in sequence with a small delay (100ms) between them to avoid rate limiting.
- **`/forget` and E8 dependency:** `/forget` can be registered in E6 but should return `{ available: false }` if the `memories` table doesn't exist yet. When E8 lands, the handler will find the table and operate normally — no code change needed, just the table presence check.
- **Command naming convention:** Commands use lowercase with hyphens for multi-word names (e.g., `/dead-letter`, not `/deadLetter`). Keep names short — they're typed by humans.
- **Agent-scope commands:** `scope: "agent"` commands are not implemented in E6. They are registered in E6's registry as placeholders and forwarded to the agent as `type: "command_invocation"` channel events. the agent handles them in her system prompt. This scope distinction allows future agent-custom commands without touching bus-core.

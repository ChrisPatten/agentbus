# Runtime capabilities

An agent **runtime** is what hosts the agent behind a route: `cc-headless`, `cc-pool`, `claude-code`, or any other harness that polls the bus (`mcp-polled`). Runtime capabilities describe what the bus can do with that agent: start a turn on its own, resume a session, or count on hooks.

They are separate from channel adapter capabilities (`AdapterCapabilities` in `src/core/registry.ts`: typing, reactions, tool status). A channel adapter delivers to a person. A runtime hosts the agent that answers.

Code: `src/core/runtime-capabilities.ts` (types and matrix) and `src/core/runtime-resolver.ts` (resolution, live checks, requirement validation).

## Capabilities

| Capability | Meaning | Kind |
|---|---|---|
| `systemMessages` | The bus can start a turn with its own content (no human message), scoped to one conversation: a scheduled job, a journaling instruction, an advisory | static |
| `schedules` | Scheduler jobs run as their own background turn, isolated from the human conversation and honoring a per-schedule `model` | static |
| `sessionResume` | The bus can resume a conversation's earlier Claude session by id | static + live |
| `sessionFork` | The bus can branch a new conversation from an existing Claude session | static + live |
| `exclusiveSession` | Each conversation has its own session; no other conversation shares it | static + live |
| `liveAgent` | An agent process stays running between turns and holds the session in memory | static + live |
| `nativeMemory` | The harness loads `CLAUDE.md` and Claude Code auto memory itself | static |
| `contextInjection` | The bus can add context alongside each delivered turn | static |
| `hookEvents` | Harness events the runtime can report through hooks: `turn-ended`, `pre-compact`, `session-end`, `clear` | static |

**Static** capabilities are fixed by the runtime type. Features check them when the config loads. **Live** capabilities also depend on the state of one session, and are checked at run time. A runtime that lacks a capability statically never passes its live check.

## Matrix

| | `cc-headless` | `cc-pool` | `claude-code` | `mcp-polled` |
|---|---|---|---|---|
| `systemMessages` | yes | yes | no | no |
| `schedules` | yes | yes | no | no |
| `sessionResume` | yes | yes | no | no |
| `sessionFork` | yes | no | no | no |
| `exclusiveSession` | yes | yes | no | no |
| `liveAgent` | no | yes | yes | yes |
| `nativeMemory` | yes | yes | yes | no |
| `contextInjection` | yes | yes | yes | no |
| `hookEvents` | `pre-compact` | all four | all four | none |

Why each value holds:

- **`cc-headless`** spawns `claude -p` per batch. Journaling turns and `system:` or scheduled batches are bus-originated turns. Scheduled batches run in the `system` turn class, use the reserved slots, and honor `schedule_model`. `--resume <claude_session_id>` resumes a conversation. Forking is the Mac app's Earlier resume, which starts a new bus session from a resumable transcript (the bus never passes `--fork-session`). No process stays alive between turns, so there is no live agent. The harness supports native memory, but until E67 the bus sets `CLAUDE_CODE_DISABLE_AUTO_MEMORY` and injects memory itself. The bus sees turn end and process exit directly and `/clear` is a bus command, so the only hook that adds information is `pre-compact`.
- **`cc-pool`** leases one interactive pane per conversation. Bus-originated messages route to the conversation's own pane, and a recurring schedule gets its own `sched:` topic, so its own pane and model. A pane resumes the conversation's session with `--resume` when the transcript is still on disk. Earlier resume only covers `cc-headless`, so there is no fork. An interactive Claude Code session fires Stop, PreCompact and SessionEnd, and handles `/clear`.
- **`claude-code`** is one persistent session that every routed conversation shares. The bus neither launches nor resumes it. A scheduled message is still delivered, but into the shared session, and `schedule_model` is ignored. A bus-originated turn can't be scoped to one conversation.
- **`mcp-polled`** is any other harness that drains an agent queue over HTTP. The bus only knows that it polls.

## Resolving an agent's runtime

`RuntimeResolver.resolve(agentId)` accepts a bare (`baxter`) or prefixed (`agent:baxter`) id and returns the runtime with its capabilities, or `undefined`. Sources, in precedence order:

1. `adapters.cc-headless` instances → `cc-headless` (with the instance config and working directory).
2. `adapters.cc-pool` instances → `cc-pool`, for the pool's own id and every pane id derived from it (`peggy-pool-3`).
3. `pipeline.routes` targets (including `also_notify`) with `adapterId: claude-code` and an `agent:` recipient → `claude-code`.
4. Any other route target with an `agent:` recipient → `mcp-polled`.

An agent that only receives messages through the implicit default route does not resolve, because the bus can't tell it from a typo. Give it an explicit route.

`list()` returns each configured agent once (pools without their panes). `/status` and `/api/v1/health` use it.

## Live checks

`RuntimeResolver.checkLive(capability, session)` returns `{ ok, capability, runtime, check, reason }`. `session` carries `agentId` and whatever is known of `conversationId`, `sessionId` and `claudeSessionId`. A missing `claude_session_id` is looked up from `sessions`, preferring the open session.

| Check | Applies to | Passes when |
|---|---|---|
| `pane-lease` | `liveAgent`, `exclusiveSession` on `cc-pool` | a pane is leased to this conversation, in state `leased` |
| `transcript` | `sessionResume`, `sessionFork` on `cc-headless` and `cc-pool` | `~/.claude/projects/<cwd slug>/<claude_session_id>.jsonl` exists for the runtime's working directory. Claude Code's `cleanupPeriodDays` deletes old transcripts |
| `polling` | `liveAgent` on `claude-code` and `mcp-polled` | the agent polled `/api/v1/messages/pending` recently: within three `claude-code` poll intervals, and at least 15 seconds |
| `static` | everything else | the runtime has the capability |
| `unresolved` | any | never: no runtime hosts the agent |

Poll times are kept in memory, so after a bus restart a harness counts as not polling until its next poll.

## Declaring requirements

A feature lists what it needs from an agent's runtime as `RuntimeRequirement` entries: `{ feature, agentId, requires }`. `requires` holds capability names and, for hooks, `hookEvents:<event>` (for example `hookEvents:pre-compact`).

`collectRuntimeRequirements(config)` gathers every config-driven requirement, and `loadConfig()` checks them with `validateRuntimeRequirements()`. A mismatch stops the bus at startup with every problem listed:

```
Runtime capability check failed:
  journaling chain: system-message: agent agent:claude runs on claude-code, which lacks systemMessages, exclusiveSession
  journaling chain: script: agent agent:ghost has no runtime (no cc-headless/cc-pool instance or agent route)
```

No feature declares requirements yet; journaling chains (E66) are the first. Advisories (E65) use `systemMessages` but don't require it: a runtime without it gets advisories directly on the owner's channel (see [ADVISORIES.md](ADVISORIES.md#delivery-paths)). Owners configured for an agent that resolves to no runtime only log a startup warning.

## Where it shows

`/status` adds a `Runtimes:` section, one line per agent, omitted when no agent resolves. `GET /api/v1/health` adds a `runtimes` object keyed by agent id. See [SLASH_COMMANDS.md](SLASH_COMMANDS.md#status) and [HTTP_API.md](HTTP_API.md#get-apiv1health).

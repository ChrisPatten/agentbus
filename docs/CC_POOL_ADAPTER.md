# cc-pool adapter

`cc-pool` runs a pool of tmux panes, each an interactive `claude` session paired with its own `cc.ts` MCP process, leased to a conversation on demand by `PoolManager` (`src/pool/`). It sits between the two other Claude Code adapters: [`claude-code`](CC_ADAPTER.md) gives you one persistent interactive session that every routed conversation shares, and [`cc-headless`](CC_HEADLESS_ADAPTER.md) gives every conversation its own Claude session but only as non-interactive `claude -p` batches. Reach for `cc-pool` when you want `cc-headless`'s per-conversation isolation — a separate session per contact, channel, or thread — but still need a real session you can attach to, watch, or type into by hand. See [Choosing an adapter](CC_ADAPTER.md#choosing-an-adapter) for the full comparison.

## Architecture

Message delivery never goes through an adapter's `send()` method — `cc-pool` has no `AdapterInstance` and is not registered in the `AdapterRegistry`. Delivery is the same pending/ack polling convention every agent runtime in AgentBus already uses: `queue.enqueue()` with a `recipient` string, picked up by whichever process polls `GET /api/v1/messages/pending?agent=<that string>`. The only thing `cc-pool` adds is a pipeline stage, `pool-route-resolve` (slot 72, between `route-resolve` at 70 and `transcript-log` at 80), that decides which concrete pane's agent id that string should be, on every inbound message, before the existing enqueue path runs completely unchanged.

```
inbound message  (Telegram, email, ...)
        │
        ▼
Stage 70   route-resolve
        │    route = { adapterId: cc-pool, recipientId: agent:peggy }
        ▼
Stage 72   pool-route-resolve   ← pipeline stage, not an adapter — no send() anywhere in this path
        │    PoolManager.resolveRoute(conversationId):
        │      LeaseStore.acquire()  →  reuse | bound | grow | evict | exhausted
        │      bound/grow/evict      →  launch or --resume the pane's claude session
        │    rewrites route.recipientId  →  agent:peggy-pool-2
        ▼
Stage 80   transcript-log, then the normal fan-out loop
        │    queue.enqueue({ recipient: 'agent:peggy-pool-2', ... })
        ▼
pane 2's cc.ts polls  GET /api/v1/messages/pending?agent=peggy-pool-2
        │
        ▼
notifications/claude/channel  →  wakes the interactive session
        │
        ▼
agent calls reply()  →  normal outbound path  →  Telegram, email, ...
```

If a route's `recipientId` doesn't match any configured pool, `pool-route-resolve` logs an error and leaves the route untouched — the message is enqueued under an id nothing polls, rather than silently dropped or crashing the pipeline (the stage is registered with `critical: false` for the same reason: a bug here must not take down transcript logging or delivery to other route targets, such as an `also_notify` entry).

tmux `send-keys` is used only for pane lifecycle — the launch command, `/clear`, and `Ctrl-C` — never to deliver message text. No user-authored content is ever typed into a pane, so there's no shell-escaping or prompt-injection surface from a conversation's own messages.

## Configuration reference

Every field of `adapters.cc-pool`:

| Field | Type | Default | Description |
|---|---|---|---|
| `agent_id` | string | required | Logical agent id for the pool. Routes target `recipientId: agent:<agent_id>`. Each pane gets its own derived id, `<agent_id>-pool-<n>`. |
| `tmux_session` | string | required | tmux session name holding this pool's panes — one tmux window per pane. |
| `panes` | number | `2` | Number of panes created at startup. |
| `growth` | `fixed` \| `dynamic` | `fixed` | `fixed` keeps exactly `panes` panes for the pool's lifetime. `dynamic` starts at `panes` and grows on demand up to `max_panes`. |
| `max_panes` | number | = `panes` | Upper bound on pane count when `growth: dynamic`. Ignored when `growth: fixed` — setting it below `panes` there fails validation at startup. |
| `claude_bin` | string | required, absolute path | Absolute path to the `claude` CLI binary. Unlike `cc-headless`, there's no default: a bare `claude` typed into a tmux pane resolves through your shell profile, which commonly aliases `claude` to a tmux-wrapping function rather than the CLI itself. |
| `model` | string | unset | Passed as `--model` to each pane's `claude` invocation. Omit to use the CLI's own default. |
| `working_dir` | string | bus-core cwd | Working directory shared by every pane in the pool. Determines the auto-loaded `CLAUDE.md` hierarchy. |
| `launch_args` | list of strings | `[]` | Extra CLI args appended verbatim to every launch/resume invocation. |
| `poll_interval_ms` | number | `1000` | Poll interval passed through to each pane's `cc.ts` process. |
| `system_prompt` | string | unset | Appended via `--append-system-prompt-file` — it adds to the CLI's default prompt rather than replacing it, unlike `cc-headless`'s required `system_prompt`. Supports the same `{{var}}` templates and `@path` expansion as `cc-headless`. |
| `lease.idle_evict_ms` | number (ms) | `1800000` (30 min) | Idle time after which a leased pane becomes evictable by a new conversation. |
| `lease.hard_idle_ms` | number (ms) | `21600000` (6 h) | Time since a lease started after which it's proactively released, regardless of activity. |
| `lease.park_timeout_ms` | number (ms) | `300000` (5 min) | How long a parked message waits for a free pane before it's dead-lettered. |
| `on_evict` | `clear` \| `kill` | `clear` | What happens to a pane on release: type `/clear` (keep the window, drop context) or send `Ctrl-C` and kill the window (the next launch recreates it). |
| `launch_ack_delay_ms` | number (ms) | `5000` | Total time to poll `capture-pane` output for the `--dangerously-load-development-channels` confirmation prompt to actually appear, before concluding there's nothing to dismiss. `Enter` is only ever sent once the prompt is confirmed showing — this is not a blind pre-Enter delay. |
| `launch_ack_max_attempts` | number | `3` | Maximum `Enter` presses to dismiss the ack prompt, once it's confirmed showing, before giving up. |
| `launch_ack_pattern` | string | `"loading development channels"` | Text matched (case-insensitively) in pane output to detect the ack prompt — the real prompt's header reads "WARNING: Loading development channels". Override if a CLI update rewords it. |
| `pane_env` | map of string to string | `{}` | Extra environment variables set at window-creation time (`tmux new-window -e`). `TERM` and `COLORTERM` are always added on top, unconditionally. |

### Single instance vs. named instances

A single pool:

```yaml
adapters:
  cc-pool:
    agent_id: peggy
    tmux_session: peggy-pool
    panes: 4
    claude_bin: /usr/local/bin/claude
    working_dir: /home/peggy
```

Or a named record, one entry per pool:

```yaml
adapters:
  cc-pool:
    peggy-pool:
      agent_id: peggy
      tmux_session: peggy-pool
      panes: 4
      claude_bin: /usr/local/bin/claude
      working_dir: /home/peggy
    jarvis-pool:
      agent_id: jarvis
      tmux_session: jarvis-pool
      panes: 2
      claude_bin: /usr/local/bin/claude
      working_dir: /home/jarvis
```

`getCcPoolInstances()` (`src/config/schema.ts`) normalizes both forms into the same instance list, the same pattern `cc-headless` and Telegram already use. Validated at startup:

- Instance names must match `^[a-z0-9_-]+$`.
- `agent_id` must be unique across instances — it's the routing target.
- `tmux_session` must be unique across instances — two pools can't share one tmux session.
- `growth: fixed` with an explicit `max_panes` below `panes` fails to load — a fixed pool ignores `max_panes`, so a value below `panes` can only be a mistake.

### Routing

Routing is unchanged in shape — a pool is just another route target:

```yaml
pipeline:
  routes:
    - match: { channel: telegram:peggy }
      target: { adapterId: cc-pool, recipientId: agent:peggy }
```

`recipientId` always names the pool's logical `agent_id`, never a specific pane — `pool-route-resolve` rewrites it to the concrete pane per message.

## Pane lifecycle

Each pane's lease moves through a small state machine, stored per pane in the `pool_leases` table (one row per `pool_id`/`pane_id` pair):

| Transition | Trigger |
|---|---|
| `free` → `launching` | A conversation claims the pane: `LeaseStore.acquire()` bound a free pane, grew a new one, or evicted an idle occupant. The claim is atomic — two conversations can never claim the same pane. |
| `launching` → `leased` | The pane's `claude` session launched, acknowledged the MCP-channel prompt, and its `cc.ts` was confirmed polling. `PoolManager` calls `confirmReady()`. |
| `launching` → `dead` | Launch failed — the ack handshake exhausted `launch_ack_max_attempts`, or readiness wasn't confirmed within 30 seconds. The conversation's message is parked instead. |
| `leased` → `free` | The lease is released: the hard-idle sweep found it past `lease.hard_idle_ms`, or a new conversation's `acquire()` evicted it (least-recently-active, past `lease.idle_evict_ms`). Either way, `on_evict` runs against the pane. |
| `leased`/`draining` → `free` | `reconcileLiveness()` finds the pane's tmux window is gone (a crash) and releases the row. The conversation keeps its Claude session id on `sessions`, so it resumes correctly wherever it's next claimed. Runs once at startup and again on every recurring sweep tick, so a mid-operation crash is caught within one sweep interval, not just at the next bus-core restart. |
| `dead` → `free` | `reconcileLiveness()` also revives every `dead` row it finds, on the same startup-and-recurring cadence: it best-effort kills any lingering window at that pane (a failed launch can leave one partially started) and releases the row back to `free`. A launch failure therefore costs the pool a pane for at most one sweep interval, not permanently. |

`draining` is defined for a pane whose in-flight turn shouldn't be reused until that turn completes, and `reconcileLiveness()` treats it the same as `leased` for liveness-checking. Nothing in the current implementation actually transitions a pane into `draining`, though: eviction is immediate. When `acquire()` evicts an idle occupant, the DB claim and the `on_evict` action (`/clear` or kill) both happen right away, not gated on the previous turn finishing. The [outbound lease guard](#allocation-and-eviction) is what actually protects against a reply from that superseded turn landing in the wrong conversation.

### Launch sequence

1. **Ensure the window exists.** If the pane's tmux window is already alive (a warm restart, or a pane being reused), this step is skipped. Otherwise the tmux session is created if needed, and the window is created with `TERM`, `COLORTERM`, and any `pane_env` set at creation time — tmux can't add environment variables to a window after it exists, and the TUI depends on these being present from the start.
2. **Write a per-pane MCP config.** A JSON file is generated — the project's own `.mcp.json` is never edited — that copies in any other MCP servers the project already configures, then overwrites the `agentbus` entry with this pane's own `AGENTBUS_AGENT_ID`. The pane launches with `--mcp-config <file> --strict-mcp-config`, so this generated file, not the project's `.mcp.json`, is authoritative for that pane. Without the copy step, `--strict-mcp-config` would silently drop the project's other servers.
3. **Send the launch line.** `claude --session-id <uuid>` (fresh) or `claude --resume <uuid>` (returning), plus `--permission-mode auto`, the generated `--mcp-config`, an optional `--append-system-prompt-file`, `--model` if configured, and `--dangerously-load-development-channels server:agentbus` — the flag that makes this pane's `cc.ts` act as a channel source at all. `launch_args` is appended last.
4. **Acknowledge the development-channels prompt.** A freshly started session — fresh or resumed — blocks on a confirmation prompt for `--dangerously-load-development-channels` (a real captured example, v2.1.274-276: `WARNING: Loading development channels ... ❯ 1. I am using this for local development / 2. Exit`). The pane first *polls* `capture-pane` output for `launch_ack_pattern` to actually appear — up to `launch_ack_delay_ms` total — rather than blindly waiting a fixed time and hoping the prompt has rendered by then; measured against the real CLI, the prompt can take over a second to render, and a blind guess that lands too early looks identical, from `capture-pane`'s point of view, to "already dismissed" (see Troubleshooting below for the bug this caused). Only once the prompt is confirmed showing does it send `Enter` and recheck; if it's still showing, it retries on a short backoff, up to `launch_ack_max_attempts` times, before giving up. If the prompt never appears within `launch_ack_delay_ms` at all, there's nothing to dismiss and this step is a no-op. This phase shares the same overall `LAUNCH_READY_TIMEOUT_MS` (30s) budget as step 5, not a separate one — a pathologically large `launch_ack_max_attempts` (or `launch_ack_delay_ms`) can still exhaust the launch deadline on its own.
5. **Confirm readiness.** The pane isn't handed a message until its `cc.ts` has actually polled the bus: `PoolManager` checks `GET /api/v1/agents/<pane agent id>/last-poll` until it reports a poll at or after the launch started, or the 30-second launch timeout elapses. This bound is enforced by wall-clock deadline, not by counting polls — it holds even if an individual `/last-poll` request stalls.

### Session id: durable vs. transient

`--session-id <uuid>` starts a brand-new Claude session with a bus-chosen UUID; `--resume <uuid>` reopens an existing one. `PoolManager` decides which by looking up the conversation's session in the `sessions` table — the same table and the same `claude_session_id` column `cc-headless` already writes.

Two records track a Claude session id, at different lifetimes:

| Record | Column | Lifetime | Cleared |
|---|---|---|---|
| Pane cache | `pool_leases.claude_session_id` | Transient — scoped to the pane's current lease | On every `release()` |
| Conversation record | `sessions.claude_session_id` | Durable — scoped to the conversation | Never, by `cc-pool` |

`pool_leases.claude_session_id` only answers "what's loaded in this pane right now" — it says nothing about whether the conversation itself is new. When a lease resolves with no session id cached in the pane, `PoolManager` still checks `sessions` for that conversation before deciding `--session-id` (nothing found — a genuinely new conversation) versus `--resume` (found — a conversation returning to a pane, possibly a different one than it last used). Once launch succeeds, the id is written to both places: `pool_leases` for the pool's own hot-path reads, and `sessions.claude_session_id` so cross-cutting consumers (`SessionTracker`, `/clear`, `/cost`) see it too.

## Allocation and eviction

`LeaseStore.acquire()` resolves every inbound message to a pane in one atomic step, trying each of the following in order:

| Outcome | Condition | What happens |
|---|---|---|
| `reuse` | This conversation already holds a `leased` pane. | The lease is touched (activity timestamp bumped); no launch needed. |
| `bound` | A `free` pane exists. | It's claimed for this conversation and launched. |
| `grow` | No free pane, but `growth: dynamic` and the pool is under `max_panes`. | A new pane row is created and launched — the tmux window itself is created lazily, on this first claim. |
| `evict` | No free or growable pane, but some `leased` pane has been idle past `lease.idle_evict_ms`. | The least-recently-active idle pane is reassigned: its prior occupant is released (`on_evict`), then the new conversation is launched into it. |
| `exhausted` | None of the above. | The message is parked (below) instead of delivered or dropped. |

Eviction always picks the least-recently-active idle pane, never a busy one — a pane with recent activity is not eviction-eligible no matter how long its conversation has existed.

A pool never actually shrinks back down in row count. A grown pane that's later released — by the hard-idle sweep or by LRU eviction — becomes an ordinary free pane, indistinguishable from one seeded at startup: its tmux window may be torn down (`on_evict: kill`) and recreated later, but its `pool_leases` row persists. Growth is a one-way ratchet up to `max_panes`, not elastic capacity that gives room back when idle.

**Hard-idle release** runs independently of new demand: on every sweep tick (60 seconds — a fixed interval, not currently configurable), any `leased` pane idle past `lease.hard_idle_ms` is released, `on_evict` applied, even when no other conversation is waiting for it — so a pool doesn't sit fully leased forever on conversations that trailed off.

**The parked queue.** An `exhausted` result doesn't drop the message: it's enqueued to a synthetic per-pool recipient (`agent:<agent_id>__parked`) that nothing polls directly. The same sweep tick that runs hard-idle release also drains this queue — up to 20 messages per tick — retrying `resolveRoute()` for each. A message that now resolves to a real pane is re-addressed and delivered there. One still exhausted is re-parked, carrying forward the timestamp of when it was first parked. Once that timestamp is older than `lease.park_timeout_ms`, the message is dead-lettered, and exactly one system notice per conversation — not per message — is sent; later timeouts for the same conversation, within the same process lifetime, don't repeat it.

**Outbound lease guard.** Because eviction reassigns a pane immediately rather than waiting for its current turn to finish, a slow reply from the just-evicted turn could otherwise land after the pane has moved on to a new conversation. `POST /api/v1/messages` guards against this: it resolves the outbound message's target conversation, looks up the sending pane's current lease by its agent id, and rejects with `409` if that pane is `leased` to a different conversation than the one the reply targets. This is enforced for every outbound send a pane's agent id can trigger — `reply`, `send_message`, and `send_email` all thread the pane's real `AGENTBUS_AGENT_ID` through as the sender for exactly this check.

## Session-tracker interaction

Writing `sessions.claude_session_id` for a pool-owned session — rather than leaving it `NULL` — is deliberate, not incidental. That column doubles as a flag `SessionTracker` reads two ways:

- It opts the session **out of** `SessionTracker.closeIdleSessions()`'s legacy idle-close path, which only ever considers sessions where `claude_session_id IS NULL`. Idle handling for a pool session is `cc-pool`'s own job — the hard-idle sweep and LRU eviction above — not the generic session-closer's.
- It opts the session **into** `SessionTracker.dispatchJournaling()`'s candidate query, which selects on `claude_session_id IS NOT NULL`. That dispatcher requires a registered `JournalingRunner` for the session's agent id, so every `cc-pool` instance registers one at startup, exactly like `cc-headless` does.

That registered runner is a deliberate, permanent no-op. Pool sessions are interactive and long-lived, with a live `claude` process — or a human, attached by hand — already able to update memory files at any time, so there's no out-of-band turn worth firing the way `cc-headless` fires a silent `--resume` journaling turn between batch invocations.

It also currently has no effect either way: `dispatchJournaling()` builds its dispatch table only from `getCcHeadlessInstances()`, so a session whose agent id is a pool pane's is never looked up there — the loop moves on before it would even check for a registered runner. Registering the no-op runner costs nothing and keeps the two adapter types' startup wiring parallel, but today it is unreachable code, not a working no-op you're relying on. Closing that gap is tracked in the maintenance backlog, not something you can affect through configuration.

## Observability

### Live tool-call status stream

`cc-headless` gets the typing indicator and live tool-call status stream (E29) for free by parsing its spawned `claude -p` process's own stdout stream — see [TELEGRAM_ADAPTER.md#live-tool-call-status-stream](TELEGRAM_ADAPTER.md#live-tool-call-status-stream). A pool pane has no equivalent: it's a normal interactive `claude` process talking to bus-core over MCP, so bus-core only ever sees calls to the small set of MCP tools it itself exposes, not the pane's other tool calls.

[`scripts/hooks/agentbus_tool_status_hook.sh`](../scripts/hooks/agentbus_tool_status_hook.sh) closes that gap from the other side: it's a Claude Code hook, wired into the pane's *own* project as both a `UserPromptSubmit` and `PostToolUse` hook (same script, branches on `hook_event_name`), calling the same adapter-agnostic `POST /api/v1/adapters/:id/typing` and `/tool-status` endpoints `cc-headless` uses. `UserPromptSubmit` regex-parses the `sender`/`channel`/`topic` triple back out of the rendered `New message from ... via ... (topic: ...)` prompt text (`cc.ts`'s `formatMessagesForSampling` — see [CC_ADAPTER.md#message-format](CC_ADAPTER.md#message-format)) and caches it per-session; `PostToolUse` reads that cache and posts a short summary of the tool that just ran, until a `reply`/`send_message` call marks the turn delivered.

This script lives here because it's AgentBus functionality, but it *runs* inside a separate Claude Code project — the pane's own working directory (e.g. `peggy-claude-code`), not bus-core. Deploy it by symlinking `scripts/hooks/agentbus_tool_status_hook.sh` from that project's own `scripts/hooks/` into this file, and registering it in that project's `.claude/settings.json` under both `UserPromptSubmit` and `PostToolUse`. `STATE_DIR` inside the script is a hardcoded per-deployment constant (one deployment == one agent's project dir with its own symlink) — a second pool agent reusing this script needs its own copy of the registration pointing at a distinct `STATE_DIR`.

**Version-skew gotcha (bit us 2026-09-20):** a pool pane's `cc.ts` subprocess is spawned once, at pane launch, and never restarts on its own — it keeps running whatever `agentbus` source existed at that moment for as long as the pane stays alive, which for a long-lived pooled pane can be days. When `cc.ts`'s message format changed to add the `(topic: ...)` segment (commit `4340adf`), panes already running from before that commit kept emitting the old format indefinitely. The hook's regex must tolerate every message-format version any currently-running pane might still be emitting, not just the latest — it cannot assume a pane's `cc.ts` is current just because the repo is. The shipped regex treats `(topic: ...)` as optional for exactly this reason (falls back to `general`, matching pre-fix behavior) rather than requiring it.

### Cold-start placeholder

The hooks above only cover a pane that's already alive. A `bound`/`grow`/`evict` resolution (see [Allocation and eviction](#allocation-and-eviction)) is a genuine cold start: `resolveRoute()` blocks on the full [launch sequence](#launch-sequence) — the ack handshake and readiness poll, up to the 30s launch timeout — before the message is even delivered to the pane, and until it is, nothing has run the tool-status hook's `UserPromptSubmit` branch yet. Before this, the user saw nothing at all during that wait.

`PoolManager.resolveRoute()` (`src/pool/pool-manager.ts`) now covers this itself: right before calling `paneLauncher.launch()` for any non-`reuse` outcome, it fires a fire-and-forget `POST /api/v1/adapters/:channel/tool-status` with `{ contact_id, text: "One moment…", topic, placeholder: true }` — the same endpoint and adapter capability check (`capabilities.toolStatus`) as a real tool-status line, just with `placeholder: true` set. `reuse` never fires it — a reused pane has no launch latency to cover.

On the adapter side (`TelegramAdapter.appendToolCallLine`, `src/adapters/telegram.ts`), a draft created from a `placeholder: true` call is marked as such (`DraftState.placeholder`). The *next* line posted for that same chat/topic — whether a real tool-status line from the pane's own hook, or the final reply overwriting the draft outright if no tool call happened at all — replaces the placeholder's `lines` instead of appending to it, so "One moment…" never lingers as a permanent first line once anything real has happened. Only Telegram implements `reportToolCall`/`capabilities.toolStatus` today (see [TELEGRAM_ADAPTER.md#live-tool-call-status-stream](TELEGRAM_ADAPTER.md#live-tool-call-status-stream)), so this is currently Telegram-only, same as the rest of the live tool-call status stream — other channels see no behavior change.

### `/pool` command

`/pool [pool-agent-id]` renders pane leases and parked-queue depth as text, from any connected channel:

```
/pool
-> Pool peggy (agent:peggy) — 2 panes
     peggy-pool-1: leased  conv=a3f9c21e  idle=12s
     peggy-pool-2: free
     parked: 1 (oldest 42s)
```

An optional argument narrows the output to one pool, matched against either the bare or `agent:`-prefixed form of its logical agent id. `/status` also gets a one-line summary per configured pool (`pool peggy: 3/4 leased, 1 parked`), omitted entirely on a deployment with no `cc-pool` instances configured.

### `GET /api/v1/pool`

The same data as JSON, optionally filtered with `?pool=<agent id>`:

```json
{
  "ok": true,
  "pools": [
    {
      "pool_id": "peggy",
      "agent_id": "agent:peggy",
      "panes": [
        {
          "pane_id": "peggy-pool:1",
          "agent_id": "agent:peggy-pool-1",
          "state": "leased",
          "conversation_id": "a3f9c21e...",
          "claude_session_id": "b7e1...",
          "leased_at": "2026-09-17T10:00:00.000Z",
          "last_activity_at": "2026-09-17T10:05:00.000Z"
        },
        {
          "pane_id": "peggy-pool:2",
          "agent_id": "agent:peggy-pool-2",
          "state": "free",
          "conversation_id": null,
          "claude_session_id": null,
          "leased_at": null,
          "last_activity_at": null
        }
      ],
      "parked": { "count": 1, "oldest_parked_at": "2026-09-17T10:04:00.000Z" }
    }
  ]
}
```

With no `cc-pool` instances configured, both return an empty result (`{ "ok": true, "pools": [] }`) rather than an error. An unmatched `?pool=` filter returns `404`. See [HTTP_API.md#pool](HTTP_API.md#pool) and [SLASH_COMMANDS.md#pool-pool-agent-id](SLASH_COMMANDS.md#pool-pool-agent-id) for the full reference.

### `POST /api/v1/pool/:agentId/turn-ended`

`last_activity_at` above is otherwise only bumped when a message is routed **in** to a pane (`acquire()`'s `reuse` branch) — never when the pane's own turn actually finishes. A long turn or extended thinking time can therefore look idle well before it is. This endpoint is a real-time correction, meant to be fed by a native Claude Code `Stop` hook (fires after every assistant turn) configured on the pane's `claude` process:

```json
{ "session_id": "b7e1..." }
```

`:agentId` is the pool's bare agent id (e.g. `peggy`). The endpoint looks up the pane whose `claude_session_id` matches `session_id` and calls `leaseStore.touch()` on it. Fire-and-forget, like `/typing` and `/tool-status`: always `200 { "ok": true }`, silently a no-op if the pool or a matching pane isn't found. This is purely an activity-accuracy fix — it does not decide journal-worthiness or run any journaling turn (see [Session-tracker interaction](#session-tracker-interaction) above for that separate, still-open gap).

The `Stop` hook that feeds it is [`scripts/hooks/agentbus_stop_hook.sh`](../scripts/hooks/agentbus_stop_hook.sh) — deployed the same way as the tool-status hook above (symlinked from the pane's own project into this file, registered in that project's `.claude/settings.json`). `POOL_AGENT_ID` inside the script is a hardcoded per-deployment constant, same convention as the tool-status hook's `STATE_DIR`.

### Other pool-pane hooks

[`scripts/hooks/agentbus_precompact_snapshot.sh`](../scripts/hooks/agentbus_precompact_snapshot.sh) is deployed the same way (symlink + `.claude/settings.json` registration, as a `PreCompact` hook), but doesn't call any AgentBus endpoint — it's a Claude-Code-native safety net for a pool agent's own memory system: Claude Code's auto-compaction can discard transcript content before it's ever journaled, so this hook snapshots the last 500 lines of the about-to-be-compacted transcript to `memory/precompact-snapshots/` and leaves one pointer line in that day's journal file. It lives alongside the other pool-pane hooks for consistency, not because it's part of the HTTP API surface documented above.

### What "enqueued" and "delivered" do — and don't — guarantee for a pooled route

`POST /api/v1/inbound` (and every other inbound entry point) fully `await`s the pipeline, including `pool-route-resolve`, before responding — so `{"ok":true,"enqueued_count":1}` genuinely means Stage 72 finished resolving a route and Stage 80's fan-out enqueue succeeded. What it does **not** tell you is which of `reuse`/`bound`/`grow`/`evict`/`exhausted` that resolution landed on. A `bound`/`grow`/`evict` result blocks the response on the full pane `launch()` (ack handshake + readiness poll, up to the 30s launch timeout) before it can return — so if you see an immediate, fast response for a message on a pool that's currently mid-launch (a pane in `launching` state in `/pool`), that response is for a message that hit the `exhausted` branch and was parked; it did **not** wait on, and says nothing about the outcome of, whatever launch is already in flight for that pool. Check `/pool`'s per-pane `state` (or `GET /api/v1/pool`), not just an inbound response's `ok`/`enqueued_count`, to know whether a pool is actually able to seat a conversation right now.

Similarly, `message_queue.status` for a message parked to `agent:<agent_id>__parked` is not a reliable signal of whether that conversation ever actually reached a live pane. The park-queue drain (`PoolManager.drainParked()`, on every sweep tick) retries still-exhausted messages by **re-enqueueing a fresh copy under a new message id** and `ack()`-ing the old row purely to satisfy `ack()`'s "must be `processing`" precondition — `ack()`'s only status transition is `processing → delivered`, there is no dedicated "requeued"/"superseded" status. So a parked message's original row will show `status: "delivered"` after its very first re-park cycle (at most one `sweepIntervalMs`, 60s by default, after it was first parked) even though the conversation is, in current fact, still sitting in the parked queue — just under a different row id. This is expected, not a bug: don't infer "this conversation's message actually reached its agent" from one row's `status` by id alone. To check whether a conversation is genuinely still parked, use `/pool`'s `parked:` count/oldest-age for that pool, or `PoolManager.parkedStatus()`, not a single historical message id.

## Attaching to a pane by hand

Every pane is a normal tmux window — attach the same way you would any tmux session:

```bash
tmux attach -t peggy-pool:1
```

(`<tmux_session>:<window>`, where the window name is the pane's 1-based index within the pool.) Typing into a live pane is fully supported — the bus only touches lease bookkeeping (timestamps, state, which conversation owns the pane) and never reads or depends on what's actually on screen. A human turn in a leased pane is indistinguishable, from the bus's point of view, from the same session responding to a bus-delivered message; it counts as pane activity like anything else. Detach with the usual `Ctrl-b d` — detaching doesn't affect the lease.

## Troubleshooting

| Symptom | Likely cause | What to check |
|---|---|---|
| A pane shows `dead` in `/pool` | Launch failed (ack handshake or readiness timeout). `reconcileLiveness()` revives a `dead` pane back to `free` on the next sweep tick (at most `sweepIntervalMs`, 60 seconds by default), so this should be transient — a pane stuck `dead` for longer than that points at a repeated launch failure, not a one-off. | Pane output around the failure (`tmux capture-pane -t <pane> -p`); whether `launch_ack_pattern` still matches the installed CLI's actual prompt wording (see below); bus-core logs for repeated `[pool:<id>] reconcileLiveness` lines against the same pane, which mean it's failing to launch again each time it's retried. |
| A lease seems stuck past when you'd expect it to idle out | `lease.idle_evict_ms` only makes a pane evictable by a new conversation — it doesn't release anything by itself. Proactive release only happens at `lease.hard_idle_ms`, on the sweep tick. | `/pool`'s `idle=` value against both `lease.idle_evict_ms` and `lease.hard_idle_ms`; whether any new conversation has actually tried to claim a pane, since eviction below the hard-idle ceiling is demand-driven, not time-driven. |
| `/pool` shows a growing `parked` count | Every pane is leased and none are evict-eligible yet. | Whether `panes`/`max_panes` matches expected concurrent-conversation load; whether existing conversations are idling out as expected; raise `growth: dynamic` and `max_panes` if the pool is legitimately undersized. |
| A pane never reaches `leased` | The launch or ack handshake is failing before readiness. | `claude_bin` is an absolute path to the real binary, not a shell alias; `launch_ack_pattern` against the pane's actual prompt text with `tmux capture-pane -t <pane> -p` — a CLI update can reword this prompt, which is exactly why the pattern is configurable rather than hardcoded. Two historical bugs on this exact failure mode, both fixed: (1) an old default `launch_ack_pattern` ("experimental") that never appeared anywhere in the real prompt, and (2) `ackHandshake` blindly sending `Enter` after a fixed delay and treating the pattern's *absence* from `capture-pane` as proof of dismissal — which is indistinguishable from "hasn't rendered yet" when the delay is shorter than the CLI's actual render time (measured ~1.0-1.6s). Either bug leaves the pane sitting at the confirmation screen indefinitely, `cc.ts` never starts, and the readiness poll (step 5) runs out its full 30s and marks the pane `dead`. The current implementation polls `capture-pane` for the pattern to actually appear before ever pressing `Enter` (see step 4 above), so if you still see this on a current build, `tmux capture-pane -t <pane> -p` on the stuck pane is the fastest way to confirm whether the configured `launch_ack_pattern` simply doesn't match your CLI's actual wording. |
| Every message on a `cc-pool` route lands on the same pane forever, regardless of conversation, and bus-core logs "No cc-pool instance configured for recipient" for every message after the first | Historical bug, fixed: `route-resolve.ts` (Stage 70) used to hand out a route target that shared object identity with `config.pipeline.routes[i].target` — the parsed-once config object, not a per-envelope copy. `pool-route-resolve.ts` (Stage 72) assigns the resolved pane id directly onto whatever object it's given, so the first message on the route permanently overwrote the static config's own `recipientId` from the pool's logical id (`agent:peggy`) to that first message's concrete pane (`agent:peggy-pool-1`). Every later message matching the same route rule then failed `pool-route-resolve`'s lookup (keyed by the now-missing logical id) and fell through untouched, pinned to the stale pane. `route-resolve.ts` now copies each route target (and each `also_notify` target) per envelope instead of sharing the config's reference, so this can't happen on a current build. If you see this symptom, check you're not running a build older than this fix. |
| The [live tool-call status stream](#live-tool-call-status-stream) goes completely silent for a pool pane — no typing indicator, no tool-status lines — while `cc-headless` sessions on the same deployment work fine | Historical bug, fixed 2026-09-20: `agentbus_tool_status_hook.sh`'s `UserPromptSubmit` regex required the `(topic: ...)` segment `cc.ts` added in commit `4340adf`. A pool pane's `cc.ts` subprocess only reads the format that existed when the pane was launched and never restarts on its own, so any pane already running from before that commit kept emitting the old, topic-less format indefinitely — against which the tightened regex matched zero messages, so its per-session state file stayed `[]` forever and `PostToolUse` had nothing to report to. The regex now treats `(topic: ...)` as optional (fallback `general`), so it matches both the old and new format regardless of which one a given pane's `cc.ts` happens to be running. | The pane's per-session state file, `/tmp/<STATE_DIR>/route-<claude_session_id>.json` — `[]` after a real inbound message means the `UserPromptSubmit` regex isn't matching that pane's actual prompt text; compare the pane's `cc.ts` process start time (`ps -o lstart -p <pid>`) against the last time the message format changed. |

**Journaling runner is a documented no-op.** Every `cc-pool` instance registers a `JournalingRunner` with `SessionTracker` at startup, but `dispatchJournaling()` only resolves sessions against configured `cc-headless` instances today, so a pool session's runner is never actually invoked. This has no user-visible effect — pool sessions don't need the silent journaling turn `cc-headless` relies on, since a live interactive session can update its own memory files directly — but the registration is currently inert, not a working safety net.

## Migrating from a hand-run interactive session

If you're currently running a single persistent tmux session holding one interactive `claude` process, kept alive by a hand-rolled watchdog script or a scheduled job that restarts it on crash, moving to `cc-pool` is a config change, not a rewrite:

1. Add a `cc-pool` block under `adapters`. Set `panes: 1` if you just want to preserve today's single-session behavior with bus-managed lifecycle in place of a hand-rolled one, or a higher number for real concurrency.
2. Point your existing routes at it: `target: { adapterId: cc-pool, recipientId: agent:<your agent_id> }`.
3. Set `claude_bin` to the absolute path of the CLI binary, not whatever your shell's `claude` resolves to. This is a hard requirement, validated at config load, because a tmux-launched pane doesn't source your interactive shell profile.

`cc-pool` takes over launching, resuming, and liveness-checking the pane from here — the same job a watchdog script does, generalized to N panes and made lease-aware.

Retiring your existing watchdog script and whatever schedules it (a launchd plist, a cron entry, a systemd timer) is a manual step you do yourself. AgentBus's code doesn't reach outside its own repository to modify, disable, or unload anything belonging to another project — running both at once against the same tmux session would fight over it, so unload the old job before pointing traffic at the new pool, not after.

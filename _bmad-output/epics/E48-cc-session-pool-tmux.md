# E48 — Interactive Claude Code Session Pool (tmux)

| Field | Value |
|---|---|
| Epic ID | E48 |
| Dependencies | E2 (`cc.ts` MCP adapter + poll loop), E5 (inbound pipeline / Stage 70 routing), E20 (long-lived sessions keyed on `conversation_id`), E23 (multi-instance adapter config pattern), E29 (tool-status stream), E30 (early delivery unblock) |
| Story Count | 10 |
| Estimated Complexity | L |

---

## Epic Summary

Today there are two ways to put a Claude Code agent behind a Telegram/email
channel, and each gives up something the other has:

- **`cc-headless`** (`src/adapters/cc-headless.ts`) spawns `claude -p` per
  message batch. It scales across conversations: sessions are keyed on
  `conversation_id` and resumed with `--resume`, so every Telegram topic and
  every email thread keeps its own Claude session, and N of them can be live at
  once. What it gives up is the interactive session — no TUI to watch, no
  human takeover at the keyboard, no `--dangerously-load-development-channels`
  behaviors that only the interactive client has.
- **`claude-code`** (`src/adapters/cc.ts`) is a persistent MCP server attached
  to one interactive Claude Code session, typically kept alive in tmux. It is
  the session you can actually look at and type into. What it gives up is
  concurrency: one process, one `AGENTBUS_AGENT_ID`, one session. Every topic
  and thread routed to it lands in the *same* conversation, so a second
  Telegram topic interleaves with the first instead of getting its own context.

E48 closes that gap: a **pool of tmux panes, each running one interactive
Claude Code session with its own `cc.ts` MCP process**, plus a bus-side
**pool manager** that leases a pane to a `conversation_id` on demand, launches
or resumes the right Claude session in it, and releases it when the
conversation goes idle. The result mirrors `cc-headless`'s per-conversation
session semantics while keeping every pane a real, attachable, interactive
session.

### The delivery path (settled)

**tmux `send-keys` is used only for pane lifecycle — never to deliver message
text.** Each pane runs its own `cc.ts` with a distinct `AGENTBUS_AGENT_ID`
(`cc-pool-1` … `cc-pool-N`), so message delivery uses the existing, unchanged
pending/ack/channel-notification path:

```
inbound → pipeline Stage 70 → target { adapterId: cc-pool, recipientId: agent:peggy }
        → CcPoolAdapter.send()
             ├── lease(conversation_id) → pane 2 (agent:cc-pool-2)
             ├── tmux: launch `claude --session-id <uuid>` or `claude --resume <uuid>`
             └── hand envelope to agent:cc-pool-2's queue
        → pane 2's cc.ts polls /api/v1/messages/pending?agent=cc-pool-2
        → notifications/claude/channel → the interactive session wakes
        → agent calls reply → normal outbound path back to Telegram/email
```

`send-keys` carries only: the launch command, `/clear`, and `C-c`/kill. No
user-authored text is ever typed into a terminal, so there is no shell-escaping
or prompt-injection surface, and `cc.ts`'s message formatting, attachment
handling, typing indicators, memory-context injection (Stage 85) and ack
accounting all work exactly as they do today, per pane, with zero changes.

### Why the session id is ours to choose

`claude --session-id <uuid>` accepts a caller-supplied session UUID, and
`claude --resume <uuid>` reopens it. The pool manager therefore **generates**
the UUID when it first binds a conversation to a pane and stores it on
`sessions.claude_session_id` — the same column, with the same meaning, that
`cc-headless` already populates from the `stream-json` `session_id` event. No
scraping of `~/.claude/projects/*/*.jsonl` is required, and a conversation's
Claude session survives being evicted from one pane and later resumed in a
different one.

---

## Prior Art: What Already Exists (and Where)

None of this lives in the agentbus repo — the only tmux mention in `src/` is
the `memory.on_session_close` config example, which just runs an
operator-supplied shell command. The real machinery is in the **agent's**
workspace, `~/workspace/peggy-claude-code/`, as shell scripts around a single
session:

| Artifact | What it does | Fate under E48 |
|---|---|---|
| `start.sh` | Kills and recreates one tmux session, sources `.envrc`, passes `TERM`/`COLORTERM`/`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` via `tmux new-session -e`, launches `claude --permission-mode auto --dangerously-load-development-channels server:agentbus`. | Superseded by S48.4 pane launch; its argv and `-e` env handling are the reference implementation. |
| `scripts/agentbus_session_watchdog.sh` | Every 300s via launchd (`com.peggy.session-watchdog.plist`): liveness-checks the pane, restarts a dead session with `--resume <newest jsonl>`, snapshots the pane with `capture-pane`, and POSTs a `channel: system` notice to `/api/v1/inbound` so the agent tells the operator it was restarted. Guards concurrency with a `mkdir` lock in `/tmp`. | Superseded by S48.7 (reconciliation + silent-pane reaper), which must carry over the restart-notification and pane-snapshot behavior. |
| `.mcp.json` | Wires the `agentbus` MCP server to `cc.ts` with a **hardcoded** `AGENTBUS_AGENT_ID: peggy`. | Blocker for pooling — see below. |
| `.claude/settings.json` | `defaultMode: auto`, `mcp__agentbus__*` + `Bash(*)`/`Read(*)`/… allowlist, `enableAllProjectMcpServers`, tool-status hooks on `UserPromptSubmit`/`PostToolUse`. | Reused as-is; this is why the "permission prompts block a pane" risk is largely already solved in practice. |

So: **the watchdog is built, for one session.** E48 does not start from zero —
it generalizes a proven single-session script into an N-pane, lease-aware
manager inside bus-core, and retires the launchd job.

### Four concrete gotchas the existing scripts already paid for

1. **`claude` is a shell function, not the binary.** The user's zsh profile
   defines `claude()` as a tmux wrapper (`tmux new-session -A -s "claude:$(basename $PWD)"`).
   Typing `claude …` into a pane would nest tmux. The watchdog works around it
   with `unset TMUX; command claude --resume …`. The pool must invoke the
   absolute `claude_bin` (or `command claude`) and must not rely on an
   interactive shell's PATH resolution.
2. **Env must be set at window-creation time**, via `tmux new-window -e KEY=VAL`,
   because the launch command is typed into an already-running shell. `TERM`
   and `COLORTERM` are load-bearing for the TUI.
3. **The launch argv is not what E48 first assumed.** It is
   `--permission-mode auto --dangerously-load-development-channels server:agentbus` —
   the positional `server:agentbus` selects which MCP server acts as the channel
   source. MCP servers come from the project's `.mcp.json` +
   `enableAllProjectMcpServers`, not from `--mcp-config`.
4. **`AGENTBUS_AGENT_ID` is baked into `.mcp.json`.** That file is per
   `working_dir`, and every pane in a pool shares one `working_dir` — so all N
   panes would claim the same agent id and fight over the same queue. Resolving
   this is a prerequisite, not a detail (S48.2a).

---

## Entry Criteria

- `cc.ts` runs as a stdio MCP server, reads `AGENTBUS_AGENT_ID` from the
  environment, polls `/api/v1/messages/pending?agent=<id>`, acks, and wakes the
  session via `notifications/claude/channel` (`src/adapters/cc.ts`).
- Stage 70 computes a stable `conversation_id` = sha256(sorted([contact_id,
  channel, topic])) and stores it on transcript rows
  (`src/pipeline/stages/route-resolve.ts`).
- `sessions` has `conversation_id` and `claude_session_id`; E20's long-lived
  session semantics (`ended_at` stays NULL) are in place.
- `getTelegramInstances`/`getEmailInstances`/`getCcHeadlessInstances` exist in
  `src/config/schema.ts` as the reference pattern for keyed multi-instance
  adapter config (E23).
- `claude --session-id <uuid>`, `--resume <uuid>`, `--mcp-config`,
  `--append-system-prompt-file` and `--add-dir` are available on the installed
  CLI (verified on the target machine).
- The single-session precedent in `~/workspace/peggy-claude-code/` (`start.sh`,
  `scripts/agentbus_session_watchdog.sh`, `.mcp.json`,
  `.claude/settings.json`) is working today — see Prior Art.

---

## Exit Criteria

- A configured pool of N tmux panes serves N concurrent conversations, each a
  real interactive Claude Code session with its own context.
- Two Telegram topics (or a Telegram topic and an email thread) routed to the
  same pooled agent land in **different** Claude sessions and never interleave —
  the behavior `cc-headless` has today and the single `claude-code` adapter
  does not.
- A conversation that goes idle, is evicted, and then receives a new message
  resumes its own Claude session (`--resume`) with full prior context, in
  whichever pane is free at the time.
- With every pane leased, a new conversation's messages are parked and
  delivered — not dropped, not dead-lettered — as soon as a pane frees or an
  idle lease is evicted.
- Bus-core restart reattaches to the existing tmux session and its live panes
  without killing in-flight interactive sessions; leases are recovered from the
  DB.
- The operator can attach to any pane by hand (`tmux attach -t …`), watch a
  turn, and type into it, without breaking the bus's accounting of that pane.
- `cc-headless` and the single-session `claude-code` adapter both keep working
  unchanged; E48 adds a third option and retires neither.
- The `com.peggy.session-watchdog` launchd job and `start.sh` are retired in
  favor of the in-bus manager, with no loss of behavior: liveness checking,
  resume-on-restart, pane snapshot on failure, and the `channel: system`
  restart notification all survive the move.

---

## Non-Goals

- Replacing `cc-headless`. Headless stays the right choice for high-volume,
  unattended personas; the pool is for when the interactive session matters.
- Multi-machine pools / remote tmux. Single host, single tmux server.
- Automatic pool sizing from load. `max_panes` is operator-set (see
  `growth: dynamic` in Config Shape for the on-demand-window variant, which is
  bounded by the same cap).
- Driving Claude's TUI by keystroke (menus, `/resume` picker, permission
  prompts). Anything the pool needs from the CLI must be expressible as a
  launch flag or a slash command typed as one line; permission prompts are
  configured away up front (see Risks).

---

## Config Shape

```yaml
adapters:
  cc-pool:
    peggy-pool:
      agent_id: peggy            # logical agent routes target
      tmux_session: peggy-pool   # tmux session holding the panes
      panes: 4                   # pool size (windows created at startup)
      growth: fixed              # fixed | dynamic (dynamic creates up to max_panes on demand)
      max_panes: 8               # only meaningful when growth: dynamic
      claude_bin: /Users/chrispatten/.local/bin/claude
      model: claude-sonnet-5
      working_dir: /Users/chrispatten/workspace/peggy-claude-code
      launch_args:               # appended verbatim to every launch/resume
        - --dangerously-load-development-channels
      poll_interval_ms: 1000     # passed through to each pane's cc.ts
      launch_ack_delay_ms: 500   # wait, then send Enter to ack the experimental MCP channel prompt
      launch_ack_max_attempts: 3 # re-send Enter if capture-pane still shows the prompt
      launch_ack_pattern: "experimental"  # prompt text to match; override if the CLI rewords it
      pane_env:                  # set via `tmux new-window -e` (TERM/COLORTERM always added)
        CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "50" 
      system_prompt: |           # rendered per-lease, same {{...}} vars as cc-headless
        You are Peggy, on {{channel}} for {{contact_id}}. ...
      lease:
        idle_evict_ms: 1800000   # 30m without activity → evictable
        hard_idle_ms: 21600000   # 6h → proactively released even if pool is idle
        park_timeout_ms: 300000  # a parked message waits this long before erroring back
      on_evict: clear            # clear | kill  (what happens to the pane on release)
```

Routing is unchanged in shape — the pool is just another adapter target:

```yaml
pipeline:
  routes:
    - match: { channel: telegram:peggy }
      target: { adapterId: cc-pool, recipientId: agent:peggy }
```

Like `telegram`/`email`/`cc-headless`, `cc-pool` accepts either a single-object
form or a named record, normalized by `getCcPoolInstances(config)`.

---

## Data Model

One new table, plus reuse of `sessions.claude_session_id`:

```sql
CREATE TABLE IF NOT EXISTS pool_leases (
  pool_id            TEXT NOT NULL,   -- cc-pool instance name
  pane_id            TEXT NOT NULL,   -- tmux target, e.g. "peggy-pool:2"
  agent_id           TEXT NOT NULL,   -- cc-pool-2 (the pane's AGENTBUS_AGENT_ID)
  conversation_id    TEXT,            -- NULL = pane is free
  claude_session_id  TEXT,            -- the UUID we generated / are resuming
  state              TEXT NOT NULL,   -- free | launching | leased | draining | dead
  leased_at          TEXT,
  last_activity_at   TEXT,
  PRIMARY KEY (pool_id, pane_id)
);
CREATE INDEX IF NOT EXISTS idx_pool_leases_conv ON pool_leases (pool_id, conversation_id);
```

`pool_leases` is the source of truth for "who holds which pane" and survives a
bus restart. The mapping `conversation_id → claude_session_id` continues to
live on `sessions` (E20), so an evicted conversation's session id is found the
same way `cc-headless` finds it.

---

## Constraint Discovered During Planning

`DeliveryService` does **not** retry today: `src/core/delivery.ts:98-103` has a
`retryable` branch whose body dead-letters instead of requeueing, with a TODO
noting retry-count tracking is missing. So the pool **cannot** express
"all panes busy" by returning `{ success: false, retryable: true }` — that
would dead-letter the user's message. S48.5 therefore gives `CcPoolAdapter` its
own park queue rather than leaning on delivery retry. Fixing the general retry
path is out of scope here; it is worth a maintenance-backlog item.

---

## Stories

### S48.1 — tmux Control Layer

**User story:** As the pool manager, I want a small, testable wrapper around
tmux, so that pane lifecycle is one seam I can fake in unit tests instead of
shelling out from five places.

**Acceptance criteria:**
- New `src/pool/tmux.ts` exporting a `TmuxController` with:
  `ensureSession(name, cwd)`, `listWindows(session)`, `createWindow(session,
  name, cwd)`, `killWindow(target)`, `sendKeys(target, keys, { literal })`,
  `sendCommand(target, line)` (types a line and presses Enter),
  `paneAlive(target)`, and `paneCommand(target)` (the running process name, for
  liveness).
- All tmux invocation goes through one injected `exec` function so tests drive
  it with a fake; no test spawns tmux.
- `sendCommand` refuses any argument containing a newline or control character,
  and quotes via an explicit allowlist — the pool only ever sends launch
  commands and slash commands, and this is the guardrail that keeps it that
  way.
- `ensureSession` is idempotent: creating a session that exists is a no-op
  (`tmux new-session -A -d`).
- `createWindow` accepts an env map and emits `-e KEY=VAL` per entry (tmux sets
  these at window creation; a command typed into a running shell cannot pick
  them up otherwise). `TERM=xterm-256color` and `COLORTERM=truecolor` are
  always included — the precedent in `start.sh` shows the TUI depends on them.
- `sendCommand` never relies on PATH resolution for `claude`: the caller passes
  an absolute `claude_bin`, and the emitted line is prefixed with `unset TMUX;`
  so a nested-tmux shell function cannot intercept it (the exact workaround
  `agentbus_session_watchdog.sh` uses today).
- `capturePane(target, lines)` wraps `tmux capture-pane -p`, for failure
  diagnostics and for the launch handshake in S48.4.
- Unit tests in `src/pool/tmux.test.ts` cover: idempotent session creation,
  window list parsing, `sendCommand` rejection of newline/control input, and
  `paneAlive` false for a missing target.

**Complexity:** S

---

### S48.2 — Config Schema: `adapters.cc-pool`

**User story:** As an operator, I want to declare a pool in `config.yaml` the
same way I declare a headless agent, so that there is one config idiom to
learn.

**Acceptance criteria:**
- `CcPoolAdapterSchema` in `src/config/schema.ts` per the Config Shape above,
  with defaults: `panes: 2`, `growth: 'fixed'`, `max_panes: panes`,
  `claude_bin: 'claude'`, `on_evict: 'clear'`, `lease.idle_evict_ms: 1_800_000`,
  `lease.hard_idle_ms: 21_600_000`, `lease.park_timeout_ms: 300_000`,
  `launch_ack_delay_ms: 500`, `launch_ack_max_attempts: 3`,
  `launch_ack_pattern: 'experimental'`.
- `claude_bin` must be an absolute path (validated) — a bare `claude` resolves
  to the operator's tmux-wrapping shell function (Prior Art gotcha 1).
- `AdaptersConfigSchema['cc-pool'] = z.union([CcPoolAdapterSchema,
  z.record(z.string(), CcPoolAdapterSchema)]).optional()`, mirroring E23.
- `getCcPoolInstances(config): CcPoolInstanceConfig[]` mirroring
  `getCcHeadlessInstances`: single-object form → one instance (`name: null`);
  named record → one per key, validated against `VALID_INSTANCE_NAME_RE`;
  duplicate `agent_id` or duplicate `tmux_session` across instances throws.
- Validation rejects `growth: fixed` with `max_panes < panes`, and `panes < 1`.
- `system_prompt` accepts the same `{{...}}` variables `prompt-renderer.ts`
  already supports for `cc-headless`.
- `config.yaml.example` gains a commented `cc-pool` block.
- Unit tests mirror the existing `getCcHeadlessInstances` block.

**Complexity:** S

---

### S48.2a — Per-Pane Agent Identity (`.mcp.json` Prerequisite)

**User story:** As the pool manager, I want each pane's `cc.ts` to claim a
different agent id while sharing one `working_dir`, so that four panes do not
all poll the same queue and steal each other's messages.

**Acceptance criteria:**
- The hardcoded `AGENTBUS_AGENT_ID` in the agent's project `.mcp.json` is the
  blocker (see Prior Art gotcha 4). Resolve it by **one** of these, decided by
  a short spike at the top of this story and recorded in the epic:
  - **(a) Inherit from the pane env** — drop `env.AGENTBUS_AGENT_ID` from
    `.mcp.json` so `cc.ts` picks it up from the pane's environment, set per
    window via `tmux new-window -e AGENTBUS_AGENT_ID=cc-pool-2`. Cleanest if
    Claude Code passes the parent environment through to stdio MCP subprocesses.
  - **(b) Per-pane `--mcp-config`** — generate one JSON file per pane with the
    pane's agent id, passed on the launch line. Must be verified to *merge*
    with (not replace) the project's other servers, e.g. `bmp`; do **not** use
    `--strict-mcp-config`, which would drop them.
  - **(c) Per-pane working dir** — one cloned/symlinked project dir per pane,
    each with its own `.mcp.json`. Most isolated, heaviest to maintain, and it
    splits the `~/.claude/projects/<slug>` transcript namespace per pane, which
    breaks resume-in-a-different-pane. Fallback only.
- Whichever wins, `cc.ts` itself is unchanged: it already reads
  `AGENTBUS_AGENT_ID` from the environment (`src/adapters/cc.ts:24`).
- The spike's finding is written into `docs/CC_POOL_ADAPTER.md`, including what
  an operator must change in their own `.mcp.json` to make a project poolable.
- Test: two panes launched from one `working_dir` poll two distinct
  `?agent=` URLs, asserted against the bus's request log.

**Complexity:** S (spike-gated)

---

### S48.3 — Lease Store and Allocation Policy

**User story:** As the bus, I want a durable record of which pane serves which
conversation, so that a restart, an eviction, or a crashed pane never loses
track of a live Claude session.

**Acceptance criteria:**
- Schema migration adds `pool_leases` per the Data Model section, registered in
  `src/db/schema.ts` alongside the existing migrations.
- New `src/pool/lease-store.ts` with pure-ish, unit-tested operations against
  an injected `Database`: `acquire(poolId, conversationId)`, `release(poolId,
  paneId)`, `touch(poolId, paneId)`, `findByConversation`, `findByAgent`,
  `list(poolId)`, `markDead(poolId, paneId)`.
- `acquire` resolution order:
  1. Existing lease for this `conversation_id` → return it (`touch`ed).
  2. A `free` pane → bind it.
  3. `growth: dynamic` and `count < max_panes` → signal `grow` to the caller.
  4. The least-recently-active `leased` pane whose `last_activity_at` is older
     than `idle_evict_ms` → signal `evict` with that pane.
  5. Otherwise → `exhausted`.
- `acquire` returns a discriminated result (`{ kind: 'bound' | 'grow' |
  'evict' | 'exhausted', … }`) rather than performing tmux work itself — the
  store stays I/O-free so allocation policy is unit-testable with a fixture DB.
- Allocation is serialized per pool (one in-flight `acquire` at a time) so two
  conversations cannot bind the same pane.
- Unit tests cover every branch of the order above, including: two
  conversations racing for one free pane; LRU selection picking the oldest idle
  lease and never a busy one; and an idle-but-below-threshold pool returning
  `exhausted`.

**Complexity:** M

---

### S48.4 — Pane Lifecycle: Launch, Resume, Clear, Kill

**User story:** As the pool manager, I want to put a specific Claude session
into a specific pane and know when it is ready, so that messages are never
handed to a pane that is still booting.

**Acceptance criteria:**
- New `src/pool/pane.ts` owning one pane's lifecycle, built on `TmuxController`.
- **Launch (new conversation):** generate a UUID; render the system prompt to a
  temp file (reusing `renderSystemPrompt`/`expandFileReferences` from
  `prompt-renderer.ts`); create the window with the pane's env (S48.1), then
  `sendCommand` the launch line, modeled on `start.sh`'s working invocation and
  on whichever agent-identity mechanism S48.2a picked:
  ```
  unset TMUX; <claude_bin> --session-id <uuid> \
      --permission-mode auto \
      --append-system-prompt-file <path> --model <model> \
      --dangerously-load-development-channels server:agentbus
  ```
  The positional `server:agentbus` selects the MCP server that acts as the
  channel source — it is required, not decorative. Run with the pane's
  `working_dir` as cwd.
- **Experimental-channel acknowledgment (required).** A freshly launched
  session prompts for confirmation that an experimental MCP channel interface
  is in use, and **blocks until it is acknowledged**. After sending the launch
  line, the pane waits `launch_ack_delay_ms` (config, default **500ms**) and
  sends a bare `Enter`. Specifics:
  - This applies to a fresh launch **and** to `--resume` — both start a new
    client process, so both see the prompt.
  - The Enter is sent as a key, not as a typed line, and is the only keystroke
    the pool ever sends that is not a command.
  - Because a blind 500ms is a race on a loaded machine, the acknowledgment is
    **verified, then retried**: after sending Enter, `capturePane` is checked
    for the prompt text; if it is still present, Enter is re-sent on a short
    backoff up to `launch_ack_max_attempts` (default 3) before the pane is
    marked `dead`. The 500ms default stays the fast path; the check is what
    makes it not flaky.
  - The prompt's matched text is a single config-overridable constant
    (`launch_ack_pattern`) so a wording change in a future CLI release is a
    config edit, not a code change.
  - An already-acknowledged pane must never receive a stray Enter — the
    handshake runs exactly once per launch, gated on the pane's `launching`
    state.
- **Resume (returning conversation):** identical, with `--resume <uuid>` in
  place of `--session-id <uuid>`, where the UUID comes from
  `sessions.claude_session_id` for that `conversation_id` — with the same
  acknowledgment handshake.
- **Readiness gate:** ordering is launch → acknowledge → ready. A pane is
  `leased` only once its `cc.ts` has registered —
  detected by that agent id appearing on the bus (a lightweight
  `/api/v1/adapters/…/status` or first successful poll), not by sleeping a
  fixed interval. Timeout → `markDead` + operator-visible error, and the
  allocation is retried on another pane.
- **Clear / kill on release:** `on_evict: clear` types `/clear`;
  `on_evict: kill` sends `C-c` then kills the window. Both leave the DB lease
  `free` (or the row removed, for a dynamically grown window).
- Temp prompt/MCP-config files are cleaned up on release, and on startup any
  stale ones from a previous run are swept.
- The generated session UUID is persisted to `sessions.claude_session_id` for
  the conversation **before** the first message is handed over, so a crash
  between launch and delivery still leaves a resumable session.
- Unit tests with a fake `TmuxController` assert: the exact argv for launch vs
  resume; that the acknowledgment Enter is sent once, after the configured
  delay, on both paths; that a pane still showing the prompt gets a retried
  Enter and is marked `dead` after `launch_ack_max_attempts`; that an
  acknowledged pane receives no further Enter; the readiness timeout path; and
  clear-vs-kill on release.

**Complexity:** M

---

### S48.5 — `CcPoolAdapter`: Routing, Hand-off, and the Park Queue

**User story:** As a user, I want my message to reach a pooled session whether
or not a pane happens to be free right now, so that a busy pool means a wait,
never a lost message.

**Acceptance criteria:**
- New `src/adapters/cc-pool.ts` implementing `AdapterInstance` with
  `id: 'cc-pool'` (or `cc-pool:<name>`), `capabilities.channels` covering the
  logical agent it fronts, and `handlesChannel` matching the route target.
- `send(envelope)`:
  1. Resolve `conversation_id` from the transcript row for `envelope.id`,
     falling back to the sha256 derivation — the same resolution
     `cc-headless.resolveConversationId` performs (factor it into a shared
     helper rather than copying it).
  2. `acquire` a lease; act on the result (`bound` / `grow` / `evict` /
     `exhausted`) via S48.4's pane lifecycle.
  3. On a bound pane, hand the envelope to that pane's agent queue —
     re-addressed to `agent:cc-pool-<n>` — so the pane's `cc.ts` picks it up on
     its next poll. Return `{ success: true }`.
- **Park queue:** on `exhausted`, the envelope goes onto a per-pool FIFO and
  `send` returns success (accepted, not delivered). The FIFO drains whenever a
  pane frees. Parked entries are persisted (a `parked` state on the message or
  a small side table) so a restart does not lose them.
- A parked envelope older than `lease.park_timeout_ms` is dead-lettered with a
  clear error and — where the source channel supports it — a user-visible
  "still waiting for a free session" notice is sent once per conversation, not
  per message.
- Ordering within a conversation is preserved: while a conversation has parked
  messages, later messages for it park behind them rather than jumping to a
  pane that frees mid-drain.
- The constraint in "Constraint Discovered During Planning" is honored: the
  adapter never returns `retryable: true` expecting delivery to retry.
- Unit tests: bound hand-off re-addresses the envelope; exhaustion parks and
  later drains in FIFO order; per-conversation ordering under interleaved
  arrivals; park timeout dead-letters exactly once and notifies once.

**Complexity:** L

---

### S48.6 — Outbound Integrity: A Pane Replies Only for Its Own Lease

**User story:** As a user, I want the answer that comes back to be from the
session that read my message, so that a pane recycled between conversations can
never deliver a stale or cross-wired reply.

**Acceptance criteria:**
- Confirm (with a test, not by inspection) that a pane's `reply` /
  `send_message` MCP calls already route back to the originating channel/topic
  unchanged, since the envelope carries `channel`, `sender` and `topic` and the
  pane serves one conversation at a time.
- Add a lease guard on the outbound path: an outbound envelope from
  `agent:cc-pool-<n>` whose target conversation does not match that pane's
  current lease is rejected and logged loudly, rather than delivered. This is
  the guard against a slow turn landing after an eviction.
- Draining, not slamming: a pane with an in-flight turn is marked `draining` on
  eviction and is not rebound until the turn completes or a grace period
  elapses; `/clear` is only sent once it is quiet.
- E29 tool-status and typing indicators continue to work per pane (they are
  driven by `cc.ts` and the source adapter, so this is a regression test, not
  new code).
- Tests: post-eviction late reply is rejected; a normal reply for the held
  lease is delivered; a pane mid-turn is not rebound.

**Complexity:** M

---

### S48.7 — Idle Expiry, Eviction, and Restart Recovery

**User story:** As an operator, I want the pool to look after itself, so that
panes are not held forever by conversations that ended an hour ago and a bus
restart does not orphan four live Claude sessions.

**Acceptance criteria:**
- A sweep timer releases leases past `lease.hard_idle_ms` even when nothing is
  waiting, applying `on_evict` and running the existing session-close hook
  (`memory.on_session_close`) so journaling parity with `cc-headless` is kept.
- Eviction under contention (S48.3 branch 4) runs the same release path, so an
  evicted conversation is journaled and cleanly resumable.
- On bus-core startup: `ensureSession`, reconcile `pool_leases` against the
  live tmux windows — panes that vanished are `markDead` and recreated; leases
  whose pane still runs the expected `claude` process are adopted as-is,
  **without** restarting those sessions.
- A pane whose `cc.ts` stops polling for a configurable interval is marked
  `dead`, its lease released (conversation keeps its `claude_session_id`, so it
  resumes elsewhere), and the window is recreated.
- `growth: dynamic` shrinks: windows created above `panes` are killed once free
  and idle past `hard_idle_ms`.
- **Watchdog parity.** The behaviors `agentbus_session_watchdog.sh` provides
  today are carried over, not dropped:
  - Liveness is checked the way the script does it — the window exists *and*
    its `pane_pid` has a live `claude` child — not merely "the window exists".
  - On a detected death, `capture-pane -p | tail -15` is captured into the log
    before the pane is recreated, so a crash leaves evidence.
  - A restart posts a `channel: system` notice to `/api/v1/inbound` (same shape
    the script posts) so the agent tells the operator it was restarted rather
    than recovering silently. Rate-limited so a flapping pane cannot spam.
  - Single-flight: only one reconciliation pass runs at a time per pool (the
    script's `/tmp` `mkdir` lock becomes an in-process guard).
- `~/workspace/peggy-claude-code/scripts/agentbus_session_watchdog.sh` and its
  `com.peggy.session-watchdog` launchd job (`StartInterval 300`) are unloaded
  and removed as part of this story — running both would fight over the same
  tmux session. `start.sh` is likewise retired or reduced to a thin
  "start bus-core" wrapper. Documented in `docs/CC_POOL_ADAPTER.md` as a
  migration step.
- Tests: hard-idle release fires the session-close hook; startup reconciliation
  adopts a live pane and recreates a vanished one; a silent pane is reaped and
  its conversation rebinds to another pane with `--resume`; a recreated pane
  emits exactly one `channel: system` notice and logs a pane snapshot.

**Complexity:** M

---

### S48.8 — Observability: `/pool` and `GET /api/v1/pool`

**User story:** As an operator, I want to see at a glance which pane is serving
whom and what is waiting, so that "why is Peggy slow" is a one-command answer.

**Acceptance criteria:**
- `GET /api/v1/pool` (optionally `?pool=<name>`) returns, per pane: `pane_id`,
  `agent_id`, `state`, `conversation_id`, the human-readable channel/topic and
  contact behind it, `claude_session_id`, `leased_at`, `last_activity_at`, plus
  pool-level `parked` depth and oldest parked age.
- A `/pool` slash command renders that as a compact table to the requesting
  channel, following the existing `src/commands/handlers.ts` conventions.
- `/status` gains a one-line pool summary (`pool peggy-pool: 3/4 leased, 1
  parked`) next to the existing adapter lines.
- Pane state transitions are logged with a stable `[cc-pool:<name>]` prefix.
- Tests cover the endpoint shape and the command renderer with a fixture lease
  table.

**Complexity:** S

---

### S48.9 — Documentation

**User story:** As an operator choosing between three Claude Code adapters, I
want one page that tells me which to use and how to run the pool, so that the
decision is not archaeology across three docs.

**Acceptance criteria:**
- New `docs/CC_POOL_ADAPTER.md`: architecture (with the delivery-path diagram
  from this epic), full config reference, lease lifecycle and state machine,
  eviction/parking behavior, `/pool` and the HTTP endpoint, attaching to a pane
  by hand, and troubleshooting (dead pane, stuck lease, exhausted pool).
- A short "choosing an adapter" comparison table — `claude-code` vs
  `cc-headless` vs `cc-pool` — added to `docs/CC_ADAPTER.md` and linked from
  `docs/README.md`.
- `docs/CC_HEADLESS_ADAPTER.md` and `docs/TELEGRAM_ADAPTER.md` cross-link the
  new page where they discuss session keying and `on_session_close`.
- `CHANGELOG.md` `[Unreleased]` gains an **Added** bullet.
- Per CLAUDE.md, docs land in the same change as the implementation, not after.

**Complexity:** S

---

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| **Permission prompts block a pane.** An interactive session that stops to ask about a tool call hangs its lease with no way out. | Largely solved already: the agent's `.claude/settings.json` sets `defaultMode: auto` with an `mcp__agentbus__*` + `Bash(*)`/`Read(*)`/… allowlist, and `start.sh` passes `--permission-mode auto`. S48.4 carries both forward; the readiness gate plus the silent-pane reaper (S48.7) catch anything that still stalls. |
| **The experimental-channel prompt is a blind-timing race.** A 500ms delay before the acknowledging Enter is a guess, and a missed Enter leaves the pane wedged before `cc.ts` ever registers. | S48.4 verifies the acknowledgment with `capture-pane` and retries rather than firing and forgetting; the matched prompt text is config, so a CLI rewording is an operator edit. The readiness gate means a wedged pane fails loudly and is reallocated instead of silently holding a lease. |
| **Two managers, one tmux session.** The launchd watchdog would fight the in-bus manager over the same session during rollout. | S48.7 explicitly unloads `com.peggy.session-watchdog` and retires `start.sh` as part of the change, and the migration step is documented. |
| **Interactive login expiry.** Panes need a logged-in CLI; a token expiry takes down the whole pool at once. | Pane health includes a liveness probe; a pane that fails to become ready surfaces on `/pool` and `/status` rather than silently parking messages. Documented in troubleshooting. |
| **Operator types into a leased pane.** A human takeover mid-turn is a feature, but the bus must not miscount it. | Leases are touched by bus activity only; human input is harmless (it is the same session). S48.6's draining logic covers the in-flight case. Documented explicitly as supported. |
| **Startup cost per lease.** Launching an interactive session per new conversation is slower than `claude -p`. | Panes are pre-created and kept warm; only the `claude` launch is per-lease. If measured latency is unacceptable, a follow-up can keep a spare session pre-launched with `--session-id` reserved. |
| **`--session-id` / `--resume` behavior drift.** The pool leans on caller-supplied session UUIDs in the interactive client. | S48.4 lands behind a small verification step against the installed CLI before the rest of the epic builds on it; the fallback (discovering the id from `~/.claude/projects/<slug>/*.jsonl`) is documented but not implemented unless needed. |
| **tmux server restart / machine reboot.** All panes die at once. | S48.7's startup reconciliation recreates panes; conversations keep their `claude_session_id` and resume on next message. |

---

## Sequencing

S48.1 and S48.2 are independent and can go in parallel. **S48.2a is the first
real gate** — if per-pane agent identity cannot be solved cleanly, the whole
pool shape changes, so run its spike before committing to S48.3+. S48.3 depends
on S48.2 (config) only for pool identity. S48.4 depends on S48.1 + S48.2a +
S48.3. S48.5 depends
on S48.4 and is the first point at which the feature is end-to-end usable.
S48.6–S48.8 harden and expose it. S48.9 lands with whichever stories touch
behavior, per the docs-in-the-same-change rule.

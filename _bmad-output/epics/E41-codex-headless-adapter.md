# E41 — `codex-headless` Adapter (OpenAI Codex CLI)

| Field | Value |
|---|---|
| Epic ID | E41 |
| Dependencies | E19/E19.1 (headless adapter), E20 (journaling + long-lived sessions), E23 (multi-instance), E29 (tool-call status), E30 (decoupled memory logging), E39 (cost command) |
| Story Count | 9 |
| Estimated Complexity | L |

---

## Epic Summary

`cc-headless` (`src/adapters/cc-headless.ts`) is AgentBus's per-request agent
runtime: poll the bus for an agent's pending messages, serialize per contact,
spawn `claude -p` with an assembled memory context, let the agent deliver via
the `reply`/`send_message` MCP tools, resume the same CLI session on the next
turn, and sweep memory files on pause. Every bus-side feature built since —
long-lived sessions, journaling, `/clear`, `/stop`, `/cost`, the Telegram
tool-call status stream — is wired to that one runtime.

E41 adds a **second backend for the same runtime shape**: `codex-headless`,
driving OpenAI's `codex exec` instead of `claude -p`. An agent configured on
`codex-headless` is indistinguishable to users and to the rest of the bus —
same tools, same memory files, same journaling, same slash commands — but
runs on a different vendor's CLI and a different credential.

Two things motivate it beyond "more models":

1. **Vendor independence for a live persona.** `config.yaml`'s `cc-headless`
   block is commented out as of 2026-09-11 because Chris's Anthropic API key
   was rotated, and Peggy has been running on the older `claude-code`
   tmux/MCP path since. A second headless backend means a key rotation or an
   API outage is a config swap, not a fallback to a tmux pane.
2. **`codex exec` is genuinely close to feature parity** — non-interactive,
   JSONL event stream, resumable threads, stdio MCP servers, project-doc
   auto-loading, per-turn token accounting, images. The gaps are real but
   bounded, and every one has a workable mapping (see the parity table).

Per the architecture decision for this epic, `codex-headless` ships as a
**standalone sibling** of `cc-headless` — a parallel adapter that duplicates
the runtime skeleton and swaps the spawn + stream parsing. Extracting a shared
`HeadlessAgentBase` + per-CLI driver from both is deliberately deferred to a
follow-up epic, once both backends have run in production.

---

## `claude -p` vs `codex exec` — parity analysis

Researched against `openai/codex@main` (`codex-rs/exec/src/cli.rs`,
`exec_events.rs`, `event_processor_with_jsonl_output.rs`,
`codex-rs/config/src/config_toml.rs`, `codex-rs/utils/cli/src/*`).

| Concern | `claude -p` (cc-headless today) | `codex exec` | Mapping |
|---|---|---|---|
| Invocation | `claude -p "<prompt>" --output-format stream-json --verbose` | `codex exec --json [PROMPT\|-]` | Direct. Prompt read from **stdin** (`-`) instead of argv — see S41.3. |
| Event stream | JSONL: `assistant` / `result` events, Anthropic message shape | JSONL: `ThreadEvent` tagged union — `thread.started`, `turn.started`, `item.started`, `item.updated`, `item.completed`, `turn.completed`, `turn.failed`, `error` | New parser module (S41.4). |
| Resume id | `session_id` on init + `result` | `thread.started` → `thread_id` (emitted on new **and** resumed threads) | Stored in the same `sessions.claude_session_id` column (S41.6). |
| Resume | `--resume <id>` | `codex exec resume <SESSION_ID>` (subcommand) | Direct. |
| Working dir | `cwd` of the spawn | `--cd <DIR>` (plus `cwd`) | Direct. |
| Project context | `CLAUDE.md` hierarchy auto-loaded | `AGENTS.md` auto-loaded (`project_doc_fallback_filenames` also matches `CLAUDE.md`), capped by `project_doc_max_bytes` | Direct — agent's static persona goes in `working_dir/AGENTS.md`. |
| System prompt | `--system-prompt-file` (replaces default) | **No flag.** `model_instructions_file` in config replaces built-in instructions but is explicitly discouraged by OpenAI; `developer_instructions` injects a developer message | **Neither.** Render the same `system_prompt` template and **prepend it to the prompt** each turn (S41.3). |
| MCP servers | `--mcp-config <file>` | `[mcp_servers.<id>]` in `config.toml` under `$CODEX_HOME` (or `-c` overrides) | Per-agent `CODEX_HOME` with a managed `config.toml` (S41.3). |
| MCP tool identity in stream | `tool_use` block, name `mcp__agentbus__reply` | `item` type `mcp_tool_call` with separate `server` + `tool` fields | Delivery detection matches `server === "agentbus" && tool ∈ {reply, send_message}`. |
| Tool permissions | `--allowedTools all` | `--sandbox {read-only,workspace-write,danger-full-access}` + `approval_policy` | Config keys `sandbox_mode` / `approval_policy` (S41.2). `approval_policy` must be `never`: in exec mode an approval request is a hard failure. |
| Model | `--model <m>` | `-m/--model <m>` | Direct; `headless_model_overrides` (E39/migration 015) applies unchanged. |
| Reasoning effort | n/a | `model_reasoning_effort` (`minimal`…`xhigh`) | New optional config key. |
| Final text | `result` event's `result` | last `item.completed` with `agent_message` (also `-o/--output-last-message`) | Stdout-fallback delivery uses the last `agent_message` text. |
| Errors | `result.is_error`, non-zero exit, stderr | `turn.failed` `{error:{message}}`, top-level `error` event, non-zero exit, stderr | Same `error_reply` / `error_passthrough` handling. |
| Token/cost | `result.total_cost_usd` + `usage` **per turn** | `turn.completed.usage` — **cumulative thread totals**, no USD | Delta accounting + optional price table (S41.7). ⚠️ See note. |
| Auto-compaction | on by default (`autoCompactEnabled`) | `model_auto_compact_token_limit` | Leave at default; same "nothing else bounds a long thread" reasoning as E20. |
| Auto-memory double-load | suppressed via `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` | no equivalent native feature | Nothing to suppress. |
| Images | `[Image: <path>]` lines in the prompt | `-i/--image <FILE>,...` (native attachment) | S41.8 attaches natively. |
| Session persistence | `~/.claude` | `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` + `session_index.jsonl` | Per-agent `CODEX_HOME`. |
| Interrupt | SIGKILL the child (`/stop`) | same | Direct. |
| Git repo requirement | none | **refuses to run outside a git repo** unless `--skip-git-repo-check` | Config key, defaulting to `true`. |

### ⚠️ Cumulative usage is the one real trap

`TurnCompletedEvent.usage` is built by `usage_from_last_total()`, which reads
`ThreadTokenUsage.total` — the **running total for the whole thread**, not the
delta for the turn that just ended. Inserting it into `turn_costs` per turn the
way E39 does for Claude would over-count quadratically on a long resumed
conversation (turn 10 of a thread re-reports turns 1–9). S41.7 records the
**delta** against a per-session snapshot instead.

---

## Entry Criteria

- E23 complete: `getCcHeadlessInstances`, per-instance `HeadlessInstance` state,
  `sessions.agent_id` (migration 011), agent-keyed journaling/`/clear` routing.
- E30 complete: journaling debounce + ceiling, early queue advance on delivery,
  early `claude_session_id` persistence.
- E39 complete: `turn_costs` (migration 014), `/cost`, `headless_model_overrides`
  (migration 015).
- A working `codex` binary on the host. **Currently broken:**
  `/opt/homebrew/bin/codex` is a dangling symlink into
  `/opt/homebrew/Caskroom/codex/0.110.0/` (payload missing); `~/.codex/version.json`
  reports `latest_version: 0.114.0`. Reinstall/upgrade before S41.1.
- An authenticated `~/.codex/auth.json` (ChatGPT login) or a `CODEX_API_KEY`.

---

## Exit Criteria

- `config.adapters.codex-headless` accepts the same two forms as `cc-headless`
  (single object, or named record of instances), validated the same way.
- A Telegram (or email) message routed to `{ adapterId: codex-headless,
  recipientId: agent:<id> }` produces a reply delivered through the `reply`
  MCP tool, with the agent's `MEMORY.md` + daily journals in context.
- The next message on that conversation resumes the same codex thread
  (`codex exec resume <thread_id>`), verified by the agent recalling
  something said in the previous turn that is not in its memory files.
- A paused conversation fires a silent journaling turn on the codex instance's
  own `journaling` config and updates its memory files, delivering nothing.
- `/clear`, `/stop`, and `/cost` all work against a codex-backed agent,
  routed via `sessions.agent_id` exactly as they are for `cc-headless`.
- The Telegram tool-call status stream shows codex's shell/file/MCP/web-search
  activity in the same live-draft format as Claude's.
- `turn_costs` rows for a codex agent carry **per-turn deltas** (never
  cumulative totals), with `cost_usd` computed when a price table is
  configured for the model and `0` otherwise; `/cost` shows both USD and
  token totals.
- Two instances sharing an `agent_id` across `cc-headless` and
  `codex-headless` is rejected at startup, not silently raced.
- `cc-headless` behavior is byte-for-byte unchanged; no regression to the
  `claude-code` MCP path.
- `docs/CODEX_HEADLESS_ADAPTER.md` exists and documents every divergence from
  `docs/CC_HEADLESS_ADAPTER.md` rather than restating it.

---

## Config Shape

```yaml
adapters:
  codex-headless:
    peggy-codex:
      agent_id: peggy-codex
      poll_interval_ms: 1000

      codex_bin: codex
      # Per-agent $CODEX_HOME: sessions, history, and the agentbus-managed
      # config.toml live here, isolated from the operator's own ~/.codex.
      codex_home: /Users/chrispatten/workspace/peggy-codex/.codex
      # Symlinked into codex_home/auth.json on start if absent (unset = skip).
      codex_auth_source: ~/.codex/auth.json

      working_dir: /Users/chrispatten/workspace/peggy-codex
      model: gpt-5.4
      reasoning_effort: medium          # minimal|low|medium|high|xhigh (optional)

      sandbox_mode: workspace-write     # read-only | workspace-write | danger-full-access
      approval_policy: never            # exec mode: an approval request is a hard failure
      skip_git_repo_check: true         # codex refuses to run outside a git repo otherwise
      add_dir: []                       # extra writable roots (--add-dir)
      config_overrides:                 # extra `-c key=value` pairs, passed verbatim
        hide_agent_reasoning: true

      error_reply: "Sorry — I hit an error processing that. Please try again."
      error_passthrough: false

      system_prompt: |
        You are Peggy, on {{channel}} for {{contact_id}}. Today is {{date}}.

        Deliver every user-facing message by calling the `reply` tool with the
        message id shown as [id:<id>]. Do not put your answer only in plain text.

        Once you have replied, stop — a separate process journals memory later.

        @persona.md

        {{memories}}

      # Identical shape and semantics to cc-headless (E20/E30).
      memory:
        dir: memory
        index_file: MEMORY.md
        daily_subdir: daily
        journal_lookback_days: 3
      journaling:
        enabled: true
        threshold_ms: { telegram: 300000, email: 86400000, default: 300000 }
        ceiling_ms: 1800000
        prompt: |
          Our conversation has paused. Review it and update your memory files...

      # Optional — USD per 1M tokens. Omit to record tokens with cost_usd = 0.
      pricing:
        gpt-5.4: { input: 1.25, cached_input: 0.125, output: 10.00 }
```

Routing is unchanged in shape:

```yaml
  - match: { channel: telegram:peggy }
    target: { adapterId: codex-headless, recipientId: agent:peggy-codex }
```

---

## Stories

### S41.1 — Spike: Pin and Verify the `codex exec` Contract

**User story:** As the implementer, I want the exact flag ordering, event
shapes, and resume behavior confirmed against a real `codex` binary before
building on them, so that the adapter is not written against a `main`-branch
schema the installed CLI does not emit.

**Acceptance criteria:**
- `codex` is reinstalled/upgraded on the host (the `0.110.0` cask symlink is
  currently dangling) and `codex --version` is recorded in the epic notes.
- A throwaway script in `scripts/` (or a documented shell transcript) confirms,
  against that binary:
  - `codex exec --json` emits `thread.started` with a `thread_id` as its first
    event, and `turn.completed` with a `usage` object.
  - `codex exec resume <thread_id> --json` re-emits `thread.started` with the
    **same** `thread_id` and continues the prior context.
  - The prompt can be supplied on **stdin** (`codex exec … -`) rather than
    argv, and a prompt beginning with `-` is not misparsed.
  - Root-level `--cd` / `--sandbox` / `-m` are inherited by the `resume`
    subcommand (`inherit_exec_root_options`), or the correct ordering is
    recorded if not.
  - A `[mcp_servers.agentbus]` stdio entry in `$CODEX_HOME/config.toml` is
    picked up, and a tool call surfaces as an `item.started`/`item.completed`
    with `type: "mcp_tool_call"`, `server: "agentbus"`, `tool: "<name>"`, and
    populated `arguments`.
  - `turn.completed.usage` is confirmed **cumulative across the thread** (run
    two turns on one thread and compare) — the assumption S41.7 is built on.
  - Behavior when `approval_policy` is not `never` (expected: hard failure).
- A minimum supported `codex` version is recorded, and the adapter logs a
  warning (not a failure) on an unrecognized event `type` so a CLI upgrade
  degrades rather than crashes.
- Any divergence found is written back into the parity table above before
  S41.3/S41.4 begin.

**Complexity:** S

---

### S41.2 — Config Schema: `adapters.codex-headless`

**User story:** As an operator, I want to declare codex-backed agents in
`config.yaml` the same way I declare Claude-backed ones, so that switching an
agent between backends is a config edit.

**Acceptance criteria:**
- `CodexHeadlessAdapterSchema` in `src/config/schema.ts`, reusing
  `CcHeadlessAdapterSchema`'s `agent_id`, `poll_interval_ms`, `system_prompt`,
  `working_dir`, `error_reply`, `error_passthrough`, `memory`, and
  `journaling` fragments verbatim (extract the shared sub-schemas rather than
  copy-pasting the zod definitions), plus codex-specific keys:
  `codex_bin` (default `codex`), `codex_home` (optional),
  `codex_auth_source` (optional), `model` (optional),
  `reasoning_effort` (optional enum), `sandbox_mode`
  (default `workspace-write`), `approval_policy` (default `never`),
  `skip_git_repo_check` (default `true`), `add_dir` (default `[]`),
  `config_overrides` (default `{}`), `pricing` (optional record).
- `AdaptersConfigSchema` gains
  `'codex-headless': z.union([CodexHeadlessAdapterSchema, z.record(z.string(), CodexHeadlessAdapterSchema)]).optional()`.
- `getCodexHeadlessInstances(config)` mirrors `getCcHeadlessInstances` exactly:
  single-object vs named-record discrimination, `^[a-z0-9_-]+$` instance names,
  duplicate-`agent_id` throw, `name: null` for the legacy form.
- A new `assertUniqueHeadlessAgentIds(config)` throws at startup when an
  `agent_id` appears in **both** `cc-headless` and `codex-headless` — two
  pollers on the same `/api/v1/messages/pending?agent=<id>` queue race the ack
  and silently drop whichever one loses (the exact failure documented in
  `config.yaml:20-27`).
- `approval_policy` values other than `never` are accepted but logged as a
  warning at startup, since exec mode hard-fails on an approval request.
- Unit tests in `src/config/schema.test.ts` mirroring the
  `getCcHeadlessInstances` block, plus the cross-adapter duplicate case.

**Complexity:** S

---

### S41.3 — `CODEX_HOME` Provisioning and Spawn Invocation

**User story:** As the bus, I want each codex agent to run against its own
isolated Codex home and a deterministic command line, so that agent sessions
never mix with the operator's interactive ones and no per-turn config write
can race a concurrent turn.

**Acceptance criteria:**
- On `start()`, each instance ensures `codex_home` exists and writes a
  **managed** `config.toml` there **once** (not per turn), containing:
  ```toml
  # Managed by AgentBus (codex-headless) — edits will be overwritten.
  approval_policy = "never"
  sandbox_mode = "workspace-write"
  model = "gpt-5.4"                 # only when configured
  model_reasoning_effort = "medium" # only when configured

  [mcp_servers.agentbus]
  command = "npx"
  args = ["tsx", "<abs>/src/adapters/cc.ts"]
  env = { AGENTBUS_TOOLS_ONLY = "true", AGENTBUS_CONFIG = "<abs>/config.yaml" }
  ```
  Writing once at start (rather than per spawn, as `cc-headless` does for its
  temp MCP/system-prompt files) is load-bearing: instances run turns for
  different contacts concurrently, and a shared `config.toml` rewritten mid-run
  would race.
- If `<codex_home>/auth.json` is absent and `codex_auth_source` resolves to an
  existing file, a symlink is created; if neither is present, the instance logs
  an actionable error at start and does not poll (rather than failing every
  turn at spawn time).
- New-thread spawn:
  ```
  CODEX_HOME=<codex_home> codex exec \
    --json \
    --cd <working_dir> \
    --sandbox <sandbox_mode> \
    -c approval_policy="never" \
    [-m <model>] [-c model_reasoning_effort="<effort>"] \
    [--skip-git-repo-check] [--add-dir <dir>]... [-c <k>=<v>]... \
    -
  ```
  Resume spawn is the same flags with `resume <thread_id>` before the trailing
  `-` (exact ordering per S41.1's finding).
- **The prompt is written to the child's stdin, not argv** (`stdio: ['pipe',
  'pipe', 'pipe']`, write + `end()`). The assembled prompt carries the full
  memory block (`MEMORY.md` + N days of journal) and can be hundreds of KB;
  argv would risk `E2BIG` and complicates prompts beginning with `-`.
- **Persona injection:** `renderSystemPrompt` + `expandFileReferences`
  (`prompt-renderer.ts`) are reused unchanged with the same `PromptContext`
  (`contact_id`, `channel`, `date`, `memories`, `agent_id`,
  `session_summary: ''`). The rendered block is **prepended to the prompt**,
  separated by a delimiter, ahead of
  `formatMessagesForSampling(envelopes, { includeMemoryContext: false })` —
  codex has no `--system-prompt-file` equivalent, `model_instructions_file`
  would replace Codex's own agent instructions (explicitly discouraged
  upstream), and `developer_instructions` would mean a large multi-line value
  on argv with unverified re-application on resume.
- The static half of the persona lives in `working_dir/AGENTS.md`, auto-loaded
  by codex the way `CLAUDE.md` is by `claude -p`; documented in S41.9.
- `resolveModelOverride()` (E39, migration 015) is called on every spawn and
  takes precedence over `config.yaml`'s `model`, identically to `cc-headless`.
- Unit tests: argument-vector construction for new vs resume, with/without
  model, override applied, `add_dir`/`config_overrides` passthrough,
  `skip_git_repo_check` toggle; managed-`config.toml` rendering; auth-symlink
  creation and the missing-auth refusal.

**Complexity:** M

---

### S41.4 — JSONL Event-Stream Parser

**User story:** As the adapter, I want codex's `ThreadEvent` stream reduced to
the same `SpawnResult` shape `cc-headless` already produces, so that the
runtime, delivery, and error paths stay structurally identical between
backends.

**Acceptance criteria:**
- A new pure module (`src/adapters/codex-events.ts`) exporting typed
  interpretations of one parsed JSONL line, unit-testable with plain object
  fixtures and no process spawning (the `extractToolCalls` /
  `selectReportableCalls` precedent in `cc-headless.ts`):
  - `thread.started` → `threadId` (fires the early `onSessionId` callback).
  - `item.started` / `item.completed` with `item.type === "mcp_tool_call"`,
    `server === "agentbus"`, `tool ∈ {reply, send_message}` → **delivery**;
    the first such `item.started` fires `onDelivered` (E30's early
    queue-advance signal — earliest available, matching `tool_use`'s timing
    on the Claude side).
  - Every other `item.started` → a reportable tool call for the E29 status
    stream, suppressed once delivery has been seen (`selectReportableCalls`'s
    exact semantics, reimplemented over codex item types).
  - `item.completed` with `agent_message` → captured as the running "last
    agent message"; the final one is the stdout-fallback text.
  - `item.completed` with `reasoning` → ignored entirely (never delivered,
    never a status line).
  - `turn.completed` → `usage` (cumulative; see S41.7).
  - `turn.failed` → `error.message`; top-level `error` → `message`.
  - Unknown `type` or unknown `item.type` → ignored with a one-time
    `console.warn` per unknown key, never a throw (CLI-upgrade tolerance).
- A `SpawnResult`-equivalent with the same fields `cc-headless` uses
  (`claudeSessionId` → `threadId`, `resultText`, `deliveredViaTool`, `error`,
  `stoppedByUser`) plus `usage` in place of `totalCostUsd`.
- Non-JSON lines on stdout are ignored, as in `cc-headless`.
- Unit tests cover: a full happy-path stream; delivery via `reply` mid-stream;
  a turn that delivers nothing (fallback text); `turn.failed`; a top-level
  `error`; an unknown event type; and suppression of post-delivery tool calls.

**Complexity:** M

---

### S41.5 — Adapter Runtime: Poll, Queue, Turn, Delivery, `/stop`

**User story:** As an operator, I want a codex agent to behave exactly like a
headless Claude agent at runtime, so that nothing downstream of the spawn has
to know which CLI answered.

**Acceptance criteria:**
- `src/adapters/codex-headless.ts` implements `CodexHeadlessInstance` with the
  same structure and semantics as `HeadlessInstance`:
  - Poll `/api/v1/messages/pending?agent=<agent_id>&limit=20`, ack upfront,
    group by sender, enqueue per contact.
  - Per-contact promise-chain serialization; per-instance state only (no
    module-level mutable singletons), per E23's S23.2 rule.
  - Typing indicator on batch start (`POST /api/v1/adapters/<channel>/typing`),
    skipped for email channels.
  - `resolveConversationId` / `getActiveSession` / thread-id persistence
    (S41.6).
  - Agent owns delivery via `reply`/`send_message`; adapter posts the final
    `agent_message` text only when no delivery tool fired; `error_reply` /
    `error_passthrough` (500-char truncation) on failure with no delivery.
  - **E30 early queue advance**: the task resolves at `onDelivered`, with
    fallback delivery, error handling, and final thread-id persistence running
    in the background.
  - `stopTurn(contactId)` SIGKILLs the child and marks `stoppedByUser`, with
    the same `normalizeContactId` tracking-key normalization and the same
    "don't send an error reply for a user-initiated kill" rule.
- `startCodexHeadless(db)` returns `Map<'agent:<id>', HeadlessHandle>` and
  `stopCodexHeadless()` stops all instances — same signatures as
  `startHeadless`/`stopHeadless` so `index.ts` wiring is a second loop, not a
  new mechanism.
- The `HeadlessHandle` interface is reused as-is (`runJournalingTurn`,
  `journalResumeId`, `stopTurn`) so `SessionTracker` and `HeadlessControl`
  need no new types.
- Tests: mocked-fetch poll/ack/group behavior; per-contact serialization;
  delivery-tool vs fallback vs error-reply branches; `/stop` path; two
  instances not sharing queues.

**Complexity:** L

---

### S41.6 — Session Continuity, Journaling Dispatch, and `/clear` Routing

**User story:** As the bus, I want a codex-backed conversation to be
long-lived, journaled on pause by its own agent, and clearable — using the
same session machinery Claude agents use, without the session tracker
learning about a second adapter.

**Acceptance criteria:**
- The codex `thread_id` is stored in the existing
  `sessions.claude_session_id` column. That column is already the bus-wide
  "this session is headless-managed and long-lived" marker — Stage 80's
  no-teardown branch, `SessionTracker.closeIdleSessions`' `IS NULL` filter,
  and `dispatchJournaling`'s candidate query all key on it. Reusing it means
  zero changes to any of them. A rename to `headless_session_id` is cosmetic
  and is deferred to the shared-base extraction epic; the misleading name is
  called out in a code comment and in the docs.
- `transcript-log.ts:59`'s `routes.find((r) => r.adapterId === 'cc-headless')`
  becomes a lookup against a shared
  `HEADLESS_ADAPTER_IDS = new Set(['cc-headless', 'codex-headless'])`, so
  `sessions.agent_id` is stamped for codex-routed batches too. Without this,
  `/clear`, `/stop`, `/cost`, and journaling all fall back to the
  sole-instance heuristic and misroute in a mixed deployment.
- `SessionTracker.registerJournalingRunner(agentId, runner)` gains a third
  argument carrying that agent's resolved `journaling` config, stored
  alongside the runner. `dispatchJournaling()` reads thresholds from that map
  and **no longer calls `getCcHeadlessInstances(this.config)`** — the tracker
  stops needing to know which adapters exist. The sole-instance fallback for
  `agent_id IS NULL` sessions becomes "the only registered runner", across
  both adapters. E33's `warnIfJournalingBlocked` still fires, with its
  "no instances configured" reason folded into "no journaling runners
  registered".
- `runJournalingTurn(conversationId)` spawns `codex exec resume <thread_id>`
  with the instance's `journaling.prompt`, in no-deliver mode (no typing
  indicator, no fallback delivery), serialized through the same per-contact
  queue. A session with no `thread_id` yet resolves `{ skipped: true }`.
- `journalResumeId({ threadId, contactId, channel })` backs `/clear` the same
  way, registered into the existing `headlessControl.journalResumeId` map.
- `/stop` and `/cost` need no code change beyond `index.ts` populating their
  maps (S41.9) — both already resolve the agent from `sessions.agent_id`.
- Tests: a codex session extends rather than closes on an idle gap; journaling
  fires on the codex instance's own threshold and ceiling; a mixed deployment
  (one `cc-headless` + one `codex-headless`) journals each session with its
  own runner; `/clear` on a codex session invokes the codex instance's
  `journalResumeId`; an orphaned `agent_id` is skipped, not thrown.

**Complexity:** M

---

### S41.7 — Usage and Cost: Per-Turn Deltas, Optional USD

**User story:** As the operator, I want `/cost` to stay meaningful for a codex
agent, so that I can see what an agent is consuming even though Codex reports
no dollar figure.

**Acceptance criteria:**
- **Delta accounting.** `turn.completed.usage` is cumulative for the thread
  (`usage_from_last_total()` reads `ThreadTokenUsage.total`). The adapter
  keeps a per-session snapshot of the last cumulative reading and records
  `new − previous` for each turn. A negative or missing delta (new thread,
  compaction, restart with no snapshot) falls back to recording the raw
  reading for the first turn and `0` for a non-positive delta, never a
  negative row.
- Migration `016_turn_costs_usage.sql`:
  - `ALTER TABLE turn_costs ADD COLUMN cached_input_tokens INTEGER`
  - `ALTER TABLE turn_costs ADD COLUMN reasoning_output_tokens INTEGER`
  - `ALTER TABLE turn_costs ADD COLUMN model TEXT`
  - `ALTER TABLE sessions ADD COLUMN headless_usage_total TEXT`
    (JSON snapshot of the last cumulative usage for this thread)
  All nullable; `cc-headless` writes them as `NULL` and is otherwise
  untouched.
- **USD when priced.** When `pricing[<resolved model>]` is configured,
  `cost_usd = (input−cached)/1e6·input_rate + cached/1e6·cached_input_rate +
  output/1e6·output_rate` over the **delta**; otherwise `cost_usd = 0`
  (the column stays `NOT NULL`). A configured model with no matching price
  entry logs a one-time warning per model.
- `/cost` (`src/commands/cost.ts`) gains a token line alongside the USD lines,
  e.g. `Today: $1.84 · 412k in / 38k out`, rendered for Claude-backed agents
  too (whose token columns are already populated by E39).
- `scripts/backfill_turn_costs.ts` is left alone (Claude-only by construction);
  note this in the script header.
- Tests: cumulative→delta conversion across three turns; first turn with no
  snapshot; negative-delta clamp; priced vs unpriced model; `/cost` output
  formatting with and without USD.

**Complexity:** M

---

### S41.8 — Tool-Call Status Lines and Image Attachments

**User story:** As a user on Telegram, I want to see what the codex agent is
doing while it works, and I want it to actually see the photos I send.

**Acceptance criteria:**
- `src/adapters/codex-tool-summary.ts` — a codex analog of
  `formatToolCallSummary`, mapping a `ThreadItem` to a status line with the
  same truncation (`MAX_FIELD_LENGTH = 200`) and backtick-escaping (E34) rules:
  - `command_execution` → `🐚 \`<command>\``
  - `file_change` → `✏️ Editing \`<path>\`` (or `✏️ Editing N files` for >1)
  - `mcp_tool_call` → `⚙️ Running \`<server>__<tool>\``
  - `web_search` → `🔎 Searching: \`<query>\``
  - `todo_list`, `reasoning`, `agent_message` → no status line
  - anything else → `⚙️ Running \`<type>\``
  Never throws, never returns an empty string.
- Status lines are pushed to `POST /api/v1/adapters/<channel>/tool-status`
  with the `topic` passthrough (E28), skipped for email channels — identical
  to `cc-headless.reportToolCall`.
- **Images:** attachments with `type === 'image'` on the batch's envelopes are
  passed natively via `-i <path>,<path>` rather than only as
  `[Image: <path>]` prompt lines, which is all `formatMessagesForSampling`
  produces today. Non-image files keep the `[File: …]` line (codex can read
  them from disk). The `[Image: …]` line is retained alongside `-i` so the
  agent knows which message each image belongs to.
- Tests: one case per item type including the unknown-type fallback and a
  backtick-bearing command; image-flag construction for zero, one, and
  several attachments across a multi-message batch.

**Complexity:** M

---

### S41.9 — Wiring, Config, and Docs

**User story:** As an operator, I want starting bus-core to bring up codex
agents automatically and a document that tells me how they differ, so that
adding one is a config change plus a read.

**Acceptance criteria:**
- `src/index.ts` gains a second loop over `startCodexHeadless(db)`, registering
  each handle into `sessionTracker.registerJournalingRunner`,
  `headlessControl.journalResumeId`, and `headlessControl.stopTurn` — the same
  three registrations the `cc-headless` loop already does, before
  `sessionTracker.start()`. `shutdown()` calls `stopCodexHeadless()`.
- `assertUniqueHeadlessAgentIds(config)` (S41.2) runs before either loop, so a
  cross-adapter `agent_id` collision fails startup loudly instead of producing
  two pollers racing one queue.
- `config.yaml.example` gains a fully commented `codex-headless` block
  (single-instance and named-record forms) plus a note on provisioning
  `codex_home` and `AGENTS.md`.
- `docs/CODEX_HEADLESS_ADAPTER.md`: the parity table above, the
  `CODEX_HOME`/auth provisioning steps, the prompt-prepend persona model and
  why `model_instructions_file` is not used, the event-stream mapping, the
  cumulative-usage delta rule, the `sessions.claude_session_id` reuse, and the
  sandbox/approval posture. Everything shared with `cc-headless` (journaling,
  `/clear`, per-contact queue, memory assembly) is **linked**, not restated.
- `docs/CC_HEADLESS_ADAPTER.md` gains a short "see also" pointer and a note
  that `claude_session_id` now also holds codex thread ids.
- `docs/SLASH_COMMANDS.md` (`/cost`, `/clear`, `/stop`) and `docs/MEMORY_MODEL.md`
  updated where they say "cc-headless" but mean "any headless agent".
- `CHANGELOG.md` `[Unreleased]`: **Added** — `codex-headless` adapter (run
  agents on OpenAI's Codex CLI alongside Claude-backed ones); **Added** —
  token totals in `/cost`; **Changed** — journaling config is now registered
  per agent rather than read from `cc-headless` config at dispatch time.
- `sprint-status.yaml` gains the E41 block.
- Pre-merge version proposal: **MINOR** (new adapter, new config surface,
  additive migration; no breaking change to existing config).

**Complexity:** M

---

## Notes

- **Why standalone rather than a shared base.** Extracting a
  `HeadlessAgentBase` + per-CLI driver from `cc-headless.ts` first would mean
  refactoring the runtime that the operator's live persona depends on, against
  a second backend that has never run in production. Shipping
  `codex-headless.ts` as a parallel implementation keeps the blast radius at
  "new file + three touched shared modules," and the duplication becomes the
  specification for the extraction epic that follows. The shared modules
  deliberately touched here (`prompt-renderer.ts`, `memory-context.ts`,
  `formatMessagesForSampling`, `SessionTracker`, `HeadlessControl`,
  `transcript-log`) are exactly the seams that extraction will use.

- **The ack race is the sharpest operational footgun.** `startHeadless()`
  starts every configured instance regardless of `pipeline.routes`, which
  already caused silent message loss once (documented in `config.yaml:20-27`
  when a disabled-by-routes `cc-headless` instance kept winning ack races
  against the MCP adapter). A second headless adapter doubles the surface, so
  S41.2's cross-adapter `agent_id` uniqueness check is a correctness
  requirement, not hygiene. Migrating an agent between backends means
  **commenting out the old instance**, not just repointing `routes:`.

- **Sandbox posture is a real decision, not a default to skim.**
  `workspace-write` lets the agent write its own `memory/` tree under
  `working_dir` and blocks network access for model-run shell commands; MCP
  servers are spawned by Codex itself and are not sandboxed, so the `agentbus`
  tools work regardless. An agent that needs to shell out to the network needs
  `sandbox_workspace_write.network_access` or `danger-full-access` — call that
  out in the docs rather than letting operators discover it as a mysterious
  tool failure.

- **`approval_policy` must be `never`.** In exec mode an approval request is
  terminal, not a prompt. Any posture that can produce one turns into a
  `turn.failed` and an `error_reply` to the user.

- **Codex refuses to run outside a git repo.** `working_dir` for a chat persona
  is often not a repo; `skip_git_repo_check` defaults to `true` for that
  reason. Operators who do want the guard can turn it off.

- **Cross-contact isolation is identical.** Each conversation gets its own
  codex thread keyed on `conversation_id`, so the same accepted tradeoff
  documented for `cc-headless` applies unchanged — a codex agent cannot
  reference another contact's conversation.

- **Out of scope.** Extracting the shared headless base (follow-up epic);
  retiring the `claude-code` tmux/MCP adapter; `--output-schema` structured
  output; `codex exec fork`; Codex's `collab` multi-agent tools; and any
  automatic failover between backends when one vendor's credential breaks —
  E41 makes that a config swap, not an automatic one.

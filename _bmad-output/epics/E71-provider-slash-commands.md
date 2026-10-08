# E71 — Forward Slash Commands to the Provider

| Field | Value |
|---|---|
| Epic ID | E71 |
| Dependencies | E5 (Stage 40 slash-command detect), E19/E23 (`cc-headless`), E48 (`cc-pool`, tmux control), `/pane` (pane PNG rendering), `/rc` (prior art for typing into a pane) |
| Story Count | 6 |
| Estimated Complexity | M |
| Status | Implemented on `feat/e58-provider-slash-commands` and merged to main in PR #8 — awaiting live check |
| Numbering | Merged as "E58"; renumbered E71 when reconciled with `dev`, where E58 is Parallel cc-headless Conversations. The branch name keeps `e58`. |

---

## Terminology

A **provider** is the service that runs an agent's turns: `cc-pool`,
`cc-headless`, and (once E41 lands) `codex-headless`. A provider is the
`adapterId` of a route's primary target. Channel adapters (Telegram, email,
Siri) are not providers.

New code and docs use "provider". Existing identifiers are not renamed.

---

## Epic Summary

Today a slash command the bus doesn't define gets `Unknown command: /x` and
never reaches the agent. The provider's own commands (`/compact`, `/context`,
`/model`, skills, plugin commands) can't be used from chat. `/rc` is a
one-off workaround for a single command.

E71 forwards those commands to the provider that serves the conversation:

| Input | Result |
|---|---|
| `/status` | Bus command, as today. Bus commands always win. |
| `/compact` | Bus doesn't define it, so it is forwarded to the provider. |
| `//clear` | Forwarded to the provider even though the bus defines `/clear`. |
| `/Users/x/y` | Not a command name. `Unknown command`, as today. |

Forwarding happens only when the provider supports it. Otherwise the sender
gets a one-line reason.

---

## Verified Provider Behavior

Checked against the installed `claude` CLI on 2026-10-03:

- `claude -p "/context" --output-format stream-json --verbose` runs the
  command without a model call (`num_turns: 0`, `total_cost_usd: 0`) and
  returns its output as the `result` event's text.
- The `system`/`init` event carries `slash_commands`: the names available in
  that session, without a leading slash, including skills and plugin
  commands (`finance:reconciliation`). Interactive-only commands such as
  `remote-control` are absent.
- A `cc-pool` pane receives inbound messages as MCP channel notifications,
  which Claude Code does not parse as slash commands. A command must be
  typed into the pane, as `/rc` does.

---

## Design

### Parsing (Stage 40)

`//name args` parses as command `name` with `forceProvider: true`. The
payload and transcript keep the original body.

### Dispatch (`processInbound`)

A command is forwarded when it is forced, or when the registry has no
command by that name. The name must match `^[A-Za-z][\w:-]*$`.

The target is the first route (`routes[0]`). `also_notify` targets never
receive a forwarded command. The registry holds one `ProviderCommandForwarder`
per provider `adapterId`; the forwarder returns one of:

| Result | Meaning |
|---|---|
| `reply` | Handled inline. Send this response to the sender. |
| `enqueue` | Enqueue the command for the provider, marked with `metadata.provider_command`. |
| `unsupported` | Not forwarded. Send the reason to the sender. |

With no forwarder for the route's provider, an unforced command keeps
today's `Unknown command` reply; a forced one says the provider doesn't
accept commands. A forwarded command respects `/pause`: it is refused with a
reply, not dropped silently.

### Providers

| Provider | Mechanism | Reply | "Supported" check |
|---|---|---|---|
| `cc-pool` | Type the line into the conversation's leased pane (`tmux send-keys`), wait, snapshot the pane. | PNG of the pane (text fallback) | Pane must be `leased` and not showing a permission dialog. The pane itself reports an unknown name. |
| `cc-headless` | Queue the command; the instance runs `claude -p "/name args" --resume <id>` as its own turn, serialized with the contact's other turns. | The command's `result` text, or `Ran /name.` | Name must be in the last `slash_commands` list the instance saw. Unknown list (no turn since startup) passes. |
| `claude-code` (MCP) | None. | — | Unsupported: the bus can't type into that session. |
| `codex-headless` | None until E41. `codex exec` has no slash commands. | — | Unsupported. |

---

## Entry Criteria

- `/rc` and `/pane` merged (v0.14.0).

## Exit Criteria

- `/keys Escape` presses Escape in the conversation's pool pane and replies
  with a snapshot.
- `/compact` from a `cc-pool` conversation types into the leased pane and
  replies with a snapshot.
- `/context` from a `cc-headless` conversation replies with the command's
  output and writes no model turn.
- `//clear` reaches the provider; `/clear` still runs the bus command.
- A provider that can't take the command yields a reason, never silence.
- `docs/SLASH_COMMANDS.md`, `docs/CC_POOL_ADAPTER.md`,
  `docs/CC_HEADLESS_ADAPTER.md`, and `CHANGELOG.md` updated.

---

## Stories

### S71.1 — Parse `//name` and add the forwarder seam

- `SlashCommandInfo.forceProvider`; Stage 40 strips one extra leading slash.
- `ProviderCommandForwarder` types in `src/commands/provider-forward.ts`.
- `CommandRegistry.registerProvider(adapterId, forwarder)` and
  `provider(adapterId)`.

**Acceptance:** `//clear x` parses to `{ name: 'clear', forceProvider: true }`;
`//` alone and `// text` stay plain text.

### S71.2 — Dispatch in `processInbound`

- Forward on forced or unregistered names; keep `Unknown command` for
  malformed names and unforwardable unforced commands.
- `enqueue` result enqueues only `routes[0]` with
  `metadata.provider_command = { command, args_raw }` and body `/name args`.
- Pause check for forwarded commands.
- `/help` mentions forwarding and `//`.

**Acceptance:** integration tests in `src/http/inbound-commands.test.ts`
cover reply, enqueue, unsupported, forced, paused, and no-forwarder paths.

### S71.3 — `cc-pool` forwarder

- `createPoolForwarder` in `src/commands/provider-forward.ts`: resolve the
  lease from the route's pane agent id, refuse a non-`leased` pane, a
  multi-line command, or a pane at a permission dialog, then `sendCommand`,
  wait `settleMs`, and reply with a `/pane`-style image.

**Acceptance:** unit tests with a fake `TmuxExec`; no keys sent on any
refusal path.

### S71.4 — `cc-headless` forwarder and turn

- `HeadlessInstance` records `slash_commands` from each `init` event and
  exposes it through `HeadlessHandle.slashCommands()` and
  `HeadlessControl.slashCommands`.
- The poll loop runs a `provider_command` envelope as its own turn with the
  raw `/name args` prompt: no message formatting, no memory-block prefix.
- `compact` and `clear` wipe the session's context-block ledger.

**Acceptance:** unit tests for batch splitting and for the forwarder's
known/unknown/absent-list decisions.

### S71.5 — Wiring and docs

- Register both forwarders in `src/index.ts`.
- Docs and `CHANGELOG.md`.

### S71.6 — `/keys`: send keystrokes to a tmux-backed provider

- `createKeysCommand` in `src/commands/keys.ts`: `/keys [@n] <key> [key...]`
  runs `tmux send-keys -t <pane> -- <keys>` against the caller's leased pane
  or pane `n`, then replies with a pane snapshot.
- Reaches any pane that isn't `dead`, including one at a permission dialog.
  That is the use case, and the reason it is a separate command from
  forwarding, which refuses such a pane.
- At most 20 keys; no control characters; double quotes group text.

**Acceptance:** unit tests with a fake `TmuxExec`; no keys sent on any
refusal path; a clear reply when no `cc-pool` is configured.

---

## Risks

- **Typing into a busy pane.** Claude Code queues input typed mid-turn, so
  the command runs when the turn ends and the snapshot may show the turn
  still in progress. Documented; `/pane` shows the later state.
- **`//clear` on a pool pane.** It resets Claude's session under the bus
  without closing the bus session row. The bus `/clear` remains the supported
  way to start fresh. Documented.
- **Typos reach the provider.** `/stauts` is forwarded instead of answered by
  the bus. Accepted with the fallthrough syntax; the provider reports it.

---

## Notes

- A scheduled message whose body is a slash command is forwarded the same
  way, because the scheduler calls `processInbound` with the same registry.
- E41 should register a `codex-headless` forwarder that returns
  `unsupported`, or implement one if `codex exec` gains commands.

# E54 — `/model` Slash Command

| Field | Value |
|---|---|
| Epic ID | E54 |
| Dependencies | E53 (`model_overrides`, `resolveModel`, relaunch-on-mismatch in cc-pool), E6 (slash commands), E36 (follow-up capture), E74 (Telegram choice buttons, `choice_prompts`) |
| Story Count | 5 |
| Estimated Complexity | M |
| Status | Implemented on `feat/e54-model-on-e74` (rebuilt on E74) — awaiting live check |

---

## Epic Summary

Changing an agent's model today means `curl -X POST /api/v1/model-overrides`
or editing `config.yaml` and restarting. E54 adds `/model`, a bus command
that changes the model of the agent the current chat talks to, from any
channel.

```
/model                 → current model + picker (buttons on Telegram, numbered list elsewhere)
/model opus            → latest Opus (resolves to a concrete ID, e.g. claude-opus-5-5)
/model haiku 4.5       → a specific version
/model claude-sonnet-5-5 → an exact model ID
/model reset           → remove the override; back to the config model
/model list            → all known models, grouped by family
```

It writes the agent-scoped row in `model_overrides` (E53). cc-headless picks
it up on its next spawn. For cc-pool, a chat that holds a live pane between
turns has the pane switched at once (typing `/model` into the session and
answering Claude Code's `Switch model?` prompt, else E53's relaunch run
immediately), and that
prompt is answered with the key `1` (see S54.5).
Otherwise E53 applies it on the next message.

---

## Prior Art

- `src/adapters/model-override-loader.ts` — `resolveModel()`,
  `setModelOverride()`, `deleteModelOverride()`. One row per agent, plus
  one global row.
- `src/commands/registry.ts` — `CommandDefinition`, `CommandResponse`
  (`body`, `metadata`), `registerFollowUp` / `consumeFollowUp` (E36).
- `src/http/api.ts` — slash dispatch (~L429) and follow-up dispatch
  (~L383). `sendCommandResponse(deps, result, name, body, extraMetadata)`
  already forwards extra metadata onto the response envelope. The pipeline
  has already run by dispatch time, so `result.routes` holds the route
  targets for this message.
- E74 (`src/choices/*`, `choice_prompts`, `processChoiceTap` in
  `src/adapters/telegram.ts`) — single-choice Telegram buttons with
  `choice:<uuid>:<index>` callbacks, a 24-hour TTL, an atomic answer and an
  addressee check. S54.2 extends it instead of adding a second button system.
- `src/pool/pane.ts` / `pool-manager.ts` — `launch()` with `--model`,
  `handleReuse()` relaunch, `tmux.sendKeys`.
- `src/commands/cost.ts` `resolveAgentId()` — the session-based agent
  lookup. `/model` uses routes instead, because a pool agent's sessions
  carry pane ids and a chat may have no session yet.

## Non-Goals

- Global overrides from chat. `/model` changes only the agent this chat
  routes to. Global overrides stay HTTP/MCP-only.
- Per-conversation models. The override is per agent. Peggy's Telegram
  `/model` changes Peggy on every channel (schedule models still win,
  per E53).
- Live model discovery from the Anthropic API. The catalog is static plus
  config; no API key is needed (the operator's key is rotated).
- The single-session `claude-code` adapter. `/model` replies that it can't
  change that agent.

---

## Design

### Model catalog and name resolution (S54.1)

`src/models/catalog.ts` holds the built-in catalog:

```ts
export interface ModelEntry {
  id: string;          // 'claude-opus-5-5' — what --model receives
  family: string;      // 'opus' | 'sonnet' | 'haiku' | 'fable' (lower-case)
  version: string;     // '5.5' — dotted, compared numerically segment by segment
  label: string;       // 'Opus 5.5'
  deprecated?: boolean; // hidden from picker/list, still resolvable by exact ID or version
}
export const BUILTIN_MODELS: ModelEntry[];

export function loadCatalog(config: AppConfig): ModelEntry[];     // builtin ∪ config.models.catalog; config wins on same id
export type ModelQueryResult =
  | { ok: true; entry: ModelEntry; exact: boolean }               // exact = user named an exact id
  | { ok: false; reason: 'unknown-family' | 'unknown-version' | 'empty'; message: string; suggestions: ModelEntry[] };
export function resolveModelQuery(query: string, catalog: ModelEntry[]): ModelQueryResult;
```

Built-in entries (ids checked against the current model family): the live
`claude-fable-5-1`, `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`,
plus earlier releases kept resolvable but deprecated: `claude-opus-5`,
`claude-sonnet-5`, `claude-sonnet-4-6`, `claude-haiku-4-5`.

**Specificity rules.** Input is trimmed and lower-cased. Spaces, `-`, and
`_` between family and version are equivalent, and a leading `claude`
is optional. So `haiku 4.5`, `haiku-4.5`, `haiku4.5`, and
`claude haiku 4.5` are the same query.

1. **Exact ID.** Input equals a catalog `id` → that entry, `exact: true`.
2. **Family only** (`haiku`) → the non-deprecated entry of that family with
   the highest version.
3. **Family + version prefix** (`opus 5`, `haiku 4.5`) → the highest
   version whose segments start with the given ones. `opus 5` matches
   5.5 and 5.0, and picks 5.5. `opus 5.5` matches only 5.5. Deprecated
   entries are eligible here.
4. **Unknown family** → `unknown-family`, suggestions = latest of each
   family.
5. **Known family, no version match** → `unknown-version`, message
   `No Haiku 5.1 — known: 5.5`, suggestions = that family's entries.
6. **Escape hatch.** A string starting with `claude-` that isn't in the
   catalog → accepted as `{ ok: true, exact: true }` with a synthetic
   entry (`family: 'unknown'`, `label: id`). This allows a model released
   after the catalog was last updated. `/model` warns that it isn't in the
   catalog.

**Stored value.** The concrete `id` is stored, never the alias.
`/model haiku` stays on the Haiku it resolved to until someone runs
`/model` again. A catalog update never silently relaunches a pane.

**Config.** Optional section `models.catalog: ModelEntry[]` in the Zod
schema (`src/config/schema.ts`) lets the operator add a new model without
a code change. `config.yaml.example` gets a commented example.

### Interactive choices (S54.2)

A generic mechanism any command can use, built on E74 rather than a separate
button system.

```ts
// src/commands/registry.ts
export interface CommandChoice {
  label: string;   // button text / list line, at most 64 characters
  args: string;    // what gets appended to the command, e.g. 'claude-opus-5-5'
}
export interface CommandResponse {
  body?: string;
  metadata?: Record<string, unknown>;
  choices?: CommandChoice[];  // rendered as a picker; at most 8 (E74 limit)
}
```

**E74 extension (minimal).** `choice_prompts` gets a nullable `commands` JSON
column (migration 039): an array parallel to `labels`, each entry a
single-line slash command or null. `ChoiceStore.create` takes it, and
`metadata.choice_commands` carries it from a response envelope to the
adapter (validated by `choiceCommandsSchema`: `/...`, at most 200
characters, one line, array of at most 8). `processChoiceTap` is unchanged
through its checks (allow-list, addressee, expiry, atomic answer); then, if
the tapped index has a command, that command is the injected inbound
message body instead of `[tapped] <label>`. It goes through the normal
inbound pipeline, so command routing, dedup and transcript logging apply as
for a typed command. No synthetic Telegram update, no bypass of state checks.

**Delivery.** `deliverCommandResponse` in `src/http/api.ts` serves both
dispatch paths (slash and follow-up). It clips to E74's limits as a backstop.

- *Telegram channels*: `sendCommandResponse` with
  `metadata.choices` = labels and `metadata.choice_commands` =
  `/<command> <args>` per choice. The Telegram adapter renders and stores the
  prompt exactly as for agent `choices`.
- *Every other channel*: a numbered list is appended to the body and
  `registerChoiceFollowUp(channel, sender, command, choices, ttl)` registers
  a 10-minute capture. A bare reply `2` (or text matching a choice's `args`
  or `label`, case-insensitive) runs `/<command> <args>` of that choice.
  Anything else falls through as a normal message, per E36 semantics. The
  registry's single follow-up slot now holds a `PendingFollowUp` (`validate`
  or `choice` variant); latest registration still wins.

### `/model` command (S54.3)

`src/commands/model.ts`, `createModelCommand(deps)`, registered in
`src/index.ts` next to `/pool`.

```ts
export interface ModelCommandDeps {
  db: Database.Database;                    // writes go through setModelOverride/deleteModelOverride
  poolManagers?: Map<string, PoolManager>;  // to apply a change to the chat's live pane (S54.5)
}
```

**Target agent.** The command needs the route targets for this message.
Add `routes?: Array<{ adapterId: string; recipientId: string }>` to
`SlashCommandContext`, filled from `result.routes` on both dispatch
paths. The target is the first route whose `adapterId` is `cc-pool` or
`cc-headless`. If none: reply `This chat isn't routed to an agent whose
model I can change.` (covers `claude-code` and unrouted channels).

**Subcommands** (args joined with spaces, so `haiku 4.5` is one query):

| Input | Behavior |
|---|---|
| (none) | `Peggy is on Sonnet 5.5 (claude-sonnet-5-5) — from config.` then a picker: the latest non-deprecated entries by family (capped to 7, labels at most 64 characters), current marked `(current)`, plus `Reset to config (<config model>)` when an override exists, so the picker never exceeds E74's 8 buttons. |
| `list` | Text list of all catalog entries grouped by family, deprecated tagged, current marked. No picker. |
| `reset` / `default` | `deleteModelOverride(agent)`. Reply with the model it falls back to and its source. |
| anything else | `resolveModelQuery`. On success: `setModelOverride(db, entry.id, agent)`. Reply `Peggy → Opus 5.5 (claude-opus-5-5).` plus how it was applied (`Relaunched peggy-pool:1 on the new model.` / `Takes effect on the next message.` / a plain failure note). Say `already on` if unchanged. On failure: the error message plus a picker of `suggestions`. |

**"Current" and "source".** Current comes from `resolveModel({ db,
agentId, configModel })`, with no schedule model: `/model` reports the
agent's conversational model. Source wording: `agent-override` → "set
with /model", `global-override` → "global override", `config` → "from
config", `cli-default` → "CLI default — no model configured". If the
current value is an alias such as config's `sonnet`, show it as-is.
Don't guess which ID it maps to.

**Schedule caveat.** When the agent has active schedules with their own
`model`, append one line: `Note: 2 scheduled jobs set their own model and
aren't affected.`

**Telegram autocomplete** comes from `manifests()` automatically.

### cc-pool: applying the change and the model prompt (S54.5)

How the pool applies a model: `--model` is read only when the Claude process
starts (`--session-id`) or resumes (`--resume`), so a *relaunch*
(`handleReuse()`: `Ctrl-C` and kill, then `--resume` on the same Claude
session with the new `--model`) is the baseline, normally at the
conversation's next message.

Real prompt (screenshot from a live pane, typing `/model opus` mid-session):

```
Switch model?
Your next response will be slower and use more tokens
This conversation is cached for the current model. Switching to Opus 5.5
means the full history gets re-read.
❯ 1. Yes, switch to Opus 5.5
  2. No, go back
```

- `PoolManager.applyModelNow(conversationId, ctx)` runs for the chat's
  `leased` pane when the resolved model differs. It claims the row (`leased`
  -> `launching`), then **prefers keeping the session**:
  `PaneLifecycle.switchModelInPane()` types `/model <id>` (`tmux.sendCommand`),
  waits up to 10 s for the prompt, sends `1` via `tmux.sendKeys` only while
  `model_confirm_pattern` (default `switch model\?`) and a numbered
  `1. Yes, switch to <model>` line both match, retries up to
  `launch_ack_max_attempts`, then waits up to 5 s for the idle composer.
  Only the key `1` is ever sent. On any failure it falls back to the relaunch.
- A pane with a turn in flight is never typed into: `deferred`, applied at the
  next message. `no-pane`, `unchanged`, `switched` (`in-pane` or `relaunch`)
  and `failed` (with the error) complete the outcomes; `/model` maps each to a
  plain reply and the override is saved in every case. cc-headless never
  reaches this path.
- A relaunch with `--model` is not expected to show this prompt: it is a
  warning about the running session's cache, and a relaunch starts a new
  process. Only the development-channels prompt is documented for launches.
  The same guarded check stays in the launch path as a harmless safety net
  (no match, no key).
- Unverified: the idle-composer check (a `❯`/`>` input line) against a real
  post-switch capture, and the fallback behavior when no prompt appears
  because a short context has nothing cached (it then relaunches).

### Docs & changelog (S54.4)

- `docs/SLASH_COMMANDS.md`: `/model` row + section; a "Choices" subsection
  (`CommandResponse.choices`, rendering per channel, the fallback follow-up).
- `docs/CC_POOL_ADAPTER.md`: `/model` in "Model selection", the
  "Model-confirmation prompt" section, `model_confirm_pattern`.
- `docs/TELEGRAM_ADAPTER.md`: command choices on the E74 buttons
  (`choice:` callbacks, 24-hour TTL, `choice_prompts.commands`).
- `docs/CONFIG.md` (or wherever config is documented): `models.catalog`.
- `CHANGELOG.md` `[Unreleased]` → Added.

---

## Stories

- **S54.1 — Model catalog and resolver.** `src/models/catalog.ts` +
  `catalog.test.ts`, `models.catalog` in the config schema. Pure functions;
  table-driven tests cover every specificity rule above.
- **S54.2 — Interactive command choices on E74.** `CommandChoice`,
  `registerChoiceFollowUp`, `deliverCommandResponse` in `api.ts`, migration 039
  (`choice_prompts.commands`), `metadata.choice_commands`, command-payload tap
  in `processChoiceTap`. Tests: registry follow-up mapping, api.ts Telegram
  metadata and numbered-list fallback, command-payload tap (valid, second tap,
  expired, wrong sender, plain prompts unchanged).
- **S54.3 — `/model` command.** `src/commands/model.ts` + tests,
  `SlashCommandContext.routes`, wiring in `index.ts`.
- **S54.4 — Docs and changelog.**
- **S54.5 — cc-pool apply and model-confirmation prompt.** `applyModelNow`,
  `switchModelInPane`, `confirmModelPrompt`, `model_confirm_pattern`. Tests with
  a fake tmux and the real captured prompt as fixture: prompt present then `1`
  sent; prompt absent or a similar prompt no key; stuck prompt reported; busy
  pane deferred; fallback to relaunch; non-pool agent untouched.

S54.1 and S54.2 are independent. S54.3 depends on the interfaces fixed above;
S54.5 depends on S54.3.

## Exit Criteria

- `/model` in the pokeclaude Telegram DM shows the current model and a
  button per model. Tapping Opus 5.5 sets `agent:pokeclaude`'s override to
  `claude-opus-5-5`, and the next message relaunches the pane on it
  (`/pool` shows `model=claude-opus-5-5`).
- `/model haiku` → latest Haiku. `/model haiku 4.5` → exactly 4.5.
  `/model haiku 5.1` → `No Haiku 5.1 — known: 5.5` with a picker.
- **Live check (pending):** in a chat with a leased, idle pool pane,
  `/model opus` types into the pane, the `Switch model?` prompt is answered
  with `1`, the pane returns to its composer and runs Opus 5.5 with the session
  kept; `/model` mid-turn defers; a forced failure falls back to a relaunch.
- On a non-Telegram channel, `/model` shows a numbered list, and replying
  `2` applies choice 2.
- `/model reset` removes the override. `/model` then reports the config
  model.
- `npx tsc --noEmit` and `npx vitest run` pass.

## Decisions

- **D1 — Store the concrete ID, not the alias.** Predictable and visible
  in `/pool`. A later catalog update never moves a running agent. Not
  chosen: storing `haiku` and re-resolving on every launch.
- **D2 — Scope is the routed agent.** This matches the existing
  `model_overrides` store with no schema change. Not chosen:
  per-conversation overrides (would need a new column + E53 resolution
  change).
- **D4 — Reuse E74 for Telegram buttons.** One button system, one TTL (24 h),
  one answer/addressee/expiry state machine in SQLite. A tap carries a command
  payload instead of a label; nothing bypasses the tap checks. Not chosen: the
  first E54 draft's in-memory `cmd:` map with a 10-minute TTL.
- **D5 — Type `/model` into an idle pane first, relaunch as the fallback.**
  Keeping the session avoids a cold start. Typing is allowed only when no turn
  is in flight, the prompt is matched exactly before any key is sent, and only
  `1` is ever sent. The `--resume --model` relaunch covers every failure.
- **D3 — Static catalog + config extension, `claude-` escape hatch.** No
  API key dependency, and new models work the day they ship.

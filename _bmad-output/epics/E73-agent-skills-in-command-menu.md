# E73 — Agent Skills in the Channel Command Menu

| Field | Value |
|---|---|
| Epic ID | E73 |
| Dependencies | E71 (provider slash-command forwarding), E3 (Telegram `setMyCommands`), E19/E23 (`cc-headless`, `init` event `slash_commands`), E48 (`cc-pool`) |
| Story Count | 6 |
| Estimated Complexity | M |
| Status | Planned |

---

## Epic Summary

E71 lets a user run an agent's skill from chat by typing `/name`, but nothing
tells the user which skills exist. Telegram's `/` autocomplete lists only bus
commands, and there is no way to list skills from any channel.

E73 exposes each agent's **project-level skills** (the ones defined in the
agent's own working directory) in two places:

- Telegram's command menu, so `/` autocompletes them.
- A new `/skills` bus command, which works on every channel.

Selecting a skill uses the E71 forwarding path unchanged.

## Decisions

| Question | Decision |
|---|---|
| Menu scope | Per bot. One menu per Telegram bot, built from the union of the skills of every agent that bot's routes reach. No chat-scoped menus. |
| Which skills | Project-level only: `.claude/skills/*/SKILL.md` and `.claude/commands/*.md` under the agent's `working_dir`. Not user-level (`~/.claude`), not plugin skills, not the provider's built-in commands (`/compact`, `/context`, …). |
| Interactive-only commands | Hidden for `cc-headless` agents. A skill the CLI's `init` `slash_commands` list omits is not shown for that agent. |
| Default | Off. `expose_skills` must be enabled per adapter. |

Built-in provider commands stay reachable by typing them (E71) but are never
listed. User-level and plugin skills are out of scope; add them in a later
epic if wanted.

## Design

### Skill catalog (`src/commands/skill-catalog.ts`)

`SkillCatalog` returns `{ name, description, argumentHint?, agentId }[]` for
an agent.

- Scan `<working_dir>/.claude/skills/*/SKILL.md` and
  `<working_dir>/.claude/commands/*.md`. Read `name`, `description`, and
  `argument-hint` from the frontmatter; the command file name is the name when
  frontmatter has none.
- For `cc-headless` agents, intersect with `headlessControl.slashCommands`
  once the first `init` event has arrived. Before that, show the filesystem
  list. This is the interactive-only filter.
- `cc-pool` agents have no `init` event, so the filesystem list is used as is.
- Cache by directory mtime. Refresh on each `init` event and on
  `/skills refresh`.
- A malformed file is skipped with a warning; it never fails the scan.

### Name aliases

Telegram accepts `[a-z0-9_]{1,32}` only, and one invalid entry fails the whole
`setMyCommands` call. Skill names contain `-` and `:`.

- Alias: lowercase, replace each run of `-` or `:` with `_`, truncate to 32.
- Keep a reverse map alias -> real name. On a collision, the first skill
  (sorted by name) keeps the alias and the rest are dropped from the menu with
  a warning. They stay reachable by typing the real name.
- A skill whose alias equals a bus command is dropped from the menu (`//name`
  still reaches it).
- `processInbound` resolves an alias to the real name before forwarding, so
  `/code_review` is sent to the provider as `/code-review`. A name that is
  both an alias and a real provider command resolves to the real command.

### Menu registration

- `CommandManifest` gains optional `source: 'bus' | 'skill'`. Bus commands come
  first, then skills sorted by name.
- Total capped at Telegram's 100 commands; the overflow is logged, and
  `/skills` still lists everything.
- Description is `description`, with `argumentHint` appended when it fits in
  256 characters; under 3 characters it is skipped.
- Re-register after a catalog refresh, debounced (30 s) and only when the
  rendered list changed.
- Config: `adapters.telegram.expose_skills: boolean | { allow?: string[], deny?: string[] }`.
  Default `false`. `deny` wins over `allow`.

### `/skills [filter] [refresh]`

Lists the skills of the conversation's agent: real name, description, and
argument hint. `filter` is a case-insensitive substring match. Output is
plain text so every adapter renders it. `/help` mentions it. When the agent
has no project-level skills it says so.

## Stories

| Story | Title | Notes |
|---|---|---|
| S73.1 | Skill catalog | Scanner, frontmatter parser, mtime cache, `cc-headless` `init` intersection. Unit tests with fixture directories. |
| S73.2 | Name aliases | Alias and reverse map, collision and bus-name handling, tests for `-` and `:` names and 32-char truncation. |
| S73.3 | Alias resolution in dispatch | `processInbound` maps alias -> real name before the E71 forwarder; tests for precedence over typos and bus commands. |
| S73.4 | `/skills` command | Handler in `src/commands/handlers.ts`, `refresh` and filter arguments, `/help` entry. |
| S73.5 | Telegram menu | `source` on manifests, skill entries in `registerCommands`, 100-command cap, debounced refresh, `expose_skills` in `src/config/schema.ts`. |
| S73.6 | Docs and live check | `docs/SLASH_COMMANDS.md`, `docs/TELEGRAM_ADAPTER.md`, matching `site-docs/` pages (`npm run docs:build`), `CHANGELOG.md` Unreleased. Operator check on a real bot with a headless and a pool agent. |

## Risks and notes

- **Menu entry the routed agent lacks.** The menu is per bot, so a skill from
  agent A can appear in a chat routed to agent B. `cc-headless` rejects it
  (the `init` list doesn't have it). `cc-pool` types it into the pane and
  Claude replies that it is unknown. Both give the sender a clear result;
  `/skills` shows only the routed agent's skills.
- **Same skill name in two agents.** One menu entry; the description comes from
  the first agent alphabetically.
- **Telegram client caching.** The client can take a minute to show a changed
  menu; the registration log confirms what Telegram stored.
- **Skills run with the agent's permissions**, as E71 forwarding already does.
  `deny` is the control for skills that shouldn't be triggerable from chat.

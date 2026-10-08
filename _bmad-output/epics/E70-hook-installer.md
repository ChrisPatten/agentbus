# E70 — Provider Hook Installer

| Field | Value |
|---|---|
| Epic ID | E70 |
| Status | Planned (draft) |
| Dependencies | E48 (cc-pool), E51 (approvals); coordinates with E41 (`codex-headless`) and E67 (freshness hook) |
| Story Count | 6 |
| Estimated Complexity | M |

Source: planning discussion, 2026-10-05.

## Problem

AgentBus ships four Claude Code hook scripts in `scripts/hooks/`:

| Script | Events | Needed by |
|---|---|---|
| `agentbus_tool_status_hook.sh` | `UserPromptSubmit`, `PostToolUse` | `cc-pool` (live tool status, typing) |
| `agentbus_stop_hook.sh` | `Stop` | `cc-pool` (idle timing, watchdog turn-end signal) |
| `agentbus_approval_hook.sh` | `PermissionRequest` | `cc-pool` (E51 approvals) |
| `agentbus_precompact_snapshot.sh` | `PreCompact` | any agent with a memory dir |

Installing them is manual: symlink each script into the agent's project, then hand-edit that project's `.claude/settings.json`. Three things make this error-prone:

- `POOL_AGENT_ID` (stop hook) and `STATE_DIR` (tool-status hook) are hardcoded constants (`peggy`, `/tmp/peggy-agentbus-hook-state`). A second pool agent needs its own edited copy of the script.
- Missing any one registration fails silently. For example, no `Stop` hook means the watchdog reports false stalls, and no `PermissionRequest` hook means a pane freezes on a permission dialog.
- Hooks are Claude Code specific. `codex-headless` (E41) will need an equivalent, so the install path must be provider-aware from the start.

## Config findings

The config already records the target directory. `cc-pool` and `cc-headless` instances each have `working_dir` (optional; defaults to the bus-core process cwd), and `normalizeCcPoolConfigs` / the headless normalizer expose the resolved instance list with `agent_id`. That `working_dir` is the Claude Code project whose `.claude/settings.json` Claude reads, so no new config field is required. The `agent_id` is the pool id the hooks need. Only the polling `cc` adapter has no config entry; it is out of scope.

`cc-headless` gets typing and tool status from its own `claude -p` stdout stream, so it only needs the `PreCompact` hook. The installer must know which hooks apply to which adapter type and not install pool-only hooks where they do nothing.

## Intended Behavior

One command installs the right hooks for an agent's provider into that agent's project, idempotently, without damaging existing settings. It exists as both a bus slash command and a local CLI, over one shared core.

- Bus: `/install-hooks <agent> [provider] [--only a,b] [--apply] [--uninstall]`. Without `--apply` it only shows the plan (diff).
- CLI: `npx tsx scripts/install-hooks.ts (--agent <id> | --project <dir>) [--provider p] [--only a,b] [--dry-run] [--uninstall]`. It applies by default; `--dry-run` shows the plan.
- Provider defaults from the agent's adapter type: `cc-pool` and `cc-headless` map to `claude-code`; `codex-headless` will map to `codex`.

## Design Notes

- **Provider interface.** `HookProvider` has `id`, `settingsPath(projectDir)`, `hooksFor(adapterType)`, `plan(projectDir, params)` and `apply(plan)`. The registry holds `claude-code` (real) and `codex` (stub that returns "not supported until E41"). Adding a provider is one file.
- **Settings merge, not overwrite.** Our entries are identified by their command path, so re-running never duplicates them and uninstall removes only ours. Unrelated keys and user hooks are preserved. A `.bak` copy is written before any change. Malformed JSON aborts with an error and never gets overwritten.
- **Script parameterization.** The scripts read `AGENTBUS_POOL_AGENT_ID`, `AGENTBUS_STATE_DIR` and `AGENTBUS_BASE` from the environment and fall back to today's values. Existing deployments keep working unchanged, and one shared symlinked script serves every agent. The installer supplies the per-agent values in the registered hook command (an `env` prefix), derived from the adapter config (`agent_id`, `bus.host`/`bus.port`).
- **Symlinks, as documented.** Scripts are symlinked from `<project>/scripts/hooks/` back to this repo, so a bus update updates every installed agent. An existing regular file at the target is reported and never replaced.
- **Prerequisites.** `jq` and `curl` are checked. The hooks fail silently without them, so the installer warns up front.
- **Write safety from chat.** The bus command writes into a project directory on the host, so it is dry-run by default, restricts targets to configured agents' `working_dir`, and accepts no free-form path. The CLI is the only entry that takes an arbitrary `--project`.
- **Running panes keep old hooks.** Claude Code reads settings at launch, so a pool pane must be relaunched. The installer says so in its output.

## Exit Criteria

1. `/install-hooks peggy` shows the exact `settings.json` change and symlinks for a configured `cc-pool` agent. `--apply` makes them, and a second `--apply` changes nothing.
2. Existing unrelated hooks and settings in the project's `.claude/settings.json` survive install and uninstall unchanged.
3. Two pool agents each get their own `POOL_AGENT_ID` and `STATE_DIR` from the same shared scripts.
4. A `cc-headless` agent gets only the hooks that apply to it.
5. Requesting `codex` reports a clear "not supported yet" result and writes nothing.
6. Docs, CHANGELOG and the setup sections of the pool and approvals docs reflect the installer.

## Stories

### S70.1 — Provider interface and registry

- `src/hooks-install/types.ts` and `providers/index.ts` as described above.
- The `codex` provider is a stub that returns a not-supported result.
- Adapter-type to provider mapping, and adapter-type to applicable-hooks mapping.
- Tests: registry lookup, unknown provider, stub result.

### S70.2 — Claude Code settings merge

- Idempotent merge into `hooks.<Event>[]`, identified by command path, with the `.bak` backup and uninstall.
- Tests: empty or missing file, existing user hooks, re-run no-op, uninstall leaves user hooks, malformed JSON aborts without writing.

### S70.3 — Script parameterization

- Env overrides in all four scripts with backward-compatible defaults.
- Tests: a shell check that unset env reproduces the old constants.

### S70.4 — Installer core

- `installHooks({ projectDir, provider, adapterType, params, only, mode })` returning a plan and result. Symlink creation, conflict reporting, and the `jq`/`curl` prerequisite check.
- Tests against a temp directory, including an existing regular file at a symlink target.

### S70.5 — CLI wrapper

- `scripts/install-hooks.ts` with `--agent` (resolved through config) and `--project`.
- Tests for argument parsing and the exit code on failure.

### S70.6 — Bus slash command, docs and verification

- `src/commands/install-hooks.ts` registered in `src/commands/index.ts`. It is dry-run by default, resolves `<agent>` through the adapter config and rejects unknown agents.
- New `docs/HOOKS.md`. Update `docs/SLASH_COMMANDS.md`, the setup sections of `docs/CC_POOL_ADAPTER.md` and `docs/APPROVALS.md`, and `docs/README.md`. Add the CHANGELOG `[Unreleased]` entry (MINOR on release).
- Live verification on a scratch project: install, relaunch a pane, confirm each hook fires.

## Out of Scope

- A working Codex provider (waits on E41 and a working `codex` binary).
- User-level `~/.claude/settings.json`. Project-level only.
- Gemini CLI or any other provider.
- Auto-relaunching panes after install.
- Installing hooks for the polling `cc` adapter.

## Decisions

- Both a bus command and a CLI, over one shared core.
- Claude Code only in v1, behind a provider interface.
- The bus command is dry-run by default and restricted to configured agents.
- Project directory comes from the existing `working_dir` config, with no new field.

## Open Questions

1. Uninstall is planned in S70.2 because the merge design makes it cheap. Confirm it stays in v1.
2. Where do hook env values come from if `bus.host`/`bus.port` differ from the scripts' `127.0.0.1:3000` default? Plan is to read them from config, to be confirmed during S70.4.
3. When `working_dir` is unset it defaults to the bus-core cwd. Should the installer refuse in that case, or install there? Leaning toward refusing and asking for an explicit `working_dir`.

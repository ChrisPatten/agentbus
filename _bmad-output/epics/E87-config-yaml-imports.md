# E87 — Config Imports: Layered YAML With Precedence

| Field | Value |
|---|---|
| Epic ID | E87 |
| Dependencies | `src/config/loader.ts`, E66/E67 `agents.<id>` blocks, E48 cc-pool |
| Story Count | 5 |
| Estimated Complexity | M |
| Status | Scoped — not started |

---

## Epic Summary

`config.yaml` is one file that mixes bus settings (bus, pipeline, scheduler, adapter tokens) with agent settings (`agents.<id>`, that agent's `cc-pool` block, routes, topics). Peggy's live file is a symlink into her repo and holds both. This epic adds a top-level `imports:` list so agent-specific config can live beside the agent and bus config can stay separate, merged in a defined order of precedence.

## Verified Behavior

Read 2026-10-29:

- `loadConfig(path)` in `src/config/loader.ts` is the single entry point (used by cc.ts, cc-headless, the scheduler and the runtime resolver). It loads `.env` next to the file, reads one file, parses YAML, substitutes `${VAR}` and leading `~`, then validates with `AppConfigSchema`.
- Legacy-block warnings (`legacyJournalingBlocks`, `legacyMemoryBlocks`, `retiredMemoryKeys`) run on the substituted object, so they work on a merged object unchanged.
- Config changes need a restart; this does not change.

Not yet audited: every `loadConfig` caller, and where `routes`/`contacts`/`topics` sit in the live file. Entry criteria below.

## Design

Syntax:

```yaml
imports:
  - ~/workspace/peggy-claude-code/agentbus.agent.yaml
  - path: ~/workspace/pokeclaudebot/agentbus.agent.yaml
    optional: true
    allow: [agents, adapters.cc-pool, routes]
  - conf.d/*.yaml
```

Precedence, lowest to highest: each import in listed order (later wins), then the importing file on top. Nested imports resolve before their parent's own values.

Merge rules, applied to raw parsed YAML before env substitution and Zod:

- Maps deep-merge by key; scalars replaced by the higher-precedence value.
- Arrays replace by default; `!append`, `!prepend` and `!replace` YAML tags opt in per value.
- Explicit `null` removes a key.

Resolution:

- Relative paths resolve against the importing file's real (symlink-resolved) directory; `~/` expands; globs sort lexicographically.
- A missing file is a startup error unless `optional: true`; a glob matching nothing is fine.
- Cycle detection by realpath; depth limit 8; the error names the chain.
- `${VAR}` substitution runs after the merge; one `.env` (the root's) in v1.

Scoping: each import takes an optional `allow:` list of dotted key prefixes. A key outside it is a startup error naming the file and key. Omitted means unrestricted; our own migration uses it so an agent repo cannot set `bus.*`.

Diagnostics: a per-leaf source map feeds validation errors ("agents.peggy.memory.dir (from <file>)"), `agentbus config --print` (masked) and `--explain`, and one startup log line listing the loaded files in order with short hashes.

## Entry Criteria

- Audit every `loadConfig` caller and any code reading the config path directly (symlink handling, `AGENTBUS_CONFIG`).
- Decide the open questions below with the operator.

## Exit Criteria

1. A config with no `imports` loads identically to today (regression test).
2. Precedence, merge tags, null removal, nesting, globs, optional, cycle, depth and `allow` all behave as above, with tests.
3. Validation errors name the originating file.
4. `config --print` and `--explain` work.
5. Peggy's config is split into bus and agent files, and the merged parse equals the pre-split parse before the restart.
6. Docs (`site-docs/reference/configuration.md`, `config.yaml.example`) and `[Unreleased]` CHANGELOG updated.

## Stories

### S87.1 — Merge engine and loader wiring

- New `src/config/imports.ts`: `loadYamlWithImports`, custom js-yaml schema for the tags, `deepMerge`.
- `loader.ts` uses it and strips `imports` before Zod.

**Acceptance:** `src/config/imports.test.ts` covers precedence, merge rules, resolution and cycle/depth; existing loader tests pass.

### S87.2 — `allow` scoping

- Per-import key-prefix allow list, enforced before the merge.

**Acceptance:** a violation fails startup with file and key in the message.

### S87.3 — Provenance and diagnostics

- Source map built during the merge; errors carry the file; `config --print/--explain`; startup log line.

**Acceptance:** a bad value in an imported file is reported with that file's path.

### S87.4 — Docs

- "Splitting the file" section in the configuration reference, example in `config.yaml.example`, CHANGELOG.

### S87.5 — Peggy migration

- Split `agentbus-config.yaml` into a bus file and `peggy-claude-code/agentbus.agent.yaml` (`agents.peggy`, `peggy-pool`, and routes/topics if decided); update the runbook in the same turn.
- Verify with `config --print` against the pre-split parse, then a safe restart per the `agentbus-dev-workflow` skill.

**Acceptance:** identical merged config; bus-core healthy after restart.

## Open Questions

1. Root file wins (recommended) or last import wins?
2. `allow` required for imports outside the AgentBus checkout, or opt-in?
3. Arrays: replace plus `!append`, or merge routes by a key?
4. Which keys move agent-side for Peggy: just `agents.peggy` and the pool block, or routes and topics too?

## Risks

- Silent override surprises: mitigated by `--explain` and the startup log.
- Two files defining the same pool block merge and could mask a typo: `--explain` shows it.
- Symlinked `config.yaml` today: relative imports must resolve from the real file location.

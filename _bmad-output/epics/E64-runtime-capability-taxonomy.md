# E64 — Runtime Capability Taxonomy

| Field | Value |
|---|---|
| Epic ID | E64 |
| Status | Planned |
| Dependencies | None |
| Story Count | 3 |
| Estimated Complexity | S |

Source: pluggable-journaling design discussion, 2026-10-02 (`planning-artifacts/journaling/decisions.md`).

## Epic Summary

Formalize what each agent runtime can do, so features can say things like "`claude-code` doesn't support system messages or schedules" and "`cc-headless` supports session forking" and check them in one place. Today only channel adapters advertise capabilities (`AdapterCapabilities` in `src/core/registry.ts`: typing, react, toolStatus, interactiveApproval, …). Agent runtimes (`cc-headless`, `cc-pool`, `claude-code`, MCP-polled agents) have no equivalent, and `cc-pool` is not in the registry at all. Advisories (E65), journaling (E66), memory loading (E67) and learning (E68) all consume this.

## Entry Criteria

- Keep channel `AdapterCapabilities` unchanged. Runtime capabilities are a separate type describing the agent side.
- Capabilities come in two kinds: **static** (fixed by runtime type, validated at config load) and **live** (depend on session state, checked at run time).

## Exit Criteria

1. Every runtime type declares its static runtime capabilities, and the bus can resolve the runtime and its capabilities for any `agent_id`.
2. Live capabilities can be checked for a given session through one interface.
3. Features declare required capabilities and get a clear startup error for impossible configurations.
4. `/status` and `/api/v1/health` show each agent's runtime and capabilities. Docs describe the taxonomy and the per-runtime matrix.

## Stories

### S64.1 — Runtime capability model and declarations

Define `RuntimeCapabilities` with at least: `systemMessages`, `schedules`, `sessionResume`, `sessionFork`, `exclusiveSession`, `liveAgent`, `nativeMemory` (Claude Code auto memory and `CLAUDE.md` loading), `contextInjection` (bus can add context per turn), and `hookEvents` (the harness events the runtime can emit: `turn-ended`, `pre-compact`, `session-end`, `clear`). Declare static values for `cc-headless`, `cc-pool`, `claude-code`, and generic MCP-polled agents. Verify each claim against the code (for example, `claude-code` has no system messages or schedules; `cc-headless` supports `--fork-session`; `claude-code` is a shared, non-exclusive session). Unit tests pin the matrix.

### S64.2 — Runtime resolution and live checks

Resolve `agent_id` → runtime instance (headless instance, pool and pane, `claude-code`) in one lookup, replacing ad hoc resolution in the session tracker and commands where practical. Add a live-check interface, `checkLive(capability, session)`, with implementations for: pane still leased to this conversation; Claude transcript still on disk (`claude_session_id` resumable); harness currently polling.

### S64.3 — Requirement validation, surfacing and docs

A helper for features to declare required capabilities and validate config at load with an error naming the agent, runtime, and missing capability. Show runtime and capabilities in `/status` and health. Add `docs/RUNTIME_CAPABILITIES.md` with the matrix and the static versus live distinction, and link it from the adapter docs.

## Out of Scope

- Changing channel adapter capabilities.
- Consumers of the taxonomy (E65–E68).

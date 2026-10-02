# E68 — Agent Learning: Consolidation, Feedback and Self-Edit Proposals

| Field | Value |
|---|---|
| Epic ID | E68 |
| Status | Planned |
| Dependencies | E66, E67 (and E65 for proposals to owners) |
| Story Count | 5 |
| Estimated Complexity | L |

Source: pluggable-journaling design discussion, 2026-10-02 (`planning-artifacts/journaling/decisions.md`).

## Epic Summary

Turn journaling into learning. **Consolidation** periodically turns journals into durable knowledge and keeps memory small. **Feedback signals** tell journalers where the agent went wrong. **Self-edit proposals** let the agent improve its own instructions and skills, with owner approval.

## Entry Criteria

- Consolidation is an agent-level job kind in the E66 journaler framework, not a separate system.
- Memory writes follow the E67 native format.
- No git versioning of agent memory (backlog). Consolidation archives and never deletes.

## Exit Criteria

1. A nightly per-agent consolidation runs through the journaler chain, is skipped when nothing new was journaled, and can be triggered with `/journal consolidate`.
2. Denied approvals, `/feedback` and tool errors are recorded as feedback events and passed to session and consolidation jobs.
3. Agents propose changes to protected paths through `propose_change`; owners approve or deny; the bus applies approved changes with a base-hash check.
4. Protected paths are enforced on headless journaling turns and monitored elsewhere.
5. Tests and docs are complete; full suite and build pass.

## Stories

### S68.1 — Consolidation job

Add the `consolidate` agent job kind (`supportsKinds` per journaler):
- **cc-headless:** a fresh `claude -p`, no `--resume`, in the agent's working dir.
- **System Message:** sent to the agent's default conversation; E66 exclusive-run rules apply.
- **Script:** `kind: "consolidate"` in the payload.

Default prompt duties:
- promote recurring patterns into `MEMORY.md` and typed topic files;
- merge duplicates and resolve contradictions (newer wins, noting what was replaced);
- keep `MEMORY.md` within the native limit;
- archive stale content and dailies older than 30 days (once promoted) to `memory/archive/`, never deleting;
- write in the native frontmatter format;
- **recurring-correction check:** flag corrections that keep recurring after a rule was added, and propose strengthening the rule (S68.3).

Config `journaling.consolidation: { cron, prompt }`. The cron runs independently of the scheduler, defaults to nightly, and is skipped when no session journal completed since the last pass. `/journal consolidate` triggers it manually. Shares the one-run-per-agent lane and records `journal_runs` rows.

### S68.2 — Feedback events

Migration for `feedback_events` (kind, agent, conversation, referenced agent message, text, timestamp). Producers:
- **denied approvals** (E51 resolution path);
- **`/feedback <text>`:** immediate acknowledgment, recorded, never delivered as a normal message, no immediate journal;
- **tool errors:** headless stream tool errors and failed delivery calls.

Session jobs receive `feedback[]` for their window (script payload, system-message summary block, headless prompt). Consolidation receives cross-session counts. Denied approvals and `/feedback` make the session eligible immediately (bypassing `min_human_messages`); tool errors do not. `/stop`, reactions, edits and quick-follow-up heuristics are excluded.

### S68.3 — Self-edit proposals

MCP tool `propose_change({ path, new_content | diff, rationale, evidence })`; scripts return `proposals[]` in stdout JSON. A new request type in the E51 approvals system, sent to owner contacts (E65) with the rationale, a compact diff, and Approve/Deny. **On approve, the bus applies the change** if the file's hash still matches the proposal's base; otherwise the proposal is marked stale and the agent may re-propose. Deny records a denied-approval feedback event. Proposals expire after 7 days; at most 3 per agent per day. Approve/Deny only (no inline edits).

### S68.4 — Protected paths enforcement

Per-agent `protected_paths`, default `CLAUDE.md`, the agent's system-prompt file, `skills/`, `.claude/`. Memory files stay freely writable, including pinned memory imported from `CLAUDE.md`. cc-headless journaling and consolidation turns run with permission rules denying edits to protected paths. For all journalers, hash protected files before and after each run and raise a `warning` advisory listing any changed without an approved proposal.

### S68.5 — Docs and verification

`docs/AGENT_LEARNING.md`: consolidation, feedback events, `/feedback`, proposals, and protected paths. Update `JOURNALING.md`, `APPROVALS.md`, `MCP_TOOLS.md`, `SLASH_COMMANDS.md`. End-to-end check on one agent: a correction via `/feedback` is journaled, consolidated into a `feedback` memory, and a recurring correction yields a proposal.

## Out of Scope

- Daily budget caps, git-versioned memory and rollback, trust tiers.
- Reaction, edit and quick-follow-up signals.

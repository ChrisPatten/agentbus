# E73 — Hook-Delivered recent.md (Full on Start, Deltas After)

| Field | Value |
|---|---|
| Epic ID | E73 |
| Status | Implemented; Baxter migration and live checks pending |
| Dependencies | E67 (native memory layout, `recent.md`, freshness hook and endpoint), E66 (journaling regenerates `recent.md`) |
| Story Count | 5 |
| Estimated Complexity | M |

Source: operator discussion, 2026-10-16, after the freshness-hook delta change (`recentDelta` in `src/memory/recent-freshness.ts`) and an inspection of real Baxter transcripts.

## Epic Summary

Today an agent gets `recent.md` through an `@memory/recent.md` import in `CLAUDE.md`. Claude Code re-reads the import on every `claude -p --resume` and, whenever the file changed, adds the whole file to the transcript again. This epic removes the import and delivers `recent.md` through the freshness hook instead, for every runtime: `SessionStart` injects the full file when the session has not seen it (new session, `/clear`, compaction), and each later `SessionStart` or `UserPromptSubmit` injects only the lines appended since the session last saw it. The same hook then serves cc-headless, cc-pool and interactive sessions such as the Claude Code desktop app.

## Problem

Measured in two bus-driven Baxter sessions under `~/.claude/projects/-Users-pattenchris-workspace-baxter-agent` (native memory, the default):

1. **Claude Code resends changed instruction files whole.** On each resume it checks the files it loaded (`CLAUDE.md`, imports, auto `MEMORY.md`). A changed file is added to the transcript as a new `instructions` attachment (`reason: session_start`) with full content.
2. **`recent.md` is the largest and most volatile.** It is rewritten after every journal run and holds up to `recent_budget_chars` (40000 for Baxter). In a 33-turn session it was re-attached in 11 turns, at 1.7 to 40 KB each, about 260 KB (roughly 65k tokens) of mostly repeated journal text, all of it staying in context until compaction.
3. **The freshness hook only serves part of the problem.** `agentbus_recent_memory_hook.sh` sends deltas to a session that already loaded the file through the import. It treats `SessionStart` as a baseline (nothing injected), so it cannot replace the import.
4. **The ledger route doesn't cover interactive sessions.** Moving `recent.md` to bus injection in `runClaudeTurn` (E49 ledger) would help headless turns only. Removing the import for that would leave desktop and pool sessions without `recent.md`.

## Design

Remove `@memory/recent.md` from the agent's `CLAUDE.md`. Register `agentbus_recent_memory_hook.sh` for `SessionStart` and `UserPromptSubmit` in the agent project's `.claude/settings.json`. Both events call `GET /api/v1/memory/recent` with the harness session id and, for `SessionStart`, the start reason.

The bus decides from what it recorded for that session (`memory_recent_seen`), not from the event:

| Situation | Response | Hook prints |
|---|---|---|
| No record for this session (new session) | Full file, record text | Full file |
| `SessionStart` with reason `clear` or `compact` | Forget the record, then as above | Full file |
| `SessionStart` with reason `resume` (every headless turn) or `UserPromptSubmit`, text unchanged | `unchanged` | Nothing |
| Same, lines appended | Delta from `recentDelta`, record advances | New lines only |
| Same, new day | The new day whole | New day |
| Midnight rollover, no new entries | `no-new-entries` | Nothing |
| Bus unreachable, error, no agent | Hook falls back (see S73.3) | See S73.3 |

**Decisions**

| Decision | Choice |
|---|---|
| Mechanism | One endpoint and one script for all runtimes. No `runClaudeTurn` change, no ledger column, no per-agent config switch. |
| Compaction and clear | Driven by the `SessionStart` reason, not by the token-drop heuristic: `source=compact` forgets the record and resends the whole file; `/clear` gives a new session id, so it has no record and gets the whole file. Auto-compaction emitting `compact` is inferred, still to confirm on a live session. |
| Session tracking | `memory_recent_seen` keyed by harness session id, as today (migration 035 already stores the text). |
| Interactive sessions | No bus session exists, so the hook command carries `AGENTBUS_AGENT_ID=<agent>`; the endpoint already resolves a configured agent from `agent=`. |
| Delta logic | Existing `recentDelta` and `parseRecentDays`, unchanged. |
| Failure mode | The hook becomes the only source. A failed `SessionStart` falls back to printing `recent.md` from disk so the agent never starts without it (S73.3). |
| Opt-in | By configuration: an agent that keeps its import is unaffected, because the first `SessionStart` check would send the full file and double-load. The setup check warns (S73.4). |

## Spike First (S73.1)

These assumptions come from transcript evidence and docs, and each must be confirmed against the binary `config.yaml` uses (`/Users/pattenchris/.local/bin/claude`) before building:

1. `SessionStart` fires on every `claude -p --resume` and its input names the reason (`startup`, `resume`, `clear`, `compact`).
2. Auto-compaction fires `SessionStart` with `compact`, and `/clear` with `clear`.
3. Project `.claude/settings.json` hooks run when the bus passes `--settings '{"autoMemoryDirectory": …}'` and `--system-prompt-file`.
4. Hook stdout from `SessionStart` lands in context at about its own size (no wrapping blow-up), in `-p` mode and in the desktop app.
5. In the desktop app the hook sees a session id, and `AGENTBUS_AGENT_ID` in the command string resolves the agent.

If 1 or 2 fail, the epic's compaction story falls back to the existing token-drop detector in the bus (`detectCompaction`), which then needs a per-session reset call.

## Exit Criteria

1. With the import removed and the hook registered, a new headless session's first turn contains the full `recent.md` exactly once, and Claude Code no longer re-attaches it in later turns (confirmed in a real Baxter transcript).
2. After lines are appended, the next turn carries only those lines; an unchanged turn carries nothing.
3. `/clear` and compaction each lead to one full resend, then deltas again.
4. A desktop Claude Code session in the agent's working directory starts with the full `recent.md` and then receives deltas.
5. With the bus down, a new session still starts with `recent.md` (disk fallback).
6. cc-pool panes and agents that keep the import behave as documented, with the setup check warning on a double load.
7. Docs updated; full suite, `tsc` and `npm run docs:build` pass.

## Stories

### S73.1 — Spike: hook behavior across runtimes

- Verify the five assumptions above with a throwaway project and the real binary, in `-p --resume`, cc-pool and the desktop app.
- Record the findings (hook input fields, observed reasons, output size) in this file and in `docs/AGENT_MEMORY.md`.
- Decide the compaction path (reason-driven or detector-driven) from the result.

### S73.2 — Endpoint: full on first sight, delta after

- Extend `parseFreshnessQuery` with the start reason (for example `source=startup|resume|clear|compact`).
- `RecentFreshness.check`: no row, `clear` or `compact` returns the full file with a "loaded for the first time / re-loaded" preamble; otherwise the existing delta path. Shipped: the bus decides per agent, from the working dir's `CLAUDE.md` import closure, whether the agent is in import mode (imports `recent.md`, or has no working dir: unchanged E67 behavior, `SessionStart` records a baseline) or hook mode (no import: full file for an unseen session id and after `source=compact`, deltas after, nothing when unchanged). No query flag.
- Tests in `recent-freshness.test.ts`: each row of the table above, `resume` on every turn, reason handling, legacy rows.

### S73.3 — Hook script: pass the reason, print on SessionStart, disk fallback

- `scripts/hooks/agentbus_recent_memory_hook.sh`: read the start reason from the hook input, send it, and print the response context for both events.
- On a failed `SessionStart` request (bus down, timeout, no agent), print the agent's `recent.md` from disk, located through a new `AGENTBUS_RECENT_FILE` variable or derived from the project directory. Stay best-effort: exit 0, 2 second timeout, nothing on error for `UserPromptSubmit`.
- Update the stub-bus tests in `recent-freshness.test.ts` for the new behavior.

### S73.4 — Setup check and advisory

- `checkMemorySetup`: report `recent.md` delivery as `import`, `hook` or `none`. Warn when both are present (loaded twice). Warn when neither is present (the agent never sees recent journals).
- Detect hook registration by reading the working dir's `.claude/settings.json` and `.claude/settings.local.json` for the script, as the import check already follows `CLAUDE.md` imports.
- `memory:recent-not-imported` must not fire for an agent that delivers through the hook. Add a `memory:recent-not-delivered` condition if the existing advisory cannot express it.
- Tests in `setup-check.test.ts` and `setup-advisory.test.ts`.

### S73.5 — Docs and Baxter migration

- `docs/AGENT_MEMORY.md` (Loading and Freshness hook sections, setup steps), `docs/MEMORY_MODEL.md` if affected, `site-docs/features/agent-memory.md`, `site-docs/runtimes/cc-pool.md` hook table, `CHANGELOG.md` under `[Unreleased]`.
- Baxter migration (operator-approved): register the hook with `AGENTBUS_AGENT_ID=baxter`, remove `@memory/recent.md` from Baxter's `CLAUDE.md`, then verify in new transcripts that `recent.md` appears once per session in headless, cc-pool and the desktop app, and that later turns carry only deltas.
- Versioning: backward-compatible, so propose a MINOR bump at merge time.

## Spike findings (S73.1)

Run 2026-10-16 with `/Users/pattenchris/.local/bin/claude` 2.1.287, `--model haiku`, `-p`, `--output-format json`, in a throwaway project (`CLAUDE.md`, `.claude/settings.json` with one logging script on `SessionStart` and `UserPromptSubmit` that logs stdin JSON and prints `HOOKMARK-<event>-<n>`, plus a 2.5 KB filler block on `SessionStart`). Transcripts were read from `~/.claude/projects/<mangled path>/`. Not tested: cc-pool, the desktop app, real auto-compaction.

| # | Question | Result | Evidence |
|---|---|---|---|
| 1 | `SessionStart` on fresh `-p` and on every `--resume`? Input fields? `UserPromptSubmit` in `-p`? Order? | Yes to both. Fresh run: `source: "startup"`. Each `--resume`: `source: "resume"` (3 of 3 resumes). `UserPromptSubmit` also fires in `-p`, always after `SessionStart` of the same call. | Hook log: `SessionStart startup` then `UserPromptSubmit`, then per resume `SessionStart resume` then `UserPromptSubmit`. |
| 1b | Input fields | Common: `session_id`, `transcript_path`, `cwd`, `scratchpad_dir`, `hook_event_name`. `SessionStart` adds `source`. On `resume` it also has `seconds_since_last_response`, `context_tokens`, `prompt_cache_likely_expired`, `estimated_cache_write_usd`. On `compact` it adds `model`. `UserPromptSubmit` adds `prompt_id`, `permission_mode`, `prompt` (full prompt text). | e.g. `{"hook_event_name":"SessionStart","source":"resume","seconds_since_last_response":19,"context_tokens":37534,"prompt_cache_likely_expired":false,...}`. The binary's matcher metadata lists the `source` values `startup`, `resume`, `clear`, `compact`, `fork`. |
| 2a | `claude -p "/compact" --resume <id>` | Works. `SessionStart` fires twice in that one call: first `source: "resume"` (the process resumed the session), then, after the summary is written, `source: "compact"` with the **same** `session_id`. No `UserPromptSubmit` fires (slash command). Output JSON has empty `result`. | Log rows 7 and 8, same session id `2db5eeef...`. Transcript: `SessionStart:resume` row, `compact_boundary`, the summary user row, then a `SessionStart:compact` attachment (after the boundary, so it is in post-compaction context). |
| 2b | `claude -p "/clear" --resume <id>` | Works but creates a **new session id**. `SessionStart` fires `resume` for the old id, then `source: "clear"` with the new id `051b3743...`. The new transcript file holds a `SessionStart:clear` attachment. `--output-format json` prints the new id. | Log rows 9 and 10; `ls` shows a second `.jsonl`. |
| 2c | Auto-compaction | Not triggered (impractical at haiku scale). Binary strings: manual and automatic compaction appear to share one compact routine that ends with the `compact` start hook, so `source: "compact"` is expected for both. This is inferred, not observed. | The matcher metadata lists `compact`; no public doc was found locally. |
| 3 | Project hooks with `--settings '{"autoMemoryDirectory":...}'` and `--system-prompt-file`? | Yes. Start and resume turns both ran `SessionStart` (`startup`, `resume`) and `UserPromptSubmit`. The transcript has four `hook_success` attachments. | Log rows 12 to 15, session `6669beea...`. |
| 4 | Where does stdout land? | In the transcript as `type: attachment`, `attachment.type: "hook_success"`, with `hookEvent`, `hookName` (`SessionStart:startup`, `SessionStart:resume`, `SessionStart:compact`, `SessionStart:clear`, or `UserPromptSubmit`), `content`, `stdout`, `exitCode`, `command`, `durationMs`. One row per hook call, so a new full copy per turn if the script prints. Model-visible form (`rendered`): `<system-reminder>\nSessionStart:<source> hook success: <stdout></system-reminder>`, about 60 chars of wrapping around stdout (stdout 2536 chars, rendered 2665 chars). The `content`/`stdout`/`rendered` duplication affects only the transcript file, not context. | The model quoted all `HOOKMARK-*` markers it could see from `system-reminder` blocks and counted 120 filler lines (40 per `SessionStart` copy in three calls). Empty stdout wrote no attachment row at all (tested with a silent hook on a resume). |
| 5 | Is `session_id` stable across resumes and equal to the JSON output? | Yes across resumes and `/compact`: one id in hook input of all calls and in `session_id` of `--output-format json`. It changes on `/clear` (new id, both in hook input and JSON output). | Compared in `hook.log` and `out*.json`. |
| 6 | Desktop app | Not testable here. Operator follow-up: confirm in the desktop app that project hooks run on session start, that `source` is `startup` there, that `session_id` is present, and that stdout lands as a `hook_success` attachment. cc-pool panes also remain to be verified (S73.1 asks for it). | |

### Surprises

- `/compact` and `/clear` in `-p` each run a `resume` start hook first. A reason-driven bus must treat `resume` as "unchanged or delta" and let the later `compact` call reset. Both calls arrive within one process, a few seconds apart.
- `/clear` yields a new session id. A bus record keyed by session id therefore never needs a "forget on clear" step: the id is simply new, and `source: "clear"` carries an id with no record. (The design table's `clear` row is correct but redundant; `compact` is the only reason that needs an explicit reset.)
- `resume` input contains `context_tokens` and `prompt_cache_likely_expired`, which the bus could use as extra signals but does not need.
- The `SessionStart` stdout from the `resume` call just before a compaction is summarized away, and the `compact` call re-attaches fresh output after the boundary. That is what E73 wants: one full resend after compaction.
- A silent hook costs nothing in the transcript (no row), so the unchanged-turn case is free.

### Recommendation

Use the reason-driven path. `SessionStart` fires on every resume, `source: "compact"` is observed for manual compaction with a stable session id, and `clear` arrives with a new id. Implement S73.2 as designed (`compact` forgets the record; `clear` is covered by the unseen new id), and keep the token-drop detector (`detectCompaction`) out of the E73 critical path. Residual risk: auto-compaction was not observed; the binary shares the compaction routine, so it is likely the same, and Exit Criterion 3 should confirm it on a real long session (Baxter). If auto-compaction does not emit `compact`, fall back to the detector and add a per-session reset call.

## Operator follow-ups

1. Desktop app check: the project hook runs on session start, `source` is `startup`, `session_id` is present, and stdout lands as a `hook_success` attachment.
2. Auto-compaction emits `source: "compact"` on a long Baxter session (then one full resend, deltas after).
3. Baxter migration: register the hook for `SessionStart` and `UserPromptSubmit` with `AGENTBUS_AGENT_ID=baxter` and `AGENTBUS_RECENT_FILE` in the command, and remove `@memory/recent.md` from Baxter's `CLAUDE.md`. Then verify in new transcripts that `recent.md` appears once per session and later turns carry only deltas.

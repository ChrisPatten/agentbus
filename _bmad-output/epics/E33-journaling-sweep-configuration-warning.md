# E33 — Journaling Sweep: Warn (Don't Silently No-op) on Missing cc-headless Config

| Field | Value |
|---|---|
| Epic ID | E33 |
| Dependencies | None. Touches only `SessionTracker.dispatchJournaling()` (E20/E23/E30). |
| Story Count | 2 |
| Estimated Complexity | S |

---

## Epic Summary

1. `SessionTracker.dispatchJournaling()` (`src/memory/session-tracker.ts:150`)
   opens with:
   ```ts
   const instances = getCcHeadlessInstances(this.config);
   if (instances.length === 0 || this.journalingRunners.size === 0) return;
   ```
   This is an **all-or-nothing** dependency: if the `cc-headless` config block
   is absent for any reason (operator swapped to a different Claude Code
   adapter, a config edit temporarily dropped the block, a deploy raced a
   config reload), the entire journaling sweep silently returns on every
   tick, for **every** session bus-wide — not just sessions belonging to the
   missing adapter. There is no other adapter-scoping check anywhere else in
   `dispatchJournaling()`; this one early return is the sole gate.
2. **Confirmed by a real incident** (2026-08-26 – 2026-08-31, ~5 days): an
   operator swap away from `cc-headless` (to the interactive tmux/MCP
   adapter) silently disabled the sweep for the entire bus the whole time.
   Verified directly against the live DB: the main DM session's
   `last_journaled_at` stayed frozen while `last_activity` kept advancing
   normally — no error, no log line, nothing to notice short of comparing
   the two columns by hand. The gap was only caught because the operator
   happened to ask about it directly; nothing in the system's own output
   would have surfaced it.
3. **Fix is small and purely additive**: log a warning (once per
   configuration state, not once per tick — ticks run on
   `summarizer_interval_ms`, likely far too frequent for a per-tick log line)
   when `dispatchJournaling` finds zero configured `cc-headless` instances
   (or zero registered runners) while there exist headless-managed sessions
   (`claude_session_id IS NOT NULL`, `ended_at IS NULL`) whose
   `last_journaled_at` is stale relative to `last_activity` — i.e., sessions
   that are actually waiting on the sweep and not getting it. No behavior
   change to the early return itself; this only makes the existing no-op
   observable.

---

## Entry Criteria

- None. Read-only diagnostic addition to an existing method; no schema
  change, no config change, no change to what does or doesn't get
  journaled.

---

## Exit Criteria

1. When `dispatchJournaling()` would no-op due to zero configured
   `cc-headless` instances or zero registered runners, and at least one
   eligible session exists that would otherwise have been a journaling
   candidate, a warning is logged identifying the condition (missing
   instances vs. missing runners) and the count of sessions waiting.
2. The warning does not repeat on every tick while the condition persists —
   it fires once when the condition is newly detected, and again only if it
   clears and re-occurs (edge-triggered, not level-triggered).
3. No change in behavior when instances/runners *are* configured — zero
   added log noise in the healthy case.
4. No change to journaling semantics: sessions still simply accumulate
   sweep-lag until the configuration is restored; this epic only makes that
   lag visible.

---

## Stories

### S33.1 — Edge-triggered warning in `dispatchJournaling()`

**User story:** As the operator, I want to see a log line the moment
journaling silently stops working bus-wide, so a config change (intentional
or not) doesn't cost days of unlogged memory sweeps before anyone notices.

**Acceptance criteria:**
1. Add a small piece of state to `SessionTracker` (e.g. a boolean or
   timestamp field, mirroring the existing `journalingInFlight`/
   `journalingAttempts` map style already in the class) tracking whether the
   "no instances/no runners" condition was already warned about on the
   previous tick.
2. In the early-return branch of `dispatchJournaling()`, before returning:
   query (or reuse the existing candidate query, adapted) whether any
   eligible session exists (`ended_at IS NULL AND claude_session_id IS NOT
   NULL AND (last_journaled_at IS NULL OR last_journaled_at < last_activity)`).
   If so, and the warning hasn't already fired for this condition instance,
   log `console.warn` with: which sub-condition is true (`instances.length
   === 0` vs. `this.journalingRunners.size === 0`), and the count of waiting
   sessions.
3. When the condition clears (instances/runners become non-empty again on a
   later tick), reset the warned flag so a future recurrence re-warns.
4. Test: simulate zero configured instances with waiting sessions present —
   assert exactly one `console.warn` across several consecutive `tick()`
   calls, then assert a second warning after instances are "restored" and
   then removed again.

**Complexity:** S

### S33.2 — Docs

**User story:** As a maintainer investigating a "why is memory stale"
report, I want the docs to say where to look.

**Acceptance criteria:**
1. `docs/MEMORY_MODEL.md` (or wherever E20/E30's journaling sweep is
   documented) gets a short note: journaling is entirely dependent on at
   least one configured+registered `cc-headless` instance; removing the last
   one silently pauses the sweep for all sessions, now surfaced via a
   `console.warn` rather than silently.
2. `CHANGELOG.md` entry under `[Unreleased]`.

**Complexity:** S

---

## Notes

- **Why a warning, not a structural fix (e.g. per-adapter scoping).** The
  candidate query already filters to `claude_session_id IS NOT NULL`
  (headless-managed sessions), so in principle a multi-adapter deployment
  where *some* sessions belong to non-headless adapters wouldn't need this
  gate at all for those sessions. But today's actual failure mode is
  single-adapter (the only adapter *is* cc-headless), and the fix that
  matters right now is observability, not a redesign of adapter attribution.
  A deeper "decouple journaling eligibility from adapter configuration
  entirely" rework is a reasonable future item but out of scope here —
  scoped deliberately small to close the "silent" part of the incident
  fast.
- **Origin**: root-caused 2026-08-31 while diagnosing a confirmed live
  5-day memory-sweep outage; written up same-day per Chris's request as a
  lightweight prompt-only fix (`claude_agentbus` tmux session), not a
  Peggy-authored implementation.

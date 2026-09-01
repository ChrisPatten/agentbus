# E40 — Durable Post-Restart Wake-Up (via Scheduled One-Shot + Staleness Dead-Letter)

| Field | Value |
|---|---|
| Epic ID | E40 |
| Dependencies | None structural. Extends the existing E18 Scheduler (`src/scheduler/scheduler.ts`, `scheduled_items` table, `POST /api/v1/schedules`) rather than building a parallel mechanism. Updates `agentbus/scripts/safe_restart.sh` (built Aug 31, 2026). |
| Story Count | 5 |
| Estimated Complexity | M |

---

## Epic Summary

1. **Request** (Chris, 2026-09-01, in response to two failed `bus-core`
   restart attempts that never notified him): "figure out a way you can be
   triggered again after a restart. Maybe it's a special type of message
   you can queue before the restart with the session information that auto
   fires after the bus comes up. There'd be a timeout period to dead letter
   it after a while."
2. **Two real gaps this fixes.** `scripts/safe_restart.sh`'s current
   `notify_peggy()` calls `curl -X POST /api/v1/inbound` *live*, after its
   own health-check confirms `bus-core` is back up. This has two problems
   surfaced by today's actual incidents: (a) it posts to the generic
   `system` channel, not the specific conversation/topic that triggered the
   restart — the notification lands in whatever session owns `system`
   (likely the main DM), not necessarily where Chris is looking; and (b) it
   only fires if the *calling script itself* survives long enough to reach
   that line — twice today, the Bash tool call running `safe_restart.sh`
   (and even a bare `pm2 restart`) got rejected/blocked before executing at
   all, meaning the notify step never had a chance to run, durable or not.
3. **The fix reuses existing infrastructure almost entirely as-is.** The
   E18 Scheduler already does exactly what's being asked for, just not
   named that way: `scheduled_items` is a DB-persisted table (survives a
   process restart trivially — it's just a SQLite row), each row already
   carries `channel`/`topic`/`sender`/`payload_body` (the "session
   information" Chris's ask describes), and `Scheduler.tick()`'s query is
   `WHERE status='active' AND fire_at <= now` — meaning a one-shot schedule
   whose `fire_at` has already passed **fires on the very first tick after
   the process comes back up**, with zero restart-specific code needed.
   Creating one via `POST /api/v1/schedules` *before* calling
   `pm2 restart` — while `bus-core` is still up and serving that endpoint —
   means the wake-up survives even if the restart command itself, or the
   script/turn that issued it, dies immediately after.
4. **The one real gap versus what's asked for**: today's Scheduler has no
   staleness/timeout concept — an overdue one-shot fires no matter how
   overdue, whether it's 10 seconds or 10 days late. Chris explicitly wants
   "a timeout period to dead letter it after a while" (e.g. bus-core never
   recovers, or is down for hours): a wake-up that stale shouldn't fire at
   all. This epic adds that as a small, optional, opt-in field
   (`stale_after_ms`) so it costs nothing for every other existing
   scheduled-item use case (nags, morning brief, reminders) which don't set
   it and are completely unaffected.
5. **Net result**: `safe_restart.sh` creates a one-shot schedule targeting
   the exact channel/topic that triggered the restart, with a generous
   `stale_after_ms` ceiling, right before attempting the restart. If
   `bus-core` comes back within that window, the wake-up fires as a real
   inbound turn (`processInbound()`, same mechanism the Scheduler already
   uses for every other schedule) — Peggy genuinely "wakes back up" in the
   right conversation. If it doesn't come back within the window, the item
   dead-letters instead of firing a confusingly-late message whenever it
   eventually does restart.

---

## Entry Criteria

- None. Additive: one new nullable column, one new optional API/tool
  param, one new conditional check in an existing tick loop, and a
  `safe_restart.sh` update.

---

## Exit Criteria

1. `POST /api/v1/schedules` accepts an optional `stale_after_ms` field
   (positive integer, milliseconds). Existing callers that omit it are
   completely unaffected (defaults to `null` = no staleness limit, current
   behavior preserved exactly).
2. `Scheduler.tick()`, for a due `type: 'once'` item with `stale_after_ms`
   set: if `now - fire_at > stale_after_ms`, does **not** call
   `processInbound()` — instead marks the item `status = 'dead_letter'`
   (a new allowed status value) and logs why. Items without
   `stale_after_ms` set, and all `type: 'cron'` items, are unaffected.
3. `schedule_message` (MCP tool) exposes the same optional param, for any
   future agent-initiated use beyond `safe_restart.sh`.
4. `scripts/safe_restart.sh` creates a one-shot schedule (via
   `POST /api/v1/schedules`, called while `bus-core` is confirmed healthy,
   right before each restart attempt) targeting the channel/topic that
   invoked the restart, with a `stale_after_ms` ceiling (e.g. 45-60
   minutes), instead of (or alongside, during a transition) its current
   live `notify_peggy()` curl-to-`/api/v1/inbound` call.
5. A real end-to-end test: restart `bus-core` with a wake-up scheduled,
   confirm a genuine inbound turn fires in the target channel/topic once
   healthy again; separately, confirm a deliberately-stale item (fire_at
   far enough in the past, `stale_after_ms` small) gets marked
   `dead_letter` on the next tick rather than firing.

---

## Stories

### S40.1 — `stale_after_ms` column + schema

**User story:** As the bus, I want to know when a scheduled one-shot has
gone stale, so I don't fire a wildly-late notification just because the
process happened to restart hours later.

**Acceptance criteria:**
1. New migration (next free number, confirm via `ls src/db/migrations/`)
   adds `stale_after_ms INTEGER` (nullable) to `scheduled_items`.
2. `ScheduleCreateSchema` (`src/http/api.ts:1188`) gets an optional
   `stale_after_ms: z.number().int().positive().optional()`, only
   meaningful when `type: 'once'` — reject (400) if set alongside
   `type: 'cron'` (a recurring schedule re-arms its own `fire_at` every
   cycle, so "staleness since fire_at" doesn't map cleanly onto it).
3. `POST /api/v1/schedules`'s INSERT includes the new column
   (`data.stale_after_ms ?? null`).
4. `ScheduledItem` interface (`src/scheduler/types.ts`) gets
   `stale_after_ms: number | null` and `'dead_letter'` added to the
   `status` union.

**Complexity:** S

### S40.2 — Staleness check in `Scheduler.tick()`

**User story:** As the bus, when I catch up on a backlog of one-shot
schedules after being down, I want overdue-beyond-tolerance ones to
dead-letter instead of firing late.

**Acceptance criteria:**
1. In the per-item loop of `tick()`, before calling `processInbound()` for
   a `type: 'once'` item: if `item.stale_after_ms != null` and
   `Date.now() - new Date(item.fire_at).getTime() > item.stale_after_ms`,
   skip firing. Update the row: `status = 'dead_letter'`,
   `last_fired_at` left untouched (it never fired), log a clear
   `console.warn` (schedule id, how overdue, the configured ceiling).
2. Items with `stale_after_ms === null` (the default, and every existing
   schedule) are completely unaffected — identical behavior to today.
3. `type: 'cron'` items are never subject to this check (see S40.1 AC2 —
   the field can't even be set on them).
4. Test: a `once` item with `fire_at` 2 hours in the past and
   `stale_after_ms` of 30 minutes → dead-lettered, `processInbound` never
   called. A `once` item 2 hours overdue with no `stale_after_ms` set →
   fires normally (regression coverage for the untouched default path). A
   `once` item overdue by *less* than its `stale_after_ms` → fires
   normally.

**Complexity:** S

### S40.3 — `schedule_message` MCP tool param + docs

**User story:** As an agent, I want to set a staleness ceiling on a one-shot
schedule I create, not just via raw HTTP.

**Acceptance criteria:**
1. `schedule_message`'s input schema (`src/mcp/tools/scheduling.ts`) gets
   the same optional `stale_after_ms` param, passed through to the
   `POST /api/v1/schedules` body unchanged.
2. Tool description update: briefly explains the use case (a wake-up that
   shouldn't fire if it's sat unfired for too long — e.g. waiting for a
   process restart that might not happen soon).
3. `docs/MCP_TOOLS.md` / scheduler docs updated with the new field and the
   `dead_letter` status value.

**Complexity:** S

### S40.4 — `safe_restart.sh`: durable, correctly-targeted wake-up

**User story:** As Chris, I want to actually hear back in the right
conversation after a restart, even if the restart script itself gets
interrupted right after kicking things off.

**Acceptance criteria:**
1. `safe_restart.sh` accepts `--notify-channel` and `--notify-topic`
   arguments (both optional; if omitted, falls back to today's generic
   `system`/`safe-restart` behavior as a safety net, with a log line noting
   the fallback).
2. Immediately before each `restart_bus_core()` call (both the first
   attempt and the post-rollback attempt), while `bus-core` is confirmed
   reachable (skip this step if it's already known to be down — nothing to
   POST to), call `POST /api/v1/schedules` with `type: 'once'`,
   `fire_at` = now + 10 seconds, the target `channel`/`topic`, `sender`
   set to the resolved contact (e.g. `contact:chris`), a `payload_body`
   describing what's about to happen (e.g. "Restarting bus-core to pick up
   a config/code change. I'll follow up here once it's back."), and
   `stale_after_ms` = 45 minutes.
3. On successful health confirmation, `notify_peggy()`'s existing
   live-curl path still fires as it does today (belt-and-suspenders during
   the transition) — the scheduled wake-up is the durable fallback for the
   case where that live call never gets a chance to run, not a replacement
   for it. (Revisit collapsing to just the scheduled path once this has
   proven itself in a couple of real restarts — noted, not required by
   this epic.)
4. Log the created schedule's id to `safe_restart.sh`'s own log file for
   traceability.
5. Manual test: run `safe_restart.sh` for a real (healthy) restart, confirm
   a schedule gets created and fires as a genuine inbound turn in the
   right channel/topic shortly after.

**Complexity:** M

### S40.5 — Tests, docs

**Acceptance criteria:**
1. Endpoint test: `POST /api/v1/schedules` with `stale_after_ms` on a
   `type: 'cron'` body → 400.
2. `docs/` scheduler reference (wherever E18/`schedule_message` is
   documented) gets a short "dead-letter on staleness" note and the
   post-restart-wakeup pattern as a worked example.
3. `CHANGELOG.md` entry under `[Unreleased]`.
4. Full existing test suite + `tsc --noEmit` pass (this touches a shared,
   heavily-used tick loop — regression coverage matters more than usual
   here).

**Complexity:** S

---

## Notes

- **Why extend the Scheduler instead of building a new `pending_wakeups`
  table.** The first design pass for this epic sketched exactly that — a
  dedicated table, a new insertion endpoint, new startup-time consumption
  logic in `index.ts`. All of that already exists, under a different name,
  in the E18 Scheduler: persisted rows, channel/topic/sender targeting,
  and "fires on the next tick even if overdue" catch-up behavior are all
  already there. The only genuinely missing piece was staleness/dead-
  lettering — a small, surgical addition, not a parallel system. Same
  reasoning shape as E32 (join, not new column) and E35 (reuse E31's
  outbound-transcript helpers) earlier this week.
- **Why keep `notify_peggy()`'s live path alongside the new scheduled one
  (S40.4 AC3), rather than replacing it outright.** The live path is
  strictly redundant once the scheduled wake-up is reliable, but removing
  it isn't necessary for this epic's exit criteria and this hasn't been
  proven in production yet — keeping both costs nothing (the schedule just
  won't have fired yet when the live notification also lands, so at worst
  Chris gets confirmation twice within a few seconds of each other) and is
  the safer rollout given tonight's two live restart attempts already
  failed outright before reaching that code.
- **Origin**: direct response to two real, same-morning incidents (2026-
  09-01) where a restart-notification never reached Chris because the
  triggering Bash call itself was blocked before `safe_restart.sh` could
  run at all — see `memory/daily/2026-09-01.md`'s `08:48`/`09:01`/`12:11`
  entries in the `peggy-claude-code` repo for the full incident narrative
  that motivated this.

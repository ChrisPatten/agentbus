# E100 — Moment fields on Surface Events

| Field | Value |
|---|---|
| Epic ID | E100 |
| Dependencies | E96 (Surface API v2), E99 (Phase web client) |
| Story Count | 6 |
| Estimated Complexity | M |
| Status | Built on `feat/e100-moment-fields` (Nov 5, 2026); not merged or deployed |

Design source: `peggy-claude-code/data/intercom/design/plum-dusk/spec.md`, section 6 (data model) and 7.3 (alerts). Follows the "Server work this exposes" list in E99.

---

## Goal

The Compact's Phase design models every Surface Event as a **Moment** with a weight, an optional consequence and changed value, a hold-or-tap kind on each button, and a lifecycle state. Today an Event has only `level` and disappears when it ends. Make the bus accept and store the Moment fields, own the lifecycle, and keep ended Events as tombstones so devices can show them in the Earlier tray with the right word. Keep the main web client behaving exactly as before.

## Decisions

1. **`weight`** (optional): `ambient | notice | decision | urgent`. `level` stays for backward compatibility. Only weight: level is derived and stored (ambient/notice → info, decision → attention, urgent → urgent). Only level: no weight is stored (clients keep mapping info → ambient, attention → decision, urgent → urgent). Both: they must agree under that mapping, else `400` naming both.
2. **`consequence`** (optional, at most 60 characters): urgent only (weight urgent or level urgent), else `400`.
3. **`changed`** (optional): `{field: start|end|place|title|other, old, new}`, `old` and `new` at most 24 characters each; urgent only.
4. **Action `kind`**: `tap | hold`. Default `hold` when the action has `confirm` or `run.sends_on_behalf`, else `tap`. Explicit `tap` on such an action is refused; explicit `hold` on a plain action is allowed. The resolved kind is stored on the action the device sees (Event buttons, the primary slot's button, approvals: both Approve and Deny are `hold`).
5. **Lifecycle `state`**: `open | answered | expired | withdrawn | cleared`, bus-owned (agents sending `state` or `ended_at` get a `400`).
   - Publishing (create or replace) sets `open`. Re-publishing an ended id starts a new life: `201`, `revived: true`, new `created_at`, fresh jobs (fire counts reset).
   - `surface_remove_event` / `DELETE` take `reason: withdrawn | answered | cleared` (default `withdrawn`). An already-ended event is left as it is (`removed: false`, its `state`).
   - The expiry sweep sets `expired` (`ended_at` = `expires_at`).
   - Auto-answer: a `done` fire on a decision or urgent Event (by weight, else level attention/urgent) ends it as `answered`, only if it is still the version that was tapped (same `updated_at`). Ambient and notice Events stay open.
   - Approvals: `weight: decision`; when no longer pending they become tombstones: `answered` (approved/denied, `ended_at` = `resolved_at`), `expired`, or `withdrawn` (stale or gone).
   - **Tombstones** stay in `events` with `state` and `ended_at`; they do not count toward `eventsPerSurface`, never block `ringPrimary`/`ringOverlap`, are never re-expired, and are purged `surface_api.event_tombstone_hours` (default 24) after `ended_at`. An open event that expired longer ago than that (bus down) is removed outright.
   - Taps on a tombstone answer the existing `expired` status with `reason` = the state (`expired`, `withdrawn`, `answered`, `cleared`); no new status, so older clients show Expired and disable the button.
   - Every transition is a `set` op carrying the whole item, so a connected device sees open → expired rather than a bare removal; resume replays it and `GET /state` equals the pushed result. Only the purge is a `remove`.
6. **Old web client**: drops every Event whose `state` is present and not `open` from its store after each delta and snapshot (`dropEnded`), so it behaves as before; it ignores the other new fields.
7. **Phase client**: weight wins over level; `changed` and `consequence` render on the urgent screen (and `changed` wins over the leave-now screen); `kind: hold` without a draft is hold-to-fire on alert pills, decision pills and the detail capsule; only open Events are Moments; terminal notice/decision/urgent Events are filed once in Earlier with their word and end time (ambient ones are not: spec 6.2 clears them when past).
8. **No migration.** Items stored before E100 have no `state` and read as `open`; their buttons have no `kind` (clients treat a draft as hold).

## Stories

- **S100.1 Validation.** `weight`/`level` agreement and derivation, urgent-only `consequence` and `changed` with bounds, action `kind` rules, `state`/`ended_at` refused; `BOUNDS.consequence` and `BOUNDS.changedValue` (`src/surface/types.ts`, `validate.ts`).
- **S100.2 Lifecycle and tombstones.** `src/surface/lifecycle.ts`; hub cap counts live events only; sweep tombstones and purges (`resources.ts`, config `surface_api.event_tombstone_hours`); ring check ignores tombstones; publish route revives, `DELETE` takes `reason`.
- **S100.3 Actions.** Tombstone taps answer `expired` + state; auto-answer of decision and urgent Events (`actions.ts`); approval tombstones (`approvals.ts`).
- **S100.4 MCP tools.** `surface_publish_event` schema and description (weight, consequence, changed, kind, urgent-only rules, lifecycle), `surface_remove_event` `reason`.
- **S100.5 Web clients and mock.** Main client `dropEnded`; Phase model and app (state filter, Earlier from tombstones, hold pills, changed over leave-now); `dev/surface-mock.mjs` stores Events as the bus does and gains `urgent`, `decide`, `end:`, `expire:`; `cdp-phase-live.mjs` checks.
- **S100.6 Tests and docs.** Unit and route tests, an end-to-end lifecycle test through the real hub with the web client's `applyDelta`; `docs/SURFACE_API.md` (shapes, bounds, lifecycle, tools), `docs/MCP_TOOLS.md`, `docs/INTERCOM_WEB.md`, site docs, CHANGELOG.

## Acceptance Criteria

- Publishing with weight only stores weight and the derived level; level only stores no weight; disagreeing weight and level, consequence or changed on a non-urgent event, and `kind: tap` on a sending button each answer `400` with a message that says what to change; nothing is written.
- Publish → `open`; remove with each reason → that state; sweep → `expired`; a decision tap → `answered`, an ambient tap stays `open`; re-publish revives; tombstones are purged after the retention; tombstones do not count toward the cap and do not block the ring.
- A device that applies every delta holds exactly `GET /state`; resume from any rev reproduces it.
- Taps on tombstones answer `expired` with the state as reason and fire nothing.
- The main web client's tests pass and a new test shows tombstones are dropped; the Phase client renders the 28 reference states as before (average mismatch 1.53%, identical to `dev`) and the live driver's new checks pass.
- `npx vitest run` and `npx tsc --noEmit` pass.

## Not in scope

- `preview` (covered by `confirm.draft`) and `place` (covered by `detail.location`).
- Notices (E89) keep their own states; they are not Moments on the bus.
- Agent-job fields in `sessions`, undo, voice: still listed in E99.

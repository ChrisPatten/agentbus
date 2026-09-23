# E52 — Pool Pane Watchdog (detect and recover stalled panes)

| Field | Value |
|---|---|
| Epic ID | E52 |
| Dependencies | E48 (cc-pool: leases, `TmuxController`, the 60s sweep, `reconcileLiveness`), E51 (approval requests — owns permission dialogs), E29/E48 hooks (`Stop` → `/turn-ended`) |
| Story Count | 6 |
| Estimated Complexity | M |
| Status | Ready — decisions recorded, not started |

---

## Epic Summary

A `cc-pool` pane can stop making progress while its tmux window is alive and
its `cc.ts` is still polling the bus. Nothing in AgentBus notices, so every
message routed to it, including scheduled jobs, is silently lost until someone
runs `tmux attach`. E51 closes one cause: a permission dialog, which now has a
Telegram approval path. E52 is the backstop for everything else, and for the
cases E51 can't reach.

Three failure classes, because each needs a different response:

1. **Blocked on a screen.** A prompt is waiting for a keypress: a resume
   prompt, folder trust, an MCP server approval, a usage-limit screen, a
   feedback survey, or a permission dialog nobody could answer.
2. **Delivered but never woken.** The message was acked by `cc.ts`, but Claude
   never started a turn. The screen sits at an idle prompt.
3. **Frozen mid-turn.** A turn started and stopped advancing: a network stall,
   a hung tool, an infinite loop.

The watchdog detects a stall from **evidence of unhandled work plus a static
screen**, classifies it, and escalates: alert, then auto-answer a screen known
to be safe, and alert again if that answer doesn't work. It ships
**observe-only first**: incidents are recorded and alerts are sent, but the
watchdog never presses a key in a pane, so real stalled screens can be
collected before any action is enabled. The pattern table has to come from
screens that actually occurred.

**Deliberately not** a general agent-quality monitor and not an LLM reading the
screen. It answers one question, "is this pane blocked and does work depend on
it", with signals the bus already has.

---

## Prior Art: What Already Exists (and Where)

- `src/pool/pool-manager.ts` — `start()` runs a 60s `sweepTick()` that calls
  `reconcileLiveness()`, `sweepHardIdle()`, and `drainParked()`.
  `reconcileLiveness()` only detects a **vanished window** (`paneAlive`); a hung
  pane has a live window, so it is invisible to it. It already captures the
  pane tail with `capturePane` and reports through `notifySystem()`, which is
  the shape this epic's alert should follow.
- `src/pool/tmux.ts` — `capturePane(target, lines)`, `sendKeys`, `killWindow`.
  No new tmux primitive is needed.
- `src/pool/lease-store.ts` — `pool_leases.last_activity_at` is bumped by
  `acquire()` (a message routed in) and by `POST /api/v1/pool/:agentId/turn-ended`
  (the `Stop` hook). It conflates the two, so on its own it cannot say "a
  message arrived and no turn ended since". S52.2 adds a dedicated column.
- `message_queue.acked_at` — `cc.ts` acks a message when it **receives** it
  (`src/adapters/cc.ts`, before the channel notification), not when Claude
  handles it. So "acked" means delivered, not handled. This is why class 2
  exists and why "no ack pending" is not evidence of health.
- `src/pool/pane.ts` `ackHandshake` — handles exactly one blocking screen (the
  `--dangerously-load-development-channels` confirmation), and only during
  launch. Nothing watches a pane after launch.
- `src/approvals/` (E51) — `PermissionRequest` hook → Telegram buttons →
  `Enter`/`Escape`. It owns permission dialogs. `PoolManager.resolveApproval()`
  already uses `capturePane` plus the `Esc to cancel` footer to recognize one.
- Scheduled jobs default to `channel: telegram`, `sender: contact:chris`
  (`src/scheduler/`), so E51 reaches Chris for them. **`system`-channel
  conversations** (restart and pool notices, `sender: pool-manager:<id>`) have
  no human contact. `resolveApprovalTarget` finds no session, or one with no
  Telegram chat, so the request is dropped (`422`, logged) or marked `stale`.
  Either way nothing alerts anyone. The watchdog is the only thing that would
  catch a pane blocked on one of those.
- Hooks live in this repo under `scripts/hooks/` and are symlinked into the
  pane project (`docs/CC_POOL_ADAPTER.md`).

---

## Entry Criteria

- E51 live. The watchdog must not fight it for permission dialogs.
- At least one real non-dialog stall captured, or S52.1 run long enough to
  capture one. S52.3's default patterns are written from captures only.

## Exit Criteria

- A leased pane with unhandled work and a screen unchanged for
  `stall_after_ms` produces an incident row with a screen snapshot and a
  Telegram alert to the configured contact, within one sampling interval of the
  threshold.
- No alert or action for an idle pane with no unhandled work, however long its
  screen is static, and none for a pane whose screen is advancing.
- A screen matching an allow-listed pattern is answered automatically, and the
  incident records whether the screen changed afterward.
- If an auto-answer doesn't work as expected (the screen doesn't change, the
  same pattern still matches, or the keys can't be sent), a second alert says
  so. The watchdog does not retry.
- `GET /api/v1/pool` and `/pool` show a pane's stall state.

## Non-Goals

- Replacing E51. A permission dialog with a pending approval request is E51's;
  the watchdog steps in only after that request is `expired` or `stale`.
- Interpreting screens with an LLM.
- Automatic recycling: killing a stalled pane's window and relaunching it. Deferred; see [Deferred](#deferred).
- Watching `cc-headless` or the single persistent `claude-code` session.
- Detecting a slow-but-progressing turn. Only "no progress" is a stall.

---

## Detection Model

Sampling runs on its own interval, `sample_interval_ms` (default 30s), not the
60s sweep, so a threshold of a few minutes resolves to within one sample. For
each `leased` pane:

1. `capturePane(pane, 40)` and hash the result into `screen_hash`. Track
   `screen_changed_at` per pane, in memory. A bus-core restart resets it, which
   errs toward not alerting.
2. Load the pane's **unhandled work**: `message_queue` rows for the pane's
   recipient with `acked_at` later than `last_turn_ended_at`
   (`NULL` counts as before all of them). Its oldest `acked_at` is
   `unhandled_since`.
3. The pane is **stalled** when all hold:
   - `unhandled_since` exists and is older than `stall_after_ms` (default 5 min);
   - `now - screen_changed_at` is at least `stall_after_ms`;
   - no pending approval request for the pane (E51 owns it).

An idle pane has a static screen but no unhandled work, so it never matches. A
working pane's screen advances (spinner, elapsed timer, token count), so it
never matches either. **The hash must not strip that timer:** a moving timer is
the liveness signal. S52.1 verifies this against a real working pane before
anything depends on it.

### Classification

Once stalled, in order:

1. **Known screen**: the captured text matches an entry in the pattern table.
   The entry names the action.
2. **Idle prompt**: no working indicator and no dialog (class 2). Delivered but
   never woken.
3. **Working indicator, frozen** (class 3): `esc to interrupt` present, screen
   static.
4. **Unknown blocked**: anything else.

### Actions

Two actions, and the pattern table decides which applies:

| Action | When | Effect |
|---|---|---|
| **Alert** | The stall matches no `answer` pattern (classes 2 and 3, unknown, or a known screen marked `alert`), or an auto-answer failed | Telegram DM with the class, pane, conversation, how long, and the last 15 screen lines |
| **Auto-answer** | The screen matches a pattern marked `answer` and `observe_only` is off | `sendKeys`, re-sample, and stay quiet if it worked |

An auto-answer **worked** when, after a short delay, the screen changed and no
longer matches the pattern. It **failed** when any of these hold, and each
sends its own alert ("auto-answer did not work") naming the keys sent and
what the screen looked like afterward:

- the screen is unchanged;
- the same pattern still matches;
- `sendKeys` threw;
- the incident is still open after another `stall_after_ms`.

A failed answer is never retried. A retry could press keys into a screen the
bus no longer understands.

Alerts go to the contact's Telegram DM. Each alert is deduplicated per
incident, except that a failed auto-answer always sends its own. Alerts are
rate-limited per pane.

In `observe_only` mode a pattern marked `answer` is treated as `alert`: the
watchdog reports the screen and never presses a key.

## Data Model

Migration `020_pane_watchdog.sql`:

```sql
ALTER TABLE pool_leases ADD COLUMN last_turn_ended_at TEXT;  -- set by /turn-ended

CREATE TABLE pane_incidents (
  id TEXT PRIMARY KEY,
  pool_id TEXT NOT NULL,
  pane_id TEXT NOT NULL,
  conversation_id TEXT,
  class TEXT NOT NULL,            -- known_screen | idle_prompt | frozen_turn | unknown_blocked
  pattern TEXT,                   -- pattern-table entry name, if any
  detected_at TEXT NOT NULL,
  unhandled_since TEXT,
  screen_snapshot TEXT NOT NULL,  -- full captured text, kept locally, never sent verbatim
  actions TEXT,                   -- JSON array: [{ at, action, result }]
  resolved_at TEXT,               -- screen changed, turn ended, or lease released
  resolution TEXT                 -- recovered | answered | answer_failed | released | superseded
);
CREATE INDEX idx_pane_incidents_open ON pane_incidents(pool_id, pane_id, resolved_at);
```

`screen_snapshot` is stored in full because it is the input to writing better
patterns. It can contain conversation content, so it stays in the local db, and
alerts carry only a trimmed tail.

## Configuration

Under `adapters.cc-pool`, all optional:

```yaml
watchdog:
  enabled: true
  observe_only: true        # never presses a key; incidents and alerts still happen
  sample_interval_ms: 30000
  stall_after_ms: 300000    # 5 minutes
  alert_contact: chris      # default: see below
  patterns: []              # extra entries; defaults are added by S52.3
```

`observe_only: true` ships as the default until Chris flips it.

**Alert contact.** Alerts go to a Telegram DM. `alert_contact` defaults to the
one configured contact that has a Telegram id, and the watchdog refuses to
enable alerting at startup, with a logged reason, if there isn't exactly one
and none is named. This applies to every stall, including `system`-channel
ones, which have no human on the conversation to address.

---

## Stories

### S52.1 — Screen sampler and stall detector (observe-only)

- New `src/pool/watchdog.ts`: per-pool sampler on `sample_interval_ms`, screen
  hash and `screen_changed_at`, the stall predicate above.
- Migration 020's `pane_incidents` table and a small store.
- On a stall, write an incident with the snapshot and log it. **No alert and
  no keys in this story;** alerting arrives in S52.4.
- Verify the unknowns against a real pane and record the answers in the doc:
  (a) a working pane's captured screen changes between samples, (b) an idle
  pane's does not, (c) what a class-2 idle-prompt stall looks like, (d) the
  exact text that marks a working turn (`esc to interrupt` is assumed, not
  confirmed).
- Tests use a fake `TmuxController` and injectable clock, like
  `pool-manager.test.ts`.

### S52.2 — Activity signal and unhandled-work query

- `pool_leases.last_turn_ended_at`, set by `/turn-ended` alongside the existing
  `touch()`.
- `unhandledWork(pane)` query against `message_queue` by recipient.
- Confirm the `Stop` hook fires per assistant turn, including for a turn that
  ends with a permission denial or interrupt. If it doesn't, list the cases
  here, because they would look like stalls.

### S52.3 — Classifier and pattern table

- Pattern table in `src/pool/watchdog-patterns.ts`: `{ name, match, action }`
  where `action` is `alert`, or `answer` with the keys to send. Seeded **only**
  from screens captured by S52.1. Nothing in it is guessed.
- Config `patterns` extends and can disable defaults.
- Skip panes with a pending E51 request; once it is `expired` or `stale`, the
  pane is eligible.
- Tests use recorded screens as fixtures.

### S52.4 — Actions: alert and auto-answer

- Alert: Telegram DM to `alert_contact` through the normal outbound path,
  deduplicated per incident and rate-limited per pane. Trimmed tail only.
- Auto-answer: `sendKeys`, re-sample after a short delay, and judge it
  worked or failed by the rules in [Actions](#actions). On failure, send the
  "auto-answer did not work" alert and never retry.
- Skipped entirely while `observe_only` is on; the pattern is alerted instead.
- Every action and its result is appended to the incident's `actions`.
- `system`-channel stalls alert the same way, closing E51's gap.
- Tests cover each failure condition: unchanged screen, pattern still
  matching, `sendKeys` throwing, and the incident staying open.

### S52.5 — Observability

- `GET /api/v1/pool` gains per-pane `stall` (`null` or the open incident's
  class, age, and pattern).
- `GET /api/v1/pool/incidents?open=1`.
- `/pool` shows the stall state.
- `make pool-incidents`, alongside `make pool`.

### S52.6 — Docs

- New section in `docs/CC_POOL_ADAPTER.md`: the three classes, the predicate,
  the two actions, config, and how to move from observe-only to enabled.
- Include the manual recovery for a stalled pane (see [Deferred](#deferred)).
- Cross-link from `docs/APPROVALS.md` (what E51 leaves to the watchdog).
- `docs/HTTP_API.md`, `CHANGELOG.md`, `sprint-status.yaml`.

---

## Risks and Mitigations

- **False positives.** An alert on a healthy pane is noise, and an
  auto-answer on the wrong screen could change a live turn. Mitigation:
  requires unhandled work and a static screen for `stall_after_ms`;
  observe-only ships first and never presses a key; each action is recorded
  with its evidence.
- **The liveness signal is unverified.** The predicate assumes a working pane's
  captured screen changes. If the timer isn't in the capture, a long turn looks
  frozen. S52.1 verifies this before S52.3 or S52.4 start.
- **Patterns drift with the CLI.** A `claude` update can reword a prompt, as
  `launch_ack_pattern` already had to. Mitigation: config-overridable table,
  and the generic stall path catches an unrecognized screen anyway.
- **Screen content in alerts.** A captured screen can hold private content.
  Mitigation: alerts send a 15-line tail to the configured contact only; the
  full snapshot never leaves the local db.
- **Alert fatigue.** A pane that keeps stalling would page repeatedly.
  Mitigation: per-incident dedupe, per-pane rate limit, and a failed
  auto-answer alerts once instead of retrying.
- **Auto-answering the wrong thing.** Only patterns marked `answer` get keys,
  each seeded from a real capture, and a key that doesn't change the screen
  raises an alert rather than a retry.

## Decisions

Recorded 2026-09-23.

| Question | Decision |
|---|---|
| Who gets alerts? | Telegram DM. `system`-channel stalls go to the same DM. |
| `stall_after_ms` | 5 minutes. |
| Auto-answer | Allowed for allow-listed patterns. An answer that doesn't work as expected must alert. |
| Rollout | Observe-only for now: alerts and incident records, no keys pressed. |
| Recycle | Deferred. |

## Deferred

**Recycle** means killing a stalled pane's tmux window and starting it again,
the way restarting a frozen app does. The pool relaunches the pane, with
`claude --resume <session>` when the conversation's active `sessions` row
holds a Claude session id, so the history comes back. That id is not always
stored (see the P1 item in `maintenance-backlog.md`), and without it the pane
starts a fresh session. It is
deferred because the watchdog would also have to decide what to do with
messages the pane had received but not handled. Re-sending them could repeat
work the pane had partly done (a tool already ran, a reply already went out),
and dropping them loses the job.

Until that is designed, the manual version already works: kill the window with
`tmux kill-window -t peggy-pool:<N>`. `reconcileLiveness()` notices the missing
window within 60 seconds and releases the lease, and the next message to that
conversation launches a fresh pane. It resumes the session only if the id was
stored. The message the
pane was stuck on is not re-sent. The alert text should say this.

## Sequencing

S52.1 and S52.2 first, in parallel. Ship S52.1 and let it run to collect real
stalled screens. S52.3 waits on those captures. S52.4 after S52.3.
S52.5 alongside S52.4. S52.6 throughout, finalized last.

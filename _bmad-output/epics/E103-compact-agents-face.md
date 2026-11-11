# E103 — The Compact: Agents face

**Status:** approved for build (Chris, Nov 9, 2026)
**Repos:** firmware `~/workspace/intercom-firmware` (most of the work); AgentBus `~/workspace/agentbus` only if a gap below needs it
**Design:** `~/workspace/peggy-claude-code/data/intercom/design/plum-dusk/` — spec.md §6.3 (Agent job), §7.4 (Agents), §5 row 9 (agent count ring on Now), §8 / §8.1 (navigation), list-row component (§ "List row (Agents, Earlier, Settings)"). Reference screens: `screens/04-agent-activity/{a-nothing-running,b-several-running,c-one-waiting-on-me}.png` (+ `.layout.png` / `.html` with exact coordinates). Precedence: **spec over boards**; where both are silent, copy the Phase web client.
**Reference implementation:** the Phase web client already draws this face from live data: `~/workspace/agentbus/apps/intercom-web/phase/model.js` (`sessionState`, `agentsModel`, `questionOf`) and `screens.js` / `app.js` (the Agents face). Port its behaviour, not its code style.

## Why

The firmware has Day, Now and Thread. Agents is the one face of the four (Day · Now · Agents · Thread) that is missing. It shows the agent working for you: what is running, what failed, and what is waiting on you, with the question and its buttons right there.

## What exists already

- **Bus:** Surface v2 resource `sessions` (`src/surface/sessions.ts`, type `SurfaceSession` in `src/surface/types.ts`): `id, title, subject, state (stuck|waiting|working|finished|idle), channel, conversation_id, since, last_activity_at, needs_you, needs_you_message_id, system`. Already ordered needs_you first. System and routine sessions are excluded by default; idle/finished drop out after `activity_timeout_min` (30).
- **Firmware:** `main/intercom_ws.c` keeps only `events` and `notices` (`s_res[2]`) and ignores other resources. `main/thread.c` draws the followed conversation and fetches pages over HTTP (`/api/v1/surface/conversations/:id?limit=`); message buttons already work there. Faces are routed by the gesture router in `main/earlier.c` (`thread_swipe_lv` before `dayview_swipe_lv`); `thread.h` notes that Agents is not built, so Thread sits directly right of Now today.
- **Fonts:** Chris ruled Nov 9 that the spec's font sizes are great on the device. Use spec sizes as-is.

## Stories

### S103.1 — Keep the `sessions` resource on the device
- Add `sessions` to the kept resources in `intercom_ws.c` (reset + delta, revs on resume, callback `s_cbs.sessions`). Watch PSRAM/cJSON memory: at most 24 sessions.
- Confirm on the live bus that the `compact` surface actually receives `sessions` (check `/api/v1/intercom/ws` hello/reset handling and any per-surface resource filter). If it does not, fix it in AgentBus on a branch (see Rules).
- Map to job state exactly like `sessionState()` in model.js: needs_you or waiting → waiting; stuck → failed; working → working; finished → done; idle → hidden.

### S103.2 — The Agents face (spec §7.4, board 04)
Faces become **Day · Now · Agents · Thread**: swipe left from Now → Agents, again → Thread; swipe right goes back. Update the gesture router and the thread.h comment.
- **Nothing running:** two still `hair` rings (r 58 at (233,164)) + one `rose` dot · NOTHING RUNNING (y 250) · "LAST: <NAME>, <h:mm AM/PM>" (y 282) from the most recent done job, omitted when none · "Hold BOOT and ask" (y 324, Hanken 18/24).
- **Several running:** top curved caption counts ("1 failed · 2 working", order waiting, failed, working) · up to 3 list rows at y 90, 164, 238, widths 258 / 290 / 282 · status glyph per state · name in caps (subject, else title) · detail "working · 12m" / "done · 2m ago" / "needs you" · "+N WORKING" or "+N MORE" (y 322). Sort waiting, failed, working, done.
- **One waiting on me** (a job with needs_you, shown in place of the list when it is the top row): "<NAME> · NEEDS YOU" (y 100, `peri`) · the question as headline (y 130, Hanken 600 26/32, 2 lines) · "ASKED N MIN AGO" (y 226) · "RUNNING N MIN" · capsule with up to 3 option buttons + OPEN. The question and options come from the answer-needed message (`needs_you_message_id`) fetched from that session's conversation page, as `questionOf()` does. A tap sends the button exactly as Thread buttons do today; the bus clears needs_you.
- Durations and the face refresh at least once a minute while shown. Agents never wakes the device and never takes over the screen (the waiting job already appears on Now as a decision when the agent publishes one).

### S103.3 — Open a job's thread
- Tapping a row (or OPEN) opens that session's conversation in the Thread face (by `conversation_id`), with a way back (swipe right / PWR as today). The followed conversation stays the default Thread.
- Verify the device token may read and act on a conversation other than the followed one. If the bus refuses, add the narrowest bus change (e.g. allow conversations listed in this surface's `sessions`) on an AgentBus branch.
- If a session has no `conversation_id`, the row is not tappable.

### S103.4 — Agent count ring on Now (spec §5 row 9)
- At (46, 233), r 16, 1.5 px `hair` ring, count numeral 15 px 600 `ink`, centred. Shown only when ≥ 1 job is **working**; the count is working jobs only.

### S103.5 — Docs and checks
- Update `thread.h`, firmware README/notes, and the compact-device skill text block for Peggy to paste (do **not** edit files in peggy-claude-code; put the suggested skill text in your report).
- Build clean (`. ~/esp/esp-idf/export.sh && idf.py build` ends "Project build complete", no new warnings).
- If you touch AgentBus: `npx vitest run` and `npx tsc --noEmit` pass; CHANGELOG entry.

## Acceptance
1. With no active sessions, Agents shows NOTHING RUNNING with the LAST line when a job finished recently.
2. With several sessions, rows sort and caption correctly; "+N" appears past 3.
3. A session flagged `answer_needed` (agent replies with `answer_needed` + choices in the Compact topic) shows the waiting layout with its question and buttons; a tap reaches the agent as `[tapped] <label>` and the face returns to the list.
4. Tapping a row opens that conversation in Thread.
5. The count ring shows on Now only while something is working.
6. Navigation Day · Now · Agents · Thread works both ways; PWR returns to Now from Agents.
7. No memory regressions: `/info` internal_free and psram_free comparable to before after 10 min with sessions churning.

## Rules for the build agent
- Firmware: work in a worktree `git -C ~/workspace/intercom-firmware worktree add ../intercom-firmware-wt-agents -b agents-face main`. Commit there. Do **not** merge to main, do **not** OTA or USB-flash the device (Peggy verifies and installs).
- AgentBus (only if needed): worktree `git -C ~/workspace/agentbus worktree add ../agentbus-wt-e103 -b feat/e103-agents-face dev`. Do not merge, push or restart bus-core. Never touch `_bmad-output/backlog.md` in the main checkout.
- Never print tokens; read them from `~/workspace/agentbus/.env` inside commands. Don't message anyone through AgentBus.
- Commit trailer: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Report: commit hashes per repo, what you verified and how, anything you could not verify, and deviations from the spec with reasons.

## Out of scope
Queued state from the bus (no source yet), failed-job detail screens, Capture, wake word, Surface API redesign.

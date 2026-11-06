# E99 — Phase (Plum Dusk) web client for the Compact

| Field | Value |
|---|---|
| Epic ID | E99 |
| Dependencies | E89 (notifications), E93 (web prototype), E96 (Surface API v2), E97 (web client v2: `socket.js`, `surface.js`, `actions.js`) |
| Story Count | 7 |
| Estimated Complexity | L |
| Status | Built on `feat/e99-phase-ui` (Nov 5, 2026); not merged or deployed |

Design source: `peggy-claude-code/data/intercom/design/plum-dusk/` (`spec.md`, `README.md`, the eight boards and 28 reference PNGs). Requested by Chris, Nov 5, 2026, for usability testing of the Phase design on an iPhone before the Compact firmware.

---

## Epic Summary

Build the Phase design as a second web client at `/intercom/phase/`, next to the current one (which stays unchanged), so Chris can use it on his phone against the live bus. It is a static app (HTML, CSS, ES modules, no build, no CDN, local fonts) that reuses the shared socket, store and actions modules, renders every screen in the spec from the bus's data where the bus has it, and fakes the rest locally where it does not yet (Earlier, Settings, quiet hours, Capture).

`spec.md` wins over the boards; where it is silent the board is matched; the remaining choices are listed in `docs/INTERCOM_WEB.md` ("Decisions where the spec and boards were silent").

## Stories

- **S99.1 Shell and pairing.** `index.html`, manifest ("Compact Phase", scope `/intercom/phase/`, shared icons), local fonts, `intercom.pair` pairing (`#pair=`, pasted link or code), true size, Large, physical size in landscape (`?ppi=`, `?calibrate=1`), text field and Send, Side and Power stand-ins.
- **S99.2 Rendering primitives.** Spec tokens only; clip to r 233; crescent from NOAA sunrise and sunset (default Mansfield 42.0334, -71.2190); 60-dot rim, Moments with lanes, now dot and moon on the real second; progress arcs (Now only); curved captions cut by measured arc length; capsule with Hold to confirm (0.8 s wipe, early release cancels); pills, rows, glyphs, icons; motion, reduced motion, burn-in walk.
- **S99.3 Faces from live data.** Day · Now · Agents · Thread; Events → Moments (weight from `weight`, else level); sessions → agent states; the waiting question from `/conversations/{id}`; Thread with live appends; count ring of working sessions.
- **S99.4 Alerts and actions.** Notices (info → Inform 20 s → Earlier; attention → Decision; urgent → flood with rim drain to `expires_at`), approvals as a Decision through Confirm, Sent only on `done`, WAITING after 3 s, TRY AGAIN on failure or timeout; Offline screen when the socket is down.
- **S99.5 Local-only screens.** Earlier tray (localStorage, HOLD TO CLEAR), Settings (brightness overlay, volume stored, quiet hours, Daylight city with "Use phone location", Agent row), dim and rest, quiet-hours night layout with END QUIET HOURS, push-to-talk (Web Speech or placeholder), Capture timer and Saved, power menu, Pairing layout.
- **S99.6 Dev hooks.** `?demo` picker over the 28 states and `?state=<board>/<id>` frozen render.
- **S99.7 Verification and docs.** Unit tests, board screenshot comparison report, live mock driver, `docs/INTERCOM_WEB.md`, site docs, CHANGELOG.

## Acceptance Criteria

- `/intercom/phase/` loads on the bus with no server change; `/intercom/` is unchanged; `socket.js`, `surface.js`, `actions.js` and `logic.js` are unchanged and their tests pass.
- No colour outside the spec tokens (tested over all 28 states); only Lexend Exa and Hanken Grotesk are loaded, from `phase/fonts/`.
- Unit tests cover clock-to-point, the crescent table (within 2 px), the drain dot count, countdown rules, weight mapping, session mapping and Earlier storage.
- Every board state renders at 466 x 466 and is compared with its PNG (`phase/dev/SCREENSHOTS.md`); the larger differences are spec-over-board choices that are listed.
- The live driver passes against the mock: pairing, rim Moments, a notice, an attention action with hold-to-confirm, offline and reconnect, and no console errors.
- `npx vitest run` and `npx tsc --noEmit` pass for the repo.

## Server work this exposes (later epics)

- Moment fields: `weight`, `state`, `consequence`, `changed`, `preview`, and an action `kind` (hold, primary, ghost).
- Agent-job fields in `sessions`: queued, failed, done with a time, and the waiting question directly (today it needs a conversation fetch).
- A bus-side undo for sent actions and typed messages (Sent and Understood show no UNDO today).
- Voice: the E92 push-to-talk route and Capture recording upload.
- Pairing codes shown on the device (spec alphabet without O, I, 1 and 0).
- Location from the phone for the crescent (today a stored city or the browser's geolocation).
- An expected-interval or stale signal from the bus (the client calls 30 s without a frame stale).
- The mock (`dev/surface-mock.mjs`) should mirror v1 notifications into the v2 `notices` resource as the bus does.

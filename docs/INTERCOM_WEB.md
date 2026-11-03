# Intercom web app (E93)

`apps/intercom-web/` is the iPhone prototype of Intercom: a round, glanceable status surface for the agent. It is a static site (HTML, CSS, ES modules, no build step, no framework, no CDN). The bus serves it at `/intercom/`; it talks to the bus through the Intercom adapter's HTTP routes and WebSocket (`/api/v1/intercom/*`). The wire contract is `data/intercom/m0-contract.md` in the agent's workspace; this page describes the client.

## Files

| File | Purpose |
|---|---|
| `index.html`, `styles.css`, `manifest.webmanifest`, `icons/` | Page shell, look, Home Screen manifest and icons (180, 192, 512 px) |
| `app.js` | State, view selection, pairing, send form, wake lock |
| `socket.js` | WebSocket client: hello and cursor, backoff, outbox, ping, 4401 |
| `wake.js` | Keeps the screen on: Screen Wake Lock with a hidden-video fallback (see Home Screen install) |
| `logic.js` | Pure helpers: 24 h geometry, calendar selection, backoff, glance, outbox, notification map, screen priority, quiet hours (unit-tested) |
| `dial.js`, `screens.js` | SVG rims and the HTML of each dial screen |
| `demo.js` | Scripted `?demo` walkthrough: the nine mockup screens plus three notification steps |
| `dev/` | `mock-server.mjs`, `desk.test.js`, `cdp-flow.mjs` and `cdp-notify.mjs` (screenshot drivers), `frame.html`, `logic.test.js`, `notifications.test.js`, `screenshots/` |

## The dial

The dial is a 466 x 466 design square scaled with CSS. Default size is **true size**, 268 CSS px (1.75 in on an iPhone 16 Pro Max). The "Large" toggle fills the page width minus 32 px (limited by the available height); the choice is kept in `localStorage`. Everything outside the dial is plain: connection dot, size toggle, a text field and Send button.

**Landscape.** Turn the phone on its side and only the dial shows: the text field, Send button, caption and size toggle are hidden (CSS `@media (orientation: landscape) and (max-height: 600px)`; they return in portrait) and the connection dot floats at the top left (press and hold still unpairs). The dial is centred and respects the notch (safe-area insets). It is drawn at the real physical size of the Compact: `DIAL_INCHES` (1.75 in, the figure the project documents; override with `?diam=1.48` if the active area measures smaller) times CSS px per inch, default 160, so 280 CSS px at the default (the bezel adds about 8% around it). iPhones are 153 to 163 CSS px per inch, so calibrate once: open the app with `?calibrate=1`, hold a ruler to the brass bar and press + or - until it is exactly 1 inch; the value is stored in `localStorage` (`intercom.ppi`), or set it directly with `?ppi=153`. The size comes from `physicalDialSize` in `logic.js` and is clamped to fit the height only if dial plus bezel would exceed it, which does not happen on iPhones at normal ppi. The Large toggle is ignored in landscape. The manifest `orientation` is `any`, so the Home Screen app rotates. The wake lock is unaffected.

Readability rules, in design units: text at least 26 px, primary text 34 px or more, clock 110 px or more (130 in the idle view), nothing important within 30 px of the rim, buttons at least 72 px tall and at most 4, secondary grey no darker than `#b3aa9a`.

Views, in priority order (`pickScreen` in `logic.js`):

1. **Not paired**: explains briefly; the text field accepts a pasted code or link.
2. **Connecting / Offline**: shown once the socket has been down for about 1.5 s.
3. **Listening**: not wired yet (E92).
4. **Reply**: the glance in serif; tap to expand and scroll the full plain-text body; double-tap or 60 s of no touch returns to the dial. "More on Telegram" when the reply is flagged.
5. **Working, your own turn**: the `status_text` (or "Working") with a turning gold arc, while `activity` is `running` or `queued` for an interaction this surface opened (a typed send or a notification action); also for a few seconds after you send.
6. **Done**: a check mark and a few words for about 2 s after an `interaction` closes. (Not in the contract's list; it is a two-second flourish and sits here.)
7. **Needs you**: while there are active `attention` or `urgent` notifications, and not during quiet hours.
8. **Working, another turn**: a running turn that did not come from this surface.
9. **Quiet** (22:00 to 06:30 on the phone's clock) or a **desk face** (below). The **Idle day-dial**: 24 h ring with midnight at the top, one arc per timed event (overlaps move to inner lanes, past events dim), gold now-dot, 12-hour clock without seconds, date, the next event in amber (`4:10 · ENT`), and all-day items as a small line under the date. Redrawn every 15 s.

## Desk faces (E94)

When nothing outranks them (pairing, offline, reply, working, done and notice cards all win), the dial shows one of two desk faces, or the colour-only quiet face. Faces do not auto-switch: swipe left or right (or press the arrow keys) and the face stays, remembered in `localStorage` (`intercom.face`; `?face=status` or `?face=day` sets it directly). `chooseDeskFace` in `logic.js` is the one function that picks the face, the seam for smart switching later. Data comes from `GET /api/v1/intercom/desk` and the `desk` event (poll every 60 s as a fallback); see `docs/INTERCOM.md`.

- **Face 1, agent status ring.** One rim segment per session (gaps between), coloured by state: teal working, amber waiting on you, red stuck, brass finished recently, grey idle. The centre reads `3 working` and, under it, `1 needs you` (a zero line is left out; nothing active shows `All quiet`). "Needs you" means waiting on you or stuck. While something needs you the rim breathes amber (static amber under `prefers-reduced-motion`). Tap to flip to a list of up to five sessions (title, state, age) and tap again to return; a needs-you row opens the matching notice when one exists (a notification whose `source` equals the session title, or whose `key` is the session id). Titles only, no message content.
- **Face 2, day ring with leave-by.** The day-dial plus, when the server reports a `departure`: the date line becomes `Leave in N min` (within 60 minutes) or a dim `Leave 7:20` beyond; a pressure ring on the rim (green beyond 30 minutes, amber 30 to 10, red under 10, pulsing gently under 5, static under reduced motion); `Late` in red for up to 10 minutes after, then it drops to the next departure; and on office days (per the plan file) a train line such as `7:01 train` under the next event (amber with the new time when `delay_min` is set). Pressure replaces the attention halo while a departure is showing. The departure is computed on the bus; for located events it is a rough estimate (start minus 20 minutes travel minus a 5-minute buffer, no routing). Train lines follow the office-day plan (see `docs/INTERCOM.md`), so a work-from-home day shows none.
- **Quiet face (22:00 to 06:30).** Colour only, no text or numbers: two soft blurred lights drifting slowly (no static edges, burn-in safe) at no more than 12 percent brightness, 20 percent when something needs you. Teal calm, amber needs you (a session, or an attention notice that is being held back by quiet hours), red a stuck session, brass an info notice waiting. It replaces both faces and the old clock-and-count Quiet screen. As before, attention and urgent cards do not interrupt quiet hours (see Notifications); the colour carries it instead.
- **Face down** turning the screen off is a device-only behaviour (the Compact's motion sensor) and is not part of the web build. Nothing here reads motion or the microphone.

## Notifications (E89)

The client follows `m1-notifications-contract.md`. It keeps a map of `notification` events by id (durable, replayed by cursor, plus the post-welcome snapshot of every active or acknowledged item). `resolved` and `expired` drop an item; an update older than the held `updated_at` is ignored; items past `expires_at` are hidden locally. Only `active` items count; `acknowledged` ones do not. The `attention` event (`{level, count}`) is kept and drives "n waiting" on Quiet.

- **Needs-you screen.** An amber inset glow (an `urgent` item pulses slowly), the title (34 px or more, at most two lines), one clamped line of body in amber, up to three action buttons from `actions` (styled from `style`: `success` green, `danger` red, otherwise plain) and **Got it** (added automatically; skipped when an action is itself labelled "Got it", case-insensitive, which dismisses the item as any action does), so four buttons at most, each 72 px tall. With one or two buttons and a short title the buttons stack and a small "NEEDS YOU" label shows; otherwise the buttons sit in a compact two-column grid and the label is dropped to keep everything clear of the rim. With more than one item a "1 of N" counter shows; tap it or swipe left or right to move through them. Order: urgent before attention, newest first.
- **Reading the full text.** When the title or body is probably cut off (body over about 24 characters, or a long title) a small "Tap to read" shows under the body. Tapping the title or body opens an expanded view: the full title and body in a scrollable area (as with a long reply), then the item's buttons and a **Back** button; tapping the text again or **Back** returns to the compact card. Swiping to another item, or tapping any button, also closes it. The expand tap only covers the text, so buttons and the "1 of N" counter work as before.
- **Taps.** An action sends `notification_action` `{client_msg_id, id, index}` through the same outbox as typed sends (stable id, resent after reconnect, dropped after 10 minutes or on `notification_not_found`). Its `ack` carries an `interaction_id`; the app records it as its own, so Working and Reply show as for a typed message. **Got it** sends `notification_ack` and the item disappears at once (the app re-sends pending acks after every `welcome` until the server reports the item is no longer active).
- **Info items** never glow. Idle shows a brass dot and "1 note" under the date; tap it to open the item on the Needs-you screen (calm, no glow, "Got it" only unless it has actions).
- **Rim halo.** A thin amber halo on the day-dial's rim while an `attention` or `urgent` item is active. The needs screen normally takes over, so the halo shows on Idle only when something with higher priority is not on screen.
- **Quiet.** 22:00 to 06:30 on the device clock (`isQuietHours`, to be made configurable later). Needs-you never shows, nothing glows, and the colour-only quiet face carries the status. A reply or your own Working screen still shows. Dev override: `?quiet` forces quiet, `?quiet=0` forces the day screens.

## Pairing

Run `npx tsx scripts/intercom-pair.ts <surface_id>` on the bus host; it prints a URL like `https://host.ts.net/intercom/#pair=CODE`. Open it on the iPhone. The app reads the fragment, POSTs `{code}` to `/api/v1/intercom/pair`, stores `{surface_id, token}` in `localStorage` (`intercom.pair`) and removes the fragment with `history.replaceState`. The token is never put in a URL. Codes are single use. Long-press the connection dot to unpair (an in-page confirmation, then the stored credentials are cleared). A WebSocket close with code 4401 also returns the app to the pairing view. Since E96 the stored `token` is the paired device's own credential (the pair answer also carries `credential`, `device_id`, `scope`, `profile` and `cert_fingerprint`, which the app ignores), and the app still talks to the `/api/v1/intercom/*` alias with protocol v1. When the device is revoked (`scripts/surface-devices.ts revoke`), the bus closes the socket with 4403; the app's reconnect is then refused with 4401 and it returns to the pairing view. See [SURFACE_API.md](SURFACE_API.md).

## Connection

- `wss://` on HTTPS, `ws://` otherwise, same origin, `/api/v1/intercom/ws`.
- First frame is `hello` `{token, cursor, client}`. The cursor is the highest durable `seq` seen (`intercom.cursor`). On `welcome.reset` the cursor jumps to `latest_seq` and local state is dropped.
- Reconnect backoff 0.5 s doubling to 10 s, with a little jitter; it resets on `welcome`. The client pings every 15 s and reconnects if nothing arrives for 75 s.
- Typed sends go into an outbox (`intercom.outbox`) with a `client_msg_id` (`crypto.randomUUID`). Unacked sends are resent with the same id after reconnect; an `ack` (`queued` or `rejected`) removes them.
- `GET /api/v1/intercom/today` (Bearer) is fetched on load, on becoming visible and every 5 minutes as a fallback to the `calendar` event.
- Replayed `reply` events older than 2 minutes, or repeating the last `message_id`, are not shown.

## Home Screen install

iOS gives a Home Screen app its own storage, separate from Safari, and the launch URL drops the `#pair=` fragment. So install first, then pair inside the installed app: in Safari open `/intercom/` (no code), Share, **Add to Home Screen**; launch it from the icon; paste the pairing link (or just the code) into the text field and tap **Pair**. Codes are single use, so generate a fresh one for this. It opens full screen (no browser chrome, black status bar, safe-area aware). 

### Keeping the screen on

While the app is open the display is kept awake (`wake.js`). It requests `navigator.wakeLock.request('screen')` on load and again on the first touch, key or pointer (some browsers insist on a gesture), whenever the page becomes visible again, and whenever a held lock is released while the page is visible. During quiet hours (22:00 to 06:30 on the phone's clock, same rule as the Quiet screen; `?quiet` and `?quiet=0` apply here too) it holds no lock and releases any it has; a 60 s timer re-checks, so it takes the lock at 06:30 and drops it at 22:00. The decision is the pure `shouldHoldWakeLock` in `logic.js`. Where `navigator.wakeLock` is missing it falls back to a 1 px, muted, looping inline video (about 1.6 KB, NoSleep style) started on the first touch and paused in quiet hours. Every step is wrapped so a failure never affects the UI.

Limits: iOS only supports the Wake Lock API in Home Screen web apps from iOS 18.4; before that the video fallback is best effort and may not work. Low Power Mode, or the phone being locked manually, still turns the screen off. At night the phone then sleeps normally.

## Demo and mock server

- `/intercom/?demo` plays eighteen steps: the nine mockup screens (the quiet one is now colour only), a second quiet colour, the status ring, the status list and the day face with leave-by (on time and delayed), then a day-dial with a note dot and rim halo, an urgent three-action item with "1 of 3", and a calm note (tap the dial to advance, otherwise automatic). `?demo=5` starts at step 5; add `&hold` to stop auto-advance.
- `node apps/intercom-web/dev/mock-server.mjs` serves the app and speaks the contract (needs the repo's `node_modules` for `ws`). `PORT` defaults to 3098. Open `http://localhost:3098/intercom/#pair=demo-code`. Typing a message plays activity (running, status lines), a reply, and a closed interaction; `long: ...` returns a long flagged reply; `/revoke` closes the socket with 4401. Notifications: a sample item appears about 2.5 s after connect; type `notify: Title` (attention, two actions), `notify!: Title` (urgent, three actions), `note: Title` (info) or `clear:` (resolve all). Desk mode: it serves `GET /api/v1/intercom/desk` and sends `desk` events; type `desk: needs` (a session waiting on you), `desk: stuck`, `desk: delay N` (train N minutes late), `desk: leave N` (leave in N minutes; negative for late) or `desk: clear`; the default leave time is 45 minutes ahead. View a face with `http://localhost:3098/intercom/?face=status&quiet=0#pair=demo-code` or `?face=day&quiet=0`, and the night face with `?quiet`. It accepts `notification_ack` and `notification_action` (the latter starts an interaction with `[tapped] <label>`) and emits `notification` and `attention` events.
- `node apps/intercom-web/dev/cdp-flow.mjs` drives headless Chrome through the live flow and writes screenshots to `dev/screenshots/`; `PORT=3097 node apps/intercom-web/dev/cdp-notify.mjs` does the same for the notification flow (use `?quiet=0` when running at night).
- Tests: `npx vitest run apps/intercom-web`.

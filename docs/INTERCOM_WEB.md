# Intercom web app (E93)

`apps/intercom-web/` is the iPhone prototype of Intercom: a round, glanceable status surface for the agent. It is a static site (HTML, CSS, ES modules, no build step, no framework, no CDN). The bus serves it at `/intercom/`; it talks to the bus through the Intercom adapter's HTTP routes and WebSocket (`/api/v1/intercom/*`). The wire contract is `data/intercom/m0-contract.md` in the agent's workspace; this page describes the client.

## Files

| File | Purpose |
|---|---|
| `index.html`, `styles.css`, `manifest.webmanifest`, `icons/` | Page shell, look, Home Screen manifest and icons (180, 192, 512 px) |
| `app.js` | State, view selection, pairing, send form, wake lock |
| `socket.js` | WebSocket client: hello and cursor, backoff, outbox, ping, 4401 |
| `logic.js` | Pure helpers: 24 h geometry, calendar selection, backoff, glance, outbox (unit-tested) |
| `dial.js`, `screens.js` | SVG rims and the HTML of each dial screen |
| `demo.js` | Scripted `?demo` walkthrough of the nine mockup screens |
| `dev/` | `mock-server.mjs`, `cdp-flow.mjs` (screenshot driver), `frame.html`, `logic.test.js`, `screenshots/` |

## The dial

The dial is a 466 x 466 design square scaled with CSS. Default size is **true size**, 268 CSS px (1.75 in on an iPhone 16 Pro Max). The "Large" toggle fills the page width minus 32 px (limited by the available height); the choice is kept in `localStorage`. Everything outside the dial is plain: connection dot, size toggle, a text field and Send button.

Readability rules, in design units: text at least 26 px, primary text 34 px or more, clock 110 px or more (130 in the idle view), nothing important within 30 px of the rim, buttons at least 72 px tall and at most 4, secondary grey no darker than `#b3aa9a`.

Views, in priority order:

1. **Not paired**: explains briefly; the text field accepts a pasted code or link.
2. **Connecting / Offline**: shown once the socket has been down for about 1.5 s.
3. **Reply**: the glance in serif; tap to expand and scroll the full plain-text body; double-tap or 60 s of no touch returns to the dial. "More on Telegram" when the reply is flagged.
4. **Working**: the `status_text` (or "Working") with a turning gold arc, while `activity` is `running` or `queued`; also for a few seconds after you send.
5. **Done**: a check mark and a few words for about 2 s after an `interaction` closes.
6. **Idle day-dial**: 24 h ring with midnight at the top, one arc per timed event (overlaps move to inner lanes, past events dim), gold now-dot, 12-hour clock without seconds, date, the next event in amber (`4:10 · ENT`), and all-day items as a small line under the date. Redrawn every 30 s.

Listening, Choice, Needs you, Draft and Quiet exist as screens and appear in `?demo` only (M0).

## Pairing

Run `npx tsx scripts/intercom-pair.ts <surface_id>` on the bus host; it prints a URL like `https://host.ts.net/intercom/#pair=CODE`. Open it on the iPhone. The app reads the fragment, POSTs `{code}` to `/api/v1/intercom/pair`, stores `{surface_id, token}` in `localStorage` (`intercom.pair`) and removes the fragment with `history.replaceState`. The token is never put in a URL. Codes are single use. Long-press the connection dot to unpair (an in-page confirmation, then the stored credentials are cleared). A WebSocket close with code 4401 also returns the app to the pairing view.

## Connection

- `wss://` on HTTPS, `ws://` otherwise, same origin, `/api/v1/intercom/ws`.
- First frame is `hello` `{token, cursor, client}`. The cursor is the highest durable `seq` seen (`intercom.cursor`). On `welcome.reset` the cursor jumps to `latest_seq` and local state is dropped.
- Reconnect backoff 0.5 s doubling to 10 s, with a little jitter; it resets on `welcome`. The client pings every 15 s and reconnects if nothing arrives for 75 s.
- Typed sends go into an outbox (`intercom.outbox`) with a `client_msg_id` (`crypto.randomUUID`). Unacked sends are resent with the same id after reconnect; an `ack` (`queued` or `rejected`) removes them.
- `GET /api/v1/intercom/today` (Bearer) is fetched on load, on becoming visible and every 5 minutes as a fallback to the `calendar` event.
- Replayed `reply` events older than 2 minutes, or repeating the last `message_id`, are not shown.

## Home Screen install

iOS gives a Home Screen app its own storage, separate from Safari, and the launch URL drops the `#pair=` fragment. So install first, then pair inside the installed app: in Safari open `/intercom/` (no code), Share, **Add to Home Screen**; launch it from the icon; paste the pairing link (or just the code) into the text field and tap **Pair**. Codes are single use, so generate a fresh one for this. It opens full screen (no browser chrome, black status bar, safe-area aware). The Screen Wake Lock API keeps the display on while the page is visible where iOS supports it; elsewhere nothing happens.

## Demo and mock server

- `/intercom/?demo` plays all nine screens (tap the dial to advance, otherwise automatic). `?demo=5` starts at screen 5; add `&hold` to stop auto-advance.
- `node apps/intercom-web/dev/mock-server.mjs` serves the app and speaks the contract (needs the repo's `node_modules` for `ws`). `PORT` defaults to 3098. Open `http://localhost:3098/intercom/#pair=demo-code`. Typing a message plays activity (running, status lines), a reply, and a closed interaction; `long: ...` returns a long flagged reply; `/revoke` closes the socket with 4401.
- `node apps/intercom-web/dev/cdp-flow.mjs` drives headless Chrome through the live flow and writes screenshots to `dev/screenshots/`.
- Tests: `npx vitest run apps/intercom-web`.

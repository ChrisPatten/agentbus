# Intercom web app (E93)

`apps/intercom-web/` is the iPhone prototype of Intercom: a round, glanceable status surface for the agent. It is a static site (HTML, CSS, ES modules, no build step, no framework, no CDN). The bus serves it at `/intercom/`; it talks to the bus through the Surface API v2 (`/api/v1/surface/*`, protocol 2) and falls back to the legacy Intercom routes (`/api/v1/intercom/*`, protocol 1) when the surface path is not available. The wire contracts are [SURFACE_API.md](SURFACE_API.md) (v2) and `data/intercom/m0-contract.md` in the agent's workspace (v1); this page describes the client.

## Files

| File | Purpose |
|---|---|
| `index.html`, `styles.css`, `manifest.webmanifest`, `icons/` | Page shell, look, Home Screen manifest and icons (180, 192, 512 px) |
| `app.js` | State, view selection, pairing, send form |
| `socket.js` | WebSocket client: protocol 2 hello with revs and cursor, v1 fallback, backoff, outbox, ping, `view` frame, 4401 |
| `logic.js` | Pure helpers: 24 h geometry, calendar selection, backoff, glance, outbox, notification map, screen priority, quiet hours (unit-tested) |
| `surface.js` | Surface v2 resource store (`createStore`, `applyDelta`, `applyState`, `revsOf`), slot, face and approval selectors |
| `dayv2.js` | Day Dial v2 logic: ring model and layer stacking, tick placement, ring-tap nearest-Event and carousel order, hit testing, scrub, travel and leave-by, primary and context slot decisions, widget registry |
| `statusv2.js` | Agent Status v2 model (session rows, rim segments and cap), conversation page merging |
| `actions.js` | The one action path: request body, result interpretation, button states, confirm-draft gating |
| `dial.js`, `screens.js` | SVG rims and the HTML of each dial screen |
| `demo.js` | Scripted `?demo` walkthrough: the nine mockup screens plus three notification steps |
| `dev/` | `mock-server.mjs` and `surface-mock.mjs` (the mock bus, v1 and v2), `publish-demo.mjs` (demo content for a live bus), `cdp-surface.mjs`, `cdp-legacy.mjs`, `cdp-flow.mjs`, `cdp-notify.mjs` (headless Chrome drivers), tests (`surface.test.js`, `desk.test.js`, `logic.test.js`, `notifications.test.js`, `publish-demo.test.js`, `legacy-token.test.js`), `screens/` and `screenshots/` (a few small PNGs) |

## The dial

The dial is a 466 x 466 design square scaled with CSS. Default size is **true size**, 268 CSS px (1.75 in on an iPhone 16 Pro Max). The "Large" toggle fills the page width minus 32 px (limited by the available height); the choice is kept in `localStorage`. Everything outside the dial is plain: connection dot, size toggle, a text field and Send button.

**Landscape.** Turn the phone on its side and only the dial shows: the text field, Send button, caption and size toggle are hidden (CSS `@media (orientation: landscape) and (max-height: 600px)`; they return in portrait) and the connection dot floats at the top left (press and hold still unpairs). The dial is centred and respects the notch (safe-area insets). It is drawn at the real physical size of the Compact: `DIAL_INCHES` (1.75 in, the figure the project documents; override with `?diam=1.48` if the active area measures smaller) times CSS px per inch, default 160, so 280 CSS px at the default (the bezel adds about 8% around it). iPhones are 153 to 163 CSS px per inch, so calibrate once: open the app with `?calibrate=1`, hold a ruler to the brass bar and press + or - until it is exactly 1 inch; the value is stored in `localStorage` (`intercom.ppi`), or set it directly with `?ppi=153`. The size comes from `physicalDialSize` in `logic.js` and is clamped to fit the height only if dial plus bezel would exceed it, which does not happen on iPhones at normal ppi. The Large toggle is ignored in landscape. The manifest `orientation` is `any`, so the Home Screen app rotates.

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
9. **Quiet** (22:00 to 06:30 on the phone's clock) or a **desk face** (below). The **Day Dial** is described under "Surface v2".

A **view** (Event focus, Approval, draft, Conversation; see below) outranks every screen except pairing and offline, and returns to the face on Back or after 120 s without a touch.

## Desk faces

When nothing outranks them (pairing, offline, views, reply, working, done and notice cards all win), the dial shows one of the desk faces, or the colour-only quiet face. Faces do not auto-switch: swipe left or right (or press the arrow keys) and the face stays, remembered in `localStorage` (`intercom.face`; `?face=status` or `?face=day` sets it directly). With the v2 connection the order and the enabled flags come from the `faces` resource (the web app draws `day` and `status`; `desk` and unknown names are skipped); on the legacy path it is day then status. `chooseDeskFace` in `logic.js` is the one function that picks the face.

- **Quiet face (22:00 to 06:30).** Colour only, no text or numbers: two soft blurred lights drifting slowly at no more than 12 percent brightness, 20 percent when something needs you. Teal calm, amber needs you (a session, or an attention notice held back by quiet hours), red a stuck session, brass an info notice waiting. It replaces both faces. Attention and urgent cards do not interrupt quiet hours (see Notifications); the colour carries it instead.

  **Quiet escape.** Quiet hours never lock you out: a **left swipe** on the quiet face (more than 40 design px, mostly sideways; the right arrow key does the same) takes you to the main face, the Day Dial, and normal face navigation (swipe or arrow keys between day and status) works from there. A right swipe on the quiet face does nothing. The escape is an in-memory override (`S.quietEscape`, decided by `quietEscapeActive` in `logic.js`): it lasts until the quiet window ends (the first update after 06:30 clears it, so the next 22:00 shows the quiet face again) and in any case for at most 12 h. While it holds, the screen priority treats quiet as off, so a waiting Needs-you card shows as it does by day. A page reload also returns to the quiet face (swipe again). Swipe handling on other faces and the ring carousel is unchanged. Checked by `dev/desk.test.js` and the quiet-escape steps in `dev/cdp-surface.mjs` (`?quiet` forces the quiet face).
- **Face down** turning the screen off is a device-only behaviour (the Compact's motion sensor) and is not part of the web build.

## Surface v2 (E97)

### Connection and store

The socket opens `/api/v1/surface/ws` and sends `hello` with `protocol: 2`, the token, the v1 `cursor` and `revs` (the store's per-resource revs, zero ones omitted). The `welcome` frame (`version: 2`) is followed by the resume frames: a `delta` from our rev, or a `reset` when we have none or are behind the log. The store (`surface.js`) holds `faces`, `events`, `slots`, `widgets`, `sessions`, `notices` and `device` with a rev each. A delta applies only when `base_rev` equals our rev and then takes `rev` (ops are atomic: a `patch` of a missing item voids the frame); a stale rev is ignored; a `base_rev` mismatch is a gap, which ignores the frame and re-syncs through `GET /api/v1/surface/state` (at most one every 2 s). `reset` replaces a collection. A 60 s timer (and every return to the page) also fetches `state` as a poll fallback. The v1 events (`reply`, `activity`, `interaction`, `calendar`, `desk`, `notification`, `attention`), the outbox and sends all keep working over the v2 socket.

**Fallback.** On a 4401 from the v2 path the client tries the legacy path (`/api/v1/intercom/ws`, protocol 1); a 4401 there too is "pairing rejected" as before. Two attempts in a row that never reach a welcome (a bus without the v2 path) also switch paths, and a v1 `welcome` to a v2 hello is treated as v1. On the legacy path there is no store: the Day Dial draws the calendar (below), Agent Status uses the `desk` sessions, notice buttons use `notification_action`, and no `view` frames are sent. Every page load tries v2 first; the browser console shows one failed WebSocket line when the bus has no v2 path. The stored token is the device credential (for a phone paired before E96, the legacy device). `dev/legacy-token.test.js` runs the bus's own surface routes in-process and shows the legacy credential authenticates on `/api/v1/surface/health`, `/state`, `/actions` and `/ws` (hello protocol 2).

### Day Dial v2

Drawn from surface data only when the connection is v2: **the ring, the ticks and the default primary line come from surface `events` and `slots`, not from the calendar** (the agent chooses which calendar items to push; Mr. Patten, Nov 3). On the legacy path the old calendar-derived day ring, "Clear for today" line and all-day line are kept as the fallback. The 24 h ring, midnight at top, gold progress ball, leave-by pressure rim, attention halo and the past-events fade are unchanged.

- **Segments.** A `kind: event` with `at` and `end` draws an arc. `layer` `primary` (default) is wide on the main track; `overlap` is narrow (8 px), the first overlapping one inside the main track, the second outside (the bus allows 1 primary and 2 overlaps at any moment). `color` is a hex or one of the ten names. Past segments draw at 40 percent.
- **Ticks.** An Event with `at` only is a small mark across the rim (this is how deadlines show), coloured by `color` if the bus allowed one, else by `level` (urgent red, attention amber, otherwise cream).
- **Travel.** `travel.minutes` draws a dashed, 40 percent wedge of the same colour before the event and feeds the leave-by line: the Event whose `at - minutes` is soonest (up to 10 minutes late) is turned into a departure. The context line shows the earlier of that and the bus's `desk` departure (the train), through the existing `departureView` (green over 30 minutes, amber, red, pulse under 5, "Late" for 10 minutes). When the bus marks the departure `on_my_way` with a `live.departs` time (the user tapped "On my way"), the line reads `Departs 7:09` in green from the tap until a minute after that live time, in place of the countdown and "Late"; without `live` it falls back to the normal behaviour.
- **Tap (Event carousel).** Tapping the ring anywhere in a generous band (`RING_TAP`, radius 166 to 250 design px: from just inside the inner track to just past the rim, `inRingBand`) opens the **Event carousel**, a horizontal set of cards, one per ring Event of today (segments and ticks both, `carouselOrder`: by start time, a segment before a tick at the same time, then id). Past Events stay in the list, greyed. It opens on the Event nearest the tap in time (`nearestRingEvent`, measured around the 24 h ring from the tapped hour to the Event's start; zero when the tap falls inside a segment's span; a tick uses its time; equal distances go to the earlier one). The press must not be on the gold ball (that starts a scrub), and taps on the centre text or buttons and in the dead zone in the middle behave as before. With no Events today, or `event_ring: false`, a ring tap does nothing. Bars and ticks no longer need to be hit exactly (the per-target `hitTest` is still exported and tested, but the Day Dial does not use it).
- **Carousel view.** Each card is the Event focus content: `n of N` counter row with previous and next arrows (and dots for up to nine cards), time range, title, `detail.location`, `detail.image` (fetched from `/api/v1/surface/assets/<hash>` with the bearer token and shown through a blob URL), `body`, `detail.description`, the travel line (`20 min by drive before`) and the Event's buttons (at most three) through the same action path (Sent, Failed, Expired states; a `confirm.draft` action opens the draft step and returns to the same card; an approval Event is never a card). An `opens: conversation` Event's card adds an **Open conversation** button, which opens the Conversation view (Back returns to the card). Move between cards by swiping horizontally (more than 50 design px and mostly sideways), the arrows, or the left and right arrow keys; the cards wrap round. A card slides in from the side of the swipe, or swaps instantly under `prefers-reduced-motion`. A card taller than the dial scrolls vertically. Back, Escape, 120 s without a touch, or the Event disappearing from the ring closes the view (Back returns to the Day Dial; closing keeps the view-priority rule above). Nothing about an Event outside today's ring model is shown. The older single **Event focus** view still exists for the Needs-you Review path and is unchanged.
- **Scrub.** Only the gold ball starts a scrub (press within 34 design px of it); the rest of the dial keeps its swipe and tap behaviour. Dragging moves the ball (pointer capture, touch or mouse) and the centre shows that time and the Event there (a surface primary first, then an overlap) or "Free". After release it snaps back to now about 4 s later (a timer, no animation, so reduced motion needs nothing). The dial uses `touch-action: none` only while the Day Dial is showing so the drag is not taken for a scroll.
- **Primary slot** (the amber line under the time). Default: the next surface Event or tick with a time today. A live `primary` slot (until its `until`) overrides it; with an `action` it adds a 72 px button under the text. With no slot and no upcoming surface Event **nothing is shown** (no "Clear for today" in v2). `layout.slots.primary: false` hides it.
- **Context slot** (above the time). At most two text lines. A departure ("Leave in N min") takes the first line; then a live `context` slot adds its `lines` (up to the room left), or its `widgets` (up to three that exist and can be drawn, in one row, in place of the date); with neither, the date. `layout.slots.context` (`lines` or `widgets`) limits the form drawn, `event_ring: false` hides the ring Events. The face re-renders on every delta.
- **Widget registry** (`widgetView` in `dayv2.js`; the bus stores `{id, type, data}` and does not fix the shapes, so these are this client's): `text` `{text|value, label?}`; `gauge` or `progress` `{value, max=100, label?, color?, text?}` (a 38 px ring and the percentage); `countdown` `{to|at|until, label?}` (`2h 15m`, recomputed with the clock); `icon`, `icon-with-value`, `icon_with_value` `{icon, value, label?}` (the icon is a glyph or short text, not an image); `sparkline` or `sparkline-lite` `{points: number[], label?}` (up to 24 points). An unknown type draws its `data.text`, else nothing. A gauge's `label` is not drawn (the cell is only wide enough for the value).

### Agent Status v2

A small clock at the top, a scrollable list of the sessions in the order the server sent them (needs_you first), four rows in view (64 design px each, snapping), and one rim segment per session (the first eight, then a "+N" marker). A row is the session `subject`, else its `title`, a dot in the state colour and the age; `needs_you` sessions are amber with an amber outline and the rim breathes (static amber under `prefers-reduced-motion`). Text is 26 design px at the smallest. Tapping a row with a `conversation_id` opens the Conversation view. No message text is on the face. On the legacy path the rows come from the `desk` sessions, and a needs-you row opens its matching notice as before.

### Conversation view

`GET /api/v1/surface/conversations/<id>?limit=30` on open, older pages with `before=<next_before>` when the list is scrolled to the top (the scroll position is kept), the newest message in view on open. The client sends `{type: "view", view: "conversation:<id>"}` when the view opens (and again after a reconnect) and `{view: null}` when it closes, and appends `conversation_append` events for that conversation (repeat ids ignored; it sticks to the bottom only if you were at the bottom). Messages are bubbles by role (you on the right). A message's `buttons` are tappable: they fire `conversations:<id>` with `action_id` = the button index and `message_id`. Back returns to the previous view or the face; Escape does the same on a keyboard.

### Actions and Approval

One function (`fire` in `app.js`, `submitAction` in `actions.js`) sends every button through `POST /api/v1/surface/actions` with a fresh `idempotency_key` per tap: Event and slot buttons (`events:<id>`, `slots:primary`), notice buttons (`notices:<id>`, action id = the index), conversation buttons. The button shows **Sending…**, then **Sent** (`done`; disabled), **Already sent** (`already_done`; disabled), **Expired** (disabled) or **Failed** (a retryable failure re-enables after 4 s; `invalid`, `forbidden`, `not_found`, `read_only`, `confirm_required`, `draft_mismatch` and `no_route` stay disabled). On the legacy path notice buttons still use `notification_action` through the outbox.

An action with `confirm.draft` opens the **draft step** first: the exact text in quotes with Send and Hold. Send posts the same text back as `draft`; Hold returns. The client refuses to send a confirm action without its exact draft (no network call), so there is no way to fire it from the face. After Sent the draft view returns to where it came from. A `kind: approval` Event is not drawn on the ring. Pending ones ride the Needs-you screen as an item (the title, "Approval needed", **Review** and **Got it**, which hides it locally only); Review opens the **Approval view**: the title, `approval.detail` exactly as sent (monospace, scrollable) and the Event's approve and deny buttons (deny styled destructive, through the same action path). An approval answered elsewhere or expired leaves the list.

### Decisions where the brief was open

- The calendar does not auto-draw in v2 (above); `today` is still fetched for the legacy fallback.
- Views time out after 120 s without a touch (the device is meant to rest on its face). While a view is open a reply or a "done" flourish does not take the screen; they show when it closes.
- Notice and approval tapping while the status face is up works as before; approvals use the Needs-you screen rather than a face because the web build has no Approvals face.
- Gauge labels, long context lines (40 characters at 26 px do not fit 300 px, they are cut with an ellipsis) and the density of a face with a leave line, widgets, a primary button and a train line are untested on the real round display.
- Not built: voice, recording, Picker and Card views beyond Event focus and the carousel, face layout editing, notice history.

## Notifications (E89)

The client follows `m1-notifications-contract.md`. It keeps a map of `notification` events by id (durable, replayed by cursor, plus the post-welcome snapshot of every active or acknowledged item). `resolved` and `expired` drop an item; an update older than the held `updated_at` is ignored; items past `expires_at` are hidden locally. Only `active` items count; `acknowledged` ones do not. The `attention` event (`{level, count}`) is kept and drives "n waiting" on Quiet.

- **Needs-you screen.** An amber inset glow (an `urgent` item pulses slowly), the title (34 px or more, at most two lines), one clamped line of body in amber, up to three action buttons from `actions` (styled from `style`: `success` green, `danger` red, otherwise plain) and **Got it** (added automatically; skipped when an action is itself labelled "Got it", case-insensitive, which dismisses the item as any action does), so four buttons at most, each 72 px tall. With one or two buttons and a short title the buttons stack and a small "NEEDS YOU" label shows; otherwise the buttons sit in a compact two-column grid and the label is dropped to keep everything clear of the rim. With more than one item a "1 of N" counter shows; tap it or swipe left or right to move through them. Order: urgent before attention, newest first.
- **Reading the full text.** When the title or body is probably cut off (body over about 24 characters, or a long title) a small "Tap to read" shows under the body. Tapping the title or body opens an expanded view: the full title and body in a scrollable area (as with a long reply), then the item's buttons and a **Back** button; tapping the text again or **Back** returns to the compact card. Swiping to another item, or tapping any button, also closes it. The expand tap only covers the text, so buttons and the "1 of N" counter work as before.
- **Taps.** An action sends `notification_action` `{client_msg_id, id, index}` through the same outbox as typed sends (stable id, resent after reconnect, dropped after 10 minutes or on `notification_not_found`). Its `ack` carries an `interaction_id`; the app records it as its own, so Working and Reply show as for a typed message. **Got it** sends `notification_ack` and the item disappears at once (the app re-sends pending acks after every `welcome` until the server reports the item is no longer active).
- **Info items** never glow. Idle shows a brass dot and "1 note" under the date; tap it to open the item on the Needs-you screen (calm, no glow, "Got it" only unless it has actions).
- **Rim halo.** A thin amber halo on the day-dial's rim while an `attention` or `urgent` item is active. The needs screen normally takes over, so the halo shows on Idle only when something with higher priority is not on screen.
- **Quiet.** 22:00 to 06:30 on the device clock (`isQuietHours`, to be made configurable later). Needs-you never shows, nothing glows, and the colour-only quiet face carries the status. A reply or your own Working screen still shows. Dev override: `?quiet` forces quiet, `?quiet=0` forces the day screens.

## Pairing

Run `npx tsx scripts/intercom-pair.ts <surface_id>` on the bus host; it prints a URL like `https://host.ts.net/intercom/#pair=CODE`. Open it on the iPhone. The app reads the fragment, POSTs `{code}` to `/api/v1/intercom/pair`, stores `{surface_id, token}` in `localStorage` (`intercom.pair`) and removes the fragment with `history.replaceState`. The token is never put in a URL. Codes are single use. Long-press the connection dot to unpair (an in-page confirmation, then the stored credentials are cleared). A WebSocket close with code 4401 also returns the app to the pairing view. Since E96 the stored `token` is the paired device's own credential (the pair answer also carries `credential`, `device_id`, `scope`, `profile` and `cert_fingerprint`, which the app ignores), and the app now tries `/api/v1/surface/*` with protocol 2 first, falling back to the `/api/v1/intercom/*` alias with protocol v1 (see Surface v2). Pairing itself still goes through `/api/v1/intercom/pair`, unchanged. When the device is revoked (`scripts/surface-devices.ts revoke`), the bus closes the socket with 4403; the app's reconnect is then refused with 4401 and it returns to the pairing view. See [SURFACE_API.md](SURFACE_API.md).

## Connection

- `wss://` on HTTPS, `ws://` otherwise, same origin: `/api/v1/surface/ws` first, `/api/v1/intercom/ws` as the fallback (see Surface v2).
- First frame is `hello` `{token, cursor, client}` (plus `protocol: 2` and `revs` on the v2 path). The cursor is the highest durable `seq` seen (`intercom.cursor`). On `welcome.reset` the cursor jumps to `latest_seq` and local state is dropped.
- Reconnect backoff 0.5 s doubling to 10 s, with a little jitter; it resets on `welcome`. The client pings every 15 s and reconnects if nothing arrives for 75 s.
- Typed sends go into an outbox (`intercom.outbox`) with a `client_msg_id` (`crypto.randomUUID`). Unacked sends are resent with the same id after reconnect; an `ack` (`queued` or `rejected`) removes them.
- `GET /api/v1/intercom/today` (Bearer) is fetched on load, on becoming visible and every 5 minutes as a fallback to the `calendar` event.
- Replayed `reply` events older than 2 minutes, or repeating the last `message_id`, are not shown.

## Home Screen install

iOS gives a Home Screen app its own storage, separate from Safari, and the launch URL drops the `#pair=` fragment. So install first, then pair inside the installed app: in Safari open `/intercom/` (no code), Share, **Add to Home Screen**; launch it from the icon; paste the pairing link (or just the code) into the text field and tap **Pair**. Codes are single use, so generate a fresh one for this. It opens full screen (no browser chrome, black status bar, safe-area aware). 

## Demo and mock server

- `/intercom/?demo` plays the scripted screens: the nine mockup screens, the quiet colours, the Agent Status list, the leave-by day face (on time and delayed), the note dot and halo, urgent and long Needs-you items, and the Surface v2 set (Day Dial v2 with overlaps, a tick, a travel wedge and context lines; scrubbing; a primary slot button; Event focus; Approval; Conversation). Tap the dial to advance, otherwise automatic. `?demo=5` starts at step 5; add `&hold` to stop auto-advance.
- `node apps/intercom-web/dev/mock-server.mjs` serves the app and speaks both contracts (needs the repo's `node_modules` for `ws`). `PORT` defaults to 3098. Open `http://localhost:3098/intercom/?quiet=0#pair=demo-code`. The mock starts with calendar-style Events across today (busy blocks, lunch, J practice, Celtics) so the ring is populated. Typing a message plays activity, a reply and a closed interaction; `long: ...` returns a long flagged reply; `/revoke` closes the socket with 4401. `MOCK_NO_V2=1` refuses the v2 socket path to exercise the fallback.
- **v1 commands** (unchanged): `notify: Title`, `notify!: Title`, `note: Title`, `clear:` (resolves notices), `desk: needs`, `desk: stuck`, `desk: delay N`, `desk: leave N`, `desk: clear`.
- **Surface v2 commands** (typed as a message; they change resources and push deltas): `event: dentist` (primary segment with travel, detail, image, a confirm-draft button and a plain one), `event: fail` (a button that fails), `event: expired` (a button that answers expired), `event: chat` (opens a conversation), `overlap` (two narrow overlaps over the dentist), `tick: bill` (a deadline tick), `travel` (an Event 45 minutes out with 30 minutes of travel), `slot: primary` (override with a confirm-draft button), `slot: context lines`, `widgets` (gauge, countdown, icon in the context slot), `sessions` (six sessions), `needs` (a session that needs you, with a question and three buttons in `conv-main`), `approval` (a bus approval), `convo` (a new agent message with buttons, appended live), `calendar` (reseed the calendar-style Events), `clear` (remove all Events, slots, widgets, sessions and notices). `dev/surface-mock.mjs` implements the resources, the op log and resume, `/state`, `/conversations`, `/assets`, `/actions` (idempotency, one-shot, draft echo) and the `view` frame.
- `node apps/intercom-web/dev/publish-demo.mjs` publishes demo Events, slots and widgets to a live bus (ids prefixed `demo-`) through `/api/v1/surface-publish/*`, using `BUS_TOKEN` from the environment (never printed), so the phone shows the new faces; `--clear` removes them, `--widgets` puts widgets in the context slot, `--dry-run` prints the requests. Its buttons post a harmless `[demo]` message into the followed conversation. `publish-demo.test.js` runs its payloads through the bus's own validators.
- `PORT=3098 node apps/intercom-web/dev/cdp-surface.mjs [outDir]` drives headless Chrome through the v2 flows against the mock (pairing, segments, taps, draft, scrub, slots, widgets, approval, status, conversation, landscape, a 466 px dial), prints PASS or FAIL per check and any console errors, and saves dial screenshots; `MOCK_NO_V2=1` on the mock plus `cdp-legacy.mjs` checks the fallback. `cdp-flow.mjs` and `cdp-notify.mjs` are the older drivers (the notification one needs `?quiet=0` at night).
- Tests: `npx vitest run apps/intercom-web`.

## Phase (Plum Dusk, E99)

A second, separate client for usability testing the Compact's "Phase" design on an iPhone, served at `/intercom/phase/` (note the trailing slash) next to the existing client, which is unchanged. The design source is `peggy-claude-code/data/intercom/design/plum-dusk/` (`spec.md` wins over the boards; where the spec is silent the board is matched; the remaining choices are listed below). Static HTML, CSS and ES modules, no build step, no framework, no CDN; the only fonts are Lexend Exa and Hanken Grotesk (and its italic), shipped in `phase/fonts/` with their OFL licences.

### Files (`apps/intercom-web/phase/`)

- `index.html`, `manifest.webmanifest` ("Compact Phase", scope and start URL `/intercom/phase/`, the existing `../icons`), `phase.css` (spec 3.1 colour tokens on `:root`, the only colours used; motion; reduced motion).
- `time.js` (zoned time and the spec's text forms), `sun.js` (NOAA sunrise and sunset, daylight fraction, the crescent's centre), `geom.js` (dial geometry: clock angle to point, arcs, the rim drain, the moon, the burn-in walk, the Settings sliders).
- `model.js`: pure mapping from bus data to Moments and face models (weights, sessions, rim marks and lanes, countdown, Now, Day, detail, alerts, quiet hours). `earlier.js`: the Earlier tray in `localStorage`.
- `prims.js` (SVG and HTML primitives: crescent, rim, marks, now dot and moon, progress arcs, curved captions cut by measured arc length, icons, glyphs, capsule, pills, rows) and `screens.js` (one view-model builder per screen).
- `states.js`: the 28 board states with frozen times, for `?state=` and `?demo`.
- `app.js`: wiring (socket, store, screen choice, actions, rest and quiet hours, push-to-talk, Capture, the hardware stand-ins, Settings).
- It reuses `../socket.js`, `../surface.js`, `../actions.js` and `../logic.js` unchanged.

### Using it

- Pairing is shared with the main client (`intercom.pair` in `localStorage`): `/intercom/phase/#pair=CODE`, or paste the link or code in the text field and tap Pair. Unpaired, the dial shows the Pairing screen and mirrors the pasted code.
- The dial is drawn at true size (466 px of CSS at the phone's density); **Large** fills the width. In landscape the chrome hides and the dial is drawn at physical size using the same `?ppi=` setting as the main client (`intercom.ppi`), and `?calibrate=1` shows the calibration panel.
- Below the dial: a text field and Send (the message goes to the followed conversation and opens Understood), **Side** (hold for push-to-talk; double-press starts or stops Capture) and **Power** (click wakes or returns to Now; hold 3 s for the power menu). Keyboard: Space is Side, Escape or `p` is Power, arrow keys swipe.
- **Keep screen on** (checkbox next to Reduced motion; hidden where `navigator.wakeLock` is missing): a manual Screen Wake Lock for the phone's real screen, saved as `phase.keepAwake` (default off). It is re-requested when the page becomes visible and on the next tap, fails quietly, and is separate from the dial's simulated dim and rest (`phase/wake.js`).
- Faces, by horizontal swipe: Day · Now · Agents · Thread. Swipe down for Settings, up for Earlier.
- `?demo` adds a picker over all 28 states (live data is ignored while a state is shown); `?state=<board>/<id>` (for example `?state=01-home/b-busy-day`) renders one state frozen, the way the screenshot driver uses it. Dev switches: `?quiet` or `?quiet=0` force quiet hours on or off, `?fast` divides the dim and rest times by 10.

### Live data versus local only

Live from the bus: Now, Day and event detail (from surface Events, as Moments), rim marks and the progress arcs, alerts (Events by weight, notices, approvals), the Agents face and the waiting question (sessions plus `GET /conversations/{id}`), the Thread face (the followed conversation, live appends through the `view` frame), sending text (Understood, then the agent's answer), the connection glyph and the Offline screen.

- Event weight comes from `weight` when present, otherwise from `level` (info → ambient, attention → decision, urgent → urgent). Approvals become a Decision whose action uses Confirm. `consequence` and `changed` are read if present (the server does not send them yet).
- Notices: info shows as Inform for 20 s, then goes to Earlier; attention is a Decision; urgent floods rose with the rim draining to `expires_at`. Notices come from the v2 `notices` resource and the v1 `notification` events, merged.
- Sessions: `needs_you` or waiting → waiting, stuck → failed, working → working, finished → done; idle is hidden. The count ring on Now shows working sessions.
- Actions go through `POST /api/v1/surface/actions` with an idempotency key. SENT ✓ shows only on `done` (or `already_done`); after 3 s without an answer the capsule shows WAITING, and TRY AGAIN on failure or after 10 s.

Local only (prototype): the Earlier tray (`phase.earlier`, capped at 30, HOLD TO CLEAR keeps open items), Settings (brightness is an overlay, volume is stored only, quiet hours default 10 PM-7 AM, the Daylight city with "Use phone location", the Agent row), set-aside alerts (`phase.aside`), dimming and rest (outside quiet hours: dim to 40% after 30 s untouched, rest as a dimmed Now 2 min after that; in quiet hours the night layout rests after 20 s and a touch shows END QUIET HOURS), push-to-talk (Web Speech `SpeechRecognition` when the browser has it, otherwise a placeholder that sends nothing), Capture (a local timer; Saved says it is a prototype), the power menu.

### Decisions where the spec and boards were silent

- Captions are cut to a measured arc length (top 375 px, bottom 400 px), calibrated so the board's "Q4 PLANNING WITH PLATFORM…" fits.
- The crescent uses the morning branch at a daylight fraction of exactly 0.5, so noon matches the spec table (466).
- Capsule segments are fitted to their labels with equal spare space. Labels longer than 10 characters are cut without an ellipsis (logged once).
- Sent: UNDO is not offered (the bus has no undo). A draft action opens Confirm with HOLD TO SEND; EDIT is not offered. An approval's Confirm offers DENY as a hold in place of EDIT.
- LATER and Power on an alert set it aside into Earlier as open. Notices are acknowledged on the bus only by GOT IT and Dismiss.
- "N missed" counts open or expired Earlier items since the last time Now was seen. The Now label reads "NEXT h:mm", "TOMORROW" or "NEXT"; with nothing on, only the lower arc is drawn; a third overlap reads "◆ N MORE OVERLAPPING".
- An alert's icon is `notice.icon`, else the agent icon. Urgent pills are the first two actions plus Dismiss or Got it. Without `changed`, the urgent screen shows the detail sentence as the headline.
- A new urgent or decision Moment wakes the glass once when it arrives; it does not hold the glass awake. Decisions do not wake the glass during quiet hours.
- The UNDERSTOOD check sits left of the word with an 8 px gap (README).
- The quiet-hours row cycles presets on tap (10 PM-7 AM, 11 PM-7 AM, 10 PM-6:30 AM, 9 PM-6 AM, off); quiet hours never lock the dial (a touch always wakes it, and END QUIET HOURS ends them).
- The moon is peri on waiting screens (board) and parked but visible during push-to-talk (spec). Day rest dims to 20% with the moon hidden. Power during Capture only wakes.
- Stale: no frame for 30 s shows the reconnecting glyph. The Thread face shows the newest agent message; the waiting screen's "who" line is the session title.

### Where it differs from the boards (spec wins)

Capture uses a black ground without the crescent (spec 5.3, 7.6); the Understood and Thread capsules are 296 wide with the first segment primary; Earlier rows are 66 high; the Settings sliders span 240-300°; the resting clock is Numeral L 100; the rim dots use `0.1 22.31` so the 60 dots are exact (the board's 22.41 drifts).

### Dev drivers

- `PORT=3098 node apps/intercom-web/dev/cdp-phase-shots.mjs [outDir]` renders every `?state=` at 466 x 466 and compares it with the board PNG inside r 229; it writes `phase/dev/SCREENSHOTS.md`. Needs the mock running. A few example renders and one diff are in `phase/dev/screenshots/`.
- `node apps/intercom-web/dev/cdp-phase-live.mjs [outDir]` starts its own mock on port 3197 and drives headless Chrome through pairing, rim Moments, notices, a decision, approval hold-to-confirm (early release sends nothing), Day and detail, agents and the waiting question, Thread, Settings, push-to-talk, Capture, a typed message, offline and reconnect, landscape, dimming, quiet hours, the power menu and console errors (56 checks).
- Unit tests: `apps/intercom-web/dev/phase.test.js` (geometry, crescent table within 2 px, NOAA, the drain, countdown, weights, sessions, rim marks, Earlier storage, captions, every state uses tokens only).

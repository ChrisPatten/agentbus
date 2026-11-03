# Surface API: where the implementation differs from the design

The design is `peggy-claude-code/data/intercom/architecture.md` (sections 3, 4, 7, 9, 10) and `taxonomy.md`. The implementation is E96 plus the follow-on that closed review gaps 1 to 6 (event shape, conversation buttons, slots, faces, assets, widget binding). This page lists every place the code intentionally does something other than the design, and the choice made where the design was ambiguous. The wire contract is [SURFACE_API.md](SURFACE_API.md).

## Kept from E96 (the implementation is better, or just different)

| Topic | Design | Implementation | Why |
|---|---|---|---|
| Bounds | 24 events in the window, title 40, 3 actions, description 600 | 50 live events per surface, title 80, body 500, 3 actions, description 600, location 120 | E96's numbers were chosen before the design reached the bus; the review kept them. Description 600 and 3 actions match |
| Jobs are hidden | An action carries `job` and `payload` | The device sees `{id, label, style, confirm, once}`; the job (channel, sender, payload, expiry) lives in `surface_jobs` on the bus | The device never needs, and must not choose, what runs. An agent sets `run: {body}` when publishing |
| Action request | `{action_id, source: {kind, id}, idempotency_key, payload?}` returning `accepted\|rejected\|expired\|already_done` | `{object: "<kind>:<id>", action_id, idempotency_key, draft?, message_id?}` returning `done\|failed\|expired\|already_done` with a `reason` | Matches the E89 notice action shape that already existed; no client `payload` (jobs are fixed server side) |
| `kind` and `level` on Event | Not in the design | `kind: event\|approval`, `level: info\|attention\|urgent` | Come from the notices model; approvals are Events with `kind: approval`. They do not draw on the ring |
| Time fields | `start`, `end`, `expires` | `at`, `end`, `expires_at` | Existing E96 names (and the notices model). `at` is the start |
| Event ids | `evt_01H...` | `[a-z0-9][a-z0-9_-]{0,63}`, chosen by the agent | Agents address events by a meaningful id (`dentist`), and reusing an id replaces it |
| Action `expires` | Per action | An action expires with its Event (or slot) | One lifetime to reason about; per-action expiry was not needed |
| Delta ops | `{resource, rev, op, id?, data}` | `{resource, base_rev, rev, ops: [{op, id, value}]}`, coalesced, with `reset` | Batched, gap-checked via `base_rev` |
| Reactive data store (`data/{key}`) | Keyed store widgets bind to | Not built: widgets are `{id, type, data}` objects the agent rewrites | Review gap 6: acceptable for standard widgets; custom code is the later sandbox epic |
| Voice, recording mode | Sections 8 and 15 | Frames reserved only | Not in this epic |

## Added by the follow-on, with the choices made

**Event ring fields.** `layer`, `color`, `travel`, `detail`, `opens`, `conversation_id` are optional and absent from events that do not set them.
- *Ring placement.* An event is on the ring if and only if it is `kind: event` with both `at` and `end`. Approvals never draw, because the bus creates them without those fields (an agent cannot write them). `layer`, `color` and `travel` without both times are refused rather than ignored, so a typo does not silently produce a card instead of a segment.
- *Layer default.* No `layer` means `primary` for capacity purposes, but the field is not filled in on the stored event; consumers default it.
- *Ring capacity.* The design says "max 2 overlaps shown". The code enforces at publish time that at most 1 `primary` and 2 `overlap` live ring events overlap in time (touching end to start is allowed; the event being replaced is ignored; expired events do not count). The error names the events in the way. The check runs on publish only; an event whose neighbour is removed is not re-checked, and bus-written events are not subject to it.
- *Colour.* `#rgb`, `#rrggbb` or one of ten names (`orange`, `red`, `green`, `blue`, `purple`, `yellow`, `teal`, `pink`, `gray`, `white`), stored lowercase. Slot colours keep the older looser rule (any lowercase name) for compatibility.
- *Travel.* `minutes` 1 to 720, `mode` one of `walk`, `drive`, `transit`, `bike`, `train`. The design only says `mode?`; the list is the smallest useful one.
- *Detail image.* A 64-hex asset hash, stored bare (the design writes `asset:ab12...`; that prefix is accepted on input). Publishing checks the file exists in the asset store, so a dangling image is caught when the agent can still fix it.
- *`opens`.* `focus` is the default and is not stored unless given. `conversation_id` is required with `conversation` and refused with `focus`. It is not checked against the conversations the surface may read; the device's own read check applies when it opens the page.

**Conversation buttons.** Design section 9 says one callback path for event, notice and conversation buttons. Implemented as an action object `conversations:<conversation_id>` with `action_id` = the button index and an optional `message_id`.
- *Which prompt.* The conversation page numbers buttons per message, so an index alone is ambiguous when two questions are open. Without `message_id` the newest open prompt in the conversation is used; a device that rendered a specific message should send its `id` as `message_id`.
- *Same as a Telegram tap.* The same `resolveChoiceTap` runs (addressee check, atomic answer, slash-command choices, answer-needed flag cleared), the same inbound message is injected as the followed contact, and a failed injection reopens the prompt. Differences: the injected message carries `origin: surface_action` and the device id, not Telegram message ids; the Telegram message's keyboard is cleared (through the adapter's `finalizeChoicePrompt`) rather than edited to "You chose" or a disabled chosen button, because the surface cannot know the message text; `answered_by` is `device:<id>`; an `answer_needed` flag cleared by a tap is not restored when delivery fails and the prompt is reopened (same as Telegram's path).
- *Not yet.* Copy and link buttons answer `invalid`. `ask_input` prompts are not tappable from a surface.

**Slots.** `primary` and `context` are the two named slots.
- *Primary button.* One `action`, the same shape and rules as an Event button (confirm draft, `once`), with its job under `slots:<slot id>:<action id>`, created and removed with the slot. A job is deleted when the slot is cleared or replaced without an action; when the slot lapses at `until` the job is kept for a day (as for Events) so a late tap answers `expired`.
- *Context.* `lines` (at most 2, 40 characters each) or `widgets` (at most 3). The design says `{lines: [..2]}` or `{widgets: [w1,w2,w3]}` without a line length; 40 characters is the width the round display can show, an assumption to revisit on the real device. `widgets` ids must exist when the slot is set. Removing a widget that the context slot lists is refused; the design does not say, and refusing keeps the binding honest without background re-validation. If the context slot is removed by expiry the widgets are untouched.
- *Other slot names* still work with `text` only (compatibility with E96). `context` with plain `text` still validates for the same reason.
- *Default primary.* "Server default is the next Event" is a device or later server concern; the bus stores only overrides.

**Faces.** `layout` is `{slots: {event_ring?: boolean, primary?: boolean, context?: "lines"|"widgets"}}` and nothing else. The design describes faces and slot layouts as bus data; this implements only the slot bindings, not positions or custom faces. Faces are still fixed in firmware: the bus seeds `day`, `status` and `desk` without a layout and an absent layout means the device default. An agent can edit an existing face (`enabled`, `order`, `layout`) but cannot create one, because an unknown face has no renderer.

**Assets.** Upload is `POST /api/v1/surface-publish/assets`, raw body, on the publishing side (shared bus token, agent must publish to some surface). Devices cannot upload. Allowed types are PNG, JPEG and static SVG; the design mentions QR codes, which are served as ordinary PNGs (no separate type and no server-side QR generation). Size limit `surface_api.asset_max_bytes` (default 1 MiB, applied per upload, not per surface). No per-agent quota, no delete route, no listing; files are kept until removed by hand.

**Widgets.** Slot-to-widget binding is real (above). Widgets stay `{id, type, data}`, at most 24 per surface and 4,096 bytes of data each.

## Not done

- A route or tool to read an asset back for an agent, or to delete one.
- Re-validating the ring when an event expires or is removed.
- Telegram "You chose: ..." text after a device tap.
- Custom widgets, the reactive key store, voice and recording mode (section 15).

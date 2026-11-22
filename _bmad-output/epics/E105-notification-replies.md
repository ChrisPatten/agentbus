# E105 — The Compact: replies to notifications

**Status:** approved for build (Chris, Nov 22, 2026)
**Repos:** AgentBus (`feat/e105-notification-replies`), firmware `~/workspace/intercom-firmware` (branch `notif-reply`, after the contract is frozen), Peggy (`intercom-surface` skill, CLAUDE.md)
**Design:** `~/workspace/peggy-claude-code/data/intercom/design/plum-dusk/proposals/2026-11-22-twelve-hour-dial-breathing-ring-notification-replies.md` section 3, with the Nov 22 decisions at the bottom.

## Decisions that shape the build
- Push-to-talk by BOOT only (no touch mic pill, so no new frame).
- A spoken reply binds to a notification only when the device sends `notification_id` (Reply view open); the bus never binds on its own.
- No voice confirm screen (no `hold`, no `confirm`, no second send frame); no private/non-private field.
- Peggy's rule stands: a reply never counts as approval to send an outbound message unless the exact draft was shown (the bus says so in the system block).

## Stories
- **S105.1** Frozen frame and field contract: `docs/NOTIFICATION_REPLIES_CONTRACT.md`.
- **S105.2** Store: migration 48, `reply` config, `reply_state`, atomic single-reply claim, `resolution`.
- **S105.3** Routing: choice taps and bound voice replies into the bound conversation; system block; interaction binding so the job's `reply()` reaches the device (the proposal's unverified assumption).
- **S105.4** `audio_start.notification_id`: preflight, transcript frames with the id, per-recording `hints`.
- **S105.5** SKIP, expiry note or wake, tools and HTTP schema, docs, tests.

## Acceptance
- Unit tests: every refusal code, single-reply and release on failure, idempotent `client_msg_id`, bound versus followed routing, the `reply` event for a non-followed conversation, expiry note and wake, MCP fill of `conversation_id`.
- Full suite green; no restart of bus-core until Chris decides.

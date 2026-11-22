# Notification replies: frame and field contract (E105)

Status: FROZEN for firmware (branch `notif-reply`). Bus branch `feat/e105-notification-replies`. A change after this point needs a version note at the bottom and a message to the firmware owner.

Scope decisions (Mr. Patten, Nov 22, 2026), already applied here:

- Push-to-talk by BOOT only. There is no touch mic pill, and so no touch trigger frame.
- A spoken reply binds to a notification only when the device says so: `audio_start` carries `notification_id`. The bus never binds on its own.
- No voice confirm screen. There is no `hold`, no `confirm`, and no second `send` frame: the bus sends straight after transcription, exactly like an unbound push-to-talk.
- No private/non-private differentiation. There is no `private` field.
- Standing rule (Peggy's, not enforced by the bus): a reply is never approval to send an outbound message unless the exact draft was shown. The bus tells the session so in the system block.

Everything below is additive. A notification without `reply.mode` behaves exactly as in docs/NOTIFICATIONS.md.

## 1. Fields on `notify` (MCP tool, `POST /api/v1/notifications`, `POST /api/v1/internal/notifications`)

```
reply?: {
  mode: "none" | "voice" | "choices" | "both"     // default none
  prompt?: string      // <= 80 chars, what to say: "Say a time"
  context?: string     // <= 600 chars, NEVER sent to the device; handed verbatim to the session with the reply
  hints?: string[]     // <= 8 items, each <= 40 chars; transcription keyterms for this recording only
  on_expire?: "note" | "wake"   // default note
}
conversation_id? | (channel + topic? + contact?)   // where replies go (the binding)
expires_in_s         // required when reply.mode is not none; 1..86400 in that case
```

- `conversation_id`, or `channel` (with optional `topic`, default `general`, and optional `contact`, default the notification's contact, normally `chris`), is REQUIRED when `reply.mode` is not none. The MCP tool fills `conversation_id` from the calling headless turn when none of the three is passed. A `conversation_id` the bus has never seen answers 400 `unknown_conversation`.
- `choices` and `both` need at least one entry in `actions`. Otherwise 400 `invalid_body`.
- `reply.mode` none with a binding is allowed: the action taps are routed to the bound conversation, there is no one-reply limit and no reply state (`reply_state: "none"`).
- The binding is stored in `conversation_ref` as JSON `{"conversation_id","channel","topic","contact"}`. It is never sent to the device.
- Re-raising the same `key` while the item is open resets it to `active`, clears `replied_at`, `reply_via` and `resolution`, and makes `reply_state` `awaiting` again. Omitting `reply` and the binding on a re-raise keeps the old ones.
- Unknown keys are rejected (400), so `confirm` and `private` are errors, not ignored.

`update_notification` (`PATCH`) gains `resolution?: string` (<= 60 chars, shown on the device when the job closes the loop: "Booked 3:30"). `state: "resolved"` is how the job closes the loop. `resolution` is stored whatever the state is, and is only meant with `resolved`.

## 2. Public shape: `notification` event and `notices` resource item

Existing keys unchanged (`id, key, title, body, level, state, actions, source, created_at, updated_at, expires_at`). New keys, ALWAYS present:

| key | type | meaning |
|---|---|---|
| `reply` | object or null | `{mode, prompt, hints, on_expire}`; null when the notification has no reply mode. `context` is never included |
| `reply_state` | string | `none`, `awaiting`, `received`, `skipped`, `closed` (below) |
| `replied_at` | ISO string or null | when the bus accepted the reply or the skip |
| `reply_via` | string or null | `voice`, `choice` or `skip` |
| `resolution` | string or null | the job's closing text |

`reply_state`:

- `none`: no reply mode.
- `awaiting`: reply mode set, the item is open (`active` or `acknowledged`), nothing accepted yet. A plain `notification_ack` ("seen") does NOT end this: a reply is still allowed after it.
- `received`: the bus accepted a reply and handed it to the session (`reply_via` voice or choice). The state is `acknowledged`.
- `skipped`: the device sent `notification_ack` with `skip: true`. The state is `acknowledged`; no reply is possible afterwards.
- `closed`: `state` is `resolved` or `expired`.

The device may only offer an answer when `reply_state` is `awaiting`.

Delivery: the v1 `notification` event (durable, with `seq`, plus the snapshot after `welcome`) is sent on every change including `resolved` and `expired`. The v2 `notices` resource holds open items only, so a `resolved` or `expired` item leaves it with a `delete` op; a device that wants an EXPIRED or DONE row must keep the last item it saw (or take it from the v1 event). A `resolved` item carries `resolution` in its last v1 event.

## 3. Frames, device to bus

### 3.1 Choice tap: `notification_action` (v1 frame) and `notices:<id>` action (v2)

Unchanged frame: `{"type":"notification_action","client_msg_id","id","index"}`.

- Notification with a binding: acknowledges the item, then injects `[tapped] <label>` into the BOUND conversation (not the followed one). `input: "choice"`.
- No binding: unchanged (followed conversation).
- Reply-mode notification (`choices` or `both`): the first tap sets `replied_at`, `reply_via: "choice"`, `reply_state: "received"` and publishes the item. A second tap, or a tap after a voice reply, is refused `already_replied`.
- Mode `voice`: a tap is refused `reply_not_allowed`.

Answers: the usual `ack` (`status: "queued"`, `message_id`, `interaction_id`), idempotent on `client_msg_id` (a repeat returns the stored ack even after the item was resolved). Refusals:

- Unknown or untargeted id, or a non-reply item that is resolved or expired: `{"type":"error","code":"notification_not_found"}` (as today).
- Reply-mode item (the bus knows the mode): `{"type":"ack","client_msg_id","status":"rejected","reason":"<code>"}` with `reason` one of `notification_not_found` (resolved), `notification_expired`, `reply_not_allowed`, `already_replied`, `no_route`.
- `index` outside `actions`, bad frame: `{"type":"error","code":"invalid_frame"}`.

The v2 `action_result` is `failed` with `reason` = the same code (`not_found` for `notification_not_found`).

### 3.2 Voice reply: `audio_start` with `notification_id`

```
{"type":"audio_start","client_msg_id":"<uuid>","rate":16000,"notification_id":"<id>"}
```
then binary PCM, then `audio_end` / `audio_cancel` (unchanged). Optional field; without it the press is an ordinary unbound push-to-talk.

- Checked at `audio_start`, so a bad press fails at once: the bus answers `{"type":"transcript","client_msg_id","final":true,"status":"failed","reason":"<code>","notification_id":"<id>"}` and drops the recording (later PCM and `audio_end` are ignored). Codes: `notification_not_found`, `notification_expired`, `reply_not_allowed` (mode `none` or `choices`, or no binding), `already_replied` (also when the item was skipped).
- Checked again at send time (the item may have been resolved while he spoke). A refusal then arrives as the `ack` below, after the `transcript` frame, so the device still has the text and can offer SEND TO PEGGY.
- `transcript` frames (interim and final) carry `notification_id` when the recording is bound. Interim frames are unchanged otherwise.
- Final transcript `status: "ok"`: the bus injects the text into the bound conversation straight away (`input: "voice"`), then answers the usual ack: `{"type":"ack","client_msg_id","status":"queued","message_id","interaction_id"}`. On success the item moves to `acknowledged`, `reply_via: "voice"`, `reply_state: "received"`, and the device gets the updated `notification`. `empty` and `failed` transcripts send nothing and leave the item `awaiting`.
- Rejected ack reasons: `notification_not_found`, `notification_expired`, `reply_not_allowed`, `already_replied`, `no_route`, plus the existing `invalid_body`, `internal_error`.
- `client_msg_id` is idempotent as before.
- Per-recording `hints` from the notification are sent to the speech engine as keyterms (ElevenLabs) or appended to the prompt (OpenAI) for this recording only.

### 3.3 SKIP: `notification_ack` with `skip`

`{"type":"notification_ack","id":"<id>","skip":true}`. On a reply-mode notification that is still `awaiting`: acknowledges it, sets `reply_via: "skip"`, `replied_at`, `reply_state: "skipped"`, and writes a hidden context-only note "skipped" into the bound conversation (no wake). On anything else it is a plain ack. A plain `{"type":"notification_ack","id"}` is unchanged ("seen").

### 3.4 Late reply (TOO LATE)

When a reply is refused as `notification_not_found`, `notification_expired` or `already_replied`, the device offers SEND TO PEGGY: an ordinary `send` frame with `body` = `(late reply to "<title>") <transcript>`, into the followed conversation. No new frame.

## 4. Where the answer goes, and what the session sees

Bound conversation = the one in `conversation_ref`. The inbound message looks like a message from the contact in that conversation's channel and topic:

- Voice body: `[reply to "<title>"] <text>`. Choice body: `[tapped] <label>`.
- Metadata: `origin: "intercom"`, `surface_id`, `interaction_id`, `client_msg_id`, `notification_id`, `notification_key`, `input` (`voice` or `choice`), `reply_mode`, plus `transcript_engine` for voice.
- One system block (never stored in the transcript): notification title, body, source, raised time, level, the options, `context` verbatim, whether the text is a speech transcript that may contain recognition errors, the reminder that a reply is never approval of an outbound message unless the exact draft was shown, and "close the loop with update_notification(key, state resolved, resolution); answer with reply()".
- The envelope `reply_to` is unchanged. A silent echo (`🎙️`/`⌨️ text — via Intercom`) goes to the bound conversation's chat, not the followed one.

The job's `reply(message_id)` back to that message produces the usual `reply` event on the device: while the interaction is open, an outbound agent message in a conversation BOUND to the interaction is delivered to the surface exactly like one in the followed conversation (same `interaction_id`, `glance`, spoken reply for push-to-talk). The binding lives on the surface's interaction and ends when the interaction closes (the bound conversation's turn ends, or the stale timer).

## 5. Expiry

The existing 60 s tick. `expireDue` marks `active` and `acknowledged` rows past `expires_at` as `expired` (`reply_state: "closed"`), and tells surfaces.

- `on_expire: "note"` (default): if a reply was neither received nor skipped, a hidden context-only note `notification "<title>" expired unanswered at HH:MM` is written into the bound conversation. Wakes nothing.
- `on_expire: "wake"`: a bus-originated system turn is injected into the bound conversation (`system_only`, block text `Notification "<title>" (key <key>) expired unanswered at HH:MM. Do the default named in its context, or log it and stop.` plus `context`), so the job acts.
- Nothing is written when the reply was received or skipped, or when there is no binding.
- Resolved items write no note.

## 6. Quiet hours and who sees what

No change: the server sends to every targeted surface; quiet hours and wake rules are the device's business. There is no per-notification privacy field.

## 7. Errors, summary

| code | where | meaning |
|---|---|---|
| `notification_not_found` | action, audio_start, ack | unknown, untargeted, or resolved |
| `notification_expired` | audio_start, ack (reply-mode items) | past `expires_at` |
| `reply_not_allowed` | audio_start, ack | mode does not include the input used, or no binding |
| `already_replied` | audio_start, ack | a reply or skip was already accepted |
| `no_route` | ack | the bound conversation would not take the message |

## Version notes

- v1 (Nov 22, 2026): initial freeze.

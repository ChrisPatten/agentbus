# E86 — Choice Buttons in the Mac App

| Field | Value |
|---|---|
| Epic ID | E86 |
| Dependencies | E74 (Telegram choice buttons, `choice_prompts`), E54 (command choices), E81 (buttons v2: style, copy_text, url), E59 (app adapter protocol v1), E62 (Mac client) |
| Story Count | 6 |
| Estimated Complexity | L |
| Status | Complete (live tap check on baxter-mac-test passed 2026-10-30; /model picker, expiry and second-window sync not yet checked live) |

Source: operator request, 2026-10-29.

---

## Epic Summary

Choice buttons only work on Telegram. The Mac app gets the same choices as a numbered list appended to the message. For command pickers such as `/model`, it also gets a "reply with a number" follow-up that is held in memory. This epic draws the buttons in the Mac transcript. A tap reaches the agent the way a Telegram tap does, and the prompt shows as answered or expired on every client and after a reload.

## Verified Behavior

Checked against `dev` at `4f6c7ed` on 2026-10-29.

**Choices never reach the app as buttons**
- `applyChoices` (`src/choices/validate.ts:100`) puts `metadata.choices` on Telegram channels only. Every other channel gets a numbered list appended to the body.
- `AppAdapter.persist` (`src/adapters/app.ts:46`) stores the full envelope metadata in `transcripts.metadata`.
- The client never sees that metadata. `messageInfo` (`src/app/store.ts:215-234`) sends a fixed set of fields, and choices are not one of them.

**Command choices on the app**
- E54 command choices take a non-Telegram branch in `deliverCommandResponse` (`src/http/api.ts:482-490`).
- That branch registers an in-memory follow-up keyed only by `channel:sender` (`src/commands/registry.ts:199-216`), with a 10-minute TTL.
- Because of that key, the user's next app message in *any* session uses up the follow-up.

**The event log has no update path**
- `app_events` allows only `kind IN ('message','session')` (migration 024).
- Nothing updates a transcript row's metadata after it is written.
- `ChatStore.upsert` (`Store.swift:169`) never changes a cached message once it is stored. Nor do `CursorReducer` (`Protocol.swift:273`) or anything else on the Mac client.
- History and unread queries already filter on `kind = 'message'` (`src/app/store.ts:140,160,254`).

**Tap logic is mostly shared already**
- `processChoiceTap` (`src/adapters/telegram.ts:1857`) does the lookup, the addressee check, the atomic `ChoiceStore.answer()`, the "command or `[tapped] <label>`" body and reopen-on-failure. None of that is Telegram-specific; only the toast and the keyboard edit are.
- The expiry sweep (`src/choices/sweep.ts`) already calls a per-adapter `finalizeChoicePrompt` hook.

**The Mac client**
- `BusMessage` (`Protocol.swift:113`) has no metadata field.
- `AgentMessageView` (`TranscriptView.swift:424-468`) has no controls inside a message.
- `SessionDetail.command(_:)` (`SessionDetailView.swift:169`) already sends a message without the composer.

## Design Decisions

| Decision | Choice |
|---|---|
| Button kinds | All of them: E74 labels, E54 command choices, and E81 `style` / `copy_text` / `url`. On the Mac, copy and link buttons need no round trip to the bus. |
| Numbered list on the app | Dropped. The app channel uses buttons only, like Telegram. The bus and the Mac app ship together, so a Mac app that hasn't been updated shows no options. |
| Prompt storage | The existing `choice_prompts` table with `channel = 'app'`. `platform_message_id` and `bus_message_id` are both the envelope id. A prompt is persisted only when it has at least one callback button, as on Telegram. |
| State to the client | Derived when the row is read: `messageInfo` joins `choice_prompts` on `bus_message_id`. History pages and a reset reload therefore always show the current state. |
| Live updates | A new durable `choice` event kind in the per-contact `seq` stream, recorded on answer and on expiry. |
| Tap | A new WebSocket client frame, `choice {client_msg_id, prompt_id, index}`, answered with an `ack`. It injects through `submitInbound` with `bound_session_id` set to the prompt's session. |
| Tap echo | The inbound `[tapped] <label>` row is still logged, so the agent sees it as on Telegram. The Mac app draws it as a compact "You chose *X*" note, not a bubble. |
| Offline taps | Not queued. Buttons are disabled while the socket is disconnected. |
| Protocol version | Stays **1**. The message fields, event kind and frame are all additive. |
| Approvals | Out of scope. `E74-app-channel-approvals` (planned) rebuilds the same `app_events` CHECK, so whichever epic lands second adds its kind to it. |

## Wire Contract

Fixed before S86.2 so the bus and the Mac client can be built in parallel. Every addition is optional and additive. Clients ignore fields and event kinds they don't know.

**Message object** (history page items and `message` event `data`). There are two new optional fields.

On an outbound message that carries choices:
```json
"choices": {
  "prompt_id": "<uuid>" | null,
  "items": [{ "label": "Approve", "style": "success", "copy_text": "...", "url": "https://..." }],
  "status": "open" | "answered" | "expired",
  "chosen_index": 1 | null
}
```
- In `items`, `style`, `copy_text` and `url` are each optional, and an item never has both `copy_text` and `url`.
- `prompt_id` is null when no item is a callback button. That means every item has `copy_text` or `url`, nothing is tappable back to the bus, and `status` is always `open`.

On an inbound message that is a tap:
```json
"choice_answer": { "prompt_id": "<uuid>", "index": 1, "label": "Approve" }
```

**Server event** (durable, in the per-contact `seq` stream):
```json
{ "type": "event", "seq": 812, "event": "choice",
  "data": { "message_id": "<prompt message id>", "session_id": "...", "conversation_id": "...",
            "choices": { /* the full object above, current state */ } } }
```
- The bus records one event when a prompt is answered and one when it expires.
- The client replaces the cached message's `choices` with `data.choices`.
- If the message isn't cached, the client ignores the event; history carries the state.

**Client frame:**
```json
{ "type": "choice", "client_msg_id": "<uuid>", "prompt_id": "<uuid>", "index": 1 }
```
`index` is the item's position in `items`. Only items without `copy_text` and `url` may be sent.

**Ack:**
```json
{ "type": "ack", "client_msg_id": "<uuid>", "status": "queued" | "command" | "rejected", "reason"?: "already_answered" | "expired" | "forbidden" | "not_found" | "invalid_choice" | "delivery_failed" | "<other text>" }
```
- `queued`: the tap was injected as `[tapped] <label>`.
- `command`: the choice's slash command ran.
- `already_answered`: final. The state arrives in a `choice` event.

## Exit Criteria

1. An agent `reply` with `choices: ["A","B","C"]` in a Mac session shows three buttons, and the body has no numbered list.
2. Tapping B sends the agent `[tapped] B` in that session. The chosen button shows a checkmark, the others are disabled, and the transcript shows "You chose B".
3. A second Mac window or a reload shows the same answered state.
4. The following are rejected, with an inline message and no inbound row:
   - a second tap
   - a tap after expiry
   - a tap sent with another contact's token
5. `/model` in the app shows a picker, and a tap runs the command.
6. An expired prompt greys out its buttons live and after a reload.
7. Copy and link buttons work and send nothing to the bus.
8. Telegram choice behavior is unchanged. Email and other channels still get the numbered list.
9. Bus tests, Mac XCTest cases, `docs/APP_ADAPTER.md`, `docs/MAC_CLIENT.md`, `docs/MCP_TOOLS.md`, `docs/SLASH_COMMANDS.md`, `site-docs/channels/mac-app.md` and `CHANGELOG.md` are updated. The full suite, `tsc`, `npm run docs:build` and the Xcode build and tests pass.

## Stories

### S86.1 — Shared choice logic (refactor, no behavior change)

- `src/choices/parse.ts`: move `parseChoices`, `parseChoiceCommands` and `hasCallbackButton` out of `telegram.ts`, with the log tag passed in.
- `src/choices/tap.ts`: `resolveChoiceTap(store, promptId, index, contactId)` returns `{outcome, prompt, label, body, metadata}`.
  - Outcomes: `answered`, `already_answered`, `expired`, `invalid_choice`, `not_found` and `forbidden`.
  - `body` is the choice's command when it has one, otherwise `[tapped] <label>`.
- `TelegramAdapter.processChoiceTap` uses it, and keeps its own toasts, keyboard edits and `telegram_*` metadata.

**Acceptance:** `tap.test.ts` covers every outcome. `telegram-choices.test.ts` and `telegram-e81.test.ts` pass unchanged.

### S86.2 — App prompt persistence and the `choice` event

- `supportsChoiceButtons(channel)` replaces the `isTelegramChannel` gate in `applyChoices`, and is true for Telegram and `app`. Update `CHOICES_DESCRIPTION`.
- `AppAdapter.persist` creates the prompt in the same transaction as the transcript row. The TTL comes from the new optional `adapters.app.choice_ttl_hours`, defaulting to 24 h.
- Migration `043_app_choice_events.sql`:
  - rebuild `app_events` with `kind IN ('message','session','choice')` and a nullable `choice_prompt_id`
  - recreate the triggers and indexes
- `AppAdapter.finalizeChoicePrompt` (called by the sweep) and `recordChoiceEvent` (called after a tap) write `choice` events.

**Acceptance:**
- A send with choices creates one prompt row.
- A copy-only send creates none.
- An expiry sweep writes a `choice` event.
- The migration test passes.

### S86.3 — Client-facing message fields

`src/app/store.ts`:
- `messageInfo.choices`: `{prompt_id, items[{label, style?, copy_text?, url?}], status, chosen_index}`. The items come from the transcript metadata and the state from the join. A prompt with no row is `open` with `prompt_id: null`.
- `messageInfo.choice_answer`: `{prompt_id, index, label}` on inbound rows that carry `choice_prompt_id`.
- `readEvents` builds `choice` events: `{prompt_id, message_id, session_id, status, chosen_index}`.

**Acceptance:**
- History and replay show the current state.
- `choice` events don't count as unread.
- `choice` events don't duplicate messages in history pages.

### S86.4 — Tap frame and command pickers

- `app-routes.ts`: the `choice` frame and its handler. On `answered` it calls `submitInbound`, and calls `reopen()` if that throws. It then records the `choice` event and acks `queued` or `command`.
- Other outcomes get `status: 'rejected'` with the outcome as `reason`.
- If the prompt's session has ended, `bound_session_id` is dropped.
- `deliverCommandResponse` sends command choices as buttons on the app channel.
- `scripts/app-client.ts`: a `choose <prompt_id> <index>` command.

**Acceptance (WebSocket tests):**
- A tap injects exactly one inbound row.
- A double tap gives `already_answered`.
- An expired prompt and another contact's token are rejected.
- A command choice runs the command.
- In `inbound-commands.test.ts`, the app takes the button path and email keeps the numbered list.

### S86.5 — Mac client

- `Protocol.swift`:
  - decode `choices` and `choice_answer` with `try?`
  - handle the `choice` event kind
  - add the `.choice` client frame
- `Store.swift`:
  - add `choicesJSON`, `choiceAnswerJSON` and a local `choicePendingIndex` to `CachedMessage`
  - a `choice` branch in `apply`
  - `upsert` refreshes the choice state
- `Connection.swift`:
  - `choose(message:index:)`
  - ack handling, with an inline error for `expired`, `forbidden` and `not_found`
- `TranscriptView.swift`:
  - a `ChoiceButtonsView` after the attachment cards, receiving its tap action through an environment key
  - Layout: one button per row, or two when every label is 12 characters or fewer.
  - `style` sets the tint.
  - A copy button writes to `NSPasteboard`, and a link button opens through `openURL`.
  - States: open, pending, answered, expired and offline.
- `TranscriptItem.build` draws tap rows as compact notes.
- `PreviewSupport.swift` seeds a message in each state.

**Acceptance:** XCTest cases cover:
- decoding the new fields and the `choice` event
- the frame a tap sends
- the ack and the `choice` event updating the cached message
- building the compact note

The Xcode build passes.

### S86.6 — Docs and live check

- `docs/APP_ADAPTER.md`: the fields, event, frame, ack reasons and migration.
- `docs/MAC_CLIENT.md`, `docs/MCP_TOOLS.md` and `docs/SLASH_COMMANDS.md`, plus `docs/HTTP_API.md` if it lists app frames.
- `site-docs/channels/mac-app.md`: a new "Buttons" section with a `choice_ttl_hours` options table.
- `site-docs/channels/telegram.md`: change "On other channels" to exclude the Mac app.
- `site-docs/features/slash-commands.md`, if it mentions the numbered list.
- `npm run docs:build`.
- `CHANGELOG.md` `[Unreleased]` → Added.
- Live check on baxter-mac-test after a safe restart, covering exit criteria 1–7.

## Risks

- **Old Mac builds show no options** once the numbered list is dropped. This is accepted: the bus and the app ship together.
- **`app_events` table rebuild.** It must keep `seq`, `rotation` and every trigger intact. Copy the pattern from migrations 024 and 037, and test that replay after the migration matches replay before it.
- **A tap on a prompt whose session ended.** Normal routing picks the session, so the answer may open a new session rather than land in the original one.
- **A lost ack.** The retry gets `already_answered`, which the client treats as final. The state comes from the `choice` event.

## Non-Goals

- App-channel approvals (`E74-app-channel-approvals`).
- iOS Peggy client support.
- Multi-select choices.
- Queueing taps while the app is offline.

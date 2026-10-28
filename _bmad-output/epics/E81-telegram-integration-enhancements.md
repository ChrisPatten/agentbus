# E81 — Telegram Integration Enhancements

| Field | Value |
|---|---|
| Epic ID | E81 |
| Dependencies | E74 (choice buttons: `choice_prompts`, `processCallbackQuery` routing), E79 (status lines), E51 (inline keyboard plumbing) |
| Story Count | 9 |
| Estimated Complexity | L |
| Status | Implemented on feat/e81-telegram-enhancements (S81.1-S81.9 code and tests done; live check after safe restart pending) |

Source: Chris's request of 2026-10-28 after the Bot API review (Bot API 10.3, Aug 24, 2026; core.telegram.org/bots/api, /bots/features, /bots/api-changelog).

---

## Epic Summary

Agents can currently send plain text with single-choice buttons. Telegram offers much more that an agent can use through MCP tools. This epic adds the subset Chris selected: richer send parameters, a second generation of buttons, input prompts, location/venue/contact and document sends, pin and edit-in-place, and rich messages (native tables, collapsible blocks, inline buttons).

## Out of scope (decided by Chris, 2026-10-28)

- Polls and quizzes.
- Checklists.
- Streaming drafts (`sendMessageDraft`) and the Stop button.
- Also not selected: business Secretary Mode, guest mode, ephemeral messages, Mini Apps, inline mode.

## Verified baseline (adapter inspection, 2026-10-28)

`src/adapters/telegram.ts` already calls sendMessage, editMessageText, editMessageReplyMarkup, answerCallbackQuery, sendChatAction, sendPhoto, getFile, createForumTopic, setMyCommands, setChatMenuButton and setMessageReaction. Polling requests `allowed_updates: ['message','message_reaction','callback_query']`. No pin, location, contact, document or rich-message calls exist yet.

## Verified Behavior (S81.1 spike, 2026-10-28)

Method: Bot API docs (core.telegram.org/bots/api/*.md) plus a minimum of live calls from a scratch forum topic in the Peggy group (created and deleted by the spike; no existing topic was touched; no `getUpdates` was issued, so the running bus-core poller was undisturbed). The bot is an administrator of the group with `can_pin_messages` and `can_manage_topics` already true. Not verifiable without a client or a private chat (so left to the live check): button taps, `users_shared`/location/contact answers, and anything in Chris's DM.

- PASS rich messages exist (Bot API 10.1). `sendRichMessage {chat_id, message_thread_id, rich_message, reply_markup?, disable_notification?, reply_parameters?}`; works inside a forum topic. `rich_message` takes exactly one of `markdown`, `html`, `blocks`. Working shape: `{"rich_message":{"markdown":"# Brief\n\n| Item | Time |\n|:--|--:|\n| Dentist | 10:00 |\n\n<details><summary>Calendar</summary>\n\n- Dentist\n\n</details>\n\n<tg-button-row align=\"left\"><tg-button type=\"copy_text\" text=\"hello\">Copy</tg-button><tg-button type=\"url\" url=\"https://t.me\">Link</tg-button></tg-button-row>"}}`.
- PASS Rich Markdown is the most reliable input (native tables, `<details>`, button rows in one string). HTML (`<table>`, `<details>`) and `blocks` (`heading`/`paragraph`/`details`) also worked. Decision: `send_rich` accepts `markdown` or `html`; `blocks` is not exposed.
- PASS rich edit: `editMessageText {chat_id, message_id, rich_message}` edits a rich message, converts plain to rich and back.
- PASS rich limits: 5000 characters accepted (the 4096 plain limit does not apply); 32769 rejected with `RICH_MESSAGE_TEXT_TOO_LONG`. Documented limits: 32768 characters, 500 blocks, 50 media, 20 table columns.
- PASS inline keyboard on a rich message via `reply_markup` (with `style`, `copy_text`, `url`, `callback_data`).
- PASS `style` on an inline button (`"success"`, `"danger"`, `"primary"`) accepted.
- PASS `copy_text` button `{text, copy_text:{text}}` accepted (taps produce no update).
- PASS `DisabledButton`: `editMessageReplyMarkup` with `{"text":"A","disabled":{}}` accepted, also combined with `style`.
- PASS `disable_notification` and `link_preview_options {is_disabled:true}` accepted on sendMessage (the response echoes `link_preview_options`).
- PASS edit text; PASS no-op edit returns `400 Bad Request: message is not modified` (the adapter must catch it).
- PASS pin/unpin in a topic: `pinChatMessage {chat_id, message_id, disable_notification}`, `unpinChatMessage {chat_id, message_id}`, `unpinAllForumTopicMessages {chat_id, message_thread_id}`; unpinning a message that is not pinned is a silent success. Required right: `can_pin_messages` (the bot already has it). The "not enough rights" error text could not be provoked live; handled by substring match (`not enough rights`) from the documented error.
- PASS `sendLocation`, `sendVenue`, `sendContact` (with `vcard`) in a topic. `latitude: 99` returns `400 invalid location specified` (the adapter range-checks first).
- PASS `sendDocument` multipart with a caption; caption of 1025 characters rejected (`message caption is too long`).
- PASS text of 4097 characters rejected (`message is too long`), confirming the 4096 limit for plain sends and edits.
- PASS `force_reply` with `input_field_placeholder` works inside a forum topic.
- PASS remove-keyboard trick: `sendMessage` with `reply_markup {remove_keyboard:true}` followed by `deleteMessage` works.
- FAIL (limitation) `request_location`, `request_contact` and `request_users` reply-keyboard buttons: `400 ... can be requested in private chats only`. `ask_input` for `location`/`contact`/`person` therefore works only in a private chat; in a group topic it degrades to a `force_reply` text prompt (the user can still send a location or contact from the attach menu; the adapter forwards those). Private-chat behavior is documented but was not exercised live (would message Chris).
- FAIL `message_effect_id` in the group: `400 can't use message effects in the chat`. Private chats are documented as supported but unverified, so the `effect` parameter of S81.2 is NOT built.
- Fallbacks used: none of the rich features was unavailable. S81.8 uses the stated degrade for group chats (above); S81.2 omits `effect`.
- BotFather toggles: none found necessary. No new `allowed_updates` are needed (location, contact and `users_shared` arrive as `message` updates).
- Edit window: ordinary bot messages in groups have no edit window (the 48 hour limit applies only to business messages), so `edit_message` enforces none.

## Design notes

- Every new tool goes through the existing envelope: new fields in `metadata`, rendered by the Telegram adapter, with a plain-text fallback for other channels (email, app, Siri) so no tool breaks off-Telegram.
- Editing and pinning need the platform message id of an outbound message. E74 already persists these for choice prompts; this epic generalizes that into an `outbound_messages` lookup (bus message id → chat, thread, platform message id) so `edit_message` and `pin_message` can take the bus message id.
- All send tools honor the existing contact allow-list. Nothing here widens who can be messaged.
- Rich messages and several button styles are 10.x-era features. S81.1 verifies each against the live bot before the dependent stories are built; where a feature is unavailable the story degrades to the stated fallback.

## Entry Criteria

- E74 on `dev` (confirmed implemented on its feature branch; verify it has merged before starting).
- A scratch Telegram topic for live checks.

## Exit Criteria

1. Each new tool works end to end in a real Telegram topic, verified by a live check, not only unit tests.
2. Existing behavior is unchanged: E74 choices, E51 approve/deny, E79 status lines, reactions.
3. Non-Telegram channels receive a sensible plain-text fallback for every new tool.
4. Unit tests for every story; docs and CHANGELOG updated.

## Stories

### S81.1 — Spike: verify the 10.x features against our bot

- Against the live bot in a scratch topic, confirm: rich message send and edit format (Rich Markdown vs HTML vs block objects), whether rich messages and `force_reply` work inside forum topics, `DisabledButton`, button `style`, `CopyTextButton`, `pin_chat_message` rights needed in the group, `effect_id` (private chats only?), and the 4096-char and caption limits.
- Record findings and any BotFather toggles in the epic's Verified Behavior section. Decide per story whether to proceed as designed or use the fallback.

**Acceptance:** a short findings note with one pass/fail line per feature, plus the exact request shape that worked.

### S81.2 — Send parameters on `reply` / `send_message`

- New optional params: `silent` (disable_notification), `no_preview` (LinkPreviewOptions is_disabled), `pin` (pin after sending, see S81.5 for rights), `effect` only if S81.1 shows it works for our chat types.
- Carried in `metadata`, applied by the adapter, ignored by other channels.

**Acceptance:** a silent send arrives without a notification; `no_preview` suppresses the link card; each param is individually optional and combinable with `choices`.

### S81.3 — Buttons v2

- Extend `choices` items to allow objects: `{label, style?, copy_text?, url?}` alongside plain strings (backward compatible with E74).
- `copy_text` renders a CopyTextButton (tap copies, no inbound message). `url` opens a link. `style` maps to the 9.4 button style if S81.1 confirms it.
- After a choice tap, edit the keyboard so the chosen button remains visible and disabled while the others are removed or disabled (`DisabledButton`), instead of dropping the keyboard. Fallback if unsupported: current E74 "You chose" behavior.

**Acceptance:** a prompt mixing choice, copy-text and url buttons renders correctly; copy-text taps produce no inbound message; a plain-string `choices` call behaves exactly as in E74.

### S81.4 — Outbound message registry and `edit_message`

- Migration: `outbound_messages` (bus message id, channel, chat id, thread id, platform message id, kind, created_at). Backfill hooks in the Telegram send path; reuse for E74 prompts.
- New MCP tool `edit_message(message_id, body, choices?)` for messages the bot itself sent: editMessageText, optionally replacing or clearing the keyboard. Reject messages older than the Telegram edit window where one applies, with a clear error.

**Acceptance:** editing a previously sent message changes its text in place; editing an unknown or foreign id returns a clear error; a no-op edit (same text) is handled without a Telegram error leaking out.

### S81.5 — `pin_message` / `unpin_message`

- New MCP tools taking a bus message id, using the registry from S81.4. `silent` pin by default. Optional `unpin_all` for the topic.
- Document the bot admin right required (`can_pin_messages`) and handle the "not enough rights" error with a readable message.

**Acceptance:** a pinned message appears pinned in the topic; unpinning removes it; a missing-rights error surfaces to the agent, not just the log.

### S81.6 — `send_location`, `send_venue`, `send_contact`

- Three tools: coordinates (live-location out of scope), venue (coords + title + address), contact (name, phone, optional vCard). Each takes the same addressing as `send_message` and honors `silent`.
- Fallback for other channels: a text rendering with an Apple Maps link (venue/location) or a name and number (contact).

**Acceptance:** a venue renders as a tappable map card; a contact renders as a shareable contact card; coordinates are validated (range checks) and phone numbers are required for contacts.

### S81.7 — `send_document` (and photo-by-path)

- Tool `send_document(path, caption?, to?)`. Path must resolve inside an allow-listed set of directories (configured in `agentbus-config.yaml`, e.g. the agent's `data/` and scratchpad); symlinks are resolved before the check; anything else is rejected.
- Enforce the 50 MB upload limit with a clear error. Caption obeys the 1024-char limit.
- Fallback for other channels: attach to email where supported, otherwise report unsupported.

**Acceptance:** a PDF in `data/` arrives as a document; a path outside the allow-list, a symlink escaping it, and an oversized file are each rejected before any upload; the allow-list is documented.

### S81.8 — `ask_input`

- Tool `ask_input(kind, prompt, placeholder?)` where kind is `location`, `contact`, `text`, or `person`. Uses a one-time reply keyboard with `request_location`, `request_contact`, or `request_users`, or `force_reply` with `input_field_placeholder` for free text.
- The answer arrives as an ordinary inbound message (location and contact payloads rendered as text with structured `metadata`), linked to the prompt via `reply_to`. The keyboard is removed after the answer or after expiry.
- Requires the adapter to accept location, contact and `users_shared` messages, which are currently not forwarded.

**Acceptance:** a location prompt returns coordinates to the agent as an inbound message; a contact prompt returns name and number; a free-text `force_reply` returns the typed reply; one-time keyboards disappear after use.

### S81.9 — `send_rich`

- Tool `send_rich(blocks | markdown, ...)` producing a Telegram rich message (tables, collapsible/expandable sections, quotes, media, inline buttons), using whichever input form S81.1 proves most reliable. Edits via `edit_message` use the rich form too.
- Fallback when rich messages are unavailable or the channel is not Telegram: render to plain text with tables as aligned lists (no markdown tables, per Chris's standing preference).
- Size handling: split or truncate with a clear marker beyond the platform limit.

**Acceptance:** a morning-brief-shaped message (heading, a table, three collapsible sections, one button row) renders correctly in a Telegram topic; the same call on an email channel yields a readable plain-text body; an oversized message is split predictably.

## Sequencing

S81.1 first (gates S81.3 and S81.9). S81.2, S81.4 can run in parallel after it; S81.5 needs S81.4. S81.6, S81.7, S81.8 are independent. S81.9 last.

## Peggy-side follow-up (not an AgentBus story)

Update CLAUDE.md and the morning-brief skill once the tools are live: notification tiering rules (silent for routine scans, audible for urgent items), the pinned open-commitments board, document sends for paper-inbox, and the rich-message brief.

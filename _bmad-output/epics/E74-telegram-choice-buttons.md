# E74 — Telegram Choice Buttons

| Field | Value |
|---|---|
| Epic ID | E74 |
| Dependencies | E51 (interactive approvals: inline keyboard + callback_query plumbing) |
| Story Count | 4 |
| Estimated Complexity | M |
| Status | Implemented on feat/e74-telegram-choice-buttons (S74.1-S74.4 code and tests done; live check after safe restart pending) |

---

## Epic Summary

Agents can only send plain text, so a multiple-choice question means the user types an answer. The Telegram adapter already renders inline keyboards and handles taps, but only for E51 approvals (`approve:<id>` / `deny:<id>`), and the `reply` / `send_message` MCP tools cannot attach buttons. This epic adds general single-choice buttons: the agent passes `choices`, the user taps, and the pick is delivered back to the agent as an ordinary inbound message.

## Verified Behavior

Checked against `src/adapters/telegram.ts` on 2026-10-27:
- `notifyApproval` sends `reply_markup.inline_keyboard` with `callback_data` `approve:<uuid>` / `deny:<uuid>`.
- `processCallbackQuery` matches only `^(approve|deny):<uuid>$`; anything else is answered "Unrecognized action". It enforces the allow-list and the addressee, answers the tap, and edits the message via `editApprovalMessage` (empty keyboard).
- Polling already requests `allowed_updates: ['message','message_reaction','callback_query']`.
- Telegram limits `callback_data` to 64 bytes, so labels cannot be carried in it.

## Design

- MCP: `reply` and `send_message` gain optional `choices: string[]` (1–8 labels, each ≤ 64 chars). Carried to the adapter in envelope `metadata.choices`.
- Storage: new table `choice_prompts` (id uuid, channel, topic, contact_id, labels JSON, outbound platform message ref, status `open|answered|expired`, chosen_index, created_at, expires_at, reply-to bus message id). New migration.
- Telegram send: when `metadata.choices` is present, add an inline keyboard (one button per row; two per row if all labels ≤ 12 chars) with `callback_data` `choice:<id>:<index>`. Persist the prompt after Telegram returns the message id.
- Tap handling: extend `processCallbackQuery` to route `choice:` data. Enforce allow-list and addressee, reject expired or answered prompts (answer text "Already answered" / "Expired"), mark answered, edit the message to append "You chose: <label>" with an empty keyboard, then inject an inbound message into the same conversation/topic: `[tapped] <label>` with `metadata.choice_prompt_id` and `reply_to` the original bus message.
- Typed replies still flow normally. Prompts expire after 24 h (configurable); an expiry sweep clears the keyboard on expired prompts.
- Other channels ignore `choices`; the MCP layer appends a numbered list to the body for non-Telegram channels.
- Single choice only; multi-select is out of scope.

## Entry Criteria

- E51 approval code on the working branch (confirmed present).

## Exit Criteria

- `reply` with `choices: ["A","B","C"]` in a Telegram topic shows three tappable buttons.
- Tapping one edits the message to show the pick, removes the buttons, and the agent receives a `[tapped] B` inbound message in that conversation.
- A second tap, a tap after expiry, and a tap by a non-addressee are each rejected with a toast and no inbound message.
- E51 approve/deny buttons behave exactly as before.
- Unit tests cover send, tap, double-tap, expiry, wrong sender, and the 64-byte `callback_data` limit.

## Stories

### S74.1 — MCP `choices` argument and envelope plumbing

- Add `choices` to `reply` and `send_message` schemas with validation (1–8 labels, ≤ 64 chars, non-empty).
- Pass through as `metadata.choices`; for non-Telegram channels append a numbered list to the body.

**Acceptance:** a call with 3 choices yields an envelope with `metadata.choices` of length 3; 9 choices or an empty label is rejected with a clear error.

### S74.2 — `choice_prompts` table and store

- Migration and store module (create, get, mark answered, mark expired, list expiring).

**Acceptance:** store tests pass for create/answer/expire and for answering an already-answered prompt returning "already_answered".

### S74.3 — Telegram send and tap handling

- Render the keyboard on send; persist the prompt with the Telegram message ref.
- Route `choice:` callbacks; allow-list + addressee check; edit message; inject inbound `[tapped] <label>`.

**Acceptance:** simulated callback for a valid prompt injects exactly one inbound message and edits the message; replay of the same callback injects nothing.

### S74.4 — Expiry sweep, docs, live check

- Expiry sweep (24 h default) clears keyboards and marks prompts expired.
- CHANGELOG and docs entry; note the feature in the agent-facing tool description.
- Live check on the `telegram:peggy` test topic.

**Acceptance:** a real prompt sent to Mr. Patten's topic can be tapped end to end after a safe restart.

## Risks

- Tap arrives while the agent session is mid-turn or reassigned — inject as a normal inbound message so existing routing/lease rules apply.
- Stale keyboards after restart — expiry sweep runs on startup as well as on a timer.
- Callback data limit — only ids and indexes in `callback_data`, labels stored server-side.

## Notes

- Out of scope: multi-select with a Done button; buttons on email/app channels.
- Peggy-side follow-up (not an AgentBus change): CLAUDE.md guidance to use `choices` only for real decisions.

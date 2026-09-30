# E60 — Cross-Channel Session Continuation

| Field | Value |
|---|---|
| Epic ID | E60 |
| Status | Implemented; live Telegram-to-app walkthrough pending |
| Dependencies | E58 conversation-scoped queue and `/stop`; E59 authenticated app protocol, session list, history, and event stream |
| Story Count | 6 |
| Estimated Complexity | XL |

Source: `planning-artifacts/mac-client/product-brief.md` §4–6 and `planning-artifacts/mac-client/PRD.md` §3.3 (FR-30–FR-36), §7–9.

## Epic Summary

Let a Mac-origin message continue an existing session that began on Telegram, email, Siri, or an Earlier app conversation. Its session identity and owning agent remain intact, while its arrival channel is `app`. The agent is told both channels; a reply to that Mac message returns to the app in the same session. Commands, activity, journaling, and stale-reply guards must use the bound session rather than deriving a new one from the arrival channel.

## Entry Criteria

- Finish and review the channel-keyed lookup audit required by FR-36 before changing the pipeline. Keep a test for each audited path.
- Resolve PRD §9 Q1 on Earlier-session resume. Prefer the PRD's proposed fork into a new app topic titled "<original title> (resumed)" if it preserves the old session and active session invariants; document the decision and exact user-visible behavior before implementation.

## Exit Criteria

1. FR-30/31: only the authenticated contact can bind to one of its listed sessions. The pipeline uses that row's session/conversation/topic and routes to `sessions.agent_id`; unbound traffic still uses normal routing. A bad, hidden, foreign-agent, or stale binding is rejected without creating a session.
2. Bound inbound transcript rows stay in the selected session, record `channel = app` as arrival channel, and appear in that session's ordered history and event stream.
3. FR-32/33: the prompt names arrival and session channels, `app` system guidance is documented, and a `reply` to the Mac-origin message goes to `app` in that session. Explicit `send_message` to another channel continues to work and is mirrored by E59.
4. FR-34: an Earlier session with a discoverable Claude transcript can continue through `--resume` without disturbing an active session on the same conversation. An unresumable one is read-only and returns `ack.status = rejected`, `reason = not_resumable` if sent anyway.
5. FR-35/36: `/clear`, `/stop`, `/cost`, typing/tool/activity, reply guards, journaling, `SessionTracker`, and context ledger all use the bound identity correctly. Each audited path has an automated test.
6. A scripted app-client continuation of a Telegram session returns the reply in the app; the agent names the arrival channel; Telegram receives no duplicate reply. Docs (`THREADING.md`, `APP_ADAPTER.md`, relevant command/headless docs) and CHANGELOG are updated.

## Stories

### S60.1 — Audit channel-derived identity and decide Earlier resume (FR-36)

Inventory every `(contact, channel, topic)` or `(contact, channel)` lookup across inbound routing, `reply`, stale-reply checks, typing/tool/activity, `/clear`, `/stop`, `/cost`, journaling, `SessionTracker`, context ledger, and transcript writes. Write a matrix of current key, required bound key, owner, and test location. Decide the Earlier resume model, including how the sidebar represents its original row and any fork, what `session_id` an ack returns, and how a failed `--resume` surfaces to the client. Gate S60.2–S60.5 on this decision.

### S60.2 — Authenticated session binding and owner routing (FR-30/31)

Allow only `AppAdapter` to set `metadata.bound_session_id`; do not trust this metadata on public inbound paths. Resolve and authorize it against the contact's listed sessions before enqueue. Propagate the bound `session_id`, `conversation_id`, and topic through pipeline stages and route to `sessions.agent_id`. Keep the arrival channel `app`. Test cross-agent and cross-contact guesses, hidden scheduler sessions, unknown IDs, and normal unbound messages.

### S60.3 — Transcript identity, prompt context, and reply destination (FR-30, FR-32/33)

Store the Mac-origin inbound row in the bound session with `arrival_channel = app`. Update `formatMessagesForSampling` so the agent sees, for example, "via app (in your telegram:peggy session)". Add full Markdown `app` channel guidance and attachment-path instructions. Carry the return route through `reply` and outbound transcript logging so the reply lands in the app-bound session. Test a Telegram-origin session with an app reply, then an explicit Telegram `send_message` that is mirrored in the app.

### S60.4 — Earlier-session resume and read-only fallback (FR-34)

Centralize the Claude transcript availability check used to set `resumable`. Implement the S60.1 resume decision without replacing the current active session's Claude ID. Preserve the original history and report the actual target session in ack/events. Reject absent transcripts before enqueue; if `--resume` fails after validation, return a visible failure without losing the message or corrupting the active-session pointer. Test closed Main/topic/foreign sessions and race with a new active session.

### S60.5 — Bound commands and state propagation (FR-35/36)

Make `/clear` close and journal the selected session, and `/stop` cancel only its turn, regardless of originating channel. Apply the S60.1 matrix to `/cost`, typing, tool status, activity, stale-reply guards, journaling, `SessionTracker`, and context ledger. Add a focused regression test for each matrix entry and for concurrent foreign and app conversations.

### S60.6 — End-to-end verification and documentation

Use `scripts/app-client.ts` against a test bus with a Telegram session to prove send, prompt header, app-only reply, command scope, Earlier resume, and read-only rejection. Run the full suite and type check. Update `THREADING.md`, `APP_ADAPTER.md`, `CC_HEADLESS_ADAPTER.md`, `SLASH_COMMANDS.md`, and CHANGELOG; document that Telegram's own chat can have gaps when continued from the app.

## Out of Scope

- Switching agents or letting one app token browse another agent's sessions.
- Synchronizing a Mac-only exchange back into Telegram or email.
- Resuming a Claude session whose transcript is unavailable on disk.

# E63 — Mac Client Bus Integration Gaps

| Field | Value |
|---|---|
| Epic ID | E63 |
| Status | Planned |
| Dependencies | E58–E61 implementation; E62 client protocol integration |
| Story Count | 4 |
| Estimated Complexity | M |

Source: `planning-artifacts/mac-client/PRD.md` flows F1, F3, F6; FR-14, FR-23, FR-57; `docs/APP_ADAPTER.md`; and the E62 client integration audit on 2026-09-30.

## Epic Summary

Close the bus-side gaps that remain when the native Mac client is connected to real conversations. The existing bus already emits `typing` and `tool_lines` in ephemeral `activity` frames for app-originated turns; the Mac client must decode and present those fields under E62. This epic extends that visibility to conversations that started on another channel, gives `/clear` a discoverable new app session, and verifies the end-to-end lifecycle without changing the durable cursor contract.

## Entry Criteria

- Treat E59 protocol version 1 as the compatibility baseline. Add optional fields without changing existing `hello`, `ack`, or durable `event` semantics.
- Reuse the existing headless activity subscription and app adapter bridge. Do not create a second event log or persist tool lines in `app_events`; activity remains ephemeral.
- Keep E62 client UI, Keychain, SwiftData, notifications, and Xcode acceptance in E62. Keep the E59–E61 live walkthroughs in their current epics.

## Exit Criteria

1. In a listed Telegram, email, or Siri session owned by the app-routed agent, a turn started on its original channel appears in the Mac socket as queued/running/typing and a bounded tool-call trail when those stages occur. The original channel keeps its current typing/tool behavior. A turn sent from the app into that foreign session produces the same activity, keyed to the selected session ID.
2. An app Main or app topic `/clear` closes the old session and makes a fresh active session for that same app topic discoverable without requiring another user message. The old session stays in Earlier, with its history and resumability intact. The command confirmation remains in the old session. The server emits session events for both states and gives the client an unambiguous successor ID, either in an additive ack field or a documented event relationship. Other channels' `/clear` behavior is preserved.
3. Activity snapshots on `hello` include the current state and bounded `tool_lines` for every authorized visible session, while idle/stop/error/completion clears stale state. No activity for another contact, hidden scheduler session, or another agent leaks to the socket. Durable replay ordering and cursors are unchanged.
4. Bus tests cover app-originated and foreign-originated activity, `/clear` replacement and event order, and all cleanup/visibility cases. `docs/APP_ADAPTER.md` and the client fixture/contract are updated. The full bus suite and build pass; the relevant E62 live F1/F3/F6 checks pass on the work laptop before this epic is marked complete.

## Stories

### S63.1 — Reconcile the activity frame contract

Document the actual protocol v1 `activity.data` fields: `agent_id`, `conversation_id`, `session_id`, `state`, `turn_class`, optional `typing`, and optional bounded `tool_lines`, plus capacity counts. Confirm E62's decoder handles `typing` and `tool_lines` arrays, including a `running` state with neither optional field. Add representative protocol fixtures shared by bus tests and client documentation. This story is a contract check; app decoding work stays in E62.

### S63.2 — Mirror foreign-session typing and tools

The headless runtime currently posts typing and tool status to the source channel. Add an app-facing observer path for those same turn events when the conversation has a visible session for the app contact and agent, including original-channel Telegram/email/Siri turns. Use the authoritative conversation/session mapping, not a guessed app topic. Preserve the source adapter's existing behavior, avoid duplicate app events for app-originated turns, and bound the tool trail to the current 40-line maximum. Test original-channel and app-bound foreign turns, concurrent sessions, visibility filtering, and queued-to-running transitions.

### S63.3 — App `/clear` successor session

For `app` Main and app topic sessions, create or identify the new active session as part of handling `/clear`, after closing the old row and without reusing its Claude transcript. Emit the old closed state and new active state through the existing transactional session-event path. Expose the successor ID to the client through an additive protocol-v1 field or a precise documented event contract. Keep the old command response in the old session, maintain idempotent retry behavior, and test Main/topic, repeated `/clear`, offline replay, and Earlier resume. Do not alter foreign-channel `/clear` semantics.

### S63.4 — Lifecycle verification and documentation

Exercise app-originated and foreign-originated typing/tool status through the real adapter endpoints and WebSocket, including `hello` snapshots, reply completion, `/stop`, crash, and disconnect/reconnect. Verify no stale trail remains and no unauthorized session emits activity. Run targeted tests, the full bus suite, and build. Update `docs/APP_ADAPTER.md`, architecture notes, and the E62 work-laptop F1/F3/F6 checklist with exact frame examples and `/clear` selection behavior.

## Out of Scope

- Mac UI presentation, protocol decoding implementation, and XCTest (E62).
- Persisting ephemeral typing/tool lines or changing the durable event cursor.
- New outbound file delivery, remote exposure, approval UI, or other backend types.
- Existing E59–E61 live acceptance checks unrelated to these gaps.

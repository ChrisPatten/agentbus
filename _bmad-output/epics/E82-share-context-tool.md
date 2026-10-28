# E82 — `share_context`: Context-Only Handoff to Main

| Field | Value |
|---|---|
| Epic ID | E82 |
| Dependencies | E69 (origin stamping, Main pending context), E59 (app replay events), E66 (journaling windows), E65 (`system_only` precedent) |
| Story Count | 6 |
| Estimated Complexity | M |
| Status | Complete (0.17.0; live check on baxter-mac-test passed 2026-10-28) |

Source: operator request, 2026-10-27.

---

## Epic Summary

The operator often works in a Claude Code session directly (finishing an artifact, making a decision) while the Main session in the Mac app has no idea it happened. Today the only way to tell Main is `send_message` to `channel: app`, which appears in the app as an outbound message from the agent. The operator doesn't want a message. They want Main to **know**, the same way it learns about a scheduled routine's output, without a bubble, without an alert, and without a turn.

E82 adds a `share_context` MCP tool. It writes a **hidden** outbound row into Main with a `metadata.context_only` flag. The app never shows it. Main's next turn receives it in the existing E69 pending-context block, in its own clearly worded section. Journaling still sees it.

## Problem

E69 injects foreign sends into Main's next turn, but the injection and the app display are one mechanism:

- `pending-context.ts` selects outbound rows with `${VISIBLE_TRANSCRIPT}` (`COALESCE(json_extract(t.metadata,'$.system_only'),0) = 0`).
- The app's history, replay events, session list, unread counts and quote resolution use the same condition.

So a row Main can see as context is a row the operator sees as a message. There is no row state that means "Main knows, the operator isn't shown".

The existing `system_only` flag can't be reused as-is. It is excluded from journaling windows (`loadWindow`), from journaler eligibility and from transcript search, because it marks bus-internal turns. Context handoffs are real conversation content and journaling should see them.

## Decisions

| Question | Decision |
|---|---|
| Tool shape | A separate tool, `share_context`, not a `context_only` flag on `send_message`. A flag invites the model to use it for ordinary notifications, and the two have different delivery semantics (no queue, no adapter, no activity). |
| Inputs | `to` (`contact:<id>`, required, matches `send_message`), `body` (required), `source` (required: the label is what tells Main where the note came from, e.g. `Claude Code: baxter`). No `topic`: v1 targets Main only. |
| Transport | A new route, `POST /api/v1/context`. The bus validates the contact and agent route, calls `ensureOutboundAppSession` for Main, and writes the transcript row directly. No `message_queue` row, no `DeliveryWorker`, no `AppAdapter.send`. `POST /api/v1/messages` keeps dropping reserved keys, so `context_only` can only be set by this route. |
| Row state | Outbound transcript row with `metadata = { origin, context_only: true }`. Origin is stamped as for `send_message` (`kind: 'external'` from a Claude Code session, with the label). A call from inside a Main turn is rejected: an agent should not hand itself context. |
| Flag semantics | `context_only` is a second hiding flag, separate from `system_only`. Hidden from: app history, replay events, session list previews, unread counts, `GET /api/v1/sessions/:id/transcript`, transcript search, quote resolution. Visible to: the pending-context query and journaling windows. |
| Filter split | `VISIBLE_TRANSCRIPT` gains `AND COALESCE(json_extract(t.metadata,'$.context_only'),0) = 0` for every app-facing read. A new `NOT_SYSTEM_ONLY` fragment (the old condition) is used by pending-context. Both live in `src/app/store.ts` so the two can't drift. |
| Replay | The `app_transcript_event` trigger fires for any transcript insert, so a replay event row is created. The app read paths already join `app_events` to `transcripts` through the visibility filter (as they do for `system_only`), so the event resolves to nothing and is skipped. S82.2 verifies the cursor still advances and no client sees a gap. |
| Session activity | A context-only write does not touch `sessions.last_activity` and does not bump `message_count`, so it fires no `app_session_changed` event, doesn't re-sort the sidebar, and doesn't affect Main's idle clock (already derived from `turn`-origin outbound rows only). The row attaches to the newest session row of Main's conversation, open or ended (so a note written after an idle rotation neither creates a row nor moves the sidebar) and changes nothing on it. Only a Main that has never had a session row gets one created, which emits one visible `session` event. |
| Framing for Main | A separate section in the pending-context block: "Context shared with you since your last turn (the user has not seen these)". Items carry datetime, age and label. The wording says explicitly that the user hasn't seen them, so Main doesn't say "as I told you". The existing visible-sends section is unchanged. |
| Ordering and budget | Both kinds share `max_items` / `max_chars`. They are merged in time order for budgeting, then rendered in their two sections. |
| Target | The Mac app's Main only (`channel: app`, topic `general`, the conversation `isMainConversation` recognizes). A Telegram DM is a different channel and conversation with its own Claude session, and pending context doesn't run there (E69: "other channels don't use it yet"), so v1 does not reach it. E83 adds Peggy's Telegram DM on cc-pool. The route is rejected (400) unless the `app` route for the contact targets a runtime that reads pending context: `cc-headless`, and since E83 `cc-pool` too. |
| TTL | A context-only item older than 24 hours is not injected. `adapters.app.pending_context.context_ttl_ms`, default `86_400_000`; `0` disables the cutoff. It is checked when the turn starts. Expired rows stay in the database (journaling still reads them) and the watermark advances past them, so they are never injected later. It applies to context-only items only; E69's visible foreign sends keep their existing behavior. |
| Size limit | `share_context` rejects a body over the `pending_context.max_chars` budget (default 4000) with an error telling the caller to summarize. A silent truncation would hide the loss from the sender. |
| Journaling | `loadWindow` includes context-only rows. A journaler would otherwise read them as the agent's own outbound words, so they are rendered in the journal window as `[Context shared by <label>, not shown to the user] <body>`. They don't count as a human message for eligibility. `loadWindow` bodies only reach the `script` journaler, so the engine also puts the notes since the journal cursor (read by conversation) in the job as `sharedContext`, and `jobContextLines` writes the newest 10 within 4000 characters into the prompt of the `system-message` and `cc-headless` journalers, so a note Main has not yet read still reaches the run. |
| Replying | A context-only row can't be a `reply_to` target (quote resolution uses the visible filter). |
| Rotation | Pending state is keyed by conversation (E69), so unseen context survives Main's Claude session rotation, `/clear` included. |

## Exit Criteria

1. From a Claude Code session with the agentbus MCP server, `share_context(to="contact:chris", source="Claude Code: baxter", body="…")` succeeds, and nothing appears in the Mac app: no message, no unread badge, no sidebar movement, no notification.
2. The next Main turn's prompt contains the note in the "context shared with you" section with its datetime, age and label, and the section says the user has not seen it. Sending several notes keeps them in order.
3. The note is not re-injected on later turns. It survives a Main rotation and an app restart. A note older than 24 hours (`context_ttl_ms`) is skipped, and is never injected afterwards.
4. It does not wake Main and does not move Main's idle-rotation clock.
5. The next journaling run for the Main session sees the note, attributed to its source and marked not shown to the user.
6. Existing `send_message` behavior, E69 visible-send injection and `system_only` hiding are unchanged. A call from inside a Main turn is rejected.
7. Docs (`docs/MCP_TOOLS.md`, `docs/HTTP_API.md`, `docs/CC_HEADLESS_ADAPTER.md`, `docs/APP_ADAPTER.md`, `docs/JOURNALING.md`), the matching `site-docs/` page and `CHANGELOG.md` are updated, and the Baxter `CLAUDE.md` wording is provided.

## Stories

### S82.1 — Row state and filter split

- Add `context_only` handling to `src/app/store.ts`: extend `VISIBLE_TRANSCRIPT`, add `NOT_SYSTEM_ONLY`, and switch the `pending-context.ts` outbound query to the latter. The inbound baseline query stays on `VISIBLE_TRANSCRIPT`.
- Audit every other `VISIBLE_TRANSCRIPT` use (`store.ts`, `main.ts`, `adapters/app.ts`, `http/api.ts`) and the two hand-written `system_only` conditions (`system-message.ts`, `pool-manager.ts`) so each hides or shows context-only rows on purpose.
- Add `context_only` to the reserved keys dropped at ingress (`system_blocks`, `system_only`, `journal_run_id`), so only the new route can set it.
- Tests: row hidden from history, session list, unread counts and transcript search; row included by the pending-context query.

### S82.2 — Route and hidden write

- `POST /api/v1/context`: validate the contact and the app route's agent, reject a body over budget, reject a call whose origin is a Main turn, stamp origin from the caller's `source` and environment (`originFromEnv`), and write the row in one transaction via `ensureOutboundAppSession` and `logOutboundTranscript`.
- Attach the row to Main's newest session row, open or ended; create a row only when the conversation has none. Don't update `last_activity` or `message_count`. Verify the replay event is skipped by the client-facing read path and that the cursor still advances.
- Reject (400) when the route serving Main is not `cc-headless`.
- Tests: write with no existing Main row (a session row is created), write with an open Main row, write after an idle rotation (no session event, `last_activity` unchanged), non-cc-headless route, `bus.auth_token`, over-budget rejection, Main-turn rejection, cursor continuity across a hidden event.

### S82.3 — MCP tool

- `share_context` in `src/mcp/tools/messaging.ts`, registered in both `registerAllTools` and `registerHeadlessTools`, listed in the tool index.
- The tool description tells the model what it is for (handing a Claude Code session's outcome to Main) and what it is not for (notifying the operator or asking a question).
- Tests: schema, error mapping, registration in both modes.

### S82.4 — Pending-context rendering

- Extend `src/app/pending-context.ts` to select both kinds, budget them together, and render the second section with the "user has not seen these" wording.
- The watermark advances over both kinds, as in E69, including expired and omitted context-only items.
- Add `context_ttl_ms` (default 24 h, `0` = no cutoff) to `pending_context` in `src/config/schema.ts`. Drop context-only items older than the TTL before budgeting, so an expired note never uses up `max_items` or `max_chars`.
- Tests: mixed visible and context-only items, budget overflow dropping the oldest of either, the empty cases (only one kind present), rotation carry-over, `max_items` and `max_chars` honored, a 23 h note injected and a 25 h note skipped (watermark still advanced), TTL `0`, visible foreign sends unaffected by the TTL.

### S82.5 — Journaling

- `loadWindow` keeps context-only rows and renders them with the source label and the not-shown marker. Eligibility is unchanged (not a human message).
- Plumb the notes since the cursor into the job (`sharedContext`) and the shared prompt lines (`jobContextLines`), so `system-message` and `cc-headless` journalers see them.
- Tests: window contains the note, correct attribution, no effect on `humanTimes`, prompt contains the notes (bounded), and context-only rows are not agent activity for hook health, the pause clock and the busy check.

### S82.6 — Docs, instruction and live check

- Update the docs listed in exit criterion 7, and the `site-docs/` page that covers Main and scheduled routines (users, plain language, one example). Run `npm run docs:build`.
- `CHANGELOG.md` `[Unreleased]` → Added.
- Provide the instruction text for the Baxter `CLAUDE.md` (when to call, what a good note contains, one note per finished piece of work, no questions needing an answer).
- Live check on `baxter-mac-test`: share context from a Claude Code session, confirm the app shows nothing, open the Main conversation, send a message that depends on the note, and confirm Main uses it. Confirm the journaling run mentions it.

## Resolved Questions

Operator decisions, 2026-10-27:

1. **Staleness:** a 24-hour TTL on context-only items (see the TTL decision).
2. **Scope:** Main only. Named app topics and other channels are out of scope.
3. **Audit view:** not needed. Hidden rows are visible only in the database.

## Out of Scope

- Waking Main or starting a turn (no eager warm turn).
- Other channels, including a Telegram DM (E83 covers Peggy's DM on cc-pool), email, and named app topics. Extending this would mean running pending context for those conversations (`pendingContextFor` in `cc-headless.ts` currently returns null unless the conversation is Main) and choosing the target conversation in `share_context`.
- A debug or audit view of hidden context.
- Replacing journaling or the memory files as the durable record. This is a short-lived handoff.
- Showing hidden context in the Mac app.

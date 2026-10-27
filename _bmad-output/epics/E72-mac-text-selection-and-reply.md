# E72 — Mac Text Selection, Copy, and Reply

| Field | Value |
|---|---|
| Epic ID | E72 |
| Status | Implemented; live acceptance pending |
| Dependencies | E62 (Mac client), E59 (app adapter protocol v1), E28 (Telegram quoted-reply context) |
| Story Count | 5 |
| Estimated Complexity | M–L |

Source: operator report and design discussion, 2026-10-14.

## Epic Summary

Text selection and copying in the Mac transcript are unreliable, and there is no way to reply to a specific message. This epic fixes the copy button, rebuilds message bodies on a native text view so selection works across a whole message, and adds two kinds of reply: quoting a selection into the composer as Markdown, and replying to a whole message by reference, following the Telegram `quoted_message` pattern.

## Problems

1. **Selection stops at block boundaries (confirmed).** `MarkdownView` (`apps/macos/AgentBus/AgentBus/Markdown.swift`) draws each paragraph, heading, quote, and list item as a separate SwiftUI `Text` with `.textSelection(.enabled)`. On macOS a selection cannot cross from one `Text` to the next, so the operator can select only one bullet at a time, even in a short message. List markers are separate `Text` views from their item text.
2. **Selection can't be extended.** SwiftUI's `Text` selection supports double-click on a word but not reliable shift-click or double-click-drag extension.
3. **Selection is lost on redraw.** `AgentMessageView` toggles `@State hovering` on hover enter/exit (`TranscriptView.swift`), which re-parses the Markdown and rebuilds every `Text`, which can drop an in-progress selection.
4. **The copy button can't be reached.** In `AgentMessageView` the `.onHover` region has no `.contentShape`, so only drawn content counts. The selectable body likely captures pointer tracking, and the button is hidden with `.opacity(0)`, which is not hit-testable. Hovering the timestamp shows the button; moving toward it crosses a non-hit-testable gap, hover ends, and the button is hidden again before it can be clicked.
5. **No copy for operator messages**, and the hover-only button isn't usable from the keyboard or VoiceOver.
6. **No reply action.** SwiftUI `Text` selection doesn't expose the selected text or allow custom context-menu items, so a reply feature requires a native text view.

## Design Decisions

| Decision | Choice |
|---|---|
| Selection scope | One message per selection. Selection never spans messages. |
| Messages that support Reply | Both agent and operator messages. |
| Reply with a selection | Quoted as Markdown in the draft body. App only, no `reply_to`. |
| Reply with no selection | Whole-message reference, sent as `reply_to` on the `send` frame. The bus builds `quoted_message`. |
| Selection replies carry `reply_to`? | No. One message may contain several quotes from different messages; a single reference would be misleading. Quotes describe themselves. |
| Formatting of quoted selections | Kept: the selected attributed text is converted back to Markdown via `MarkdownWriter`. |
| Quote length for references | 200 characters, the same as Telegram (E28). |
| `sender_name` for references | `you` for operator messages, `agent` for agent messages. |
| Keyboard shortcut | ⌘⇧R replies to the current selection. With no selection it does nothing. |
| Code blocks | Remain separate views (header, copy button, horizontal scroll). A selection stops at a code block boundary. |

## Exit Criteria

1. The copy button is reachable by pointer on every agent message, and **Copy Message** is available from the context menu on both agent and operator messages. Copy returns the original Markdown source.
2. In any message, the operator can drag-select across paragraphs, headings, quotes, and list items (including markers), extend with shift-click, and double-click-drag by word. Selection survives hover changes and live-activity redraws while it stays within one message.
3. Right-click → **Reply** or ⌘⇧R with a selection appends the selection as a Markdown quote (each line prefixed `> `, interior blank lines `>`, followed by one empty line) to the session's draft, separated from existing text by a blank line. Focus moves to the composer with the insertion point at the end, and no text is selected. Inline formatting (bold, italic, code, links) and list markers survive the round trip.
4. Right-click → **Reply** with no selection shows a "Replying to…" bar above the composer that can be cancelled with ✕ or Esc. The send carries `reply_to`; the agent sees `[Replying to you|agent: "<first 200 chars>"]` above the message. The sent bubble shows a reply note that scrolls to the original when clicked, including after reload and on another client.
5. Operator bubbles render block quotes, so sent quotes look correct.
6. Bus tests, XCTest cases, `docs/APP_ADAPTER.md`, the Mac client docs, `site-docs/`, and `CHANGELOG.md` are updated. The full bus suite, `tsc`, `npm run docs:build`, and the Xcode build/test pass.

## Stories

### S72.1 — Reachable copy button and Copy Message menu

Can ship on its own as a patch, ahead of the rest of the epic.

- Give `AgentMessageView` a full-width hover region (`.contentShape(Rectangle())` on the message container).
- Keep the copy button hit-testable while faded (dimmed rather than `opacity(0)`), and optionally keep it visible briefly after hover ends.
- Add **Copy Message** to a context menu on agent and operator messages. Agent copy returns `message.body` (Markdown source); operator copy returns the sent body.
- Add an accessibility action for copy so it doesn't depend on hover.

### S72.2 — Native message text view

Replace the stacked `Text` views with one read-only, selectable `NSTextView` per run of non-code content (`NSViewRepresentable`).

- Render paragraphs, headings, lists (markers included in the text), quotes, and rules into one `NSAttributedString`. Use font traits and attributes that `MarkdownWriter` understands: bold/italic traits, monospaced font for inline code, `.link`, and `•\t` list prefixes.
- Split a message into alternating text-view runs and `CodeBlockView`s.
- Use the same view for operator bubbles (white text, accent background) and add block-quote rendering to them; they currently use `MarkdownParser.inline` only.
- Build the attributed string only when the message body changes, so hover and live-activity redraws keep the selection. Don't let the hover state rebuild the body.
- Size correctly inside the `LazyVStack`: the height is measured at the column width and reflows on window resize.
- Keep the system context menu items (Copy, Look Up, Services) and leave room for S72.3's Reply item.
- Coordinate with the backlog item for GFM tables (`_bmad-output/backlog.md`): tables must fit into this rendering model later.
- XCTest: attributed-string rendering of each block type, and a round trip (rendered substring → `MarkdownWriter` → expected Markdown) for bold, italic, inline code, links, and lists.

### S72.3 — Reply with selection

Depends on S72.2. App only.

- Add a **Reply** item at the top of the message text view's context menu when there is a selection, and a ⌘⇧R menu command (in the Session menu, via `focusedSceneValue`) enabled only while a transcript selection exists.
- Convert the selected attributed substring to Markdown with `MarkdownWriter`, trim leading and trailing blank lines, prefix each line with `> ` (blank lines become `>`), and append `\n\n`.
- Write to `connection.drafts[draftKey]` for the transcript's session: when the draft is empty use the quote alone; otherwise append after the existing text with a blank-line separator.
- Focus the composer and place the insertion point at the end without selecting everything. The composer is `TextField(axis: .vertical)`; use its `selection:` binding or the underlying field editor, because a plain focus change can select all text.
- XCTest: quote formatting (single line, multi-line, interior blank lines, list, code span), appending to empty and non-empty drafts, and multiple quotes in one draft.

### S72.4 — Bus: `reply_to` on app sends

- Add an optional `reply_to: <message_id>` (UUID) to the `send` frame schema in `src/http/app-routes.ts`, and carry it in `StoredIntent` so recovery and idempotent retries preserve it.
- Resolve it on the server: the transcript must be a visible message in a session of this contact and agent. (Decided during planning: the bus keeps no resumed-from link, so the check is not limited to the target session or its origin.) An unknown or foreign ID returns `rejected` with reason `reply_target_not_found`; the client never supplies quote text.
- Build `metadata.quoted_message = { message_id, sender_name, text }` with `sender_name` `you` for inbound or `agent` for outbound, and `text` cut to 200 characters. The existing formatter in `src/adapters/cc.ts` renders the `[Replying to …]` line for both cc-pool and cc-headless.
- Don't set the inbound envelope's `reply_to`: on the app channel that field drives outbound reply binding (`boundAppReply` in `src/app/binding.ts`).
- Confirm that inbound transcript metadata keeps `quoted_message`, and expose it from `messageInfo` (`src/app/store.ts`) as an optional `reply_to: { message_id, sender_name, text }` on history and `message` events.
- Tests: accepted reference to agent and operator messages, rejection for a foreign contact/session, truncation, recovery after a crash, retry idempotency, the formatted agent prompt line, and history/event serialization.
- This is an additive protocol-v1 field (MINOR).

### S72.5 — Mac: reply to whole message

Depends on S72.4; can be built alongside S72.2.

- Add **Reply** to the message context menu when nothing is selected, on agent and operator messages. ⌘⇧R does nothing without a selection.
- Keep reply state per session alongside the draft. Show a "Replying to…" bar above the composer with the target's first line and ✕; Esc cancels it. Sending or switching to a different reply target replaces it.
- Send `reply_to` in the `send` frame and persist it on `PendingSend` so retries keep it.
- Decode the optional `reply_to` on `BusMessage` and in `CachedMessage`; render a "↩ Replying to…" note above the bubble that scrolls the transcript to the original (loading older history if needed) and briefly highlights it.
- Handle `reply_target_not_found` in the send-failure text.
- XCTest: protocol decoding with and without `reply_to`, pending-send persistence, and reply-state lifecycle.

## Documentation

- `docs/APP_ADAPTER.md`: `send.reply_to`, the rejection reason, `reply_to` on message events/history, and the agent-facing prompt line.
- `apps/macos/AgentBus/README.md` and internal Mac docs: selection model, Reply, ⌘⇧R.
- `site-docs/`: the Mac app page — copying messages, selecting text, replying to a selection, replying to a message, and the shortcut.
- `CHANGELOG.md` `[Unreleased]`: S72.1 under Fixed; S72.2 under Fixed/Changed; S72.3–S72.5 under Added.

## Out of Scope

- Selection that spans multiple messages.
- Multiple `reply_to` references per message, or linking from individual quotes back to their source.
- Sending replies back as native quote-replies on the session's original channel (for example, Telegram `reply_parameters`) when the app replies inside a foreign session.
- GFM table rendering (tracked in `_bmad-output/backlog.md`).
- iOS (Peggy) client changes.

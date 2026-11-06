# E99 — Mac Markdown Tables

| Field | Value |
|---|---|
| Epic ID | E99 |
| Status | Implemented; live check pending |
| Dependencies | E62 (Mac client), E72 (native message text view) |
| Story Count | 3 |
| Estimated Complexity | S |

Source: backlog item "macOS app: render Markdown tables in messages" (flagged 2026-10-05), approved for work 2026-11-04. E97 and E98 are reserved for the E96 follow-ons (web client views, widget runtime).

## Epic Summary

The Mac client's block parser (`apps/macos/AgentBus/AgentBus/Markdown.swift`) has no table block, so a GFM pipe table in an agent reply shows as raw `| a | b |` and `|---|---|` text. This epic adds a `.table` block and renders it as a native grid.

## Design Decisions

| Decision | Choice |
|---|---|
| Rendering model | A table is its own segment, like a fenced code block: a SwiftUI `Grid`, not an `NSTextTable` in the shared text storage. TextKit 1 tables don't scroll horizontally and don't fit `MessageNSTextView.fittingSize` or the `MarkdownWriter` round trip. |
| Selection | A drag selection stops at a table, the same as at a code block (E72). Cells are selectable on their own. **Copy Message** still copies the original Markdown. |
| Wide tables | Scroll horizontally inside the message column, like code blocks. Cells don't wrap. |
| Cells | Inline Markdown (bold, italic, code, strikethrough, links) through `MarkdownParser.inline`. The header row is semibold. Columns follow the `:---`, `:---:`, `---:` alignment markers. |
| Detection | A pipe row followed by a delimiter row with the same number of cells. Leading and trailing pipes are optional. As in GFM, only `\|` keeps a pipe inside a cell, including inside a backtick code span. Body rows end at a blank line or a line without a pipe. Ragged rows are padded or truncated to the header width. |
| Not tables | Pipe text with no delimiter row stays a paragraph. Pipes inside fenced code stay code. Tables inside lists and quotes aren't supported: they render as they did before. |
| Operator bubbles | Your own bubbles render a table as aligned monospaced text with a separator line. That's the same fallback fenced code gets there. |

## Exit Criteria

1. A GFM table in an agent message renders as a grid with a header, row separators, per-column alignment, inline formatting in cells, and horizontal scroll when wider than the column.
2. The parser cases in the Detection and Not tables rows above are covered by `MarkdownTests`.
3. A table in an operator bubble renders as aligned monospaced text.
4. `docs/MAC_CLIENT.md`, `site-docs/channels/mac-app.md`, and `CHANGELOG.md` are updated. `npm run docs:build` and the Xcode build and tests pass.

## Stories

### S99.1 — Parse tables

- Add `MarkdownBlock.table(Table)` with `header`, `alignments`, and `rows`.
- Detect, split cells, and normalize as described in Design Decisions.
- XCTest: basic table, alignments, no outer pipes, escaped pipe (also inside a code span), ragged rows, a table directly after a paragraph, pipe text with no delimiter row, a pipe table inside a fence, a table ended by a non-pipe line.

### S99.2 — Render tables

- Add `.table` to `MarkdownView.Segment` so a table breaks the text run.
- Add `MarkdownTableView`: a `Grid` in a horizontal `ScrollView` around `MarkdownTableGrid`, header fill, row dividers, alignment, selectable cells, styled like `CodeBlockView`.
- In `MessageTextBuilder` (operator bubbles), render a table as padded monospaced lines.
- XCTest: segmenting around a table, and the bubble fallback text.

### S99.3 — Docs

- `docs/MAC_CLIENT.md`, `site-docs/channels/mac-app.md`, `CHANGELOG.md`, and the backlog item marked as promoted.

## Live check (operator)

Send an agent reply that has a table, including a wide one, and look at it in light and dark mode.

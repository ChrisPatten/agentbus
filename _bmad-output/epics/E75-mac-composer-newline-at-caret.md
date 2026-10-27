# E75 — Mac Composer: Newline at the Caret

| Field | Value |
|---|---|
| Epic ID | E75 |
| Status | Implemented; live check in the app pending |
| Dependencies | E62 (Mac client), E72 (composer caret handling) |
| Story Count | 3 |
| Estimated Complexity | S |

Source: operator report, 2026-10-20.

## Epic Summary

In the Mac composer, Shift+Return (and Option+Return) puts the new line after the end of the draft instead of at the insertion point, and the caret doesn't move. This epic makes the newline insert where the caret is, with the caret landing after it, as in any text editor.

## Problem

`ComposerView.handleKey` (`apps/macos/AgentBus/AgentBus/ComposerView.swift`) handles `.return` with a modifier by appending to the bound string:

```swift
if press.modifiers.contains(.shift) || press.modifiers.contains(.option) {
    draft.wrappedValue += "\n"; return .handled
}
```

Root cause: `draft` is the `TextField`'s string binding, and `+= "\n"` always writes at `endIndex`, ignoring the caret entirely. Consequences:

1. **Mid-draft**: with the caret in the middle of the text, the newline is added at the very end, not at the caret. This is the reported "newlines after the cursor" behaviour. Any selection is also left in place rather than replaced.
2. **At the end of the draft**: the newline lands in the right place, but the field's `caret` (`TextSelection` binding) still refers to the old index and the bound string was replaced wholesale, so the caret may not advance past the new line.
3. **Undo**: replacing the whole string through the binding bypasses the field editor, so ⌘Z doesn't undo the newline as one step.

The same handler is the only place newlines are inserted; plain Return sends.

## Design Decisions

| Decision | Choice |
|---|---|
| Where the newline goes | At the caret, replacing any selected range. The caret ends up after the newline. |
| Mechanism | Prefer the native field editor: take the window's first responder `NSTextView` and call `insertNewlineIgnoringFieldEditor(_:)` (or `insertText("\n", replacementRange:)`), as `ComposerModel.paste` already does for rich paste. This keeps undo, IME, and selection semantics. Fallback if the field editor isn't reachable: edit `draft` through the `caret` `TextSelection` (replace the selected ranges, then set `caret` to an insertion point after the `\n`). |
| Modifiers | Shift+Return and Option+Return, unchanged. ⌘Return and plain Return still send. |
| Slash popover | Unchanged: with the popover showing, Return still completes the command. |

The implementer should confirm in S75.1 which mechanism works with `TextField(axis: .vertical)`, since SwiftUI's field editor handling can differ between OS versions.

## Exit Criteria

1. With the caret mid-draft, Shift+Return inserts a newline at the caret and the caret sits after it. Typing continues on the new line.
2. With a selection, Shift+Return replaces the selection with a newline.
3. At the end of the draft and in an empty draft, the caret ends up after the newline.
4. Option+Return behaves identically. Plain Return still sends, and the slash-command popover is unaffected.
5. ⌘Z undoes the newline as a single step.
6. The draft stored in `connection.drafts` (per session) reflects the edit, and the composer height still grows up to its 8-line limit.
7. XCTest covers the newline-insertion logic, `CHANGELOG.md` has a Fixed entry, and the Mac client docs and `site-docs/` mention the shortcut only if they already describe it.

## Stories

### S75.1 — Insert newline at the caret

- Replace the `draft.wrappedValue += "\n"` branch in `handleKey` with an insertion at the caret using the mechanism chosen above.
- Extract the string-and-selection edit as a small pure helper (input: text, selected range; output: new text, new caret) so it can be unit tested without a view, and use it for the fallback path.
- Verify live: mid-draft, selection, end, empty, multi-line draft, and a draft that was restored when switching sessions.

### S75.2 — Tests and docs

- XCTest for the helper: empty text, caret at start, middle, and end, selection replaced, non-ASCII and emoji (grapheme boundaries), existing trailing newline.
- `CHANGELOG.md` `[Unreleased]` → Fixed. Update `apps/macos/AgentBus/README.md` and `site-docs/` only where the composer keys are already documented; update the relevant `docs/` file.

### S75.3 — Keep the newest message visible as the composer grows

Operator report, 2026-10-21. The composer sits in a bottom safe-area inset, so growing the field raises the inset without moving the transcript, and the last message is covered. `TranscriptView` also read the larger inset as "scrolled away" and stopped following.

- Track the bottom inset together with the at-bottom flag. When only the inset changes and the transcript was following, scroll to the bottom; otherwise update `following` as before.
- Live check: add lines with Shift-Return at the bottom of a conversation (the last message stays visible), then scroll up and add lines (the position does not jump).

## Out of Scope

- Changing the send key bindings or making them configurable.
- iOS (Peggy) composer.
- Rich-text or Markdown editing in the composer.

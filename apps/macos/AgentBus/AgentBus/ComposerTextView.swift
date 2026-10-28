import SwiftUI
import AppKit

/// Keys the composer acts on before the text view's own handling.
enum ComposerKey { case send, up, down, tab, escape, pageUp, pageDown }

/// The composer's text area: a text view of its own in a scroll view, growing from one line to
/// `maxLines`, then scrolling. SwiftUI's vertical TextField edits through the window's shared field
/// editor, which jumps back to the start of the draft when focus leaves, ignores the scroll wheel, keeps
/// a stale wrap width after a resize, and clips the bottom of the last line and the caret.
struct ComposerTextView: NSViewRepresentable {
    @Binding var text: String
    let placeholder: String
    let model: ComposerModel
    /// Whether the key was handled. Unhandled keys get the text view's default behavior.
    let onKey: (ComposerKey) -> Bool

    static let maxLines = 8
    static let font = NSFont.systemFont(ofSize: NSFont.systemFontSize)
    /// Vertical padding inside the scroll view, so the caret and descenders of the last line aren't clipped.
    static let inset: CGFloat = 7

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSScrollView {
        let storage = NSTextStorage()
        let layout = NSLayoutManager()
        let container = NSTextContainer(size: NSSize(width: 0, height: CGFloat.greatestFiniteMagnitude))
        container.lineFragmentPadding = 0
        container.widthTracksTextView = true
        storage.addLayoutManager(layout)
        layout.addTextContainer(container)

        let view = ComposerNSTextView(frame: .zero, textContainer: container)
        view.isRichText = false
        view.allowsUndo = true
        view.font = Self.font
        view.textColor = .labelColor
        view.drawsBackground = false
        view.textContainerInset = NSSize(width: 0, height: Self.inset)
        view.isVerticallyResizable = true
        view.isHorizontallyResizable = false
        view.autoresizingMask = [.width]
        view.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude)
        view.delegate = context.coordinator
        view.string = text
        view.focusChanged = { [weak model, weak view] focused in
            guard let model, let view else { return }
            model.focusChanged(focused, in: view)
        }
        view.setAccessibilityLabel("Message")
        model.textView = view

        let scroll = OverlayScrollView()
        scroll.drawsBackground = false
        scroll.borderType = .noBorder
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.documentView = view
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        context.coordinator.parent = self
        guard let view = scroll.documentView as? NSTextView else { return }
        view.setAccessibilityPlaceholderValue(placeholder)
        // A change from outside the text view (a quote appended, the draft sent, another session's draft)
        // replaces the text and puts the insertion point at the end.
        guard view.string != text, !view.hasMarkedText() else { return }
        view.string = text
        view.setSelectedRange(NSRange(location: (text as NSString).length, length: 0))
        view.scrollRangeToVisible(view.selectedRange())
    }

    /// One line to `maxLines` lines tall at the proposed width, plus the insets. Measured off-screen:
    /// resizing the visible text view here would ask for another layout pass from inside this one, which
    /// a large paste turned into a loop that AppKit ends by crashing.
    func sizeThatFits(_ proposal: ProposedViewSize, nsView scroll: NSScrollView, context: Context) -> CGSize? {
        guard let width = proposal.width, width > 0 else { return nil }
        let draft = (scroll.documentView as? NSTextView)?.string ?? text
        let line = context.coordinator.lineHeight
        let content = min(max(context.coordinator.textHeight(draft, width: width), line), line * CGFloat(Self.maxLines))
        return CGSize(width: width, height: ceil(content) + 2 * Self.inset)
    }

    @MainActor final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: ComposerTextView
        private let storage = NSTextStorage()
        private let layout = NSLayoutManager()
        private let container = NSTextContainer(size: NSSize(width: 0, height: CGFloat.greatestFiniteMagnitude))
        private var measured: (text: String, width: CGFloat, height: CGFloat)?

        init(_ parent: ComposerTextView) {
            self.parent = parent
            container.lineFragmentPadding = 0
            storage.addLayoutManager(layout)
            layout.addTextContainer(container)
        }

        var lineHeight: CGFloat { layout.defaultLineHeight(for: ComposerTextView.font) }

        /// The height `text` wraps to at `width`, laid out the way the visible text view lays it out.
        func textHeight(_ text: String, width: CGFloat) -> CGFloat {
            if let measured, measured.width == width, measured.text == text { return measured.height }
            storage.setAttributedString(NSAttributedString(string: text, attributes: [.font: ComposerTextView.font]))
            container.size = NSSize(width: width, height: .greatestFiniteMagnitude)
            layout.ensureLayout(for: container)
            let height = layout.usedRect(for: container).height
            measured = (text, width, height)
            return height
        }

        func textDidChange(_ notification: Notification) {
            guard let view = notification.object as? NSTextView else { return }
            parent.text = view.string
            view.enclosingScrollView?.invalidateIntrinsicContentSize()
        }

        func textView(_ textView: NSTextView, doCommandBy selector: Selector) -> Bool {
            switch selector {
            case #selector(NSResponder.insertNewline(_:)):
                // Shift- and Option-Return insert a line break at the insertion point, replacing any
                // selection, with undo (E75). Plain Return sends.
                let flags = NSApp.currentEvent?.modifierFlags ?? []
                if flags.contains(.shift) || flags.contains(.option) {
                    textView.insertNewlineIgnoringFieldEditor(nil)
                    return true
                }
                return parent.onKey(.send)
            case #selector(NSResponder.moveUp(_:)): return parent.onKey(.up)
            case #selector(NSResponder.moveDown(_:)): return parent.onKey(.down)
            case #selector(NSResponder.insertTab(_:)):
                if !parent.onKey(.tab) { textView.window?.selectNextKeyView(nil) }
                return true
            case #selector(NSResponder.insertBacktab(_:)):
                textView.window?.selectPreviousKeyView(nil)
                return true
            // Swallowed when unhandled: a text view's Escape otherwise opens the completion list.
            case #selector(NSResponder.cancelOperation(_:)):
                _ = parent.onKey(.escape)
                return true
            case #selector(NSResponder.scrollPageUp(_:)), #selector(NSResponder.pageUp(_:)): return parent.onKey(.pageUp)
            case #selector(NSResponder.scrollPageDown(_:)), #selector(NSResponder.pageDown(_:)): return parent.onKey(.pageDown)
            default: return false
            }
        }
    }
}

/// Always overlay scrollers, even with a mouse attached: a legacy scroller appearing past `maxLines`
/// would narrow the text, re-wrap it and change the measured height.
final class OverlayScrollView: NSScrollView {
    override var scrollerStyle: NSScroller.Style {
        get { .overlay }
        set { super.scrollerStyle = .overlay }
    }
}

/// Reports focus changes, and puts the insertion point at the end of the draft when focus arrives from
/// anywhere but a click in the text (Tab, a quote, a session switch). A click places it where you click.
/// Leaving focus changes nothing, so the draft stays where it was scrolled.
final class ComposerNSTextView: NSTextView {
    var focusChanged: ((Bool) -> Void)?

    override func becomeFirstResponder() -> Bool {
        guard super.becomeFirstResponder() else { return false }
        if !isClickInside(NSApp.currentEvent) { moveInsertionPointToEnd() }
        focusChanged?(true)
        return true
    }

    override func resignFirstResponder() -> Bool {
        guard super.resignFirstResponder() else { return false }
        focusChanged?(false)
        return true
    }

    func moveInsertionPointToEnd() {
        setSelectedRange(NSRange(location: (string as NSString).length, length: 0))
        scrollRangeToVisible(selectedRange())
    }

    private func isClickInside(_ event: NSEvent?) -> Bool {
        guard let event, event.window === window,
              [.leftMouseDown, .rightMouseDown, .otherMouseDown].contains(event.type),
              let scroll = enclosingScrollView else { return false }
        return scroll.bounds.contains(scroll.convert(event.locationInWindow, from: nil))
    }
}

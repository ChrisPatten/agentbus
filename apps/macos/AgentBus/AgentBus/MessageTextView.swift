import SwiftUI
import AppKit

struct MessageMenuAction {
    let title: String
    let handler: @MainActor () -> Void
}

/// Tracks the one selection a transcript can hold. Starting a selection in another message text view
/// clears the previous one, so a selection never spans messages and Reply always knows what to quote.
/// It is also the transcript's single Reply entry point: a selection is quoted into the draft, and a
/// message with nothing selected becomes the draft's reply reference.
@MainActor @Observable final class TranscriptSelection {
    private(set) var hasSelection = false
    /// Whether Reply applies: the session accepts messages. Set by the session view.
    var canReply = false
    /// Called with the selection as Markdown. Set by the session view.
    @ObservationIgnored var onReply: (String) -> Void = { _ in }
    /// Called with the message to reply to as a whole. Set by the session view.
    @ObservationIgnored var onReplyToMessage: (ReplyRef) -> Void = { _ in }
    @ObservationIgnored private weak var owner: MessageNSTextView?

    var selectedMarkdown: String? { owner?.selectedMarkdown() }

    func changed(_ view: MessageNSTextView) {
        if view.selectedRange().length > 0 {
            let previous = owner
            owner = view   // before clearing, so the previous view's own notification is ignored
            hasSelection = true
            if let previous, previous !== view { previous.clearSelection() }
        } else {
            released(view)
        }
    }

    /// The view lost its selection or left the window (a lazy row scrolled away).
    func released(_ view: MessageNSTextView) {
        guard owner === view else { return }
        owner = nil
        hasSelection = false
    }

    func clear() { owner?.clearSelection() }

    func reply() {
        guard canReply, let markdown = selectedMarkdown else { return }
        onReply(markdown)
    }

    func replyToMessage(_ target: ReplyRef) {
        guard canReply else { return }
        onReplyToMessage(target)
    }
}

extension EnvironmentValues {
    @Entry var transcriptSelection: TranscriptSelection?
}

/// Draws what attributes alone can't: the bar beside a block quote and the line for a horizontal rule.
final class MessageLayoutManager: NSLayoutManager {
    override func drawBackground(forGlyphRange glyphsToShow: NSRange, at origin: NSPoint) {
        super.drawBackground(forGlyphRange: glyphsToShow, at: origin)
        guard let storage = textStorage, let container = textContainers.first else { return }
        let characters = characterRange(forGlyphRange: glyphsToShow, actualGlyphRange: nil)

        storage.enumerateAttribute(MessageTextBuilder.quoteKey, in: characters) { value, range, _ in
            guard value != nil else { return }
            var top = CGFloat.greatestFiniteMagnitude
            var bottom = -CGFloat.greatestFiniteMagnitude
            enumerateLineFragments(forGlyphRange: glyphRange(forCharacterRange: range, actualCharacterRange: nil)) { _, used, _, _, _ in
                top = min(top, used.minY)
                bottom = max(bottom, used.maxY)
            }
            guard top < bottom else { return }
            let bar = NSRect(x: origin.x, y: origin.y + top, width: 3, height: bottom - top)
            NSColor.separatorColor.setFill()
            NSBezierPath(roundedRect: bar, xRadius: 1.5, yRadius: 1.5).fill()
        }

        storage.enumerateAttribute(MessageTextBuilder.ruleKey, in: characters) { value, range, _ in
            guard value != nil else { return }
            enumerateLineFragments(forGlyphRange: glyphRange(forCharacterRange: range, actualCharacterRange: nil)) { _, used, _, _, _ in
                let width = self.firstTextView?.bounds.width ?? container.size.width
                let line = NSRect(x: origin.x, y: origin.y + used.midY, width: width, height: 1)
                NSColor.separatorColor.setFill()
                line.fill()
            }
        }
    }
}

@MainActor private final class ClosureMenuItem: NSMenuItem {
    private let handler: @MainActor () -> Void

    init(title: String, handler: @escaping @MainActor () -> Void) {
        self.handler = handler
        super.init(title: title, action: #selector(fire), keyEquivalent: "")
        target = self
    }

    required init(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    @objc private func fire() { handler() }
}

/// A read-only, selectable text view that grows to fit its text. One of these holds a whole run of
/// non-code message content, so a selection can span paragraphs, headings, quotes, and list items.
final class MessageNSTextView: NSTextView {
    var menuActions: [MessageMenuAction] = []
    var selectionModel: TranscriptSelection?
    /// The message this text belongs to, for **Reply** when nothing is selected.
    var replyTarget: ReplyRef?
    private var renderedBlocks: [MarkdownBlock] = []
    private var renderedKind: MessageTextBuilder.Kind?

    convenience init() {
        let storage = NSTextStorage()
        let layout = MessageLayoutManager()
        let container = NSTextContainer(size: NSSize(width: 0, height: CGFloat.greatestFiniteMagnitude))
        container.lineFragmentPadding = 0
        container.widthTracksTextView = true
        storage.addLayoutManager(layout)
        layout.addTextContainer(container)
        self.init(frame: .zero, textContainer: container)
        isEditable = false
        isSelectable = true
        drawsBackground = false
        textContainerInset = .zero
        isVerticallyResizable = false
        isHorizontallyResizable = false
        isAutomaticLinkDetectionEnabled = false
    }

    /// Replaces the text only when the content or style changed. Redraws that leave the message alone,
    /// such as hover changes and live activity updates, therefore keep the user's selection.
    func apply(blocks: [MarkdownBlock], kind: MessageTextBuilder.Kind) {
        guard blocks != renderedBlocks || kind != renderedKind else { return }
        if kind != renderedKind {
            switch kind {
            case .agent:
                linkTextAttributes = [.foregroundColor: NSColor.controlAccentColor, .cursor: NSCursor.pointingHand]
                selectedTextAttributes = [.backgroundColor: NSColor.selectedTextBackgroundColor]
            case .operatorBubble:
                linkTextAttributes = [.foregroundColor: NSColor.white, .underlineStyle: NSUnderlineStyle.single.rawValue,
                                      .cursor: NSCursor.pointingHand]
                selectedTextAttributes = [.backgroundColor: NSColor.white.withAlphaComponent(0.35)]
            }
        }
        renderedBlocks = blocks
        renderedKind = kind
        textStorage?.setAttributedString(MessageTextBuilder.build(blocks, kind: kind))
    }

    /// The size the text needs when offered `maxWidth`. Short text reports its own width, so bubbles hug it.
    func fittingSize(maxWidth: CGFloat?) -> CGSize {
        guard let container = textContainer, let layout = layoutManager else { return .zero }
        container.containerSize = NSSize(width: maxWidth ?? 100_000, height: .greatestFiniteMagnitude)
        layout.ensureLayout(for: container)
        let used = layout.usedRect(for: container)
        return CGSize(width: min(ceil(used.width), maxWidth ?? .infinity), height: ceil(used.height))
    }

    /// The selected text as Markdown, or nil when nothing is selected.
    func selectedMarkdown() -> String? {
        let range = selectedRange()
        guard range.length > 0, let storage = textStorage, NSMaxRange(range) <= storage.length else { return nil }
        return MarkdownWriter.markdown(from: storage.attributedSubstring(from: range))
    }

    func clearSelection() { setSelectedRange(NSRange(location: 0, length: 0)) }

    override func setSelectedRanges(_ ranges: [NSValue], affinity: NSSelectionAffinity, stillSelecting: Bool) {
        super.setSelectedRanges(ranges, affinity: affinity, stillSelecting: stillSelecting)
        selectionModel?.changed(self)
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil { selectionModel?.released(self) }
    }

    override func menu(for event: NSEvent) -> NSMenu? {
        let menu = super.menu(for: event) ?? NSMenu()
        // A selection is quoted into the draft; with nothing selected the whole message is the reply target.
        if let selectionModel, selectionModel.canReply {
            let item: ClosureMenuItem?
            if selectedRange().length > 0 {
                item = ClosureMenuItem(title: "Reply") { [weak selectionModel] in selectionModel?.reply() }
            } else if let target = replyTarget {
                item = ClosureMenuItem(title: "Reply") { [weak selectionModel] in selectionModel?.replyToMessage(target) }
            } else {
                item = nil
            }
            if let item {
                menu.insertItem(item, at: 0)
                menu.insertItem(.separator(), at: 1)
            }
        }
        guard !menuActions.isEmpty else { return menu }
        if !menu.items.isEmpty { menu.addItem(.separator()) }
        for action in menuActions { menu.addItem(ClosureMenuItem(title: action.title, handler: action.handler)) }
        return menu
    }
}

struct MessageTextView: NSViewRepresentable {
    let blocks: [MarkdownBlock]
    let kind: MessageTextBuilder.Kind
    /// Adds **Copy Message** to the context menu; the system items (Copy, Look Up, Services) stay.
    var copyMessage: (@MainActor () -> Void)?
    /// The message these blocks belong to, for **Reply** with no selection.
    var replyTarget: ReplyRef?
    @Environment(\.transcriptSelection) private var transcriptSelection

    func makeNSView(context: Context) -> MessageNSTextView { MessageNSTextView() }

    func updateNSView(_ view: MessageNSTextView, context: Context) {
        view.selectionModel = transcriptSelection
        view.replyTarget = replyTarget
        view.menuActions = copyMessage.map { [MessageMenuAction(title: "Copy Message", handler: $0)] } ?? []
        view.apply(blocks: blocks, kind: kind)
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView: MessageNSTextView, context: Context) -> CGSize? {
        nsView.fittingSize(maxWidth: proposal.width.flatMap { $0.isFinite ? $0 : nil })
    }
}

import XCTest
import SwiftUI
@testable import AgentBus

/// Drives the composer inside a real `MainWindow` on preview fixtures, where SwiftUI sizes it through the
/// transcript's safe-area inset and glass capsule.
@MainActor final class ComposerLayoutTests: XCTestCase {
    private var window: NSWindow!

    override func setUp() async throws {
        let model = PreviewFixtures.model()
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 760, height: 700),
                          styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: MainWindow(model: model, initialSelection: PreviewFixtures.mainID)
            .modelContainer(model.container))
        window.makeKeyAndOrderFront(nil)
        pump(1)
    }

    override func tearDown() async throws {
        window.close()
        window = nil
    }

    private func pump(_ seconds: TimeInterval) {
        let until = Date().addingTimeInterval(seconds)
        while Date() < until {
            if let event = NSApp.nextEvent(matching: .any, until: Date().addingTimeInterval(0.02), inMode: .default, dequeue: true) {
                NSApp.sendEvent(event)
            }
        }
    }

    private func composer() throws -> ComposerNSTextView {
        func find(_ view: NSView) -> ComposerNSTextView? {
            if let match = view as? ComposerNSTextView { return match }
            return view.subviews.lazy.compactMap(find).first
        }
        return try XCTUnwrap(find(window.contentView!))
    }

    /// A paste far past eight lines used to loop layout until AppKit crashed the app.
    func testLargePasteSettlesAtEightLines() throws {
        let view = try composer()
        window.makeFirstResponder(view)
        let chunk = (1...60).map { "Paragraph \($0): catch me up on what I need to be paying attention to and doing today." }
            .joined(separator: "\n")
        view.insertText(chunk, replacementRange: view.selectedRange())
        pump(1.5)

        XCTAssertEqual(view.string, chunk)
        let scroll = try XCTUnwrap(view.enclosingScrollView)
        let line = try XCTUnwrap(view.layoutManager).defaultLineHeight(for: ComposerTextView.font)
        XCTAssertEqual(scroll.frame.height, ceil(line * CGFloat(ComposerTextView.maxLines)) + 2 * ComposerTextView.inset, accuracy: 1)
        XCTAssertEqual(view.selectedRange().location, (chunk as NSString).length, "insertion point stays at the end")
    }

    /// ⌘V through the app's paste handling, with rich and plain text on the pasteboard. The pasteboard's
    /// previous contents are restored afterwards.
    func testCommandVPasteSettles() throws {
        let board = NSPasteboard.general
        let saved = (board.pasteboardItems ?? []).map { item in
            item.types.reduce(into: [NSPasteboard.PasteboardType: Data]()) { $0[$1] = item.data(forType: $1) }
        }
        defer {
            board.clearContents()
            board.writeObjects(saved.map { types in
                let item = NSPasteboardItem()
                for (type, data) in types { item.setData(data, forType: type) }
                return item
            })
        }

        let view = try composer()
        window.makeFirstResponder(view)
        let paragraphs = (1...30).map { "Paragraph \($0): Greg forwarded his email to Neehar on the 2027 contracts.\n• Existing team: extend 16 contractors\n• SaaS: a new 6-month contract" }
        let rich = NSMutableAttributedString()
        for text in paragraphs {
            rich.append(NSAttributedString(string: "Heading ", attributes: [.font: NSFont.boldSystemFont(ofSize: 13)]))
            rich.append(NSAttributedString(string: text + "\n", attributes: [.font: NSFont.systemFont(ofSize: 13)]))
        }
        // Rich text: ⌘V is caught by the composer's paste monitor and inserted as Markdown.
        board.clearContents()
        board.writeObjects([rich])
        var length = (view.string as NSString).length
        for type in [NSEvent.EventType.keyDown, .keyUp] {
            NSApp.postEvent(try XCTUnwrap(NSEvent.keyEvent(
                with: type, location: .zero, modifierFlags: .command, timestamp: ProcessInfo.processInfo.systemUptime,
                windowNumber: window.windowNumber, context: nil, characters: "v", charactersIgnoringModifiers: "v",
                isARepeat: false, keyCode: 9)), atStart: false)
        }
        pump(1.5)
        XCTAssertGreaterThan((view.string as NSString).length, length, "⌘V pasted rich text")

        // Plain text, with CRLF line ends and far more than fits: the text view's own paste, which the
        // monitor passes through to. The test host has no Edit menu, so it is called directly.
        board.clearContents()
        board.setString((1...700).map { "\($0) " + String(repeating: "word ", count: 25) }.joined(separator: "\r\n"), forType: .string)
        length = (view.string as NSString).length
        view.paste(nil)
        pump(2)
        XCTAssertGreaterThan((view.string as NSString).length, length + 80_000, "pasted plain text")
        let line = try XCTUnwrap(view.layoutManager).defaultLineHeight(for: ComposerTextView.font)
        XCTAssertEqual(try XCTUnwrap(view.enclosingScrollView).frame.height,
                       ceil(line * CGFloat(ComposerTextView.maxLines)) + 2 * ComposerTextView.inset, accuracy: 1)
    }

    /// Leaving the composer keeps a long draft where it was scrolled; returning puts the insertion point at the end.
    func testBlurKeepsScrollAndRefocusGoesToEnd() throws {
        let view = try composer()
        window.makeFirstResponder(view)
        view.insertText((1...30).map { "line \($0)" }.joined(separator: "\n"), replacementRange: view.selectedRange())
        pump(0.5)
        let clip = try XCTUnwrap(view.enclosingScrollView).contentView
        clip.scroll(to: NSPoint(x: 0, y: 40))
        view.setSelectedRange(NSRange(location: 3, length: 0))

        window.makeFirstResponder(nil)
        pump(0.3)
        XCTAssertEqual(clip.bounds.origin.y, 40, "blur leaves the scroll position alone")

        window.makeFirstResponder(view)
        pump(0.3)
        XCTAssertEqual(view.selectedRange().location, (view.string as NSString).length)
    }
}

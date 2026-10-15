import XCTest
import AppKit
@testable import AgentBus

final class QuoteFormatterTests: XCTestCase {
    func testSingleLine() {
        XCTAssertEqual(QuoteFormatter.quote("hello"), "> hello\n\n")
    }

    func testMultilineWithInteriorBlankLine() {
        XCTAssertEqual(QuoteFormatter.quote("one\ntwo\n\nthree"), "> one\n> two\n>\n> three\n\n")
    }

    func testTrimsLeadingAndTrailingBlankLinesAndWhitespaceOnlyLines() {
        XCTAssertEqual(QuoteFormatter.quote("\n\nfirst\n   \nsecond\n\n"), "> first\n>\n> second\n\n")
    }

    func testNothingToQuote() {
        XCTAssertNil(QuoteFormatter.quote(""))
        XCTAssertNil(QuoteFormatter.quote("\n \n\t"))
    }

    func testListAndCodeSpanSurvive() {
        XCTAssertEqual(QuoteFormatter.quote("- one\n  - nested `code`\n1. two"), "> - one\n>   - nested `code`\n> 1. two\n\n")
    }

    func testWindowsLineEndings() {
        XCTAssertEqual(QuoteFormatter.quote("a\r\nb"), "> a\n> b\n\n")
    }

    func testAppendToEmptyAndNonEmptyDrafts() {
        let quote = "> q\n\n"
        XCTAssertEqual(QuoteFormatter.append(quote, to: ""), quote)
        XCTAssertEqual(QuoteFormatter.append(quote, to: "my text"), "my text\n\n> q\n\n")
        XCTAssertEqual(QuoteFormatter.append(quote, to: "my text\n"), "my text\n\n> q\n\n")
        XCTAssertEqual(QuoteFormatter.append(quote, to: "my text\n\n"), "my text\n\n> q\n\n")
    }

    func testTwoQuotesInOneDraftStaySeparate() {
        let draft = QuoteFormatter.append("> b\n\n", to: QuoteFormatter.append("> a\n\n", to: ""))
        XCTAssertEqual(draft, "> a\n\n> b\n\n")
    }

    // MARK: Rendered message → Markdown (what Reply quotes)

    private func markdown(of blocks: String, selecting text: String? = nil, through end: String? = nil) -> String {
        let rendered = MessageTextBuilder.build(MarkdownParser.parse(blocks), kind: .agent)
        guard let text else { return MarkdownWriter.markdown(from: rendered) }
        let string = rendered.string as NSString
        let start = string.range(of: text).location
        let stop = NSMaxRange(string.range(of: end ?? text))
        return MarkdownWriter.markdown(from: rendered.attributedSubstring(from: NSRange(location: start, length: stop - start)))
    }

    func testWholeMessageRoundTripsEveryBlockType() {
        let source = """
            # Plan

            Use **bold** and `code`.

            - one
              - nested
            - two

            1. alpha
            2. beta

            > quoted
            > more

            ---
            """
        XCTAssertEqual(markdown(of: source), source)
    }

    func testSelectionAcrossParagraphsKeepsTheBlankLine() {
        XCTAssertEqual(markdown(of: "First para\n\nSecond para", selecting: "para", through: "Second"), "para\n\nSecond")
    }

    func testSelectionAcrossHeadingAndListKeepsMarkers() {
        XCTAssertEqual(markdown(of: "# Title\n\n- a\n- b", selecting: "Title", through: "b"), "# Title\n\n- a\n- b")
    }

    func testReplyQuoteOfListSelection() {
        let selected = markdown(of: "Intro\n\n- first **bold**\n- second", selecting: "first", through: "second")
        XCTAssertEqual(QuoteFormatter.quote(selected), "> first **bold**\n> - second\n\n")
    }

    // MARK: Selection model

    @MainActor func testOnlyOneViewHoldsTheSelection() {
        let model = TranscriptSelection()
        model.canReply = true
        let first = MessageNSTextView(), second = MessageNSTextView()
        first.selectionModel = model
        second.selectionModel = model
        first.apply(blocks: MarkdownParser.parse("alpha beta"), kind: .agent)
        second.apply(blocks: MarkdownParser.parse("gamma delta"), kind: .agent)
        XCTAssertFalse(model.hasSelection)
        XCTAssertNil(model.selectedMarkdown)

        first.setSelectedRange(NSRange(location: 0, length: 5))
        XCTAssertTrue(model.hasSelection)
        XCTAssertEqual(model.selectedMarkdown, "alpha")

        second.setSelectedRange(NSRange(location: 6, length: 5))
        XCTAssertEqual(first.selectedRange().length, 0)
        XCTAssertEqual(model.selectedMarkdown, "delta")
        XCTAssertTrue(model.hasSelection)

        model.clear()
        XCTAssertFalse(model.hasSelection)
        XCTAssertNil(model.selectedMarkdown)
    }

    @MainActor func testReplyPassesSelectionToHandlerOnlyWhenAllowed() {
        let model = TranscriptSelection()
        let view = MessageNSTextView()
        view.selectionModel = model
        view.apply(blocks: MarkdownParser.parse("pick **this** text"), kind: .agent)
        var received: [String] = []
        model.onReply = { received.append($0) }
        view.setSelectedRange(NSRange(location: 5, length: 4))

        model.reply()
        XCTAssertEqual(received, [])
        model.canReply = true
        model.reply()
        XCTAssertEqual(received, ["**this**"])
    }

    @MainActor func testReplacingTextClearsTheSelection() {
        let model = TranscriptSelection()
        let view = MessageNSTextView()
        view.selectionModel = model
        view.apply(blocks: MarkdownParser.parse("alpha beta"), kind: .agent)
        view.setSelectedRange(NSRange(location: 0, length: 5))
        XCTAssertTrue(model.hasSelection)
        view.apply(blocks: MarkdownParser.parse("changed"), kind: .agent)
        XCTAssertFalse(model.hasSelection)
    }
}

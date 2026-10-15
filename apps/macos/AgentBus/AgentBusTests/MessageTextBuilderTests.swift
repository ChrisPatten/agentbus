import XCTest
import AppKit
@testable import AgentBus

final class MessageTextBuilderTests: XCTestCase {
    private func build(_ source: String, kind: MessageTextBuilder.Kind = .agent) -> NSAttributedString {
        MessageTextBuilder.build(MarkdownParser.parse(source), kind: kind)
    }

    private func traits(_ text: NSAttributedString, at index: Int) -> NSFontDescriptor.SymbolicTraits {
        (text.attribute(.font, at: index, effectiveRange: nil) as? NSFont)?.fontDescriptor.symbolicTraits ?? []
    }

    func testBlocksJoinIntoOneStringWithListMarkers() {
        let text = build("# Plan\nUse it\n\n- one\n- two\n\n1. alpha")
        XCTAssertEqual(text.string, "Plan\nUse it\n•\tone\n•\ttwo\n1.\talpha")
    }

    func testHeadingIsBoldAndLargerThanBody() {
        let text = build("# Plan\nBody")
        let heading = text.attribute(.font, at: 0, effectiveRange: nil) as? NSFont
        XCTAssertTrue(traits(text, at: 0).contains(.bold))
        XCTAssertGreaterThan(heading?.pointSize ?? 0, MessageTextBuilder.bodyFont.pointSize)
        XCTAssertFalse(traits(text, at: text.length - 1).contains(.bold))
    }

    func testInlineStylesBecomeFontTraitsAndLinks() {
        let text = build("a **b** *c* `d` ~~e~~ [f](https://example.com)")
        let string = text.string as NSString
        XCTAssertTrue(traits(text, at: string.range(of: "b").location).contains(.bold))
        XCTAssertTrue(traits(text, at: string.range(of: "c").location).contains(.italic))
        XCTAssertTrue(traits(text, at: string.range(of: "d").location).contains(.monoSpace))
        XCTAssertNotNil(text.attribute(.strikethroughStyle, at: string.range(of: "e").location, effectiveRange: nil))
        XCTAssertEqual(text.attribute(.link, at: string.range(of: "f").location, effectiveRange: nil) as? URL,
                       URL(string: "https://example.com"))
    }

    func testQuoteCarriesBarAttributeAndIndent() {
        let text = build("before\n\n> quoted\n> more")
        let string = text.string as NSString
        let quote = string.range(of: "quoted")
        XCTAssertNotNil(text.attribute(MessageTextBuilder.quoteKey, at: quote.location, effectiveRange: nil))
        XCTAssertNil(text.attribute(MessageTextBuilder.quoteKey, at: 0, effectiveRange: nil))
        let style = text.attribute(.paragraphStyle, at: quote.location, effectiveRange: nil) as? NSParagraphStyle
        XCTAssertGreaterThan(style?.headIndent ?? 0, 0)
    }

    func testRuleParagraphIsMarked() {
        let text = build("a\n\n---\n\nb")
        let string = text.string as NSString
        let rule = string.range(of: " ")
        XCTAssertNotNil(text.attribute(MessageTextBuilder.ruleKey, at: rule.location, effectiveRange: nil))
    }

    func testNestedListIndentsAndHangs() {
        let text = build("- a\n  - b")
        let string = text.string as NSString
        let nested = text.attribute(.paragraphStyle, at: string.range(of: "b").location, effectiveRange: nil) as? NSParagraphStyle
        let outer = text.attribute(.paragraphStyle, at: string.range(of: "a").location, effectiveRange: nil) as? NSParagraphStyle
        XCTAssertGreaterThan(nested?.firstLineHeadIndent ?? 0, outer?.firstLineHeadIndent ?? 0)
        XCTAssertGreaterThan(outer?.headIndent ?? 0, outer?.firstLineHeadIndent ?? 0)
    }

    func testOperatorBubbleUsesWhiteTextAndKeepsCodeInline() {
        let text = build("hello\n\n```\nlet x = 1\n```", kind: .operatorBubble)
        XCTAssertEqual(text.string, "hello\nlet x = 1")
        XCTAssertEqual(text.attribute(.foregroundColor, at: 0, effectiveRange: nil) as? NSColor, .white)
        XCTAssertTrue(traits(text, at: text.length - 1).contains(.monoSpace))
    }

    func testSegmentsSplitAtCodeBlocks() {
        let blocks = MarkdownParser.parse("one\n\n```\ncode\n```\ntwo\n\nthree")
        XCTAssertEqual(MarkdownView.segments(blocks), [
            .text([.paragraph("one")]),
            .code(language: "", text: "code"),
            .text([.paragraph("two"), .paragraph("three")]),
        ])
    }

    // A rendered message must read back as the Markdown it came from, so a selection can be quoted later.
    func testInlineStylesRoundTripThroughMarkdownWriter() {
        let source = "Use **bold**, *italic*, `code` and [docs](https://example.com)"
        XCTAssertEqual(MarkdownWriter.markdown(from: build(source)), source)
    }

    func testListRoundTripsThroughMarkdownWriter() {
        XCTAssertEqual(MarkdownWriter.markdown(from: build("- one **b**\n- two")), "- one **b**\n- two")
    }

    func testPartialSelectionRoundTrips() {
        let text = build("Intro text\n\n- first **bold** item\n- second")
        let string = text.string as NSString
        let start = string.range(of: "first").location
        let end = NSMaxRange(string.range(of: "second"))
        let selection = text.attributedSubstring(from: NSRange(location: start, length: end - start))
        XCTAssertEqual(MarkdownWriter.markdown(from: selection), "first **bold** item\n- second")
    }

    @MainActor func testViewKeepsSelectionWhenContentIsUnchanged() {
        let view = MessageNSTextView()
        let blocks = MarkdownParser.parse("alpha beta gamma")
        view.apply(blocks: blocks, kind: .agent)
        view.setSelectedRange(NSRange(location: 6, length: 4))
        view.apply(blocks: blocks, kind: .agent)
        XCTAssertEqual(view.selectedRange(), NSRange(location: 6, length: 4))
        view.apply(blocks: MarkdownParser.parse("changed"), kind: .agent)
        XCTAssertEqual(view.string, "changed")
    }

    @MainActor func testViewSizeHugsShortTextAndWrapsLongText() {
        let view = MessageNSTextView()
        view.apply(blocks: MarkdownParser.parse("short"), kind: .agent)
        let short = view.fittingSize(maxWidth: 400)
        XCTAssertLessThan(short.width, 100)
        view.apply(blocks: MarkdownParser.parse(String(repeating: "word ", count: 80)), kind: .agent)
        let narrow = view.fittingSize(maxWidth: 200)
        let wide = view.fittingSize(maxWidth: 800)
        XCTAssertLessThanOrEqual(narrow.width, 200)
        XCTAssertGreaterThan(narrow.height, wide.height)
    }
}

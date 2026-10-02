import XCTest
import AppKit
@testable import AgentBus

final class MarkdownTests: XCTestCase {
    func testBlocks() {
        let blocks = MarkdownParser.parse("""
            # Plan
            First line
            second line

            - one
              continued
            - two
            1. alpha
            2) beta

            ```sql
            select 1
            ```
            > quoted
            """)
        XCTAssertEqual(blocks, [
            .heading(1, "Plan"),
            .paragraph("First line\nsecond line"),
            .list([.init(level: 0, marker: "•", text: "one\ncontinued"), .init(level: 0, marker: "•", text: "two"),
                   .init(level: 0, marker: "1.", text: "alpha"), .init(level: 0, marker: "2.", text: "beta")]),
            .code(language: "sql", text: "select 1"),
            .quote("quoted"),
        ])
    }

    func testUnclosedFenceKeepsCode() {
        XCTAssertEqual(MarkdownParser.parse("```\nlet x = 1"), [.code(language: "", text: "let x = 1")])
    }

    func testNestedListLevel() {
        XCTAssertEqual(MarkdownParser.parse("- a\n  - b"), [.list([.init(level: 0, marker: "•", text: "a"), .init(level: 1, marker: "•", text: "b")])])
    }

    func testRichPasteBecomesMarkdown() {
        let text = NSMutableAttributedString(string: "Use ", attributes: [.font: NSFont.systemFont(ofSize: 13)])
        text.append(NSAttributedString(string: "bold", attributes: [.font: NSFont.boldSystemFont(ofSize: 13)]))
        text.append(NSAttributedString(string: " and ", attributes: [.font: NSFont.systemFont(ofSize: 13)]))
        text.append(NSAttributedString(string: "stg_orders", attributes: [.font: NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)]))
        text.append(NSAttributedString(string: "\n•\tsee ", attributes: [.font: NSFont.systemFont(ofSize: 13)]))
        text.append(NSAttributedString(string: "docs", attributes: [.font: NSFont.systemFont(ofSize: 13), .link: URL(string: "https://example.com")!]))
        XCTAssertEqual(MarkdownWriter.markdown(from: text), "Use **bold** and `stg_orders`\n- see [docs](https://example.com)")
    }
}

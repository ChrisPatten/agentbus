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

    private func table(_ header: [String], _ rows: [[String]], align: [MarkdownBlock.Table.Alignment]? = nil) -> MarkdownBlock {
        .table(.init(header: header, alignments: align ?? header.map { _ in .leading }, rows: rows))
    }

    func testTable() {
        XCTAssertEqual(MarkdownParser.parse("| Name | Count |\n|---|---|\n| a | **1** |\n| b | 2 |"), [
            table(["Name", "Count"], [["a", "**1**"], ["b", "2"]]),
        ])
    }

    func testTableAlignmentsAndNoOuterPipes() {
        XCTAssertEqual(MarkdownParser.parse("a | b | c\n:--- | :-: | --:\n1 | 2 | 3"), [
            table(["a", "b", "c"], [["1", "2", "3"]], align: [.leading, .center, .trailing]),
        ])
    }

    func testTableEscapedPipeStaysInCell() {
        // As in GFM, a pipe inside a code span still splits the cell unless it is escaped.
        XCTAssertEqual(MarkdownParser.parse("| op | note |\n|---|---|\n| `a \\| b` | x \\| y |"), [
            table(["op", "note"], [["`a | b`", "x | y"]]),
        ])
    }

    func testTableRaggedRowsFitTheHeader() {
        XCTAssertEqual(MarkdownParser.parse("| a | b |\n|---|---|\n| 1 |\n| 1 | 2 | 3 |"), [
            table(["a", "b"], [["1", ""], ["1", "2"]]),
        ])
    }

    func testTableAfterParagraphAndBeforeText() {
        XCTAssertEqual(MarkdownParser.parse("Results:\n| a | b |\n| - | - |\n| 1 | 2 |\nDone."), [
            .paragraph("Results:"),
            table(["a", "b"], [["1", "2"]]),
            .paragraph("Done."),
        ])
    }

    func testHeaderOnlyTable() {
        XCTAssertEqual(MarkdownParser.parse("| a | b |\n|---|---|"), [table(["a", "b"], [])])
    }

    func testPipesWithoutDelimiterRowStayParagraph() {
        XCTAssertEqual(MarkdownParser.parse("a | b\nc | d"), [.paragraph("a | b\nc | d")])
    }

    func testDelimiterCellCountMustMatchHeader() {
        XCTAssertEqual(MarkdownParser.parse("a | b\n|---|"), [.paragraph("a | b\n|---|")])
    }

    func testPipeTableInsideFenceStaysCode() {
        XCTAssertEqual(MarkdownParser.parse("```\n| a | b |\n|---|---|\n```"), [.code(language: "", text: "| a | b |\n|---|---|")])
    }

    func testFenceEndsTable() {
        XCTAssertEqual(MarkdownParser.parse("| a |\n|---|\n| 1 |\n```\nx\n```"), [
            table(["a"], [["1"]]),
            .code(language: "", text: "x"),
        ])
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

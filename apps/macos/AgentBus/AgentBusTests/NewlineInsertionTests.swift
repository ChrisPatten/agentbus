import XCTest
@testable import AgentBus

final class NewlineInsertionTests: XCTestCase {
    private func insert(_ text: String, _ from: Int, _ to: Int? = nil) -> NewlineEdit {
        let lower = text.index(text.startIndex, offsetBy: from)
        let upper = text.index(text.startIndex, offsetBy: to ?? from)
        return NewlineInsertion.insert(into: text, replacing: [lower..<upper])
    }

    func testEmptyDraft() {
        let edit = insert("", 0)
        XCTAssertEqual(edit.text, "\n")
        XCTAssertEqual(edit.caretOffset, 1)
        XCTAssertEqual(edit.caret, edit.text.endIndex)
    }

    func testCaretAtStart() {
        XCTAssertEqual(insert("hello", 0), NewlineEdit(text: "\nhello", caretOffset: 1))
    }

    func testCaretInMiddle() {
        let edit = insert("hello world", 5)
        XCTAssertEqual(edit.text, "hello\n world")
        XCTAssertEqual(edit.caretOffset, 6)
        XCTAssertEqual(edit.text[edit.caret...], " world")
    }

    func testCaretAtEnd() {
        let edit = insert("hello", 5)
        XCTAssertEqual(edit.text, "hello\n")
        XCTAssertEqual(edit.caret, edit.text.endIndex)
    }

    func testSelectionIsReplaced() {
        XCTAssertEqual(insert("hello world", 5, 6), NewlineEdit(text: "hello\nworld", caretOffset: 6))
        XCTAssertEqual(insert("hello", 0, 5), NewlineEdit(text: "\n", caretOffset: 1))
    }

    func testExistingTrailingNewline() {
        XCTAssertEqual(insert("a\n", 2), NewlineEdit(text: "a\n\n", caretOffset: 3))
        XCTAssertEqual(insert("a\nb", 1), NewlineEdit(text: "a\n\nb", caretOffset: 2))
    }

    func testEmojiAndCombiningCharactersAreOneCharacter() {
        let family = "👨‍👩‍👧"
        let edit = insert("a\(family)é", 2)
        XCTAssertEqual(edit.text, "a\(family)\né")
        XCTAssertEqual(edit.caretOffset, 3)
        XCTAssertEqual(String(edit.text[edit.caret...]), "é")
    }

    func testNoSelectionAppends() {
        XCTAssertEqual(NewlineInsertion.insert(into: "abc", replacing: []), NewlineEdit(text: "abc\n", caretOffset: 4))
    }

    func testMultipleRangesCollapseToFirst() {
        let text = "one two three"
        let a = text.index(text.startIndex, offsetBy: 0)..<text.index(text.startIndex, offsetBy: 3)
        let b = text.index(text.startIndex, offsetBy: 8)..<text.index(text.startIndex, offsetBy: 13)
        XCTAssertEqual(NewlineInsertion.insert(into: text, replacing: [b, a]), NewlineEdit(text: "\n two ", caretOffset: 1))
    }
}

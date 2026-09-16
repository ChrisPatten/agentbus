import XCTest
@testable import Peggy

final class SpeechSanitizerTests: XCTestCase {
    func testPlainProseIsUntouched() {
        XCTAssertEqual(SpeechSanitizer.clean("Dentist at nine, then the review at two."), "Dentist at nine, then the review at two.")
    }

    func testEmphasisAndInlineCodeAreStripped() {
        XCTAssertEqual(SpeechSanitizer.clean("It's **Tuesday**, and `make restart` is done."), "It's Tuesday, and make restart is done.")
    }

    func testHeadingsAndListsBecomeProse() {
        XCTAssertEqual(SpeechSanitizer.clean("## Today\n- Dentist at 9\n- Review at 2"), "Today Dentist at 9 Review at 2")
    }

    func testLinksKeepTheirTextAndBareUrlsAreSpoken() {
        XCTAssertEqual(SpeechSanitizer.clean("See [the invoice](https://example.com/x) or https://example.com/y"), "See the invoice or a link")
    }

    func testCodeFencesAreRemoved() {
        XCTAssertEqual(SpeechSanitizer.clean("Run this:\n```bash\nmake restart\n```"), "Run this: make restart")
    }
}

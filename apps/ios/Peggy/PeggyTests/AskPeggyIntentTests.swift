import XCTest
@testable import Peggy

/// Every dialog outcome from PRD FR-20, driven through `AskPeggyIntent.run` with a
/// scripted client. Plain XCTest: `AppIntentsTesting` is not in the iOS 26 SDK
/// (spike-results.md, SDK verification) — swap to it in E45 under Xcode 27.
final class AskPeggyIntentTests: XCTestCase {
    private var previousFactory: (@Sendable () throws -> any BusClientProtocol)!

    override func setUp() {
        super.setUp()
        previousFactory = AskPeggyIntent.makeClient
    }

    override func tearDown() {
        AskPeggyIntent.makeClient = previousFactory
        super.tearDown()
    }

    private func install(_ client: MockBusClient) {
        AskPeggyIntent.makeClient = { client }
    }

    func testAnsweredSpeaksTheReplyVerbatim() async {
        let client = MockBusClient(.answered("Two things: dentist at nine and the review at two."))
        install(client)

        let outcome = await AskPeggyIntent.run(question: "What's on my calendar tomorrow?", waitBudgetSeconds: 20)

        XCTAssertEqual(outcome, .answered("Two things: dentist at nine and the review at two."))
        XCTAssertEqual(outcome.dialogText, "Two things: dentist at nine and the review at two.")
        XCTAssertEqual(client.asks.count, 1)
        XCTAssertEqual(client.asks.first?.text, "What's on my calendar tomorrow?")
        XCTAssertEqual(client.asks.first?.waitSeconds, 20)
        XCTAssertNotNil(UUID(uuidString: client.asks.first?.requestID ?? ""))
    }

    func testPendingDialog() async {
        install(MockBusClient(.pending(requestID: "req-1")))
        let outcome = await AskPeggyIntent.run(question: "Plan my week", waitBudgetSeconds: 20)
        XCTAssertEqual(outcome, .pending(requestID: "req-1"))
        XCTAssertEqual(outcome.dialogText, "Peggy's still working on it — I'll notify you when she answers.")
    }

    func testUnauthorizedDialog() async {
        install(MockBusClient(.failing(.unauthorized)))
        let outcome = await AskPeggyIntent.run(question: "hi", waitBudgetSeconds: 20)
        XCTAssertEqual(outcome, .unauthorized)
        XCTAssertEqual(outcome.dialogText, "Peggy rejected the token. Open the Peggy app to fix the setup.")
    }

    func testUnreachableDialog() async {
        install(MockBusClient(.failing(.unreachable("The request timed out."))))
        let outcome = await AskPeggyIntent.run(question: "hi", waitBudgetSeconds: 20)
        XCTAssertEqual(outcome, .unreachable)
        XCTAssertEqual(outcome.dialogText, "I can't reach Peggy right now. Check that Tailscale is connected.")
    }

    func testBadResponseIsTreatedAsUnreachable() async {
        install(MockBusClient(.failing(.badResponse(503))))
        let outcome = await AskPeggyIntent.run(question: "hi", waitBudgetSeconds: 20)
        XCTAssertEqual(outcome, .unreachable)
    }

    func testDuplicateDialog() async {
        install(MockBusClient(.failing(.duplicate)))
        let outcome = await AskPeggyIntent.run(question: "hi", waitBudgetSeconds: 20)
        XCTAssertEqual(outcome, .duplicate)
        XCTAssertEqual(outcome.dialogText, "I just asked Peggy that — give her a moment.")
    }

    func testRateLimitedDialog() async {
        install(MockBusClient(.failing(.rateLimited(retryAfterMs: 12000))))
        let outcome = await AskPeggyIntent.run(question: "hi", waitBudgetSeconds: 20)
        XCTAssertEqual(outcome, .rateLimited)
        XCTAssertEqual(outcome.dialogText, "Peggy is getting too many requests right now. Try again in a minute.")
    }

    func testNotConfiguredWhenTheClientCannotBeBuilt() async {
        AskPeggyIntent.makeClient = { throw BusError.notConfigured }
        let outcome = await AskPeggyIntent.run(question: "hi", waitBudgetSeconds: 20)
        XCTAssertEqual(outcome, .notConfigured)
        XCTAssertEqual(outcome.dialogText, "Open the Peggy app to set up the connection first.")
    }

    /// End-to-end through the real `perform()` with the mock installed: proves the
    /// intent builds a dialog result without touching the network.
    func testPerformProducesADialogResult() async throws {
        install(MockBusClient(.answered("It's Tuesday.")))
        var intent = AskPeggyIntent()
        intent.question = "  What day is it?  "
        let result = try await intent.perform()
        XCTAssertNotNil(result)
    }
}

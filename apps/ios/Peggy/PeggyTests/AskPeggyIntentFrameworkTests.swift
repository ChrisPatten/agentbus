import AppIntentsTesting
import XCTest
@testable import Peggy

/// Runs `AskPeggyIntent` through the App Intents machinery itself (Xcode 27's
/// `AppIntentsTesting`), so parameter binding and `perform()` are exercised the way
/// Siri and Shortcuts invoke them. `ResolvedIntentResult` exposes only the intent's
/// return `value`, not its dialog, so the exact dialog strings are asserted in
/// `AskPeggyIntentTests` through `AskPeggyIntent.run`.
///
/// Known limitation (2026-09-16, Xcode 27.0 / iOS 27.0 simulator, driven by
/// `xcodebuild test` from the CLI): `AnyAppIntent.run()` fails with
/// `transportCancelled` before the intent is invoked, with or without code
/// signing and after the app has been launched once so its App Intents metadata
/// is registered. The test skips on that specific error so the suite stays
/// honest about it; revisit under Xcode's own test runner in E45 (S45.4).
final class AskPeggyIntentFrameworkTests: XCTestCase {
    private var previousFactory: (@Sendable () throws -> any BusClientProtocol)!

    override func setUp() {
        super.setUp()
        previousFactory = AskPeggyIntent.makeClient
    }

    override func tearDown() {
        AskPeggyIntent.makeClient = previousFactory
        super.tearDown()
    }

    func testIntentRunsThroughTheFrameworkAndAsksTheBus() async throws {
        let client = MockBusClient(.answered("It's Wednesday."))
        AskPeggyIntent.makeClient = { client }

        let definitions = IntentDefinitions(bundleIdentifier: "com.chrispatten.peggy")
        let intent = definitions.intents["AskPeggyIntent"].makeIntent(question: "What day is it?")
        do {
            try await intent.run()
        } catch {
            let description = String(describing: error)
            try XCTSkipIf(
                description.contains("transportCancelled") || description.contains("transport cancelled"),
                "AppIntentsTesting could not reach the App Intents runtime in this simulator session: \(description)"
            )
            throw error
        }

        XCTAssertEqual(client.asks.map(\.text), ["What day is it?"])
    }
}

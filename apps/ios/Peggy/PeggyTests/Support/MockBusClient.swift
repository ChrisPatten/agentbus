import Foundation
@testable import Peggy

/// Scripted bus client for intent tests. Records every ask so tests can assert on
/// the question and wait budget the intent sent.
final class MockBusClient: BusClientProtocol, @unchecked Sendable {
    enum Script {
        case answered(String, extras: [String] = [])
        case pending(requestID: String)
        case failing(BusError)
    }

    struct RecordedAsk: Equatable {
        let text: String
        let requestID: String
        let waitSeconds: Double
    }

    let script: Script
    private let lock = NSLock()
    private var recorded: [RecordedAsk] = []

    init(_ script: Script) {
        self.script = script
    }

    var asks: [RecordedAsk] {
        lock.withLock { recorded }
    }

    func ask(_ text: String, requestID: String, waitSeconds: Double) async throws -> AskOutcome {
        let entry = RecordedAsk(text: text, requestID: requestID, waitSeconds: waitSeconds)
        lock.withLock { recorded.append(entry) }
        switch script {
        case .answered(let body, let extras):
            return .answered(body, extras: extras)
        case .pending(let requestID):
            return .pending(requestID: requestID)
        case .failing(let error):
            throw error
        }
    }

    func health() async throws -> HealthResponse {
        HealthResponse(ok: true, routed: true, agent: "agent:peggy", adapters: ["claude-code": "online"], version: "test", pending: 0)
    }
}

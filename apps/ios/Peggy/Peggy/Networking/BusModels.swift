import Foundation

// Codable DTOs mirroring the bus contract in
// _bmad-output/planning-artifacts/siri-bridge/architecture.md §4 (docs/SIRI_ADAPTER.md).
// Do not invent fields here; if the bus needs a change, write it in the bus epic.

struct AskRequest: Encodable {
    let text: String
    let wait_ms: Int
    let request_id: String
    let client: ClientInfo
}

struct ClientInfo: Encodable {
    let device: String
    let app_version: String
    let locale: String
}

struct ReplyDTO: Decodable, Equatable {
    let message_id: String?
    let body: String
    let received_at: String?
}

struct TimingDTO: Decodable, Equatable {
    let queued_ms: Int?
    let answered_ms: Int?
    let waited_ms: Int?
}

struct AskResponse: Decodable {
    let ok: Bool
    let request_id: String
    let message_id: String?
    let status: String
    let reply: ReplyDTO?
    let timing: TimingDTO?
    let extra_replies: [String]?
    let command_handled: Bool?
}

struct HealthResponse: Decodable, Equatable, Sendable {
    let ok: Bool
    let routed: Bool
    let agent: String?
    let adapters: [String: String]?
    let version: String?
    let pending: Int?
}

enum BusError: Error, Equatable {
    case notConfigured
    case unauthorized
    case rateLimited(retryAfterMs: Int?)
    case duplicate
    case unreachable(String)
    case badResponse(Int)
    case decoding
}

enum AskOutcome: Equatable, Sendable {
    case answered(String, extras: [String])
    case pending(requestID: String)
}

extension Bundle {
    var appVersion: String {
        (infoDictionary?["CFBundleShortVersionString"] as? String) ?? "0.0.0"
    }
}

import Foundation

/// All networking goes through this protocol so the intent can be tested with a mock.
protocol BusClientProtocol: Sendable {
    func ask(_ text: String, requestID: String, waitSeconds: Double) async throws -> AskOutcome
    func health() async throws -> HealthResponse
}

actor BusClient: BusClientProtocol {
    private let baseURL: URL
    private let siriToken: String
    private let busToken: String?
    private let session: URLSession

    /// - Parameter session: injected by tests (URLProtocol stub); production builds an
    ///   ephemeral session whose timeouts follow the wait budget (PRD FR-22).
    init(baseURL: URL, siriToken: String, busToken: String?, waitBudgetSeconds: Double, session: URLSession? = nil) {
        self.baseURL = baseURL
        self.siriToken = siriToken
        self.busToken = busToken
        if let session {
            self.session = session
        } else {
            let cfg = URLSessionConfiguration.ephemeral
            cfg.timeoutIntervalForRequest = waitBudgetSeconds + 3   // server cap + slack
            cfg.timeoutIntervalForResource = waitBudgetSeconds + 5
            cfg.waitsForConnectivity = false                        // fail fast if Tailscale is down
            self.session = URLSession(configuration: cfg)
        }
    }

    func ask(_ text: String, requestID: String, waitSeconds: Double) async throws -> AskOutcome {
        var request = try makeRequest(path: "/api/v1/siri/ask", method: "POST")
        request.httpBody = try JSONEncoder().encode(AskRequest(
            text: text,
            wait_ms: Int(waitSeconds * 1000),
            request_id: requestID,
            client: ClientInfo(device: "iphone", app_version: Bundle.main.appVersion, locale: Locale.current.identifier)
        ))
        return try await send(request)
    }

    func health() async throws -> HealthResponse {
        let request = try makeRequest(path: "/api/v1/siri/health", method: "GET")
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw BusError.unreachable(error.localizedDescription)
        }
        try Self.check(response)
        guard let decoded = try? JSONDecoder().decode(HealthResponse.self, from: data) else {
            throw BusError.decoding
        }
        return decoded
    }

    private func makeRequest(path: String, method: String) throws -> URLRequest {
        var request = URLRequest(url: baseURL.appending(path: path))
        request.httpMethod = method
        request.setValue("Bearer \(siriToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let busToken, !busToken.isEmpty {
            request.setValue(busToken, forHTTPHeaderField: "X-Bus-Token")
        }
        return request
    }

    private func send(_ request: URLRequest) async throws -> AskOutcome {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw BusError.unreachable(error.localizedDescription)
        }
        try Self.check(response)
        guard let decoded = try? JSONDecoder().decode(AskResponse.self, from: data) else {
            throw BusError.decoding
        }
        switch decoded.status {
        case "answered", "claimed":
            return .answered(decoded.reply?.body ?? "", extras: decoded.extra_replies ?? [])
        default:
            return .pending(requestID: decoded.request_id)
        }
    }

    private static func check(_ response: URLResponse) throws {
        guard let http = response as? HTTPURLResponse else { throw BusError.badResponse(0) }
        switch http.statusCode {
        case 200...299:
            return
        case 401:
            throw BusError.unauthorized
        case 409:
            throw BusError.duplicate
        case 429:
            let retry = http.value(forHTTPHeaderField: "Retry-After").flatMap(Int.init).map { $0 * 1000 }
            throw BusError.rateLimited(retryAfterMs: retry)
        default:
            throw BusError.badResponse(http.statusCode)
        }
    }
}

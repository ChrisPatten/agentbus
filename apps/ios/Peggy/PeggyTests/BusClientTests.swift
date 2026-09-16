import XCTest
@testable import Peggy

/// URLProtocol stub: captures the outgoing request and returns a canned response.
final class StubURLProtocol: URLProtocol {
    nonisolated(unsafe) static var handler: (@Sendable (URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        do {
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

final class BusClientTests: XCTestCase {
    private let baseURL = URL(string: "https://mini.tailnet.ts.net")!

    private func makeClient(busToken: String? = nil) -> BusClient {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = [StubURLProtocol.self]
        return BusClient(baseURL: baseURL, siriToken: "secret-siri-token", busToken: busToken, waitBudgetSeconds: 20, session: URLSession(configuration: cfg))
    }

    private func respond(_ status: Int, json: String, headers: [String: String] = [:]) {
        StubURLProtocol.handler = { request in
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: headers)!
            return (response, Data(json.utf8))
        }
    }

    override func tearDown() {
        StubURLProtocol.handler = nil
        super.tearDown()
    }

    func testAskSendsBearerTokenJsonBodyAndPath() async throws {
        let captured = Captured()
        StubURLProtocol.handler = { request in
            captured.request = request
            captured.body = request.httpBody ?? request.httpBodyStream.map { Self.read($0) } ?? Data()
            let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            return (response, Data(#"{"ok":true,"request_id":"r1","message_id":"m1","status":"answered","reply":{"body":"Hi there."}}"#.utf8))
        }

        let outcome = try await makeClient(busToken: "bus-shared").ask("What day is it?", requestID: "r1", waitSeconds: 20)

        XCTAssertEqual(outcome, .answered("Hi there.", extras: []))
        let request = try XCTUnwrap(captured.request)
        XCTAssertEqual(request.url?.path, "/api/v1/siri/ask")
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer secret-siri-token")
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-Bus-Token"), "bus-shared")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: captured.body) as? [String: Any])
        XCTAssertEqual(json["text"] as? String, "What day is it?")
        XCTAssertEqual(json["wait_ms"] as? Int, 20000)
        XCTAssertEqual(json["request_id"] as? String, "r1")
        XCTAssertEqual((json["client"] as? [String: Any])?["device"] as? String, "iphone")
    }

    func testPendingStatusMapsToPending() async throws {
        respond(200, json: #"{"ok":true,"request_id":"r2","message_id":"m2","status":"pending","timing":{"queued_ms":10,"waited_ms":20000}}"#)
        let outcome = try await makeClient().ask("slow", requestID: "r2", waitSeconds: 20)
        XCTAssertEqual(outcome, .pending(requestID: "r2"))
    }

    func testStatusCodesMapToBusErrors() async {
        let cases: [(Int, BusError)] = [
            (401, .unauthorized),
            (409, .duplicate),
            (429, .rateLimited(retryAfterMs: nil)),
            (503, .badResponse(503)),
        ]
        for (status, expected) in cases {
            respond(status, json: #"{"ok":false,"error":"x"}"#)
            do {
                _ = try await makeClient().ask("q", requestID: "r", waitSeconds: 20)
                XCTFail("expected an error for HTTP \(status)")
            } catch let error as BusError {
                XCTAssertEqual(error, expected, "HTTP \(status)")
            } catch {
                XCTFail("unexpected error type \(error)")
            }
        }
    }

    func testTransportFailureIsUnreachable() async {
        StubURLProtocol.handler = { _ in throw URLError(.cannotConnectToHost) }
        do {
            _ = try await makeClient().ask("q", requestID: "r", waitSeconds: 20)
            XCTFail("expected unreachable")
        } catch BusError.unreachable {
            // expected
        } catch {
            XCTFail("unexpected error \(error)")
        }
    }

    func testHealthDecodes() async throws {
        respond(200, json: #"{"ok":true,"routed":true,"agent":"agent:peggy","adapters":{"claude-code":"online"},"version":"0.11.0","pending":0}"#)
        let health = try await makeClient().health()
        XCTAssertTrue(health.routed)
        XCTAssertEqual(health.agent, "agent:peggy")
        XCTAssertEqual(health.version, "0.11.0")
    }

    // MARK: - helpers

    private final class Captured: @unchecked Sendable {
        var request: URLRequest?
        var body = Data()
    }

    private static func read(_ stream: InputStream) -> Data {
        stream.open()
        defer { stream.close() }
        var data = Data()
        let bufferSize = 4096
        let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: bufferSize)
        defer { buffer.deallocate() }
        while stream.hasBytesAvailable {
            let read = stream.read(buffer, maxLength: bufferSize)
            if read <= 0 { break }
            data.append(buffer, count: read)
        }
        return data
    }
}

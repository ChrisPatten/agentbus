import XCTest
import SwiftData
@testable import AgentBus

@MainActor final class MockSocket: SocketTransport {
    private(set) var sent: [Data] = []
    private var incoming: [Data] = []
    private var waiter: CheckedContinuation<Data, Error>?
    private(set) var connects = 0
    func connect(_ request: URLRequest) async throws { connects += 1 }
    func send(_ data: Data) async throws { sent.append(data) }
    func receive() async throws -> Data {
        if !incoming.isEmpty { return incoming.removeFirst() }
        return try await withCheckedThrowingContinuation { waiter = $0 }
    }
    func push(_ json: String) {
        let data = Data(json.utf8)
        if let waiter { self.waiter = nil; waiter.resume(returning: data) }
        else { incoming.append(data) }
    }
    func close() {
        if let waiter { self.waiter = nil; waiter.resume(throwing: ClientError.disconnected) }
    }
    func frame(_ index: Int) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: sent[index]) as? [String: Any])
    }
}

@MainActor final class MockAPI: BusAPI {
    let fixture = #"{"ok":true,"contact":"contact:me","agent":"agent:work","routed":true,"version":"0.14.0","limits":{"max_upload_bytes":26214400}}"#
    var sessionsPage = SessionsPage(sessions: [], nextBefore: nil)
    func health() async throws -> BusHealth { try JSONDecoder().decode(BusHealth.self, from: Data(fixture.utf8)) }
    func sessions(before: String?) async throws -> SessionsPage { sessionsPage }
    func messages(_ id: String, before: String?) async throws -> MessagesPage { MessagesPage(messages: [], nextBefore: nil) }
    func commands() async throws -> Data { Data(#"{"commands":[]}"#.utf8) }
    func upload(_ url: URL, maxBytes: Int) async throws -> UploadedFile { throw ClientError.disconnected }
}

@MainActor final class ConnectionTests: XCTestCase {
    func testEndpointKeepsQueryOutOfPath() throws {
        let settings = ClientSettings()
        settings.baseURL = "http://127.0.0.1:3000"
        let sessions = try settings.endpoint("/api/v1/app/sessions?state=all&limit=100")
        XCTAssertEqual(sessions.path, "/api/v1/app/sessions")
        XCTAssertEqual(sessions.query, "state=all&limit=100")
        let history = try settings.endpoint("/api/v1/app/sessions/abc/messages?limit=50&before=row%2F1")
        XCTAssertEqual(history.path, "/api/v1/app/sessions/abc/messages")
        XCTAssertEqual(history.query, "limit=50&before=row%2F1")
    }

    private func waitFor(_ predicate: @escaping @MainActor () -> Bool) async throws {
        for _ in 0..<200 {
            if predicate() { return }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTFail("Timed out waiting for mock socket state")
    }

    func testCursorReplayAndIdempotentPendingSend() async throws {
        let container = try ModelContainer(for: CachedSession.self, CachedMessage.self, CachedState.self, PendingSend.self,
            configurations: ModelConfiguration(isStoredInMemoryOnly: true))
        let store = ChatStore(container.mainContext)
        let settings = ClientSettings()
        settings.appToken = "test-app-token"
        let socket = MockSocket()
        let connection = BusConnection(settings: settings, store: store, socket: socket, api: MockAPI(), observeSystemEvents: false)
        connection.start()
        try await waitFor { socket.sent.count >= 1 }
        XCTAssertEqual(try socket.frame(0)["type"] as? String, "hello")
        socket.push(#"{"type":"welcome","version":1,"reset":false,"latest_seq":0}"#)
        try await waitFor { connection.state == .connected }

        try await connection.send("Hello", target: .main)
        try await waitFor { socket.sent.count >= 2 }
        let originalID = try XCTUnwrap(socket.frame(1)["client_msg_id"] as? String)
        connection.reconnect()
        try await waitFor { socket.connects == 2 && socket.sent.count >= 3 }
        XCTAssertEqual(try socket.frame(2)["cursor"] as? Int, 0)
        socket.push(#"{"type":"welcome","version":1,"reset":false,"latest_seq":0}"#)
        try await waitFor { socket.sent.count >= 4 }
        XCTAssertEqual(try socket.frame(3)["client_msg_id"] as? String, originalID)

        socket.push(#"{"type":"ack","client_msg_id":"\#(originalID)","message_id":"m1","session_id":"s1","status":"queued"}"#)
        try await waitFor { store.pending.isEmpty }
        let event = #"{"type":"event","seq":1,"event":"message","data":{"message_id":"m1","session_id":"s1","seq":1,"cursor":"row-1","direction":"outbound","arrival_channel":"app","body":"Hi","created_at":"2026-09-30T12:00:00Z","scheduled":false,"attachments":[]}}"#
        socket.push(event)
        try await waitFor { store.cursor == 1 }
        socket.push(event)
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(store.messages("s1").count, 1)
        connection.stop()
    }

    func testWelcomeResetReplacesCachedSessionsAndCursor() async throws {
        let container = try ModelContainer(for: CachedSession.self, CachedMessage.self, CachedState.self, PendingSend.self,
            configurations: ModelConfiguration(isStoredInMemoryOnly: true))
        let store = ChatStore(container.mainContext)
        let oldJSON = #"{"session_id":"old","channel":"app","topic":"thread:old","title":"Old","started_at":"2026-09-29","last_activity":"2026-09-29","ended_at":null,"unread_count":0,"resumable":true,"is_main":false,"activity":"idle"}"#
        let newJSON = #"{"session_id":"new","channel":"app","topic":"general","title":"Main","started_at":"2026-09-30","last_activity":"2026-09-30","ended_at":null,"unread_count":0,"resumable":true,"is_main":true,"activity":"idle"}"#
        try store.upsert(JSONDecoder().decode(BusSession.self, from: Data(oldJSON.utf8)))
        store.state.cursor = 2
        try store.context.save()
        let api = MockAPI()
        api.sessionsPage = SessionsPage(sessions: [try JSONDecoder().decode(BusSession.self, from: Data(newJSON.utf8))], nextBefore: nil)
        let settings = ClientSettings(); settings.appToken = "test-app-token"
        let socket = MockSocket()
        let connection = BusConnection(settings: settings, store: store, socket: socket, api: api, observeSystemEvents: false)
        connection.start()
        try await waitFor { socket.sent.count >= 1 }
        XCTAssertEqual(try socket.frame(0)["cursor"] as? Int, 2)
        socket.push(#"{"type":"welcome","version":1,"reset":true,"latest_seq":10}"#)
        try await waitFor { store.cursor == 10 }
        XCTAssertNil(store.session("old"))
        XCTAssertEqual(store.session("new")?.title, "Main")
        connection.stop()
    }
}

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

    func testLiveToolTrailMovesIntoReply() async throws {
        let container = try ModelContainer(for: CachedSession.self, CachedMessage.self, CachedState.self, PendingSend.self,
            configurations: ModelConfiguration(isStoredInMemoryOnly: true))
        let store = ChatStore(container.mainContext)
        let settings = ClientSettings(); settings.appToken = "test-app-token"
        let socket = MockSocket()
        let connection = BusConnection(settings: settings, store: store, socket: socket, api: MockAPI(), observeSystemEvents: false)
        connection.start()
        try await waitFor { socket.sent.count >= 1 }
        socket.push(#"{"type":"welcome","version":1,"reset":false,"latest_seq":0}"#)
        try await waitFor { connection.state == .connected }

        socket.push(#"{"type":"event","event":"activity","data":{"agent_id":"agent:work","conversation_id":"c1","session_id":"s1","state":"running","turn_class":"user","running_user":1,"running_system":0,"waiting":0,"limit":5,"reserved_system_slots":1,"tool_lines":["Read a","Bash b"]}}"#)
        try await waitFor { connection.live["s1"]?.lines.count == 2 }
        XCTAssertEqual(connection.activityState("s1"), "running")
        XCTAssertEqual(connection.capacity?.runningUser, 1)
        // The idle frame has no session_id and can precede the reply's durable event.
        socket.push(#"{"type":"event","event":"activity","data":{"agent_id":"agent:work","conversation_id":"c1","state":"idle","turn_class":"user","running_user":0,"running_system":0,"waiting":0,"limit":5,"reserved_system_slots":1}}"#)
        try await waitFor { connection.live["s1"] == nil }
        socket.push(#"{"type":"event","seq":1,"event":"message","data":{"message_id":"m1","session_id":"s1","seq":1,"cursor":"row-1","direction":"outbound","arrival_channel":"app","body":"Done","created_at":"2026-09-30T12:00:00Z","scheduled":false,"attachments":[]}}"#)
        try await waitFor { store.messages("s1").first?.toolTrail == ["Read a", "Bash b"] }
        connection.stop()
    }

    func testNewTopicAckRequestsSelection() async throws {
        let container = try ModelContainer(for: CachedSession.self, CachedMessage.self, CachedState.self, PendingSend.self,
            configurations: ModelConfiguration(isStoredInMemoryOnly: true))
        let store = ChatStore(container.mainContext)
        let settings = ClientSettings(); settings.appToken = "test-app-token"
        let socket = MockSocket()
        let connection = BusConnection(settings: settings, store: store, socket: socket, api: MockAPI(), observeSystemEvents: false)
        connection.start()
        try await waitFor { socket.sent.count >= 1 }
        socket.push(#"{"type":"welcome","version":1,"reset":false,"latest_seq":0}"#)
        try await waitFor { connection.state == .connected }

        try await connection.send("Same session", target: .session("s1"))
        try await waitFor { socket.sent.count >= 2 }
        let sameID = try XCTUnwrap(socket.frame(1)["client_msg_id"] as? String)
        socket.push(#"{"type":"ack","client_msg_id":"\#(sameID)","message_id":"m1","session_id":"s1","status":"queued"}"#)
        try await waitFor { store.pending.isEmpty }
        XCTAssertNil(connection.selectionRequest)

        try await connection.send("Plan", target: .new("Planning"))
        try await waitFor { socket.sent.count >= 3 }
        let newID = try XCTUnwrap(socket.frame(2)["client_msg_id"] as? String)
        socket.push(#"{"type":"ack","client_msg_id":"\#(newID)","message_id":"m2","session_id":"s2","status":"queued"}"#)
        try await waitFor { connection.selectionRequest?.sessionID == "s2" }
        connection.stop()
    }

    /// Keeps each test's in-memory container alive; a context outliving its container crashes.
    private var containers: [ModelContainer] = []

    private func connected() async throws -> (ChatStore, MockSocket, BusConnection) {
        let container = try ModelContainer(for: CachedSession.self, CachedMessage.self, CachedState.self, PendingSend.self,
            configurations: ModelConfiguration(isStoredInMemoryOnly: true))
        containers.append(container)
        let store = ChatStore(container.mainContext)
        let settings = ClientSettings(); settings.appToken = "test-app-token"
        let socket = MockSocket()
        let connection = BusConnection(settings: settings, store: store, socket: socket, api: MockAPI(), observeSystemEvents: false)
        connection.start()
        try await waitFor { socket.sent.count >= 1 }
        socket.push(#"{"type":"welcome","version":1,"reset":false,"latest_seq":0}"#)
        try await waitFor { connection.state == .connected }
        return (store, socket, connection)
    }

    func testRejectedSendRetriesAsNewIntent() async throws {
        let (store, socket, connection) = try await connected()
        try await connection.send("Same text", target: .session("s1"))
        try await waitFor { socket.sent.count >= 2 }
        let first = try XCTUnwrap(socket.frame(1)["client_msg_id"] as? String)
        socket.push(#"{"type":"ack","client_msg_id":"\#(first)","status":"rejected","reason":"Aborted at stage \"dedup\""}"#)
        try await waitFor { store.pending.first?.failure != nil }
        try await connection.retry(first)
        try await waitFor { socket.sent.count >= 3 }
        let second = try XCTUnwrap(socket.frame(2)["client_msg_id"] as? String)
        XCTAssertNotEqual(first, second)
        XCTAssertEqual(try socket.frame(2)["body"] as? String, "Same text")
        XCTAssertEqual(store.pending.map(\.id), [second])
        connection.stop()
    }

    func testTurnStaysRunningAcrossMidTurnMessages() async throws {
        let (store, socket, connection) = try await connected()
        try store.upsert(JSONDecoder().decode(BusSession.self, from: Data(#"{"session_id":"s1","channel":"app","topic":"general","title":"Main","started_at":"2026-09-30","last_activity":"2026-09-30","ended_at":null,"unread_count":0,"resumable":true,"is_main":true,"activity":"running"}"#.utf8)))
        let running = #"{"type":"event","event":"activity","data":{"agent_id":"agent:work","conversation_id":"c1","session_id":"s1","state":"running","turn_class":"user","running_user":1,"running_system":0,"waiting":0,"limit":5,"reserved_system_slots":1"#
        socket.push(running + #","tool_lines":["Read a"]}}"#)
        try await waitFor { connection.live["s1"]?.lines == ["Read a"] }
        // The bus clears the trail as it delivers a progress message, before that message's event arrives.
        socket.push(running + #","typing":true}}"#)
        try await waitFor { connection.live["s1"]?.lines.isEmpty == true }
        socket.push(#"{"type":"event","seq":1,"event":"message","data":{"message_id":"m1","session_id":"s1","seq":1,"cursor":"row-1","direction":"outbound","arrival_channel":"app","body":"Progress","created_at":"2026-09-30T12:00:00Z","scheduled":false,"attachments":[]}}"#)
        try await waitFor { store.messages("s1").first?.toolTrail == ["Read a"] }
        XCTAssertEqual(connection.live["s1"]?.state, "running")
        socket.push(#"{"type":"event","event":"activity","data":{"agent_id":"agent:work","conversation_id":"c1","state":"idle","turn_class":"user","running_user":0,"running_system":0,"waiting":0,"limit":5,"reserved_system_slots":1}}"#)
        try await waitFor { connection.live["s1"] == nil }
        // A stale "running" from an earlier session event must not outlive the turn.
        XCTAssertEqual(store.session("s1")?.activity, "idle")
        XCTAssertEqual(connection.activityState("s1"), "idle")
        connection.stop()
    }

    func testSessionEventAfterReplyUpdatesUnread() async throws {
        let (store, socket, connection) = try await connected()
        var changes = 0
        connection.onUnreadChange = { changes += 1 }
        let session = #"{"session_id":"s1","channel":"app","topic":"general","title":"Main","started_at":"2026-09-30","last_activity":"2026-09-30","ended_at":null,"unread_count":UNREAD,"resumable":true,"is_main":true,"activity":"idle"}"#
        socket.push(#"{"type":"event","seq":1,"event":"session","data":"# + session.replacingOccurrences(of: "UNREAD", with: "0") + "}")
        socket.push(#"{"type":"event","seq":2,"event":"message","data":{"message_id":"m1","session_id":"s1","seq":2,"cursor":"row-1","direction":"outbound","arrival_channel":"app","body":"Hi","created_at":"2026-09-30T12:00:00Z","scheduled":false,"attachments":[]}}"#)
        socket.push(#"{"type":"event","seq":3,"event":"session","data":"# + session.replacingOccurrences(of: "UNREAD", with: "1") + "}")
        try await waitFor { store.session("s1")?.unreadCount == 1 }
        XCTAssertGreaterThanOrEqual(changes, 2)
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

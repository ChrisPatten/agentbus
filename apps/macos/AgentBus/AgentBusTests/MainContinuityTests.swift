import XCTest
import SwiftData
@testable import AgentBus

/// E69: Main is one sidebar item across Claude session rotations, with a divider where the context changes.
@MainActor final class MainContinuityTests: XCTestCase {
    private let conversation = "app:contact:me:general"

    private func sessionJSON(_ id: String, main: Bool = true, ended: String? = nil, unread: Int = 0,
                             conversation: String? = "app:contact:me:general", claude: String? = nil,
                             started: String = "2026-10-01T09:00:00Z", extra: String = "") -> String {
        let endedValue = ended.map { "\"\($0)\"" } ?? "null"
        let conversationKey = conversation.map { #","conversation_id":"\#($0)""# } ?? ""
        let claudeKey = claude.map { #","claude_session_id":"\#($0)""# } ?? ""
        let topic = main ? "general" : "thread:" + id, title = main ? "Main" : id
        return #"{"session_id":"\#(id)","channel":"app","topic":"\#(topic)","title":"\#(title)","started_at":"\#(started)","last_activity":"\#(started)","ended_at":\#(endedValue),"unread_count":\#(unread),"resumable":true,"is_main":\#(main),"activity":"idle""# + conversationKey + claudeKey + extra + "}"
    }
    private func session(_ id: String, main: Bool = true, ended: String? = nil, unread: Int = 0,
                         conversation: String? = "app:contact:me:general", claude: String? = nil,
                         started: String = "2026-10-01T09:00:00Z") throws -> BusSession {
        try JSONDecoder().decode(BusSession.self, from: Data(sessionJSON(id, main: main, ended: ended, unread: unread,
            conversation: conversation, claude: claude, started: started).utf8))
    }
    private func messageJSON(_ id: String, session: String, seq: Int, direction: String = "outbound",
                             conversation: String? = "app:contact:me:general", at: String = "2026-10-01T12:00:00Z",
                             extra: String = "") -> String {
        let conversationKey = conversation.map { #","conversation_id":"\#($0)""# } ?? ""
        return #"{"message_id":"\#(id)","session_id":"\#(session)","seq":\#(seq),"cursor":"row-\#(seq)","direction":"\#(direction)","arrival_channel":"app","body":"Body \#(id)","created_at":"\#(at)","scheduled":false,"attachments":[]"# + conversationKey + extra + "}"
    }
    private func message(_ id: String, session: String, seq: Int, direction: String = "outbound",
                         conversation: String? = "app:contact:me:general", at: String = "2026-10-01T12:00:00Z") throws -> BusMessage {
        try JSONDecoder().decode(BusMessage.self, from: Data(messageJSON(id, session: session, seq: seq, direction: direction,
            conversation: conversation, at: at).utf8))
    }

    /// Keeps each test's in-memory container alive; a context outliving its container crashes.
    private var containers: [ModelContainer] = []
    private func makeStore() throws -> ChatStore {
        let container = try ModelContainer(for: CachedSession.self, CachedMessage.self, CachedState.self, PendingSend.self,
            configurations: ModelConfiguration(isStoredInMemoryOnly: true))
        containers.append(container)
        return ChatStore(container.mainContext)
    }

    // MARK: Protocol

    func testNewFieldsDecodeWhenPresent() throws {
        XCTAssertEqual(try session("s1").conversationID, conversation)
        XCTAssertEqual(try message("m1", session: "s1", seq: 1).conversationID, conversation)
        let page = try JSONDecoder().decode(MessagesPage.self, from: Data(#"{"messages":[],"next_before":null,"boundaries":[{"session_id":"s0","ended_at":"2026-10-01T21:00:00Z","reason":"idle"},{"session_id":"s1","ended_at":"2026-10-02T08:00:00Z","reason":null}]}"#.utf8))
        XCTAssertEqual(page.boundaries, [SessionBoundary(sessionID: "s0", endedAt: "2026-10-01T21:00:00Z", reason: "idle"),
                                         SessionBoundary(sessionID: "s1", endedAt: "2026-10-02T08:00:00Z", reason: nil)])
        let rotated = #","rotated":{"previous_session_id":"s1","ended_at":"2026-10-02T08:00:00Z","reason":"clear"}"#
        let frame = try ProtocolCodec.frame(Data((#"{"type":"event","seq":5,"event":"session","data":"# + sessionJSON("s2", extra: rotated) + "}").utf8))
        XCTAssertEqual(frame.data?.session?.sessionID, "s2")
        XCTAssertEqual(frame.data?.rotated, SessionRotation(previousSessionID: "s1", endedAt: "2026-10-02T08:00:00Z", reason: "clear"))
        XCTAssertEqual(frame.data?.rotated?.boundary, SessionBoundary(sessionID: "s1", endedAt: "2026-10-02T08:00:00Z", reason: "clear"))
    }

    func testNewFieldsAreOptionalForAnOlderBus() throws {
        XCTAssertNil(try session("s1", conversation: nil).conversationID)
        XCTAssertNil(try message("m1", session: "s1", seq: 1, conversation: nil).conversationID)
        XCTAssertNil(try JSONDecoder().decode(MessagesPage.self, from: Data(#"{"messages":[],"next_before":null}"#.utf8)).boundaries)
        let frame = try ProtocolCodec.frame(Data((#"{"type":"event","seq":5,"event":"session","data":"# + sessionJSON("s1", conversation: nil) + "}").utf8))
        XCTAssertNotNil(frame.data?.session)
        XCTAssertNil(frame.data?.rotated)
        // A malformed rotation costs only the rotation, not the session.
        let malformed = try ProtocolCodec.frame(Data((#"{"type":"event","seq":5,"event":"session","data":"# + sessionJSON("s1", extra: #","rotated":"soon""#) + "}").utf8))
        XCTAssertEqual(malformed.data?.session?.sessionID, "s1")
        XCTAssertNil(malformed.data?.rotated)
    }

    func testOutboundReplyReferenceIsKept() throws {
        let store = try makeStore()
        let json = messageJSON("m2", session: "s1", seq: 2, extra: #","reply_to":{"message_id":"m0","sender_name":"agent","text":"Scan: two calendar items","created_at":"2026-10-01T11:06:00Z","source":"Ambient scan"}"#)
        try store.upsert(JSONDecoder().decode(BusMessage.self, from: Data(json.utf8)))
        let cached = try XCTUnwrap(store.messages("s1").first)
        XCTAssertFalse(cached.isOperator)
        XCTAssertEqual(cached.replyTo, ReplyRef(messageID: "m0", senderName: "agent", text: "Scan: two calendar items"))
    }

    // MARK: Main identity

    func testRotationUpdatesTheOneMainItemInPlace() throws {
        let store = try makeStore()
        try store.upsert(session("s1", unread: 2, claude: "claude-1"))
        try store.upsert(message("m1", session: "s1", seq: 1))
        try store.setRead("s1", seq: 1)
        let item = try XCTUnwrap(store.main)

        let rotated = #","rotated":{"previous_session_id":"s1","ended_at":"2026-10-02T08:00:00Z","reason":"idle"}"#
        let frame = try ProtocolCodec.frame(Data((#"{"type":"event","seq":3,"event":"session","data":"# + sessionJSON("s2", unread: 1, extra: rotated) + "}").utf8))
        _ = try store.apply(frame)

        XCTAssertEqual(store.sessions.filter(\.isMain).count, 1)
        XCTAssertTrue(store.main === item, "the same cached item, so selection and scroll state stay")
        XCTAssertEqual(item.id, "s2")
        XCTAssertEqual(item.formerIDs, ["s1"])
        XCTAssertEqual(item.readSeq, 1)
        XCTAssertEqual(item.unreadCount, 1)
        XCTAssertNil(item.claudeSessionID, "the new row has no Claude session until its first turn")
        XCTAssertEqual(item.boundaries, [SessionBoundary(sessionID: "s1", endedAt: "2026-10-02T08:00:00Z", reason: "idle")])
        XCTAssertTrue(store.session("s1") === item)
        XCTAssertEqual(store.canonicalID("s1"), "s2")
        XCTAssertTrue(item.answers(to: "s1") && item.answers(to: "s2"))
        XCTAssertEqual(item.draftKey, BusTarget.mainSentinel)
        let groups = SessionGroups(store.sessions)
        XCTAssertEqual(groups.main?.id, "s2")
        XCTAssertTrue(groups.earlier.isEmpty)
    }

    func testRotationEventWithoutANewRowRecordsTheBoundaryOnly() throws {
        let store = try makeStore()
        try store.upsert(session("s1"))
        // After idle rotation the bus reports the ended row as Main's current row until the next turn.
        let rotated = #","rotated":{"previous_session_id":"s1","ended_at":"2026-10-02T08:00:00Z","reason":"idle"}"#
        _ = try store.apply(ProtocolCodec.frame(Data((#"{"type":"event","seq":2,"event":"session","data":"# + sessionJSON("s1", extra: rotated) + "}").utf8)))
        XCTAssertEqual(store.main?.id, "s1")
        XCTAssertEqual(store.main?.formerIDs, [])
        XCTAssertEqual(store.main?.boundaries.first?.reason, "idle")
    }

    func testOlderBusFragmentsFoldIntoOneMainEitherOrder() throws {
        for order in [["old", "new"], ["new", "old"]] {
            let store = try makeStore()
            let values = ["old": try session("s0", ended: "2026-09-30T18:00:00Z", conversation: nil, started: "2026-09-30T09:00:00Z"),
                          "new": try session("s1", conversation: nil, started: "2026-10-01T09:00:00Z")]
            for key in order { try store.upsert(values[key]!) }
            XCTAssertEqual(store.sessions.filter(\.isMain).count, 1, "order \(order)")
            XCTAssertEqual(store.main?.id, "s1", "order \(order)")
            XCTAssertEqual(store.main?.formerIDs, ["s0"], "order \(order)")
            XCTAssertEqual(store.main?.boundaries, [SessionBoundary(sessionID: "s0", endedAt: "2026-09-30T18:00:00Z", reason: nil)])
            XCTAssertNil(store.main?.endedAt)
            // A late event for the old row doesn't take Main back.
            try store.upsert(values["old"]!)
            XCTAssertEqual(store.main?.id, "s1")
            XCTAssertTrue(SessionGroups(store.sessions).earlier.isEmpty)
        }
    }

    func testFragmentsAlreadyCachedFoldOnTheNextMainUpdate() throws {
        let store = try makeStore()
        // Two Main rows cached before E69 as separate items.
        store.context.insert(CachedSession(try session("s0", ended: "2026-09-30T18:00:00Z")))
        store.context.insert(CachedSession(try session("s1")))
        try store.context.save()
        try store.upsert(session("s1", unread: 3))
        XCTAssertEqual(store.sessions.filter(\.isMain).count, 1)
        XCTAssertEqual(store.main?.id, "s1")
        XCTAssertEqual(store.main?.formerIDs, ["s0"])
        XCTAssertEqual(store.main?.unreadCount, 3)
    }

    func testMainIsNeverEarlierOrReadOnly() throws {
        let store = try makeStore()
        try store.upsert(session("s1", ended: "2026-10-02T08:00:00Z"))
        try store.upsert(session("t1", main: false, ended: "2026-10-02T08:00:00Z", conversation: nil))
        let main = try XCTUnwrap(store.main)
        main.resumable = false
        XCTAssertFalse(main.isEarlier)
        XCTAssertTrue(main.isWritable)
        let groups = SessionGroups(store.sessions)
        XCTAssertEqual(groups.main?.id, "s1")
        XCTAssertEqual(groups.earlier.map(\.id), ["t1"])
        XCTAssertFalse(groups.ordered(includeEarlier: true).dropFirst().contains("s1"))
    }

    func testResetReloadKeepsFormerRowIDs() throws {
        let store = try makeStore()
        try store.upsert(session("s1"))
        _ = try store.apply(ProtocolCodec.frame(Data((#"{"type":"event","seq":2,"event":"session","data":"# + sessionJSON("s2") + "}").utf8)))
        try store.replace(sessions: [session("s3")], history: ["s3": [message("m1", session: "s1", seq: 1)]], cursor: 9)
        XCTAssertEqual(store.main?.id, "s3")
        XCTAssertEqual(Set(store.main?.formerIDs ?? []), ["s1", "s2"])
        XCTAssertTrue(store.session("s1") === store.main)
        XCTAssertEqual(store.transcript("s3").map(\.id), ["m1"])
    }

    // MARK: Routing

    func testMessagesRouteToMainByConversationOrKnownRow() throws {
        let store = try makeStore()
        try store.upsert(session("s1"))
        try store.upsert(session("s2"))
        try store.upsert(session("t1", main: false, conversation: "app:contact:me:thread:t1"))
        try store.upsert(message("m1", session: "s1", seq: 1, conversation: nil, at: "2026-10-01T10:00:00Z"))
        let early = try message("m2", session: "s3", seq: 2, at: "2026-10-01T11:00:00Z")
        try store.upsert(early)
        try store.upsert(message("m3", session: "s2", seq: 3, at: "2026-10-01T12:00:00Z"))
        try store.upsert(message("m4", session: "t1", seq: 4, conversation: "app:contact:me:thread:t1"))

        // m1 is a known former row from an older bus; m2 is a row Main hasn't been told about yet.
        XCTAssertEqual(store.transcript("s2").map(\.id), ["m1", "m2", "m3"])
        XCTAssertEqual(store.transcript("s1").map(\.id), ["m1", "m2", "m3"])
        XCTAssertEqual(store.transcript("t1").map(\.id), ["m4"])
        XCTAssertTrue(store.item(for: early) === store.main)
        XCTAssertEqual(store.canonicalID("s3", conversation: conversation), "s2")
        XCTAssertEqual(store.canonicalID("t1", conversation: "app:contact:me:thread:t1"), "t1")
    }

    func testCachedMessageLearnsItsConversationFromHistory() throws {
        let store = try makeStore()
        try store.upsert(message("m1", session: "s9", seq: 1, conversation: nil))
        try store.upsert(message("m1", session: "s9", seq: 1))
        XCTAssertEqual(store.messages("s9").first?.conversationID, conversation)
    }

    func testHistoryPageBoundariesLandOnMain() throws {
        let store = try makeStore()
        try store.upsert(session("s2"))
        let page = MessagesPage(messages: [try message("m1", session: "s1", seq: 1)], nextBefore: nil,
                                boundaries: [SessionBoundary(sessionID: "s1", endedAt: "2026-10-01T23:00:00Z", reason: "clear")])
        try store.setHistory("s2", page: page, first: true)
        XCTAssertEqual(store.main?.boundaries.first?.reason, "clear")
        XCTAssertEqual(store.main?.formerIDs, ["s1"])
    }

    // MARK: Connection

    private func waitFor(_ predicate: @escaping @MainActor () -> Bool) async throws {
        for _ in 0..<200 {
            if predicate() { return }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTFail("Timed out waiting for mock socket state")
    }

    private func connected() async throws -> (ChatStore, MockSocket, BusConnection) {
        let store = try makeStore()
        let settings = ClientSettings(); settings.appToken = "test-app-token"
        let socket = MockSocket()
        let connection = BusConnection(settings: settings, store: store, socket: socket, api: MockAPI(), observeSystemEvents: false)
        connection.start()
        try await waitFor { socket.sent.count >= 1 }
        socket.push(#"{"type":"welcome","version":1,"reset":false,"latest_seq":0}"#)
        try await waitFor { connection.state == .connected }
        return (store, socket, connection)
    }

    private func activity(_ session: String, state: String) -> String {
        #"{"type":"event","event":"activity","data":{"agent_id":"agent:work","conversation_id":"app:contact:me:general","session_id":"\#(session)","state":"\#(state)","turn_class":"user","running_user":1,"running_system":0,"waiting":0,"limit":5,"reserved_system_slots":1}}"#
    }

    func testConnectionFollowsMainAcrossARotation() async throws {
        let (store, socket, connection) = try await connected()
        socket.push(#"{"type":"event","seq":1,"event":"session","data":"# + sessionJSON("s1") + "}")
        socket.push(#"{"type":"event","seq":2,"event":"message","data":"# + messageJSON("m1", session: "s1", seq: 2, at: "2026-10-01T10:00:00Z") + "}")
        try await waitFor { store.cursor == 2 }
        let window = UUID()
        connection.setViewing(window, session: "s1")
        // A turn starts in a row the cache hasn't seen; its conversation still finds Main.
        socket.push(activity("s2", state: "running"))
        try await waitFor { connection.live["s1"]?.state == "running" }

        let rotated = #","rotated":{"previous_session_id":"s1","ended_at":"2026-10-02T08:00:00Z","reason":"idle"}"#
        socket.push(#"{"type":"event","seq":3,"event":"session","data":"# + sessionJSON("s2", extra: rotated) + "}")
        socket.push(#"{"type":"event","seq":4,"event":"message","data":"# + messageJSON("m2", session: "s2", seq: 4, at: "2026-10-02T09:00:00Z") + "}")
        try await waitFor { store.cursor == 4 }

        XCTAssertEqual(store.main?.id, "s2")
        XCTAssertNil(connection.live["s1"])
        XCTAssertEqual(connection.live["s2"]?.state, "running")
        XCTAssertEqual(connection.activityState("s2"), "running")
        XCTAssertTrue(connection.isViewing("s2"))
        XCTAssertTrue(connection.isViewing("s1"))
        connection.requestSelection("s1")
        XCTAssertEqual(connection.selectionRequest?.sessionID, "s2")
        XCTAssertEqual(store.transcript("s2").map(\.id), ["m1", "m2"])

        let sent = socket.sent.count
        try await connection.markRead("s1")
        try await waitFor { socket.sent.count > sent }
        let frame = try socket.frame(sent)
        XCTAssertEqual(frame["type"] as? String, "mark_read")
        XCTAssertEqual(frame["session_id"] as? String, "s2")
        XCTAssertEqual(frame["seq"] as? Int, 4)
        connection.stop()
    }

    func testSendToAFormerMainRowIsNotAFork() async throws {
        let (store, socket, connection) = try await connected()
        try store.upsert(session("s1"))
        try store.upsert(session("s2"))
        try await connection.send("Hello", target: .session("s1"))
        try await waitFor { socket.sent.count >= 2 }
        let id = try XCTUnwrap(socket.frame(1)["client_msg_id"] as? String)
        socket.push(#"{"type":"ack","client_msg_id":"\#(id)","message_id":"m1","session_id":"s2","status":"queued"}"#)
        try await waitFor { store.pending.isEmpty }
        XCTAssertNil(connection.selectionRequest)
        XCTAssertNil(connection.origin(of: "s2"))
        connection.stop()
    }

    // MARK: Live upgrade (2026-10-27)

    /// The live cache an older build left behind: one Main item per row, the newest two both "active"
    /// (that build never learned the rotation), no conversation IDs, and the cursor past every event.
    private func seedPreE69Cache(_ store: ChatStore) throws {
        let rows: [(String, String?, String, String)] = [
            ("b87586fd", "2026-10-02T12:35:16.504Z", "2026-10-01T13:16:29.467Z", "2026-10-02T12:35:16.499Z"),
            ("bf1305f9", "2026-10-05T12:40:24.198Z", "2026-10-05T12:09:54.625Z", "2026-10-05T12:09:54.625Z"),
            ("22bbbf25", "2026-10-08T15:42:00.799Z", "2026-10-05T15:37:06.210Z", "2026-10-08T15:42:00.797Z"),
            ("1f9b6008", nil, "2026-10-01T13:16:29.467Z", "2026-10-27T12:23:58.292Z"),
            ("5188fd11", nil, "2026-10-01T13:16:29.467Z", "2026-10-27T13:44:14.003Z"),
        ]
        for (id, ended, started, last) in rows {
            var value = try session(id, ended: ended, conversation: nil, started: started)
            value = BusSession(sessionID: value.sessionID, channel: value.channel, topic: value.topic, title: value.title,
                               startedAt: started, lastActivity: last, endedAt: ended, unreadCount: id == "5188fd11" ? 1 : 0,
                               resumable: ended == nil, isMain: true, activity: "idle")
            store.context.insert(CachedSession(value))
        }
        let messages: [(String, String, String, String)] = [
            ("b1", "b87586fd", "inbound", "2026-10-01T13:16:29.467Z"),
            ("f1", "bf1305f9", "outbound", "2026-10-05T12:09:54.625Z"),
            ("g1", "22bbbf25", "inbound", "2026-10-08T15:40:00.000Z"),
            ("r1", "1f9b6008", "inbound", "2026-10-27T12:23:58.292Z"),
            ("r2", "1f9b6008", "outbound", "2026-10-27T12:35:42.131Z"),
            ("scan1", "5188fd11", "outbound", "2026-10-27T13:44:14.006Z"),
            ("scan2", "5188fd11", "outbound", "2026-10-27T13:46:31.704Z"),
        ]
        for (index, entry) in messages.enumerated() {
            store.context.insert(CachedMessage(try message(entry.0, session: entry.1, seq: 34_900 + index, direction: entry.2,
                                                           conversation: nil, at: entry.3)))
        }
        store.state.cursor = 34_966
        try store.context.save()
    }

    func testPreE69CacheThatAlreadySawTheRotationHealsOnLaunch() async throws {
        let store = try makeStore()
        try seedPreE69Cache(store)
        let api = ReplayAPI()
        api.sessionsPage = SessionsPage(sessions: [try session("5188fd11", unread: 1, started: "2026-10-01T13:16:29.467Z")], nextBefore: nil)
        // The bus's newest Main page spans rows: the old row's last messages, then the scans.
        api.messagesPage = MessagesPage(messages: [
            try message("r1", session: "1f9b6008", seq: 34_903, direction: "inbound", at: "2026-10-27T12:23:58.292Z"),
            try message("r2", session: "1f9b6008", seq: 34_904, at: "2026-10-27T12:35:42.131Z"),
            try message("scan1", session: "5188fd11", seq: 34_957, at: "2026-10-27T13:44:14.006Z"),
            try message("scan2", session: "5188fd11", seq: 34_962, at: "2026-10-27T13:46:31.704Z"),
        ], nextBefore: "row-r1", boundaries: [SessionBoundary(sessionID: "1f9b6008", endedAt: "2026-10-27T13:41:27.437Z", reason: "idle")])
        let settings = ClientSettings(); settings.appToken = "test-app-token"
        let socket = MockSocket()
        let connection = BusConnection(settings: settings, store: store, socket: socket, api: api, observeSystemEvents: false)

        // Launch: the window's stored selection is the old row, before any frame arrives.
        XCTAssertEqual(store.sessions.filter(\.isMain).count, 1)
        let main = try XCTUnwrap(store.main)
        XCTAssertEqual(main.id, "5188fd11")
        XCTAssertTrue(main.answers(to: "1f9b6008"))
        XCTAssertTrue(store.session("1f9b6008") === main)
        XCTAssertFalse(SessionGroups(store.sessions).earlier.contains { $0.isMain })

        // Nothing replays (the cursor is current), so the welcome itself refreshes Main.
        connection.start()
        try await waitFor { socket.sent.count >= 1 }
        socket.push(#"{"type":"welcome","version":1,"reset":false,"latest_seq":34966}"#)
        try await waitFor { connection.state == .connected }
        XCTAssertEqual(store.main?.conversationID, conversation)

        // Opening the old selection loads Main's history across rows.
        try await connection.loadHistory("1f9b6008")
        let messages = store.transcript(main.id)
        XCTAssertEqual(messages.map(\.id), ["b1", "f1", "g1", "r1", "r2", "scan1", "scan2"])
        let items = ContextDivider.apply(TranscriptItem.build(messages, pending: [], session: main, activity: "idle"),
                                         messages: messages, session: main)
        // Scan 1 is on the old row's last day, so the divider sits directly above it.
        let scan = try XCTUnwrap(items.firstIndex { $0.id == "scan1" })
        guard scan >= 1, case .divider(let divider) = items[scan - 1] else {
            return XCTFail("expected a divider directly above scan 1, got \(items.map(\.id))")
        }
        XCTAssertEqual(divider.label, "New context · after 1 h idle")
        XCTAssertEqual(Set(main.formerIDs), ["b87586fd", "bf1305f9", "22bbbf25", "1f9b6008"])
        connection.stop()
    }

    func testMainLearnsRowsFromItsConversationsMessagesAndBoundaries() throws {
        let store = try makeStore()
        try store.upsert(session("s2"))
        try store.upsert(message("m1", session: "s1", seq: 1, conversation: nil))
        XCTAssertEqual(store.transcript("s2").map(\.id), [])
        // A message logged in another Main row teaches Main that row, so its older cached messages appear.
        try store.upsert(message("m2", session: "s1", seq: 2))
        XCTAssertEqual(store.main?.formerIDs, ["s1"])
        XCTAssertEqual(store.transcript("s2").map(\.id), ["m1", "m2"])
        // A message for the next row can precede that row's session event; the event still takes Main over.
        try store.upsert(message("m3", session: "s3", seq: 3))
        try store.upsert(session("s3"))
        XCTAssertEqual(store.main?.id, "s3")
        XCTAssertEqual(store.main?.formerIDs, ["s1", "s2"])
    }

    func testReplayedRotationOverPerRowCacheFoldsIntoOneMain() async throws {
        let store = try makeStore()
        try seedPreE69Cache(store)
        // The rotation's events projected live: Main reported at the ended row until the new row exists.
        store.state.cursor = 34_943
        try store.context.save()
        let rotated = #","rotated":{"previous_session_id":"1f9b6008","ended_at":"2026-10-27T13:41:27.437Z","reason":"idle"}"#
        for (seq, json) in [(34_944, sessionJSON("1f9b6008", extra: rotated)), (34_945, sessionJSON("1f9b6008")),
                            (34_956, sessionJSON("5188fd11")),
                            (34_957, messageJSON("scan1", session: "5188fd11", seq: 34_957, at: "2026-10-27T13:44:14.006Z"))] {
            let kind = json.contains("message_id") ? "message" : "session"
            _ = try store.apply(ProtocolCodec.frame(Data(#"{"type":"event","seq":\#(seq),"event":"\#(kind)","data":\#(json)}"#.utf8)))
        }
        XCTAssertEqual(store.sessions.filter(\.isMain).count, 1)
        XCTAssertEqual(store.main?.id, "5188fd11")
        XCTAssertEqual(store.main?.boundaries.first { $0.sessionID == "1f9b6008" }?.reason, "idle")
        XCTAssertEqual(store.transcript("1f9b6008").count, 7)
    }

    // MARK: Divider

    private let start = Date(timeIntervalSince1970: 1_790_000_000)
    private func entry(_ id: String, _ session: String, hours: Double, inbound: Bool = false) -> ContextDivider.Entry {
        ContextDivider.Entry(id: id, sessionID: session, date: start.addingTimeInterval(hours * 3600), inbound: inbound)
    }
    private func iso(hours: Double) -> String { start.addingTimeInterval(hours * 3600).formatted(.iso8601) }

    func testDividersGoWhereTheRowChanges() {
        let entries = [entry("a", "s1", hours: 0, inbound: true), entry("b", "s1", hours: 0.1),
                       entry("c", "s2", hours: 20, inbound: true), entry("d", "s2", hours: 20.1),
                       entry("e", "s3", hours: 21, inbound: true)]
        let boundaries = [SessionBoundary(sessionID: "s1", endedAt: iso(hours: 12), reason: "idle"),
                          SessionBoundary(sessionID: "s2", endedAt: iso(hours: 20.5), reason: "clear")]
        let dividers = ContextDivider.place(entries, boundaries: boundaries)
        XCTAssertEqual(Set(dividers.keys), ["c", "e"])
        XCTAssertEqual(dividers["c"]?.id, "context-c")
        // Idle runs from the earlier row's last operator message to its end, not from a later agent send.
        XCTAssertEqual(dividers["c"]?.label, "New context · after 12 h idle")
        XCTAssertEqual(dividers["c"]?.endedAt, start.addingTimeInterval(12 * 3600))
        XCTAssertEqual(dividers["e"]?.label, "New context · /clear")
    }

    func testDividerLabelsWithoutAKnownReason() {
        let entries = [entry("a", "s1", hours: 0, inbound: true), entry("b", "s2", hours: 5), entry("c", "s3", hours: 6)]
        let dividers = ContextDivider.place(entries, boundaries: [SessionBoundary(sessionID: "s2", endedAt: nil, reason: nil)])
        XCTAssertEqual(dividers["b"]?.label, "New context")
        XCTAssertNil(dividers["b"]?.endedAt)
        XCTAssertEqual(dividers["c"]?.label, "New context")
        XCTAssertTrue(ContextDivider.place([entry("a", "s1", hours: 0), entry("b", "s1", hours: 30)], boundaries: []).isEmpty)
        XCTAssertTrue(ContextDivider.place([], boundaries: []).isEmpty)
        // Idle with no end time falls back to the gap before the next message.
        let gap = ContextDivider.place([entry("a", "s1", hours: 0, inbound: true), entry("b", "s2", hours: 3)],
                                       boundaries: [SessionBoundary(sessionID: "s1", endedAt: nil, reason: "idle")])
        XCTAssertEqual(gap["b"]?.label, "New context · after 3 h idle")
    }

    func testDividerSpanFormats() {
        XCTAssertEqual(ContextDivider.span(20), "1 min")
        XCTAssertEqual(ContextDivider.span(45 * 60), "45 min")
        XCTAssertEqual(ContextDivider.span(12 * 3600 + 400), "12 h")
        XCTAssertEqual(ContextDivider.span(3 * 86_400), "3 d")
        XCTAssertEqual(ContextDivider.label(reason: "idle", idle: nil), "New context · after inactivity")
    }

    func testDividerInsertsAboveTheDayLabelThatOpensTheNewContext() {
        let divider = ContextDivider(id: "context-c", label: "New context", endedAt: nil)
        let items: [TranscriptItem] = [.note("a", id: "a"), .day("Today", id: "day-c"), .note("c", id: "c"), .note("d", id: "d")]
        XCTAssertEqual(ContextDivider.insert(["c": divider], into: items).map(\.id), ["a", "context-c", "day-c", "c", "d"])
        let sameDay: [TranscriptItem] = [.note("a", id: "a"), .note("c", id: "c")]
        XCTAssertEqual(ContextDivider.insert(["c": divider], into: sameDay).map(\.id), ["a", "context-c", "c"])
        XCTAssertEqual(ContextDivider.insert([:], into: sameDay).map(\.id), ["a", "c"])
    }

    func testClearCommandNoteIsHiddenOnlyInMain() {
        XCTAssertTrue(ContextDivider.hidesClearCommand(body: "/clear", inbound: true, inMain: true))
        XCTAssertTrue(ContextDivider.hidesClearCommand(body: " /clear\n", inbound: true, inMain: true))
        XCTAssertFalse(ContextDivider.hidesClearCommand(body: "/clear", inbound: true, inMain: false))
        XCTAssertFalse(ContextDivider.hidesClearCommand(body: "/clear", inbound: false, inMain: true))
        XCTAssertFalse(ContextDivider.hidesClearCommand(body: "/clear please", inbound: true, inMain: true))
        XCTAssertFalse(ContextDivider.hidesClearCommand(body: "/stop", inbound: true, inMain: true))
    }

    private func clearSequence(_ session: String, conversation: String?) throws -> [BusMessage] {
        func cached(_ id: String, _ session: String, _ direction: String, _ body: String, _ at: String) throws -> BusMessage {
            let conversationKey = conversation.map { #","conversation_id":"\#($0)""# } ?? ""
            let json = #"{"message_id":"\#(id)","session_id":"\#(session)","seq":1,"cursor":"c-\#(id)","direction":"\#(direction)","arrival_channel":"app","body":"\#(body)","created_at":"\#(at)","scheduled":false,"attachments":[]"# + conversationKey + "}"
            return try JSONDecoder().decode(BusMessage.self, from: Data(json.utf8))
        }
        let next = conversation == nil ? session : "s2"
        return [try cached("a", session, "inbound", "Hi", "2026-10-27T14:00:00Z"),
                try cached("clear", session, "inbound", "/clear", "2026-10-27T14:22:00Z"),
                try cached("reply", session, "outbound", "Context cleared. Starting fresh.", "2026-10-27T14:22:01Z"),
                try cached("b", next, "inbound", "New topic", "2026-10-27T14:30:00Z")]
    }

    func testMainShowsTheClearDividerButNotTheClearNote() throws {
        let store = try makeStore()
        try store.upsert(session("s2"))
        for value in try clearSequence("s1", conversation: conversation) { try store.upsert(value) }
        try store.upsert(session("s2"))
        store.record(SessionBoundary(sessionID: "s1", endedAt: "2026-10-27T14:22:00Z", reason: "clear"))
        let main = try XCTUnwrap(store.main)
        let messages = store.transcript(main.id)
        let items = ContextDivider.apply(TranscriptItem.build(messages, pending: [], session: main, activity: "idle"),
                                         messages: messages, session: main)
        XCTAssertEqual(items.map(\.id), ["day-a", "a", "reply", "context-b", "b"])
        if case .divider(let divider) = items[3] { XCTAssertEqual(divider.label, "New context · /clear") } else { XCTFail() }
    }

    func testTopicKeepsTheClearNote() throws {
        let store = try makeStore()
        try store.upsert(session("t1", main: false, conversation: nil))
        for value in try clearSequence("t1", conversation: nil) { try store.upsert(value) }
        let topic = try XCTUnwrap(store.session("t1"))
        let messages = store.transcript("t1")
        let items = ContextDivider.apply(TranscriptItem.build(messages, pending: [], session: topic, activity: "idle"),
                                         messages: messages, session: topic)
        XCTAssertEqual(items.map(\.id), ["day-a", "a", "clear", "reply", "b"])
        guard case .note(let text, _) = items[2] else { return XCTFail("expected the /clear note") }
        XCTAssertTrue(text.hasPrefix("Cleared with /clear"))
    }

    func testOnlyMainTranscriptsGetDividers() throws {
        let store = try makeStore()
        try store.upsert(session("s2"))
        try store.upsert(session("t1", main: false, conversation: nil))
        try store.upsert(message("m1", session: "s1", seq: 1, direction: "inbound", at: "2026-10-01T10:00:00Z"))
        try store.upsert(message("m2", session: "s2", seq: 2, at: "2026-10-02T10:00:00Z"))
        let main = try XCTUnwrap(store.main)
        let messages = store.transcript(main.id)
        let items = TranscriptItem.build(messages, pending: [], session: main, activity: "idle")
        XCTAssertTrue(ContextDivider.apply(items, messages: messages, session: main).contains { $0.id == "context-m2" })
        XCTAssertEqual(ContextDivider.apply(items, messages: messages, session: store.session("t1")).map(\.id), items.map(\.id))
    }
}

/// Serves one sessions page and one history page, for the live-upgrade tests.
@MainActor final class ReplayAPI: BusAPI {
    var sessionsPage = SessionsPage(sessions: [], nextBefore: nil)
    var messagesPage = MessagesPage(messages: [], nextBefore: nil)
    private let fixture = #"{"ok":true,"contact":"contact:me","agent":"agent:work","routed":true,"version":"0.14.0","limits":{"max_upload_bytes":26214400}}"#
    func health() async throws -> BusHealth { try JSONDecoder().decode(BusHealth.self, from: Data(fixture.utf8)) }
    func sessions(before: String?) async throws -> SessionsPage { sessionsPage }
    func messages(_ id: String, before: String?) async throws -> MessagesPage {
        before == nil ? messagesPage : MessagesPage(messages: [], nextBefore: nil)
    }
    func commands() async throws -> Data { Data(#"{"commands":[]}"#.utf8) }
    func upload(_ url: URL, maxBytes: Int) async throws -> UploadedFile { throw ClientError.disconnected }
}

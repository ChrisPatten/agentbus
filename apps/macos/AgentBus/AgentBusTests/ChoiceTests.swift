import XCTest
import SwiftData
@testable import AgentBus

/// Choice buttons in the transcript (E86): decoding, the tap frame, acks, `choice` events and history refresh.
@MainActor final class ChoiceTests: XCTestCase {
    private static let choices = #"{"prompt_id":"p1","items":[{"label":"Approve","style":"success"},{"label":"Deny","style":"danger"},{"label":"Copy SQL","copy_text":"select 1"},{"label":"Docs","url":"https://example.com"}],"status":"open","chosen_index":null}"#

    private func message(_ id: String = "m1", direction: String = "outbound", body: String = "Ship it?",
                         at: String = "2026-10-30T12:00:00Z", extra: String) -> String {
        #"{"message_id":"\#(id)","session_id":"s1","seq":1,"cursor":"row-1","direction":"\#(direction)","arrival_channel":"app","body":"\#(body)","created_at":"\#(at)","scheduled":false,"attachments":[]"# + extra + "}"
    }
    private func event(seq: Int, _ data: String) -> String { #"{"type":"event","seq":\#(seq),"event":"message","data":"# + data + "}" }
    private func choiceEvent(seq: Int, status: String, chosen: String) -> String {
        let state = Self.choices.replacingOccurrences(of: #""status":"open","chosen_index":null"#, with: #""status":"\#(status)","chosen_index":\#(chosen)"#)
        return #"{"type":"event","seq":\#(seq),"event":"choice","data":{"message_id":"m1","session_id":"s1","conversation_id":"c1","choices":"# + state + "}}"
    }

    // MARK: Protocol

    func testMessageDecodesChoicesAndChoiceAnswer() throws {
        let agent = try XCTUnwrap(ProtocolCodec.frame(Data(event(seq: 1, message(extra: #","choices":"# + Self.choices)).utf8)).data?.message)
        let choices = try XCTUnwrap(agent.choices)
        XCTAssertEqual(choices.promptID, "p1")
        XCTAssertEqual(choices.items.map(\.label), ["Approve", "Deny", "Copy SQL", "Docs"])
        XCTAssertEqual(choices.items[0].style, "success")
        XCTAssertEqual(choices.items[2].copyText, "select 1")
        XCTAssertEqual(choices.items[3].url, "https://example.com")
        XCTAssertTrue(choices.isOpen)
        XCTAssertNil(choices.chosenIndex)
        XCTAssertNil(agent.choiceAnswer)

        let tap = try XCTUnwrap(ProtocolCodec.frame(Data(event(seq: 2, message("m2", direction: "inbound", body: "[tapped] Approve",
            extra: #","choice_answer":{"prompt_id":"p1","index":0,"label":"Approve"}"#)).utf8)).data?.message)
        XCTAssertEqual(tap.choiceAnswer, ChoiceAnswer(promptID: "p1", index: 0, label: "Approve"))
        XCTAssertNil(tap.choices)
    }

    func testMalformedChoicesCostOnlyTheChoices() throws {
        for bad in [#","choices":"nonsense""#, #","choices":{"items":[{"style":"success"}],"status":"open"}"#,
                    #","choice_answer":{"index":"one"}"#] {
            let decoded = try XCTUnwrap(ProtocolCodec.frame(Data(event(seq: 1, message(extra: bad)).utf8)).data?.message, bad)
            XCTAssertEqual(decoded.body, "Ship it?")
            XCTAssertNil(decoded.choices)
            XCTAssertNil(decoded.choiceAnswer)
        }
    }

    func testChoiceEventDecodes() throws {
        let data = try XCTUnwrap(ProtocolCodec.frame(Data(choiceEvent(seq: 9, status: "answered", chosen: "1").utf8)).data)
        XCTAssertEqual(data.messageID, "m1")
        XCTAssertEqual(data.sessionID, "s1")
        XCTAssertEqual(data.choices?.status, "answered")
        XCTAssertEqual(data.choices?.chosenIndex, 1)
        XCTAssertNil(data.message, "a choice event is not a message")
        XCTAssertNil(data.session)
    }

    func testChoiceFrameIsExact() throws {
        let encoded = try ProtocolCodec.encode(.choice("c-1", promptID: "p1", index: 1))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        XCTAssertEqual(Set(object.keys), ["type", "client_msg_id", "prompt_id", "index"])
        XCTAssertEqual(object["type"] as? String, "choice")
        XCTAssertEqual(object["client_msg_id"] as? String, "c-1")
        XCTAssertEqual(object["prompt_id"] as? String, "p1")
        XCTAssertEqual(object["index"] as? Int, 1)
    }

    func testLayoutAndActions() {
        func set(_ labels: [String]) -> ChoiceSet {
            ChoiceSet(promptID: "p", items: labels.map { ChoiceItem(label: $0) }, status: "open", chosenIndex: nil)
        }
        XCTAssertEqual(set(["Yes", "No", "Twelve chars"]).columns, 2)
        XCTAssertEqual(set(["Yes", "Thirteen char"]).columns, 1)
        XCTAssertEqual(set(["Only"]).columns, 1)
        XCTAssertEqual(ChoiceItem(label: "A").action, .send)
        XCTAssertEqual(ChoiceItem(label: "A", copyText: "x").action, .copy("x"))
        XCTAssertEqual(ChoiceItem(label: "A", url: "https://example.com/a").action, .open(URL(string: "https://example.com/a")!))
        XCTAssertEqual(ChoiceItem(label: "A", url: "file:///etc/hosts").action, .unavailable)
        XCTAssertNil(ChoiceRejection.explain("already_answered"))
        XCTAssertEqual(ChoiceRejection.explain("expired"), "This choice has expired.")
    }

    // MARK: Connection and store

    private var containers: [ModelContainer] = []

    private func makeStore() throws -> ChatStore {
        let container = try ModelContainer(for: CachedSession.self, CachedMessage.self, CachedState.self, PendingSend.self,
            configurations: ModelConfiguration(isStoredInMemoryOnly: true))
        containers.append(container)
        return ChatStore(container.mainContext)
    }

    private func waitFor(_ predicate: @escaping @MainActor () -> Bool) async throws {
        for _ in 0..<200 {
            if predicate() { return }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTFail("Timed out waiting for mock socket state")
    }

    /// A connected client with one cached agent message carrying `Self.choices`.
    private func connected() async throws -> (ChatStore, MockSocket, BusConnection) {
        let store = try makeStore()
        let settings = ClientSettings(); settings.appToken = "test-app-token"
        let socket = MockSocket()
        let connection = BusConnection(settings: settings, store: store, socket: socket, api: MockAPI(), observeSystemEvents: false)
        connection.start()
        try await waitFor { socket.sent.count >= 1 }
        socket.push(#"{"type":"welcome","version":1,"reset":false,"latest_seq":0}"#)
        try await waitFor { connection.state == .connected }
        socket.push(event(seq: 1, message(extra: #","choices":"# + Self.choices)))
        try await waitFor { store.message("m1")?.choices != nil }
        return (store, socket, connection)
    }

    func testTapSendsTheChoiceFrameAndSuccessMarksItAnswered() async throws {
        let (store, socket, connection) = try await connected()
        try await connection.choose(message: "m1", index: 1)
        XCTAssertEqual(socket.sent.count, 2)
        let frame = try socket.frame(1)
        XCTAssertEqual(frame["type"] as? String, "choice")
        XCTAssertEqual(frame["prompt_id"] as? String, "p1")
        XCTAssertEqual(frame["index"] as? Int, 1)
        XCTAssertEqual(Set(frame.keys), ["type", "client_msg_id", "prompt_id", "index"])
        let id = try XCTUnwrap(frame["client_msg_id"] as? String)
        XCTAssertEqual(store.message("m1")?.choicePendingIndex, 1)

        // A second tap while one is in flight sends nothing.
        try await connection.choose(message: "m1", index: 0)
        XCTAssertEqual(socket.sent.count, 2)

        socket.push(#"{"type":"ack","client_msg_id":"\#(id)","status":"queued"}"#)
        try await waitFor { store.message("m1")?.choicePendingIndex == nil }
        XCTAssertEqual(store.message("m1")?.choices?.status, "answered")
        XCTAssertEqual(store.message("m1")?.choices?.chosenIndex, 1)
        XCTAssertNil(store.message("m1")?.choiceError)
        XCTAssertTrue(store.pending.isEmpty, "a tap ack is not a send ack")
        connection.stop()
    }

    func testRejectedAckClearsPendingAndExplainsTheReason() async throws {
        let (store, socket, connection) = try await connected()
        try await connection.choose(message: "m1", index: 0)
        let first = try XCTUnwrap(socket.frame(1)["client_msg_id"] as? String)
        socket.push(#"{"type":"ack","client_msg_id":"\#(first)","status":"rejected","reason":"expired"}"#)
        try await waitFor { store.message("m1")?.choicePendingIndex == nil }
        XCTAssertEqual(store.message("m1")?.choiceError, "This choice has expired.")
        XCTAssertEqual(store.message("m1")?.choices?.status, "open", "state comes from the bus, not the rejection")

        // A new tap clears the old error; already_answered is final and quiet.
        try await connection.choose(message: "m1", index: 0)
        XCTAssertNil(store.message("m1")?.choiceError)
        let second = try XCTUnwrap(socket.frame(2)["client_msg_id"] as? String)
        socket.push(#"{"type":"ack","client_msg_id":"\#(second)","status":"rejected","reason":"already_answered"}"#)
        try await waitFor { store.message("m1")?.choicePendingIndex == nil }
        XCTAssertNil(store.message("m1")?.choiceError)
        connection.stop()
    }

    func testCopyLinkAndOfflineTapsSendNothing() async throws {
        let (store, socket, connection) = try await connected()
        try await connection.choose(message: "m1", index: 2)
        try await connection.choose(message: "m1", index: 3)
        try await connection.choose(message: "m1", index: 9)
        try await connection.choose(message: "missing", index: 0)
        XCTAssertEqual(socket.sent.count, 1)
        XCTAssertNil(store.message("m1")?.choicePendingIndex)
        connection.stop()
        try await connection.choose(message: "m1", index: 0)
        XCTAssertEqual(socket.sent.count, 1, "taps are not queued offline")
    }

    func testDisconnectDropsATapInFlight() async throws {
        let (store, socket, connection) = try await connected()
        try await connection.choose(message: "m1", index: 0)
        XCTAssertEqual(store.message("m1")?.choicePendingIndex, 0)
        connection.reconnect()
        XCTAssertNil(store.message("m1")?.choicePendingIndex)
        try await waitFor { socket.connects == 2 }
        connection.stop()
    }

    func testChoiceEventReplacesTheCachedState() async throws {
        let (store, socket, connection) = try await connected()
        try await connection.choose(message: "m1", index: 0)
        socket.push(choiceEvent(seq: 2, status: "answered", chosen: "1"))
        try await waitFor { store.cursor == 2 }
        XCTAssertEqual(store.message("m1")?.choices?.chosenIndex, 1)
        XCTAssertNil(store.message("m1")?.choicePendingIndex, "an answered prompt drops the local tap")
        socket.push(choiceEvent(seq: 3, status: "expired", chosen: "null"))
        try await waitFor { store.cursor == 3 }
        XCTAssertEqual(store.message("m1")?.choices?.status, "expired")
        // A prompt that isn't cached is skipped, but the cursor still moves.
        socket.push(choiceEvent(seq: 4, status: "answered", chosen: "0").replacingOccurrences(of: #""message_id":"m1""#, with: #""message_id":"gone""#))
        try await waitFor { store.cursor == 4 }
        XCTAssertFalse(store.hasMessage("gone"))
        XCTAssertEqual(store.messages("s1").count, 1)
        connection.stop()
    }

    func testHistoryPageRefreshesChoiceState() throws {
        let store = try makeStore()
        func decoded(_ status: String, _ chosen: String) throws -> BusMessage {
            let state = Self.choices.replacingOccurrences(of: #""status":"open","chosen_index":null"#, with: #""status":"\#(status)","chosen_index":\#(chosen)"#)
            return try JSONDecoder().decode(BusMessage.self, from: Data(message(extra: #","choices":"# + state).utf8))
        }
        try store.upsert(decoded("open", "null"))
        try store.setChoicePending("m1", index: 0)
        try store.setHistory("s1", page: MessagesPage(messages: [try decoded("answered", "0")], nextBefore: nil), first: true)
        XCTAssertEqual(store.message("m1")?.choices?.status, "answered")
        XCTAssertEqual(store.message("m1")?.choices?.chosenIndex, 0)
        XCTAssertNil(store.message("m1")?.choicePendingIndex)
        // A row without choices on the page leaves the cached ones alone.
        try store.upsert(try JSONDecoder().decode(BusMessage.self, from: Data(message(extra: "").utf8)))
        XCTAssertEqual(store.message("m1")?.choices?.status, "answered")
    }

    func testTapRowBuildsAChoiceNote() throws {
        let store = try makeStore()
        try store.upsert(try JSONDecoder().decode(BusMessage.self, from: Data(message(extra: #","choices":"# + Self.choices).utf8)))
        try store.upsert(try JSONDecoder().decode(BusMessage.self, from: Data(message("m2", direction: "inbound", body: "[tapped] Approve",
            at: "2026-10-30T12:01:00Z", extra: #","choice_answer":{"prompt_id":"p1","index":0,"label":"Approve"}"#).utf8)))
        let items = TranscriptItem.build(store.messages("s1"), pending: [], session: nil, activity: "idle")
        XCTAssertEqual(items.map(\.id), ["day-m1", "m1", "m2"])
        guard case .choiceNote(let label, _) = items[2] else { return XCTFail("expected a choice note") }
        XCTAssertEqual(label, "Approve")
    }
}

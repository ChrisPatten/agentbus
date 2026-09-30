import XCTest
@testable import AgentBus

final class ProtocolTests: XCTestCase {
    func testSendFrameKeepsStableClientIDAndTarget() throws {
        let id = "2f93a416-08a2-4df4-a821-48759a4c15a1"
        let encoded = try ProtocolCodec.encode(.send(id, target: .session("old-session"), body: "Continue", attachments: ["file-id"]))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        XCTAssertEqual(object["client_msg_id"] as? String, id)
        XCTAssertEqual((object["target"] as? [String: String])?["session_id"], "old-session")
        XCTAssertEqual(object["attachment_ids"] as? [String], ["file-id"])
    }
    func testWelcomeResetAndOrderedReplay() throws {
        let welcome = try ProtocolCodec.frame(Data(#"{"type":"welcome","version":1,"reset":true,"latest_seq":42}"#.utf8))
        XCTAssertEqual(CursorReducer.welcome(current: 3, reset: welcome.reset == true, latest: welcome.latestSeq ?? 0), .reset(42))
        XCTAssertEqual(CursorReducer.event(current: 42, seq: 42), .ignore)
        XCTAssertEqual(CursorReducer.event(current: 42, seq: 43), .apply(43))
    }
    func testMessageAndSessionEventsDecode() throws {
        let message = #"{"type":"event","seq":7,"event":"message","data":{"message_id":"m1","session_id":"s1","seq":7,"cursor":"row-1","direction":"outbound","arrival_channel":"app","body":"Hi","created_at":"2026-09-30T12:00:00Z","scheduled":false,"attachments":[]}}"#
        let session = #"{"type":"event","seq":8,"event":"session","data":{"session_id":"s1","channel":"app","topic":"general","title":"Main","started_at":"2026-09-30T12:00:00Z","last_activity":"2026-09-30T12:00:00Z","ended_at":null,"unread_count":1,"resumable":true,"is_main":true,"activity":"idle"}}"#
        XCTAssertEqual(try ProtocolCodec.frame(Data(message.utf8)).data?.message?.body, "Hi")
        XCTAssertEqual(try ProtocolCodec.frame(Data(session.utf8)).data?.session?.title, "Main")
    }
}

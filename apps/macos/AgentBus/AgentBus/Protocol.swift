import Foundation

struct BusHealth: Decodable {
    let ok: Bool
    let contact: String
    let agent: String?
    let routed: Bool
    let version: String
    let concurrency: [BusCapacity]?
    let limits: Limits

    struct Limits: Decodable { let maxUploadBytes: Int
        enum CodingKeys: String, CodingKey { case maxUploadBytes = "max_upload_bytes" }
    }
    /// The capacity snapshot for the routed agent, or the only one reported.
    var capacity: BusCapacity? {
        concurrency?.first { $0.agentID == agent } ?? concurrency?.first
    }
}

/// Headless agent slot usage, from `/health` and every `activity` frame.
struct BusCapacity: Decodable, Equatable {
    let agentID: String?
    let runningUser: Int
    let runningSystem: Int
    let waiting: Int
    let limit: Int
    let reservedSystemSlots: Int
    var busy: Int { runningUser + runningSystem }
    var userSlots: Int { max(limit - reservedSystemSlots, 0) }
    enum CodingKeys: String, CodingKey {
        case agentID = "agent_id", runningUser = "running_user", runningSystem = "running_system"
        case waiting, limit, reservedSystemSlots = "reserved_system_slots"
    }
}

struct SlashCommand: Decodable, Hashable {
    let name: String
    let description: String
    /// The manifest name with exactly one leading slash.
    var invocation: String { "/" + name.drop { $0 == "/" } }
}
struct CommandList: Decodable { let commands: [SlashCommand] }

struct BusSession: Codable, Identifiable {
    let sessionID: String
    let channel: String
    let topic: String
    let title: String
    let startedAt: String
    let lastActivity: String
    let endedAt: String?
    let unreadCount: Int
    let resumable: Bool
    let isMain: Bool
    let activity: String?
    var messageCount: Int? = nil
    var claudeSessionID: String? = nil
    var id: String { sessionID }

    enum CodingKeys: String, CodingKey {
        case sessionID = "session_id", channel, topic, title
        case startedAt = "started_at", lastActivity = "last_activity"
        case endedAt = "ended_at", unreadCount = "unread_count"
        case resumable, isMain = "is_main", activity
        case messageCount = "message_count", claudeSessionID = "claude_session_id"
    }
}

struct BusAttachment: Codable, Identifiable {
    let id: String?
    let type: String?
    let originalFilename: String?
    let mimeType: String?
    let expired: Bool?
    var stableID: String { id ?? originalFilename ?? UUID().uuidString }
    enum CodingKeys: String, CodingKey {
        case id, type, originalFilename = "original_filename"
        case mimeType = "mime_type", expired
    }
}

struct BusMessage: Codable, Identifiable {
    let messageID: String
    let sessionID: String
    let seq: Int
    let cursor: String
    let direction: String
    let arrivalChannel: String
    let body: String
    let createdAt: String
    let scheduled: Bool
    let attachments: [BusAttachment]
    var id: String { messageID }
    enum CodingKeys: String, CodingKey {
        case messageID = "message_id", sessionID = "session_id", seq, cursor
        case direction, arrivalChannel = "arrival_channel", body
        case createdAt = "created_at", scheduled, attachments
    }
}

struct SessionsPage: Decodable { let sessions: [BusSession]; let nextBefore: String?
    enum CodingKeys: String, CodingKey { case sessions, nextBefore = "next_before" }
}
struct MessagesPage: Decodable { let messages: [BusMessage]; let nextBefore: String?
    enum CodingKeys: String, CodingKey { case messages, nextBefore = "next_before" }
}
struct UploadedFile: Codable, Hashable { let id: String; let originalFilename: String; let size: Int
    enum CodingKeys: String, CodingKey { case id, originalFilename = "original_filename", size }
}

enum BusTarget: Encodable {
    case main, new(String), session(String)
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .main: try c.encode("main", forKey: .kind)
        case .new(let title):
            // An omitted title lets the bus name the topic "New Conversation".
            try c.encode("new", forKey: .kind)
            let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty { try c.encode(trimmed, forKey: .title) }
        case .session(let id): try c.encode("session", forKey: .kind); try c.encode(id, forKey: .sessionID)
        }
    }
    enum CodingKeys: String, CodingKey { case kind, title, sessionID = "session_id" }
}

struct ClientFrame: Encodable {
    let type: String
    var cursor: Int? = nil
    var clientMsgID: String? = nil
    var target: BusTarget? = nil
    var body: String? = nil
    var attachmentIDs: [String]? = nil
    var sessionID: String? = nil
    var title: String? = nil
    var seq: Int? = nil
    var requestID: String? = nil
    enum CodingKeys: String, CodingKey {
        case type, cursor, clientMsgID = "client_msg_id", target, body
        case attachmentIDs = "attachment_ids", sessionID = "session_id"
        case title, seq, requestID = "request_id"
    }
    static func hello(_ cursor: Int) -> Self { Self(type: "hello", cursor: cursor) }
    static func send(_ id: String, target: BusTarget, body: String, attachments: [String]) -> Self {
        Self(type: "send", clientMsgID: id, target: target, body: body, attachmentIDs: attachments)
    }
}

struct ServerFrame: Decodable {
    let type: String
    let version: Int?
    let reset: Bool?
    let latestSeq: Int?
    let seq: Int?
    let event: String?
    let data: DataPayload?
    let clientMsgID: String?
    let messageID: String?
    let sessionID: String?
    let status: String?
    let reason: String?
    let code: String?
    let requestID: String?

    enum CodingKeys: String, CodingKey {
        case type, version, reset, latestSeq = "latest_seq", seq, event, data
        case clientMsgID = "client_msg_id", messageID = "message_id"
        case sessionID = "session_id", status, reason, code, requestID = "request_id"
    }

    struct DataPayload: Decodable {
        let sessionID: String?
        let conversationID: String?
        let state: String?
        let turnClass: String?
        let typing: Bool?
        let toolLines: [String]?
        let capacity: BusCapacity?
        let message: BusMessage?
        let session: BusSession?
        enum CodingKeys: String, CodingKey {
            case sessionID = "session_id", conversationID = "conversation_id", state
            case turnClass = "turn_class", typing, toolLines = "tool_lines"
        }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            sessionID = try c.decodeIfPresent(String.self, forKey: .sessionID)
            conversationID = try c.decodeIfPresent(String.self, forKey: .conversationID)
            state = try c.decodeIfPresent(String.self, forKey: .state)
            turnClass = try c.decodeIfPresent(String.self, forKey: .turnClass)
            typing = try? c.decodeIfPresent(Bool.self, forKey: .typing)
            toolLines = try? c.decodeIfPresent([String].self, forKey: .toolLines)
            capacity = try? BusCapacity(from: decoder)
            message = try? BusMessage(from: decoder)
            session = try? BusSession(from: decoder)
        }
    }
}

enum ProtocolCodec {
    static let decoder = JSONDecoder()
    static let encoder = JSONEncoder()
    static func frame(_ data: Data) throws -> ServerFrame { try decoder.decode(ServerFrame.self, from: data) }
    static func encode(_ frame: ClientFrame) throws -> Data { try encoder.encode(frame) }
}

enum CursorDecision: Equatable {
    case ignore, apply(Int), reset(Int)
}

enum CursorReducer {
    static func welcome(current: Int, reset: Bool, latest: Int) -> CursorDecision {
        reset ? .reset(latest) : .ignore
    }
    static func event(current: Int, seq: Int?) -> CursorDecision {
        guard let seq, seq > current else { return .ignore }
        return .apply(seq)
    }
}

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
    /// The conversation the row belongs to. Main's rows share one (E69); absent from older buses.
    var conversationID: String? = nil
    var id: String { sessionID }

    enum CodingKeys: String, CodingKey {
        case sessionID = "session_id", channel, topic, title
        case startedAt = "started_at", lastActivity = "last_activity"
        case endedAt = "ended_at", unreadCount = "unread_count"
        case resumable, isMain = "is_main", activity
        case messageCount = "message_count", claudeSessionID = "claude_session_id"
        case conversationID = "conversation_id"
    }
}

/// Where one of Main's Claude sessions ended, from a history page's `boundaries` (E69).
struct SessionBoundary: Codable, Equatable {
    let sessionID: String
    let endedAt: String?
    /// "idle" (inactivity rotation), "clear" (`/clear`), or nil when the bus doesn't know.
    let reason: String?
    enum CodingKeys: String, CodingKey { case sessionID = "session_id", endedAt = "ended_at", reason }
}

/// The `rotated` part of a Main session event: the row that just ended.
struct SessionRotation: Decodable, Equatable {
    let previousSessionID: String
    let endedAt: String?
    let reason: String?
    var boundary: SessionBoundary { SessionBoundary(sessionID: previousSessionID, endedAt: endedAt, reason: reason) }
    enum CodingKeys: String, CodingKey { case previousSessionID = "previous_session_id", endedAt = "ended_at", reason }
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

/// The message a send replied to, as the bus resolved it: who said it and its first 200 characters.
struct ReplyRef: Codable, Equatable {
    let messageID: String
    /// "you" for an operator message, "agent" for an agent message.
    let senderName: String
    let text: String
    enum CodingKeys: String, CodingKey { case messageID = "message_id", senderName = "sender_name", text }
}

/// One button of an agent message's choice prompt (E86). A button with `copy_text` or `url` is handled on
/// this Mac; any other is a callback that is sent to the bus as a `choice` frame.
struct ChoiceItem: Codable, Equatable {
    let label: String
    /// "primary", "success" or "danger"; anything else draws the default button.
    var style: String? = nil
    var copyText: String? = nil
    var url: String? = nil
    var isCallback: Bool { copyText == nil && url == nil }
    enum CodingKeys: String, CodingKey { case label, style, copyText = "copy_text", url }

    enum Action: Equatable { case send, copy(String), open(URL), unavailable }
    /// What a click does. A link opens only for http or https.
    var action: Action {
        if let copyText { return .copy(copyText) }
        guard let url else { return .send }
        guard let value = URL(string: url), ["http", "https"].contains(value.scheme?.lowercased() ?? "") else { return .unavailable }
        return .open(value)
    }
}

/// An agent message's buttons and their current state, from history pages, `message` events and `choice` events.
struct ChoiceSet: Codable, Equatable {
    /// Nil when no item is a callback: nothing goes back to the bus and `status` stays "open".
    let promptID: String?
    let items: [ChoiceItem]
    /// "open", "answered" or "expired".
    let status: String
    let chosenIndex: Int?
    enum CodingKeys: String, CodingKey { case promptID = "prompt_id", items, status, chosenIndex = "chosen_index" }

    var isOpen: Bool { status == "open" }
    var isExpired: Bool { status == "expired" }
    /// Two buttons to a row when every label is 12 characters or fewer, otherwise one.
    var columns: Int { items.count > 1 && items.allSatisfy { $0.label.count <= 12 } ? 2 : 1 }
    func answered(_ index: Int) -> ChoiceSet { ChoiceSet(promptID: promptID, items: items, status: "answered", chosenIndex: index) }
}

/// On an inbound tap row: the prompt and button it answered.
struct ChoiceAnswer: Codable, Equatable {
    let promptID: String
    let index: Int
    let label: String
    enum CodingKeys: String, CodingKey { case promptID = "prompt_id", index, label }
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
    /// Present when the message replies to another one: an operator `reply_to`, or an agent reply the bus quotes.
    var replyTo: ReplyRef? = nil
    /// The row's conversation, so any of Main's rows maps to the one Main item (E69). Absent from older buses.
    var conversationID: String? = nil
    /// An agent message's buttons (E86).
    var choices: ChoiceSet? = nil
    /// An operator row that is a button tap rather than typed text (E86).
    var choiceAnswer: ChoiceAnswer? = nil
    var id: String { messageID }
    enum CodingKeys: String, CodingKey {
        case messageID = "message_id", sessionID = "session_id", seq, cursor
        case direction, arrivalChannel = "arrival_channel", body
        case createdAt = "created_at", scheduled, attachments, replyTo = "reply_to"
        case conversationID = "conversation_id", choices, choiceAnswer = "choice_answer"
    }
}

extension BusMessage {
    /// A malformed `reply_to`, `choices` or `choice_answer` must not cost the whole message, so it decodes to nil instead of throwing.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        messageID = try c.decode(String.self, forKey: .messageID)
        sessionID = try c.decode(String.self, forKey: .sessionID)
        seq = try c.decode(Int.self, forKey: .seq)
        cursor = try c.decode(String.self, forKey: .cursor)
        direction = try c.decode(String.self, forKey: .direction)
        arrivalChannel = try c.decode(String.self, forKey: .arrivalChannel)
        body = try c.decode(String.self, forKey: .body)
        createdAt = try c.decode(String.self, forKey: .createdAt)
        scheduled = try c.decode(Bool.self, forKey: .scheduled)
        attachments = try c.decode([BusAttachment].self, forKey: .attachments)
        replyTo = try? c.decodeIfPresent(ReplyRef.self, forKey: .replyTo)
        conversationID = try? c.decodeIfPresent(String.self, forKey: .conversationID)
        choices = try? c.decodeIfPresent(ChoiceSet.self, forKey: .choices)
        choiceAnswer = try? c.decodeIfPresent(ChoiceAnswer.self, forKey: .choiceAnswer)
    }
}

struct SessionsPage: Decodable { let sessions: [BusSession]; let nextBefore: String?
    enum CodingKeys: String, CodingKey { case sessions, nextBefore = "next_before" }
}
struct MessagesPage: Decodable { let messages: [BusMessage]; let nextBefore: String?
    /// Main only: where its ended rows fall within this page. Older buses and other sessions omit it.
    var boundaries: [SessionBoundary]? = nil
    enum CodingKeys: String, CodingKey { case messages, nextBefore = "next_before", boundaries }
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
    var replyTo: String? = nil
    var promptID: String? = nil
    var index: Int? = nil
    enum CodingKeys: String, CodingKey {
        case type, cursor, clientMsgID = "client_msg_id", target, body
        case attachmentIDs = "attachment_ids", sessionID = "session_id"
        case title, seq, requestID = "request_id", replyTo = "reply_to"
        case promptID = "prompt_id", index
    }
    static func hello(_ cursor: Int) -> Self { Self(type: "hello", cursor: cursor) }
    static func send(_ id: String, target: BusTarget, body: String, attachments: [String], replyTo: String? = nil) -> Self {
        Self(type: "send", clientMsgID: id, target: target, body: body, attachmentIDs: attachments, replyTo: replyTo)
    }
    /// A button tap (E86). `index` is the item's position in the prompt's `items`.
    static func choice(_ id: String, promptID: String, index: Int) -> Self {
        Self(type: "choice", clientMsgID: id, promptID: promptID, index: index)
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
        /// On a Main session event that follows a rotation: the row that ended.
        let rotated: SessionRotation?
        /// On a `choice` event: the prompt's message and its current state (E86).
        let messageID: String?
        let choices: ChoiceSet?
        enum CodingKeys: String, CodingKey {
            case sessionID = "session_id", conversationID = "conversation_id", state
            case turnClass = "turn_class", typing, toolLines = "tool_lines", rotated
            case messageID = "message_id", choices
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
            rotated = try? c.decodeIfPresent(SessionRotation.self, forKey: .rotated)
            messageID = try? c.decodeIfPresent(String.self, forKey: .messageID)
            choices = try? c.decodeIfPresent(ChoiceSet.self, forKey: .choices)
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

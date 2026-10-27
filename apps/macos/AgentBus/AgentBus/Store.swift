import Foundation
import SwiftData

@Model final class CachedSession {
    @Attribute(.unique) var id: String
    var channel: String
    var topic: String
    var title: String
    var startedAt: String
    var lastActivity: String
    var endedAt: String?
    var unreadCount: Int
    var resumable: Bool
    var isMain: Bool
    var activity: String
    var readSeq: Int
    var oldestCursor: String?
    var historyComplete: Bool
    var messageCount: Int = 0
    var claudeSessionID: String? = nil
    var conversationID: String? = nil
    /// Main only: the bus row IDs this item had before a rotation, oldest first (E69).
    var formerIDsJSON: Data? = nil
    /// Main only: where its ended rows stopped, from history pages and rotation events.
    var boundariesJSON: Data? = nil

    init(_ value: BusSession) {
        id = value.sessionID; channel = value.channel; topic = value.topic
        title = value.title; startedAt = value.startedAt; lastActivity = value.lastActivity
        endedAt = value.endedAt; unreadCount = value.unreadCount
        resumable = value.resumable; isMain = value.isMain
        activity = value.activity ?? "idle"; readSeq = 0
        oldestCursor = nil; historyComplete = false
        messageCount = value.messageCount ?? 0; claudeSessionID = value.claudeSessionID
        conversationID = value.conversationID
    }
    func update(_ value: BusSession) {
        channel = value.channel; topic = value.topic; title = value.title
        startedAt = value.startedAt; lastActivity = value.lastActivity
        endedAt = value.endedAt; unreadCount = value.unreadCount
        resumable = value.resumable; isMain = value.isMain
        activity = value.activity ?? activity
        messageCount = value.messageCount ?? messageCount
        claudeSessionID = value.claudeSessionID ?? claudeSessionID
        conversationID = value.conversationID ?? conversationID
    }
}

@Model final class CachedMessage {
    @Attribute(.unique) var id: String
    var sessionID: String
    var seq: Int
    var cursor: String
    var direction: String
    var arrivalChannel: String
    var body: String
    var createdAt: String
    var scheduled: Bool
    var attachmentJSON: Data
    var sendState: String
    var clientMsgID: String?
    /// The live tool trail that preceded this reply. Local only: the bus does not store trails.
    var toolTrailJSON: Data? = nil
    var toolSeconds: Double = 0
    /// The message this one replied to, as the bus quoted it. Kept as JSON so the store needs no migration.
    var replyToJSON: Data? = nil
    /// Routes the message to Main's one item whichever of Main's rows it was logged in (E69).
    var conversationID: String? = nil

    init(_ value: BusMessage) {
        id = value.messageID; sessionID = value.sessionID; seq = value.seq
        cursor = value.cursor; direction = value.direction
        arrivalChannel = value.arrivalChannel; body = value.body
        createdAt = value.createdAt; scheduled = value.scheduled
        attachmentJSON = (try? JSONEncoder().encode(value.attachments)) ?? Data()
        replyToJSON = value.replyTo.flatMap { try? JSONEncoder().encode($0) }
        conversationID = value.conversationID
        sendState = "sent"; clientMsgID = nil
    }
    var attachments: [BusAttachment] { (try? JSONDecoder().decode([BusAttachment].self, from: attachmentJSON)) ?? [] }
    var replyTo: ReplyRef? { replyToJSON.flatMap { try? JSONDecoder().decode(ReplyRef.self, from: $0) } }
    var toolTrail: [String] { toolTrailJSON.flatMap { try? JSONDecoder().decode([String].self, from: $0) } ?? [] }
}

@Model final class CachedState {
    @Attribute(.unique) var key: String
    var cursor: Int
    init() { key = "main"; cursor = 0 }
}

@Model final class PendingSend {
    @Attribute(.unique) var id: String
    var targetKind: String
    var targetID: String?
    var title: String?
    var body: String
    var attachmentJSON: Data
    var createdAt: Date
    var failure: String?
    /// Names and sizes of the uploads, so the pending bubble can show attachment cards.
    var filesJSON: Data? = nil
    /// The message being replied to, kept whole so the pending bubble can show its note and a retry keeps it.
    var replyToJSON: Data? = nil
    init(id: String = UUID().uuidString, target: BusTarget, body: String, attachments: [String],
         files: [UploadedFile] = [], replyTo: ReplyRef? = nil) {
        self.id = id; self.body = body
        attachmentJSON = (try? JSONEncoder().encode(attachments)) ?? Data()
        filesJSON = files.isEmpty ? nil : try? JSONEncoder().encode(files)
        replyToJSON = replyTo.flatMap { try? JSONEncoder().encode($0) }
        createdAt = .now; failure = nil
        switch target {
        case .main: targetKind = "main"; targetID = nil; title = nil
        case .new(let value): targetKind = "new"; targetID = nil; title = value
        case .session(let value): targetKind = "session"; targetID = value; title = nil
        }
    }
    var target: BusTarget {
        switch targetKind {
        case "new": .new(title ?? "New Conversation")
        case "session": .session(targetID ?? "")
        default: .main
        }
    }
    var attachmentIDs: [String] { (try? JSONDecoder().decode([String].self, from: attachmentJSON)) ?? [] }
    var files: [UploadedFile] { filesJSON.flatMap { try? JSONDecoder().decode([UploadedFile].self, from: $0) } ?? [] }
    var replyTo: ReplyRef? { replyToJSON.flatMap { try? JSONDecoder().decode(ReplyRef.self, from: $0) } }
}

extension ReplyRef {
    /// A reference to a message in the transcript, worded as the bus words it: "you" or "agent", 200 characters.
    init(_ message: CachedMessage) {
        self.init(messageID: message.id, senderName: message.isOperator ? "you" : "agent", text: String(message.body.prefix(200)))
    }
}

/// What a pending send was aimed at, captured before its row is deleted on ack.
struct AckedTarget: Equatable { let kind: String; let sessionID: String? }

@MainActor final class ChatStore {
    let context: ModelContext
    init(_ context: ModelContext) { self.context = context }
    var state: CachedState {
        if let value = try? context.fetch(FetchDescriptor<CachedState>()).first { return value }
        let value = CachedState(); context.insert(value); try? context.save(); return value
    }
    var cursor: Int { state.cursor }
    var sessions: [CachedSession] { (try? context.fetch(FetchDescriptor<CachedSession>())) ?? [] }
    var pending: [PendingSend] { (try? context.fetch(FetchDescriptor<PendingSend>())) ?? [] }
    func hasMessage(_ id: String) -> Bool {
        var descriptor = FetchDescriptor<CachedMessage>(predicate: #Predicate { $0.id == id })
        descriptor.fetchLimit = 1
        return ((try? context.fetchCount(descriptor)) ?? 0) > 0
    }
    func messages(_ sessionID: String) -> [CachedMessage] {
        let descriptor = FetchDescriptor<CachedMessage>(predicate: #Predicate { $0.sessionID == sessionID },
            sortBy: [SortDescriptor(\.createdAt)])
        return (try? context.fetch(descriptor)) ?? []
    }
    /// A session by ID. Any of Main's former row IDs finds the one Main item.
    func session(_ id: String) -> CachedSession? {
        let all = sessions
        return all.first { $0.id == id } ?? all.first { $0.isMain && $0.formerIDs.contains(id) }
    }

    func upsert(_ value: BusSession) throws {
        merge(value)
        try context.save()
    }
    func upsert(_ value: BusMessage, save: Bool = true) throws {
        let id = value.messageID
        let descriptor = FetchDescriptor<CachedMessage>(predicate: #Predicate { $0.id == id })
        if let row = try context.fetch(descriptor).first {
            // Rows cached from an older bus learn their conversation when history reloads.
            if row.conversationID == nil { row.conversationID = value.conversationID }
        } else { context.insert(CachedMessage(value)) }
        if save { try context.save() }
    }
    func apply(_ frame: ServerFrame) throws -> Bool {
        guard frame.type == "event", case .apply(let seq) = CursorReducer.event(current: cursor, seq: frame.seq) else { return false }
        if let message = frame.data?.message { try upsert(message, save: false) }
        if let session = frame.data?.session { merge(session) }
        if let rotated = frame.data?.rotated { record(rotated.boundary) }
        state.cursor = seq
        try context.save()
        return frame.data?.message != nil
    }
    func replace(sessions: [BusSession], history: [String: [BusMessage]], cursor: Int) throws {
        // Main's former row IDs keep old selections and windows pointing at Main after the reload.
        let previousMain = main.map { (ids: $0.rowIDs, boundaries: $0.boundaries) }
        for row in self.sessions { context.delete(row) }
        for row in try context.fetch(FetchDescriptor<CachedMessage>()) { context.delete(row) }
        try context.save()
        for value in sessions { merge(value); try context.save() }
        if let previousMain, let main {
            for id in previousMain.ids where id != main.id { main.addFormer(id) }
            for boundary in previousMain.boundaries { main.record(boundary) }
        }
        var seen = Set<String>()
        for page in history.values { for value in page where seen.insert(value.messageID).inserted { context.insert(CachedMessage(value)) } }
        state.cursor = cursor
        try context.save()
    }
    func addPending(_ pending: PendingSend) throws { context.insert(pending); try context.save() }
    func acknowledge(_ id: String, status: String, reason: String?) throws -> AckedTarget? {
        guard let row = pending.first(where: { $0.id == id }) else { return nil }
        let target = AckedTarget(kind: row.targetKind, sessionID: row.targetID)
        if status == "rejected" { row.failure = reason ?? "Rejected" }
        else { context.delete(row) }
        try context.save(); return target
    }
    func setActivity(_ id: String, _ state: String) throws {
        guard let row = session(id), row.activity != state else { return }
        row.activity = state; try context.save()
    }
    func discard(_ id: String) throws {
        guard let row = pending.first(where: { $0.id == id }) else { return }
        context.delete(row); try context.save()
    }
    func attachTrail(_ messageID: String, lines: [String], seconds: Double) throws {
        let descriptor = FetchDescriptor<CachedMessage>(predicate: #Predicate { $0.id == messageID })
        guard !lines.isEmpty, let row = try context.fetch(descriptor).first else { return }
        row.toolTrailJSON = try JSONEncoder().encode(lines); row.toolSeconds = seconds
        try context.save()
    }
    func retry(_ id: String) throws {
        guard let row = pending.first(where: { $0.id == id }) else { return }
        row.failure = nil; try context.save()
    }
    func setRead(_ id: String, seq: Int) throws {
        guard let row = session(id) else { return }
        row.readSeq = max(row.readSeq, seq); row.unreadCount = 0; try context.save()
    }
    func setHistory(_ id: String, page: MessagesPage, first: Bool) throws {
        for message in page.messages { try upsert(message) }
        if let row = session(id) {
            if row.isMain { for boundary in page.boundaries ?? [] { record(boundary) } }
            row.oldestCursor = page.nextBefore
            row.historyComplete = page.messages.isEmpty || page.messages.count < 50
            try context.save()
        }
    }
}

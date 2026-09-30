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

    init(_ value: BusSession) {
        id = value.sessionID; channel = value.channel; topic = value.topic
        title = value.title; startedAt = value.startedAt; lastActivity = value.lastActivity
        endedAt = value.endedAt; unreadCount = value.unreadCount
        resumable = value.resumable; isMain = value.isMain
        activity = value.activity ?? "idle"; readSeq = 0
        oldestCursor = nil; historyComplete = false
    }
    func update(_ value: BusSession) {
        channel = value.channel; topic = value.topic; title = value.title
        startedAt = value.startedAt; lastActivity = value.lastActivity
        endedAt = value.endedAt; unreadCount = value.unreadCount
        resumable = value.resumable; isMain = value.isMain
        activity = value.activity ?? activity
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

    init(_ value: BusMessage) {
        id = value.messageID; sessionID = value.sessionID; seq = value.seq
        cursor = value.cursor; direction = value.direction
        arrivalChannel = value.arrivalChannel; body = value.body
        createdAt = value.createdAt; scheduled = value.scheduled
        attachmentJSON = (try? JSONEncoder().encode(value.attachments)) ?? Data()
        sendState = "sent"; clientMsgID = nil
    }
    var attachments: [BusAttachment] { (try? JSONDecoder().decode([BusAttachment].self, from: attachmentJSON)) ?? [] }
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
    init(id: String = UUID().uuidString, target: BusTarget, body: String, attachments: [String]) {
        self.id = id; self.body = body
        attachmentJSON = (try? JSONEncoder().encode(attachments)) ?? Data()
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
}

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
    func messages(_ sessionID: String) -> [CachedMessage] {
        let descriptor = FetchDescriptor<CachedMessage>(predicate: #Predicate { $0.sessionID == sessionID },
            sortBy: [SortDescriptor(\.createdAt)])
        return (try? context.fetch(descriptor)) ?? []
    }
    func session(_ id: String) -> CachedSession? { sessions.first { $0.id == id } }

    func upsert(_ value: BusSession) throws {
        if let current = session(value.id) { current.update(value) }
        else { context.insert(CachedSession(value)) }
        try context.save()
    }
    func upsert(_ value: BusMessage, save: Bool = true) throws {
        let id = value.messageID
        let descriptor = FetchDescriptor<CachedMessage>(predicate: #Predicate { $0.id == id })
        if try context.fetch(descriptor).isEmpty { context.insert(CachedMessage(value)) }
        if save { try context.save() }
    }
    func apply(_ frame: ServerFrame) throws -> Bool {
        guard frame.type == "event", case .apply(let seq) = CursorReducer.event(current: cursor, seq: frame.seq) else { return false }
        if let message = frame.data?.message { try upsert(message, save: false) }
        if let session = frame.data?.session {
            if let current = self.session(session.id) { current.update(session) }
            else { context.insert(CachedSession(session)) }
        }
        state.cursor = seq
        try context.save()
        return frame.data?.message != nil
    }
    func replace(sessions: [BusSession], history: [String: [BusMessage]], cursor: Int) throws {
        for row in self.sessions { context.delete(row) }
        for row in try context.fetch(FetchDescriptor<CachedMessage>()) { context.delete(row) }
        for value in sessions { context.insert(CachedSession(value)) }
        for page in history.values { for value in page { context.insert(CachedMessage(value)) } }
        state.cursor = cursor
        try context.save()
    }
    func addPending(_ pending: PendingSend) throws { context.insert(pending); try context.save() }
    func acknowledge(_ id: String, status: String, reason: String?) throws -> PendingSend? {
        guard let row = pending.first(where: { $0.id == id }) else { return nil }
        if status == "rejected" { row.failure = reason ?? "Rejected" }
        else { context.delete(row) }
        try context.save(); return row
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
            row.oldestCursor = page.nextBefore
            row.historyComplete = page.messages.isEmpty || page.messages.count < 50
            try context.save()
        }
    }
}

import Foundation
import SwiftData

// E69: Main is one continuous conversation. The bus rotates its Claude session rows underneath
// (idle rotation, `/clear`) and reports Main with the current row's `session_id`. The cache keeps one
// Main item whose `id` follows that row; the rows it had before are its former IDs.

extension CachedSession {
    /// Main's earlier row IDs, oldest first. Empty for every other session.
    var formerIDs: [String] {
        get { formerIDsJSON.flatMap { try? JSONDecoder().decode([String].self, from: $0) } ?? [] }
        set { formerIDsJSON = newValue.isEmpty ? nil : try? JSONEncoder().encode(newValue) }
    }
    var boundaries: [SessionBoundary] {
        get { boundariesJSON.flatMap { try? JSONDecoder().decode([SessionBoundary].self, from: $0) } ?? [] }
        set { boundariesJSON = newValue.isEmpty ? nil : try? JSONEncoder().encode(newValue) }
    }
    /// Every bus row ID this item stands for: the current one, then the former ones.
    var rowIDs: [String] { [id] + formerIDs }
    /// Whether a selection, window or notification ID points at this item.
    func answers(to id: String?) -> Bool {
        guard let id else { return false }
        return id == self.id || (isMain && formerIDs.contains(id))
    }
    /// Drafts and reply targets for Main survive rotation, so they aren't keyed by row ID.
    var draftKey: String { isMain ? BusTarget.mainSentinel : id }

    func addFormer(_ id: String) {
        guard id != self.id, !formerIDs.contains(id) else { return }
        formerIDs.append(id)
    }
    /// Merges a boundary by row, keeping whatever either copy knows.
    func record(_ boundary: SessionBoundary) {
        var list = boundaries
        if let index = list.firstIndex(where: { $0.sessionID == boundary.sessionID }) {
            let old = list[index]
            list[index] = SessionBoundary(sessionID: boundary.sessionID, endedAt: boundary.endedAt ?? old.endedAt,
                                          reason: boundary.reason ?? old.reason)
        } else {
            list.append(boundary)
        }
        boundaries = list
    }
    /// Moves Main onto a new current row, keeping selection-relevant state (read marker, history cursor).
    func rekey(to value: BusSession) {
        // Only an older bus ends Main itself; its end is where the next row's context starts.
        if let endedAt { record(SessionBoundary(sessionID: id, endedAt: endedAt, reason: nil)) }
        let old = id
        id = value.sessionID
        // The new row may already be known: from a message logged in it, or a fragment an older build cached.
        formerIDs.removeAll { $0 == value.sessionID }
        addFormer(old)
        update(value)
        // The new row has no Claude session until its first turn runs.
        claudeSessionID = value.claudeSessionID
    }
}

private extension BusSession {
    /// Whether a Main row the cache hasn't seen takes over as Main's current row.
    func supersedes(_ current: CachedSession) -> Bool {
        endedAt == nil || (current.endedAt != nil && startedAt > current.startedAt)
    }
}

extension ChatStore {
    /// The one Main item, if the bus has created Main.
    var main: CachedSession? { sessions.first { $0.isMain } }

    /// Inserts or updates a session without saving. A Main row the cache doesn't know updates the Main
    /// item in place: it becomes the current row when active (a rotation), or a former row when it's an
    /// ended row an older bus listed. Main fragments cached before E69 fold into the one item.
    func merge(_ value: BusSession) {
        let all = sessions
        guard value.isMain else {
            if let row = all.first(where: { $0.id == value.id }) { row.update(value) }
            else { context.insert(CachedSession(value)) }
            return
        }
        let mains = all.filter(\.isMain)
        let item: CachedSession
        if let exact = mains.first(where: { $0.id == value.id }) {
            exact.update(value)
            if let ended = value.endedAt { exact.record(SessionBoundary(sessionID: value.id, endedAt: ended, reason: nil)) }
            item = exact
        } else if let current = mains.max(by: Self.currentMainOrder) {
            if value.supersedes(current) {
                current.rekey(to: value)
            } else {
                current.addFormer(value.id)
                if let ended = value.endedAt { current.record(SessionBoundary(sessionID: value.id, endedAt: ended, reason: nil)) }
            }
            item = current
        } else {
            item = CachedSession(value)
            context.insert(item)
        }
        fold(mains.filter { $0 !== item }, into: item)
    }

    /// Folds every cached Main item into one. A build before E69 cached one Main item per row (the older
    /// ones under Earlier) and may already have consumed the events that would fold them, so this runs at
    /// launch and on every welcome, not only when a Main event arrives.
    func foldMain() {
        let mains = sessions.filter(\.isMain)
        guard mains.count > 1, let item = mains.max(by: Self.currentMainOrder) else { return }
        fold(mains.filter { $0 !== item }, into: item)
        try? context.save()
    }

    /// Main's current row is the active one, then the most recently active.
    private static func currentMainOrder(_ a: CachedSession, _ b: CachedSession) -> Bool {
        let rank = { (row: CachedSession) in row.endedAt == nil ? 1 : 0 }
        return (rank(a), a.lastActivity) < (rank(b), b.lastActivity)
    }

    private func fold(_ others: [CachedSession], into item: CachedSession) {
        for other in others {
            for id in other.rowIDs { item.addFormer(id) }
            for boundary in other.boundaries { item.record(boundary) }
            if let ended = other.endedAt { item.record(SessionBoundary(sessionID: other.id, endedAt: ended, reason: nil)) }
            item.readSeq = max(item.readSeq, other.readSeq)
            item.conversationID = item.conversationID ?? other.conversationID
            // The folded rows' history isn't paged in yet; the bus pages Main across every row.
            item.historyComplete = false
            context.delete(other)
        }
    }

    /// Teaches Main a row from a message in its conversation, so that row's cached messages (stored
    /// before E69 without a conversation ID) join Main's transcript.
    func learnMainRow(from message: BusMessage) {
        guard let conversation = message.conversationID, let main, main.conversationID == conversation else { return }
        main.addFormer(message.sessionID)
    }

    /// Records where one of Main's rows ended (a rotation event or a history page).
    func record(_ boundary: SessionBoundary) {
        guard let main else { return }
        main.addFormer(boundary.sessionID)
        main.record(boundary)
    }

    /// The item a message belongs to: Main for any of Main's rows, by conversation or by known row ID.
    func item(for message: BusMessage) -> CachedSession? {
        if let conversation = message.conversationID, let main, main.conversationID == conversation { return main }
        return session(message.sessionID)
    }

    /// The current item ID for a row ID from the wire (activity frames, acks, notifications).
    func canonicalID(_ sessionID: String, conversation: String? = nil) -> String {
        if let conversation, let main, main.conversationID == conversation { return main.id }
        return session(sessionID)?.id ?? sessionID
    }

    /// Every cached message a session's transcript shows, oldest first.
    func transcript(_ id: String) -> [CachedMessage] {
        let row = session(id)
        let descriptor = FetchDescriptor<CachedMessage>(predicate: CachedMessage.transcript(of: row, origin: nil),
                                                        sortBy: [SortDescriptor(\.createdAt)])
        return row == nil ? messages(id) : (try? context.fetch(descriptor)) ?? []
    }
}

extension CachedMessage {
    /// Which messages a session's transcript shows: its own row and the Earlier session it was resumed
    /// from, or for Main every row of Main's conversation.
    static func transcript(of session: CachedSession?, origin: String?) -> Predicate<CachedMessage> {
        guard let session, session.isMain else {
            let id = session?.id ?? "__no_session__"
            let originKey = origin ?? "__no_origin__"
            return #Predicate<CachedMessage> { $0.sessionID == id || $0.sessionID == originKey }
        }
        let ids = session.rowIDs
        // A placeholder, so a bus that sends no conversation IDs doesn't match every unrouted message.
        let conversation: String? = session.conversationID ?? "__no_conversation__"
        return #Predicate<CachedMessage> { ids.contains($0.sessionID) || $0.conversationID == conversation }
    }
}

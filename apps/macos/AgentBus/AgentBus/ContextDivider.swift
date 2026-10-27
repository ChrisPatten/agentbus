import SwiftUI

/// A "New context" marker in Main's transcript, where one Claude session ended and the next began (E69).
/// Main's scrollback runs across every row; the divider says the agent no longer has what's above it in context.
struct ContextDivider: Identifiable, Equatable {
    /// "context-" plus the ID of the first message in the new context.
    let id: String
    /// "New context · after 12 h idle", "New context · /clear", "New context".
    let label: String
    /// When the earlier Claude session ended, if the bus said.
    let endedAt: Date?

    /// The parts of a message that placement needs, so placement stays a pure function.
    struct Entry: Equatable {
        let id: String
        let sessionID: String
        let date: Date?
        /// Operator messages (and scheduled prompts) count as activity; proactive agent sends don't.
        let inbound: Bool
    }

    /// One divider before every message whose row differs from the previous message's, keyed by that
    /// message's ID and labeled from the earlier row's boundary. `entries` are in transcript order.
    static func place(_ entries: [Entry], boundaries: [SessionBoundary]) -> [String: ContextDivider] {
        var result: [String: ContextDivider] = [:]
        var lastActivity: Date?
        for (index, entry) in entries.enumerated() {
            if index > 0 {
                let previous = entries[index - 1]
                if previous.sessionID != entry.sessionID {
                    let boundary = boundaries.first { $0.sessionID == previous.sessionID }
                    let ended = BusDate.parse(boundary?.endedAt)
                    let idle = idleSpan(from: lastActivity ?? previous.date, endedAt: ended, next: entry.date)
                    result[entry.id] = ContextDivider(id: "context-" + entry.id, label: label(reason: boundary?.reason, idle: idle),
                                                      endedAt: ended)
                    lastActivity = nil
                }
            }
            if entry.inbound { lastActivity = entry.date }
        }
        return result
    }

    /// How long the earlier session sat idle: from its last activity to its end, else to the next message.
    static func idleSpan(from activity: Date?, endedAt: Date?, next: Date?) -> TimeInterval? {
        guard let activity, let end = endedAt ?? next else { return nil }
        let seconds = end.timeIntervalSince(activity)
        return seconds > 0 ? seconds : nil
    }

    static func label(reason: String?, idle: TimeInterval?) -> String {
        switch reason {
        case "clear": "New context · /clear"
        case "idle": idle.map { "New context · after \(span($0)) idle" } ?? "New context · after inactivity"
        default: "New context"
        }
    }

    /// "45 min", "12 h", "3 d"
    static func span(_ seconds: TimeInterval) -> String {
        if seconds < 3600 { return "\(max(Int(seconds / 60), 1)) min" }
        if seconds < 48 * 3600 { return "\(Int((seconds / 3600).rounded())) h" }
        return "\(Int((seconds / 86_400).rounded())) d"
    }

    /// Inserts dividers ahead of the items they precede. A divider goes above the day label that opens
    /// the new context, so the label stays with its messages.
    static func insert(_ dividers: [String: ContextDivider], into items: [TranscriptItem]) -> [TranscriptItem] {
        guard !dividers.isEmpty else { return items }
        var result: [TranscriptItem] = []
        for item in items {
            if let divider = dividers[item.id] {
                if case .day = result.last { result.insert(.divider(divider), at: result.count - 1) }
                else { result.append(.divider(divider)) }
            }
            result.append(item)
        }
        return result
    }

    /// Main's transcript with its dividers; every other session's unchanged.
    @MainActor static func apply(_ items: [TranscriptItem], messages: [CachedMessage], session: CachedSession?) -> [TranscriptItem] {
        guard let session, session.isMain else { return items }
        let entries = messages.map { Entry(id: $0.id, sessionID: $0.sessionID, date: $0.date, inbound: $0.isOperator) }
        return insert(place(entries, boundaries: session.boundaries), into: items)
    }
}

/// A hairline with the divider's label centered on it.
struct ContextDividerView: View {
    let divider: ContextDivider

    var body: some View {
        HStack(spacing: 10) {
            rule
            Text(divider.label).font(.caption2).foregroundStyle(.secondary).lineLimit(1).fixedSize()
            rule
        }
        .frame(maxWidth: .infinity)
        .help(detail)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(divider.label + ". " + detail)
    }

    private var rule: some View { Rectangle().fill(.separator).frame(maxWidth: 140, maxHeight: 1) }

    /// "The agent started a new Claude session. The previous one ended Oct 27, 4:20 AM."
    private var detail: String {
        let ended = divider.endedAt.map { " The previous one ended \(BusDate.stamp($0))." } ?? ""
        return "The agent started a new Claude session." + ended
    }
}

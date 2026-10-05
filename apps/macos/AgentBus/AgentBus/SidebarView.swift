import SwiftUI
import SwiftData

/// Sidebar grouping rules (FR-54): one active Main, active Conversations by activity, then Earlier.
struct SessionGroups {
    let main: CachedSession?
    let conversations: [CachedSession]
    let earlier: [CachedSession]

    init(_ sessions: [CachedSession]) {
        let newest: (CachedSession, CachedSession) -> Bool = { $0.lastActivity > $1.lastActivity }
        main = sessions.filter { $0.isMain && $0.endedAt == nil }.sorted(by: newest).first
        conversations = sessions.filter { !$0.isMain && $0.endedAt == nil }.sorted(by: newest)
        earlier = sessions.filter { $0.endedAt != nil }.sorted(by: newest)
    }

    /// Selection order for Next/Previous Session.
    func ordered(includeEarlier: Bool) -> [String] {
        [main?.id ?? BusTarget.mainSentinel] + conversations.map(\.id) + (includeEarlier ? earlier.map(\.id) : [])
    }
}

extension BusTarget {
    /// Sidebar tag for Main before its bus session exists.
    static let mainSentinel = "main"
}

struct SessionSidebar: View {
    let connection: BusConnection
    let groups: SessionGroups
    @Binding var selection: String?
    @Binding var showEarlier: Bool
    let newConversation: () -> Void
    @Environment(\.openWindow) private var openWindow
    @State private var renameTarget: CachedSession?
    @State private var renameText = ""
    @State private var clearTarget: CachedSession?

    var body: some View {
        TimelineView(.everyMinute) { context in
            List(selection: $selection) {
                Section("Main") {
                    if let main = groups.main {
                        SessionRow(session: main, activity: connection.activityState(main.id), now: context.date)
                    } else {
                        Label("Main", systemImage: "bubble.left").tag(BusTarget.mainSentinel)
                    }
                }
                Section("Conversations") {
                    if groups.conversations.isEmpty {
                        Text("No conversations").font(.caption).foregroundStyle(.secondary).selectionDisabled()
                    }
                    ForEach(groups.conversations) { session in
                        SessionRow(session: session, activity: connection.activityState(session.id), now: context.date)
                    }
                }
                Section("Earlier", isExpanded: $showEarlier) {
                    if groups.earlier.isEmpty {
                        Text("No earlier sessions").font(.caption).foregroundStyle(.secondary).selectionDisabled()
                    }
                    ForEach(groups.earlier) { session in
                        SessionRow(session: session, activity: "idle", now: context.date)
                    }
                }
            }
            .listStyle(.sidebar)
            .contextMenu(forSelectionType: String.self) { ids in
                if let id = ids.first, let session = session(id) { menu(session) }
            } primaryAction: { ids in
                // Double-click opens the session in its own window.
                if let id = ids.first, id != BusTarget.mainSentinel { openWindow(value: id) }
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) { StatusFooter(connection: connection) }
        .toolbar {
            ToolbarItem {
                Button(action: newConversation) { Label("New Conversation", systemImage: "square.and.pencil") }
                    .help(connection.state == .connected ? "New Conversation (⌘N)" : "Connect to the bus to start a conversation")
                    .disabled(connection.state != .connected)
            }
        }
        .alert("Rename Conversation", isPresented: Binding(get: { renameTarget != nil }, set: { if !$0 { renameTarget = nil } })) {
            TextField("Title", text: $renameText)
            Button("Rename") {
                guard let id = renameTarget?.id else { return }
                let title = renameText
                Task { try? await connection.renameSession(id, title: title) }
            }
            Button("Cancel", role: .cancel) {}
        }
        .confirmationDialog("Clear \(clearTarget?.title ?? "Session")?",
                            isPresented: Binding(get: { clearTarget != nil }, set: { if !$0 { clearTarget = nil } })) {
            Button("Clear Session", role: .destructive) {
                guard let session = clearTarget else { return }
                Task { try? await connection.send("/clear", target: session.isMain ? .main : .session(session.id)) }
            }
        } message: {
            Text("The agent starts a fresh Claude session. This conversation moves to Earlier.")
        }
    }

    private func session(_ id: String) -> CachedSession? {
        ([groups.main].compactMap { $0 } + groups.conversations + groups.earlier).first { $0.id == id }
    }

    @ViewBuilder private func menu(_ session: CachedSession) -> some View {
        if session.isAppTopic && !session.isEarlier {
            Button("Rename…") { renameText = session.title; renameTarget = session }
        }
        Button("Open in New Window") { openWindow(value: session.id) }
        if !session.isEarlier {
            if connection.activityState(session.id) != "idle" {
                Button("Stop") { Task { try? await connection.send("/stop", target: session.isMain ? .main : .session(session.id)) } }
            }
            Divider()
            Button("Clear Session…") { clearTarget = session }
        }
    }
}

struct SessionRow: View {
    let session: CachedSession
    let activity: String
    let now: Date

    private enum Trailing { case working, queued, unread(Int), locked, none }
    /// At most one trailing indicator: working > queued > unread > lock.
    private var trailing: Trailing {
        if activity == "running" { return .working }
        if activity == "queued" { return .queued }
        if session.unreadCount > 0 { return .unread(session.unreadCount) }
        if session.isEarlier && !session.resumable { return .locked }
        return .none
    }

    var body: some View {
        HStack(spacing: 6) {
            Label {
                VStack(alignment: .leading, spacing: 1) {
                    Text(session.title).lineLimit(1).truncationMode(.tail)
                    Text(subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
            } icon: {
                Image(systemName: Channel.symbol(session.channel))
            }
            Spacer(minLength: 0)
            indicator
        }
        .badge(badge)
        .tag(session.id)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityText)
    }

    private var badge: Int {
        if case .unread(let count) = trailing { return count }
        return 0
    }

    @ViewBuilder private var indicator: some View {
        switch trailing {
        case .working: ProgressView().controlSize(.small)
        case .queued: Image(systemName: "clock").foregroundStyle(.secondary)
        case .locked: Image(systemName: "lock").foregroundStyle(.secondary).imageScale(.small)
        case .unread, .none: EmptyView()
        }
    }

    /// "Telegram · 9 min ago", "2 min ago", "Queued · 5 min ago", "Sep 21 · read only".
    var subtitle: String {
        if session.isEarlier {
            let date = (session.ended ?? session.lastActive).map(BusDate.short) ?? "Earlier"
            return session.resumable ? date : date + " · read only"
        }
        var parts: [String] = []
        if activity == "queued" { parts.append("Queued") }
        if session.isForeign { parts.append(Channel.name(session.channel)) }
        parts.append(session.lastActive.map { BusDate.relative($0, now: now) } ?? "")
        return parts.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    private var accessibilityText: String {
        var parts = [session.title, Channel.name(session.channel)]
        switch trailing {
        case .working: parts.append("working")
        case .queued: parts.append("queued")
        case .unread(let count): parts.append("\(count) unread")
        case .locked: parts.append("read only")
        case .none: break
        }
        return parts.joined(separator: ", ")
    }
}

/// "Connected · 4 of 5 slots busy" or "Offline · reconnecting".
struct StatusFooter: View {
    let connection: BusConnection

    var body: some View {
        HStack(spacing: 6) {
            Circle().fill(color).frame(width: 7, height: 7)
            Text(text).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16).padding(.vertical, 10)
        .accessibilityElement(children: .combine)
    }

    private var color: Color {
        switch connection.state {
        case .connected: .green
        case .connecting: .orange
        case .offline: .red
        }
    }

    private var text: String {
        switch connection.state {
        case .connected:
            guard let capacity = connection.capacity, capacity.limit > 0 else { return "Connected" }
            return "Connected · \(capacity.busy) of \(capacity.limit) slots busy"
        case .connecting: return "Connecting…"
        case .offline: return connection.settings.configured ? "Offline · reconnecting" : "Offline · setup needed"
        }
    }
}

import SwiftUI
import SwiftData
import UniformTypeIdentifiers

/// Actions on the focused session, for the File and Session menus.
struct SessionActions {
    var canWrite: Bool
    var canStop: Bool
    var canRename: Bool
    var canClear: Bool
    var inspectorShown: Bool
    var stop: () -> Void
    var clear: () -> Void
    var rename: () -> Void
    var attach: () -> Void
    var openInNewWindow: () -> Void
    var toggleInspector: () -> Void
}

/// Actions on the main window's sidebar.
struct SidebarActions {
    var canCreate: Bool
    var newConversation: () -> Void
    var next: () -> Void
    var previous: () -> Void
}

extension FocusedValues {
    @Entry var sessionActions: SessionActions?
    @Entry var sidebarActions: SidebarActions?
}

struct SessionDetail: View {
    let connection: BusConnection
    /// nil shows Main before the bus has created its session.
    let session: CachedSession?
    @Binding var showInspector: Bool
    let newConversation: () -> Void
    @Environment(\.openWindow) private var openWindow
    @State private var composer = ComposerModel()
    @State private var importing = false
    @State private var dropTargeted = false
    @State private var confirmClear = false
    @State private var renaming = false
    @State private var renameText = ""

    private var title: String { session?.title ?? "Main" }
    /// Active Main goes to `main`; everything else, including a resumable Earlier Main, by ID.
    private var target: BusTarget {
        guard let session, !(session.isMain && !session.isEarlier) else { return .main }
        return .session(session.id)
    }
    private var activity: String { session.map { connection.activityState($0.id) } ?? "idle" }
    private var writable: Bool { session?.isWritable ?? true }
    private var canClear: Bool { session?.isEarlier != true }

    var body: some View {
        TranscriptView(connection: connection, session: session) {
            Group {
                if writable {
                    ComposerView(connection: connection, session: session, target: target, model: composer, importing: $importing)
                } else {
                    ReadOnlyBar(newConversation: newConversation)
                }
            }
            .frame(maxWidth: 760)
            .padding(.horizontal, 20).padding(.bottom, 18)
            .frame(maxWidth: .infinity)
        }
        .overlay {
            if dropTargeted && writable {
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .strokeBorder(Color.accentColor, lineWidth: 2)
                    .background(Color.accentColor.opacity(0.06), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .padding(8)
                    .allowsHitTesting(false)
            }
        }
        .dropDestination(for: URL.self) { urls, _ in
            guard writable else { return false }
            urls.filter(\.isFileURL).forEach { composer.add($0, connection: connection) }
            return !urls.isEmpty
        } isTargeted: { dropTargeted = $0 }
        .onPasteCommand(of: [.fileURL]) { providers in
            guard writable else { return }
            for provider in providers {
                _ = provider.loadObject(ofClass: NSURL.self) { item, _ in
                    guard let url = (item as? NSURL) as URL? else { return }
                    Task { @MainActor in composer.add(url, connection: connection) }
                }
            }
        }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            switch result {
            case .success(let urls): urls.forEach { composer.add($0, connection: connection) }
            case .failure(let issue): composer.error = issue.localizedDescription
            }
        }
        // The detail's minimum, plus the sidebar's and inspector's, sets the window's minimum width.
        .frame(minWidth: 440, minHeight: 360)
        .navigationTitle(title)
        .navigationSubtitle(subtitle)
        .toolbar { toolbar }
        .inspector(isPresented: $showInspector) {
            SessionInspector(connection: connection, session: session, clear: { confirmClear = true }, cost: { command("/cost") })
        }
        .confirmationDialog("Clear \(title)?", isPresented: $confirmClear) {
            Button("Clear Session", role: .destructive) { command("/clear") }
        } message: {
            Text("The agent starts a fresh Claude session. This conversation moves to Earlier.")
        }
        .alert("Rename Conversation", isPresented: $renaming) {
            TextField("Title", text: $renameText)
            Button("Rename") {
                guard let id = session?.id else { return }
                let value = renameText
                Task { try? await connection.renameSession(id, title: value) }
            }
            Button("Cancel", role: .cancel) {}
        }
        .focusedSceneValue(\.sessionActions, actions)
    }

    private var actions: SessionActions {
        SessionActions(
            canWrite: writable,
            canStop: activity != "idle" && session != nil,
            canRename: session?.isAppTopic == true && session?.isEarlier == false,
            canClear: canClear,
            inspectorShown: showInspector,
            stop: { command("/stop") },
            clear: { confirmClear = true },
            rename: { renameText = title; renaming = true },
            attach: { if writable { importing = true } },
            openInNewWindow: { if let id = session?.id { openWindow(value: id) } },
            toggleInspector: { showInspector.toggle() })
    }

    private func command(_ text: String) {
        let target = target
        Task { try? await connection.send(text, target: target) }
    }

    /// "Started Sep 28 · 142 messages", "Telegram · continuing from Mac", "Sep 21 · 38 messages · read only".
    private var subtitle: String {
        guard let session else { return "" }
        let count = session.messageCount > 0 ? "\(session.messageCount) message\(session.messageCount == 1 ? "" : "s")" : nil
        if session.isEarlier {
            var parts = [(session.ended ?? session.lastActive).map(BusDate.short) ?? "Earlier"]
            if let count { parts.append(count) }
            if !session.resumable { parts.append("read only") }
            return parts.joined(separator: " · ")
        }
        if session.isForeign {
            let continuing = session.lastInboundArrival == "app"
            return Channel.name(session.channel) + " · " + (continuing ? "continuing from Mac" : session.started.map { "Started " + BusDate.short($0) } ?? "")
        }
        return ([session.started.map { "Started " + BusDate.short($0) }, count].compactMap { $0 }).joined(separator: " · ")
    }

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        if connection.state != .connected {
            ToolbarItem(placement: .primaryAction) { OfflinePill(connection: connection) }
            ToolbarSpacer(.fixed, placement: .primaryAction)
        }
        ToolbarItemGroup(placement: .primaryAction) {
            Button { command("/stop") } label: {
                Label("Stop", systemImage: "stop.fill")
            }
            .foregroundStyle(actions.canStop ? Color.red : Color.secondary)
            .disabled(!actions.canStop)
            .help("Stop")

            Button { showInspector.toggle() } label: {
                Label(showInspector ? "Hide Inspector" : "Show Inspector", systemImage: "sidebar.right")
            }
            .help(showInspector ? "Hide Inspector" : "Show Inspector")

            Menu {
                Button("Open in New Window") { actions.openInNewWindow() }.disabled(session == nil)
                if actions.canRename { Button("Rename…") { actions.rename() } }
                Divider()
                Button("Cost") { command("/cost") }.disabled(!canClear)
                Button("Clear Session…") { confirmClear = true }.disabled(!canClear)
            } label: {
                Label("More", systemImage: "ellipsis.circle")
            }
            .help("More")
        }
    }
}

/// "Offline · retrying in 8s", shown only while the socket is down.
struct OfflinePill: View {
    let connection: BusConnection

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            Label(text(context.date), systemImage: "wifi.slash")
                .labelStyle(.titleAndIcon)
                .font(.callout)
                .foregroundStyle(.red)
                .padding(.horizontal, 10).padding(.vertical, 4)
                .background(Color.red.opacity(0.12), in: Capsule())
        }
        .help(connection.error ?? "Not connected to the bus")
    }

    private func text(_ now: Date) -> String {
        if connection.state == .connecting { return "Offline · connecting…" }
        guard let retry = connection.nextRetry else { return "Offline" }
        let seconds = Int(retry.timeIntervalSince(now).rounded(.up))
        return seconds > 0 ? "Offline · retrying in \(seconds)s" : "Offline · retrying…"
    }
}

extension CachedSession {
    /// Whether the newest operator message in this session arrived from the Mac.
    @MainActor var lastInboundArrival: String? {
        let id = self.id
        var descriptor = FetchDescriptor<CachedMessage>(predicate: #Predicate { $0.sessionID == id && $0.direction == "inbound" },
                                                        sortBy: [SortDescriptor(\.createdAt, order: .reverse)])
        descriptor.fetchLimit = 1
        return (try? modelContext?.fetch(descriptor))?.first?.arrivalChannel
    }
}

import SwiftUI
import SwiftData
import UserNotifications
import os

private let alertLog = Logger(subsystem: "com.chrispatten.agentbus.mac", category: "alerts")

@MainActor final class AlertController: NSObject, UNUserNotificationCenterDelegate {
    var openSession: ((String) -> Void)?
    var hidePreviews = false
    private var pendingReplay: [String: (title: String, count: Int)] = [:]
    private var flushTask: Task<Void, Never>?

    func install() { UNUserNotificationCenter.current().delegate = self }
    /// One alert per live message; replayed messages collapse into one alert per session.
    func received(_ message: BusMessage, title: String, replay: Bool) {
        guard message.direction == "outbound" else { return }
        if replay {
            pendingReplay[message.sessionID, default: (title, 0)].count += 1
            flushTask?.cancel()
            flushTask = Task { [weak self] in
                try? await Task.sleep(for: .seconds(1))
                guard !Task.isCancelled else { return }
                self?.flushReplay()
            }
        } else {
            post(id: message.sessionID, title: title, body: hidePreviews ? "New message" : String(message.body.prefix(400)))
        }
    }
    private func flushReplay() {
        for (id, entry) in pendingReplay {
            let body = entry.count == 1 ? "1 new message while you were away" : "\(entry.count) new messages while you were away"
            post(id: id, title: entry.title, body: body)
        }
        pendingReplay.removeAll()
    }
    private func post(id: String, title: String, body: String) {
        let content = UNMutableNotificationContent()
        content.title = title; content.body = body; content.threadIdentifier = id
        content.userInfo = ["session_id": id]
        let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        Task {
            // Permission is asked in context: the first time there is something to show.
            let center = UNUserNotificationCenter.current()
            if await center.notificationSettings().authorizationStatus == .notDetermined {
                do { _ = try await center.requestAuthorization(options: [.alert, .badge, .sound]) }
                catch { alertLog.error("Notification permission request failed: \(error.localizedDescription, privacy: .public)") }
            }
            let status = await center.notificationSettings().authorizationStatus
            do {
                try await center.add(request)
                alertLog.info("Posted alert for session \(id, privacy: .public); authorization \(status.rawValue)")
            } catch {
                alertLog.error("Alert for session \(id, privacy: .public) failed (authorization \(status.rawValue)): \(error.localizedDescription, privacy: .public)")
            }
        }
    }
    func updateBadge(_ sessions: [CachedSession]) {
        let total = sessions.reduce(0) { $0 + $1.unreadCount }
        NSApp.dockTile.badgeLabel = total > 0 ? String(total) : nil
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let id = response.notification.request.content.userInfo["session_id"] as? String
        await MainActor.run { if let id { NSApp.activate(); openSession?(id) } }
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }
}

/// Owns the cache, settings, connection and alerts shared by every window.
@MainActor final class AppModel {
    /// The app's one instance. `App` structs can be initialized more than once, so the model isn't stored there.
    static let shared = AppModel()
    let container: ModelContainer
    let settings: ClientSettings
    let connection: BusConnection
    let alert = AlertController()
    /// False for previews: no socket, alerts or first-run Settings.
    let live: Bool

    init(inMemory: Bool = false, api: (any BusAPI)? = nil, live: Bool = true) {
        self.live = live
        let types: [any PersistentModel.Type] = [CachedSession.self, CachedMessage.self, CachedState.self, PendingSend.self]
        container = try! ModelContainer(for: Schema(types), configurations: ModelConfiguration(isStoredInMemoryOnly: inMemory))
        settings = ClientSettings()
        connection = BusConnection(settings: settings, store: ChatStore(container.mainContext), api: api, observeSystemEvents: live)
        guard live else { return }
        alert.install()
        settings.onSave = { [connection] in connection.reconnect() }
        alert.openSession = { [connection] in connection.requestSelection($0) }
        connection.onAgentMessage = { [weak self] message, replay in self?.agentMessage(message, replay: replay) }
        connection.onUnreadChange = { [alert, connection] in alert.updateBadge(connection.store.sessions) }
        connection.start()
    }

    private func agentMessage(_ message: BusMessage, replay: Bool) {
        let session = connection.store.session(message.sessionID)
        let onScreen = connection.isViewing(message.sessionID) && NSApp.isActive
        alertLog.debug("Agent message in \(message.sessionID, privacy: .public): onScreen=\(onScreen) replay=\(replay)")
        if onScreen {
            Task { try? await connection.markRead(message.sessionID) }
            if !replay {
                AccessibilityNotification.Announcement("New message in \(session?.title ?? "AgentBus")").post()
            }
        } else {
            alert.hidePreviews = settings.hidePreviews
            alert.received(message, title: session?.title ?? "AgentBus", replay: replay)
        }
    }

    /// ⌘N: the bus creates an empty, untitled topic and the ack selects it. Named by its first message.
    func newConversation() {
        guard connection.state == .connected else { return }
        Task { try? await connection.createSession(title: "") }
    }

    /// Loads recent history, then marks the session read when it is on screen.
    func open(_ id: String) {
        guard id != BusTarget.mainSentinel else { return }
        Task {
            try? await connection.loadHistory(id)
            if NSApp.isActive { try? await connection.markRead(id) }
        }
    }
}

@main struct AgentBusApp: App {
    private let model = AppModel.shared

    var body: some Scene {
        WindowGroup("AgentBus", id: "main") {
            MainWindow(model: model)
                .frame(minHeight: 560)
        }
        .defaultSize(width: 1280, height: 800)
        .modelContainer(model.container)
        .commands { AgentBusCommands() }

        WindowGroup("Session", for: String.self) { $id in
            SessionWindow(model: model, sessionID: id ?? BusTarget.mainSentinel)
                .frame(minHeight: 480)
        }
        .defaultSize(width: 900, height: 760)
        .modelContainer(model.container)

        Settings {
            SettingsView(settings: model.settings, connection: model.connection)
        }
    }
}

struct MainWindow: View {
    let model: AppModel
    // Preview-only starting state; the scene's stored state wins otherwise.
    var initialSelection: String? = nil
    var initialInspector = false
    var initialShowEarlier = false
    @SceneStorage("selection") private var selection: String?
    @SceneStorage("showInspector") private var showInspector = false
    @SceneStorage("showEarlier") private var showEarlier = false
    @AppStorage("settingsTab") private var settingsTab = SettingsTab.general.rawValue
    @Environment(\.openSettings) private var openSettings
    @State private var windowID = UUID()
    @Query private var sessions: [CachedSession]

    private var connection: BusConnection { model.connection }

    var body: some View {
        let groups = SessionGroups(sessions)
        NavigationSplitView {
            SessionSidebar(connection: connection, groups: groups, selection: $selection,
                           showEarlier: $showEarlier, newConversation: model.newConversation)
                .navigationSplitViewColumnWidth(min: 240, ideal: 268, max: 360)
        } detail: {
            detail(groups)
        }
        .focusedSceneValue(\.sidebarActions, SidebarActions(
            canCreate: connection.state == .connected,
            newConversation: model.newConversation,
            next: { step(groups, by: 1) },
            previous: { step(groups, by: -1) }))
        .onAppear {
            if let initialSelection {
                selection = initialSelection; showInspector = initialInspector; showEarlier = initialShowEarlier
            }
            if selection == nil { selection = groups.main?.id ?? BusTarget.mainSentinel }
            connection.setViewing(windowID, session: selection)
            if let selection { model.open(selection) }
            if model.live && !model.settings.hasSavedToken {
                settingsTab = SettingsTab.connection.rawValue
                openSettings()
            }
        }
        .onDisappear { connection.setViewing(windowID, session: nil) }
        .onChange(of: selection) { _, id in
            connection.setViewing(windowID, session: id)
            if let id { model.open(id) }
        }
        .onChange(of: groups.main?.id) { _, id in
            // Main's session appears after the first connect, or after a /clear successor.
            let selected = sessions.first { $0.id == selection }
            if let id, selection == nil || selection == BusTarget.mainSentinel || (selected?.isMain == true && selected?.isEarlier == true) {
                selection = id
            }
        }
        .onChange(of: connection.selectionRequest) { _, request in
            guard let request else { return }
            if groups.earlier.contains(where: { $0.id == request.sessionID }) { showEarlier = true }
            selection = request.sessionID
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            if let selection { model.open(selection) }
        }
    }

    @ViewBuilder private func detail(_ groups: SessionGroups) -> some View {
        let current = sessions.first { $0.id == selection }
        if current != nil || selection == BusTarget.mainSentinel || selection == nil {
            SessionDetail(connection: connection, session: current ?? (selection == nil ? groups.main : nil),
                          showInspector: $showInspector, newConversation: model.newConversation)
                .id(current?.id ?? BusTarget.mainSentinel)
        } else {
            // A new topic's ack can arrive before its session event.
            ProgressView().controlSize(.small)
        }
    }

    private func step(_ groups: SessionGroups, by offset: Int) {
        let order = groups.ordered(includeEarlier: showEarlier)
        guard !order.isEmpty else { return }
        let index = order.firstIndex(of: selection ?? "") ?? 0
        selection = order[(index + offset + order.count) % order.count]
    }
}

/// A single session in its own window (double-click a row, or ⌥⌘O).
struct SessionWindow: View {
    let model: AppModel
    let sessionID: String
    @SceneStorage("showInspector") private var showInspector = false
    @State private var windowID = UUID()
    @Query private var sessions: [CachedSession]

    var body: some View {
        Group {
            if let session = sessions.first(where: { $0.id == sessionID }) {
                SessionDetail(connection: model.connection, session: session,
                              showInspector: $showInspector, newConversation: model.newConversation)
            } else {
                ContentUnavailableView("Session Not Found", systemImage: "bubble.left.and.exclamationmark.bubble.right",
                                       description: Text("It may have been removed when the cache reloaded."))
            }
        }
        .onAppear { model.connection.setViewing(windowID, session: sessionID); model.open(sessionID) }
        .onDisappear { model.connection.setViewing(windowID, session: nil) }
    }
}

struct AgentBusCommands: Commands {
    @FocusedValue(\.sessionActions) private var session
    @FocusedValue(\.sidebarActions) private var sidebar

    var body: some Commands {
        SidebarCommands()
        CommandGroup(replacing: .newItem) {
            Button("New Conversation") { sidebar?.newConversation() }
                .keyboardShortcut("n")
                .disabled(sidebar?.canCreate != true)
            Button("Open in New Window") { session?.openInNewWindow() }
                .keyboardShortcut("o", modifiers: [.command, .option])
                .disabled(session == nil)
            Divider()
            Button("Attach Files…") { session?.attach() }
                .keyboardShortcut("o")
                .disabled(session?.canWrite != true)
        }
        CommandMenu("Session") {
            Button("Stop") { session?.stop() }
                .keyboardShortcut(".")
                .disabled(session?.canStop != true)
            Button("Clear Session…") { session?.clear() }
                .keyboardShortcut("k", modifiers: [.command, .shift])
                .disabled(session?.canClear != true)
            Button("Rename…") { session?.rename() }
                .keyboardShortcut("r")
                .disabled(session?.canRename != true)
        }
        CommandGroup(after: .sidebar) {
            Button(session?.inspectorShown == true ? "Hide Inspector" : "Show Inspector") { session?.toggleInspector() }
                .keyboardShortcut("i", modifiers: [.command, .option])
                .disabled(session == nil)
        }
        CommandGroup(before: .windowList) {
            Button("Next Session") { sidebar?.next() }
                .keyboardShortcut(.tab, modifiers: .control)
                .disabled(sidebar == nil)
            Button("Previous Session") { sidebar?.previous() }
                .keyboardShortcut(.tab, modifiers: [.control, .shift])
                .disabled(sidebar == nil)
            Divider()
        }
        CommandGroup(replacing: .appTermination) {
            Button("Quit AgentBus") { NSApp.terminate(nil) }
                .keyboardShortcut("q")
        }
    }
}

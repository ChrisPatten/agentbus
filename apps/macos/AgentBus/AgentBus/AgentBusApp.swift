import SwiftUI
import SwiftData
import UserNotifications
import ServiceManagement

@MainActor final class AlertController: NSObject, UNUserNotificationCenterDelegate {
    var openSession: ((String) -> Void)?
    private var pendingReplay: [String: Int] = [:]
    private var flushTask: Task<Void, Never>?
    var hidePreviews = false

    override init() {
        super.init()
        UNUserNotificationCenter.current().delegate = self
    }
    func askPermission() async {
        _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound])
    }
    func received(_ message: BusMessage, session: CachedSession?, viewed: String?, replay: Bool) {
        guard message.direction == "outbound", viewed != message.sessionID || !NSApp.isActive else { return }
        if replay {
            pendingReplay[message.sessionID, default: 0] += 1
            flushTask?.cancel()
            flushTask = Task { [weak self] in
                try? await Task.sleep(for: .seconds(1))
                guard !Task.isCancelled else { return }
                self?.flushReplay()
            }
        } else {
            post(id: message.sessionID, title: session?.title ?? "AgentBus", body: hidePreviews ? "New message" : message.body)
        }
    }
    private func flushReplay() {
        for (id, count) in pendingReplay {
            post(id: id, title: "AgentBus", body: count == 1 ? "New message" : "\(count) new messages")
        }
        pendingReplay.removeAll()
    }
    private func post(id: String, title: String, body: String) {
        let content = UNMutableNotificationContent()
        content.title = title; content.body = body; content.threadIdentifier = id
        content.userInfo = ["session_id": id]
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
    }
    func updateBadge(_ sessions: [CachedSession]) {
        NSApp.dockTile.badgeLabel = {
            let total = sessions.reduce(0) { $0 + $1.unreadCount }
            return total > 0 ? String(total) : nil
        }()
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let id = response.notification.request.content.userInfo["session_id"] as? String
        await MainActor.run { if let id { openSession?(id); NSApp.activate(ignoringOtherApps: true) } }
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }
}

@main struct AgentBusApp: App {
    private let container: ModelContainer
    @State private var settings = ClientSettings()
    @State private var alert = AlertController()

    init() {
        container = try! ModelContainer(for: CachedSession.self, CachedMessage.self, CachedState.self, PendingSend.self)
    }
    var body: some Scene {
        WindowGroup {
            RootView(settings: settings, alert: alert, context: container.mainContext)
                .frame(minWidth: 760, minHeight: 520)
        }
        .modelContainer(container)
        Settings { SettingsView(settings: settings) }
    }
}

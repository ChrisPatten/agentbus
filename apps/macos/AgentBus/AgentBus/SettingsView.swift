import SwiftUI
import ServiceManagement
import UserNotifications
import AppKit

enum SettingsTab: String { case general, connection, notifications }

struct SettingsView: View {
    let settings: ClientSettings
    let connection: BusConnection
    @AppStorage("settingsTab") private var tab = SettingsTab.general.rawValue

    var body: some View {
        TabView(selection: $tab) {
            Tab("General", systemImage: "gearshape", value: SettingsTab.general.rawValue) {
                GeneralSettings()
            }
            Tab("Connection", systemImage: "link", value: SettingsTab.connection.rawValue) {
                ConnectionSettings(settings: settings, connection: connection)
            }
            Tab("Notifications", systemImage: "bell", value: SettingsTab.notifications.rawValue) {
                NotificationSettings(settings: settings)
            }
        }
        .frame(width: 640)
        .frame(minHeight: 360, idealHeight: 560)
    }
}

struct GeneralSettings: View {
    @State private var openAtLogin = SMAppService.mainApp.status == .enabled
    @State private var error: String?

    var body: some View {
        Form {
            Section {
                Toggle("Open at login", isOn: $openAtLogin)
                    .onChange(of: openAtLogin) { _, enabled in
                        do {
                            if enabled { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
                            error = nil
                        } catch {
                            self.error = error.localizedDescription
                            openAtLogin = SMAppService.mainApp.status == .enabled
                        }
                    }
            } footer: {
                if let error { Text(error).font(.caption).foregroundStyle(.red) }
            }
            Section {
                LabeledContent("Quit AgentBus") {
                    Button("Quit") { NSApp.terminate(nil) }
                }
            }
        }
        .formStyle(.grouped)
    }
}

struct ConnectionSettings: View {
    @Bindable var settings: ClientSettings
    let connection: BusConnection
    @Environment(\.dismissWindow) private var dismissWindow
    @Environment(\.openWindow) private var openWindow
    @State private var tested: BusHealth?
    @State private var failure: String?
    @State private var testing = false

    /// The last test result, else the live connection's health.
    private var health: BusHealth? { tested ?? (connection.state == .connected ? connection.health : nil) }

    var body: some View {
        Form {
            Section {
                TextField("Bus URL", text: $settings.baseURL, prompt: Text("http://127.0.0.1:3000"))
                SecureField("App token", text: $settings.appToken)
                SecureField("Bus token", text: $settings.busToken, prompt: Text("Optional"))
            } footer: {
                Text("Tokens are stored in your login keychain.").font(.caption).foregroundStyle(.secondary)
            }
            .onSubmit(test)

            Section {
                HStack {
                    status
                    Spacer()
                    if testing { ProgressView().controlSize(.small) }
                    Button("Test Connection", action: test).disabled(testing || !settings.configured)
                }
                LabeledContent("Agent", value: health.map { ($0.agent ?? "No agent") + ($0.routed ? "" : " · not routed") } ?? "—")
                LabeledContent("Agent slots", value: slots)
                LabeledContent("Upload limit", value: health.map { ByteSize.format($0.limits.maxUploadBytes) } ?? "—")
                LabeledContent("Bus version", value: health?.version ?? "—")
            }
        }
        .formStyle(.grouped)
        .onDisappear(perform: saveIfNeeded)
    }

    @ViewBuilder private var status: some View {
        if let failure {
            Label(failure, systemImage: "xmark.circle.fill").foregroundStyle(.red)
        } else if let health {
            Label {
                Text("Connected as \(health.contact.replacingOccurrences(of: "contact:", with: ""))")
            } icon: {
                Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
            }
        } else if !settings.configured {
            Text("Enter the app token to connect.").foregroundStyle(.secondary)
        } else {
            Text("Not connected").foregroundStyle(.secondary)
        }
    }

    private var slots: String {
        guard let capacity = health?.capacity, capacity.limit > 0 else { return "—" }
        return "\(capacity.limit) total" + (capacity.reservedSystemSlots > 0 ? ", \(capacity.reservedSystemSlots) reserved for scheduled work" : "")
    }

    /// Tests the fields as typed; a success saves them to Keychain and reconnects.
    private func test() {
        guard settings.configured else { return }
        testing = true
        let firstRun = !settings.hasSavedToken
        Task {
            defer { testing = false }
            do {
                tested = try await BusHTTP(settings: settings).health()
                failure = nil
                if settings.hasUnsavedSecrets || firstRun { try settings.saveSecrets() }
                if firstRun {
                    openWindow(id: "main")
                    dismissWindow()
                }
            } catch {
                tested = nil
                failure = error.localizedDescription
            }
        }
    }

    private func saveIfNeeded() {
        guard settings.hasUnsavedSecrets, settings.configured else { return }
        try? settings.saveSecrets()
    }
}

struct NotificationSettings: View {
    @Bindable var settings: ClientSettings
    @State private var status: UNAuthorizationStatus = .notDetermined

    var body: some View {
        Form {
            Section {
                Toggle("Show message previews", isOn: Binding(get: { !settings.hidePreviews }, set: { settings.hidePreviews = !$0 }))
            } footer: {
                Text("When off, alerts say “New message” instead of the text.").font(.caption).foregroundStyle(.secondary)
            }
            Section {
                switch status {
                case .denied:
                    LabeledContent("Notifications are turned off for AgentBus.") {
                        Button("Open System Settings…", action: openSystemSettings)
                    }
                case .notDetermined:
                    LabeledContent("AgentBus hasn't asked to send notifications.") {
                        Button("Allow Notifications…") {
                            Task {
                                _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound])
                                await refresh()
                            }
                        }
                    }
                default:
                    LabeledContent("Notifications", value: "Allowed")
                }
            }
        }
        .formStyle(.grouped)
        .task { await refresh() }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            Task { await refresh() }
        }
    }

    private func refresh() async {
        status = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
    }

    private func openSystemSettings() {
        let id = Bundle.main.bundleIdentifier ?? "com.chrispatten.agentbus.mac"
        if let url = URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=\(id)") {
            NSWorkspace.shared.open(url)
        }
    }
}

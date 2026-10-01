import SwiftUI
import SwiftData
import UniformTypeIdentifiers
import ServiceManagement
import UserNotifications

struct SettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @Bindable var settings: ClientSettings
    @State private var result = ""
    @State private var testing = false
    var body: some View {
        Form {
            TextField("Bus URL", text: $settings.baseURL)
            SecureField("App token", text: $settings.appToken)
            SecureField("Bus token (optional)", text: $settings.busToken)
            HStack {
                Button("Test Connection") {
                    testing = true
                    Task {
                        do {
                            let health = try await BusHTTP(settings: settings).health()
                            result = "\(health.contact) → \(health.agent ?? "no agent") · \(health.routed ? "routed" : "no route") · bus \(health.version)"
                        } catch { result = error.localizedDescription }
                        testing = false
                    }
                }.disabled(testing)
                Text(result).foregroundStyle(.secondary)
            }
            HStack {
                Button("Save and Open Chat") {
                    do {
                        try settings.saveSecrets()
                        dismiss()
                    } catch { result = error.localizedDescription }
                }
                .disabled(!settings.configured)
                Button("Quit AgentBus") { NSApp.terminate(nil) }
            }
            Button("Enable notifications") {
                Task { _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) }
            }
            Toggle("Hide notification previews", isOn: $settings.hidePreviews)
            Toggle("Open at login", isOn: $settings.openAtLogin)
                .onChange(of: settings.openAtLogin) { _, enabled in
                    do {
                        if enabled { try SMAppService.mainApp.register() }
                        else { try SMAppService.mainApp.unregister() }
                    } catch { result = error.localizedDescription; settings.openAtLogin = !enabled }
                }
        }
        .padding(20).frame(width: 540)
    }
}

struct RootView: View {
    @Bindable var settings: ClientSettings
    let alert: AlertController
    let context: ModelContext
    @State private var connection: BusConnection?
    @State private var selectedID: String?
    @State private var showSetup = false
    @State private var showEarlier = false
    @State private var newTitle = ""
    @State private var showNew = false
    @Query private var sessions: [CachedSession]
    private var active: [CachedSession] { sessions.filter { $0.endedAt == nil && !$0.isMain }.sorted { $0.lastActivity > $1.lastActivity } }
    private var earlier: [CachedSession] { sessions.filter { $0.endedAt != nil }.sorted { $0.lastActivity > $1.lastActivity } }
    private var main: CachedSession? { sessions.filter(\.isMain).sorted { $0.lastActivity > $1.lastActivity }.first }

    var body: some View {
        NavigationSplitView {
            List(selection: $selectedID) {
                Section("Main") { if let main { row(main) } else { Text("Main").tag("main") } }
                Section("Conversations") { ForEach(active) { row($0) } }
                DisclosureGroup("Earlier", isExpanded: $showEarlier) { ForEach(earlier) { row($0) } }
            }
            .navigationTitle("AgentBus")
            .toolbar { Button { showNew = true } label: { Image(systemName: "plus") }.keyboardShortcut("n") }
        } detail: {
            if let session = sessions.first(where: { $0.id == selectedID }) {
                TranscriptView(session: session, connection: connection, store: connection.map { $0.store })
            } else if selectedID == "main" {
                TranscriptView(session: nil, connection: connection, store: connection.map { $0.store })
            } else { ContentUnavailableView("Select a conversation", systemImage: "bubble.left.and.bubble.right") }
        }
        .toolbar {
            ToolbarItem { Label(connection?.state.rawValue.capitalized ?? "Offline", systemImage: connection?.state == .connected ? "circle.fill" : "circle.dotted").foregroundStyle(connection?.state == .connected ? Color.green : Color.secondary) }
            ToolbarItem { Button("Settings") { showSetup = true } }
        }
        .sheet(isPresented: $showSetup) { SettingsView(settings: settings) }
        .alert("New conversation", isPresented: $showNew) {
            TextField("Title", text: $newTitle)
            Button("Create") { Task { try? await connection?.createSession(title: newTitle); newTitle = "" } }
            Button("Cancel", role: .cancel) {}
        } message: { Text("Give this conversation a title. You can rename it later.") }
        .task {
            if connection == nil {
                let value = BusConnection(settings: settings, store: ChatStore(context))
                value.onOpenSession = { selectedID = $0 }
                value.onAgentMessage = { message, replay in
                    alert.hidePreviews = settings.hidePreviews
                    alert.received(message, session: value.store.session(message.sessionID), viewed: selectedID, replay: replay)
                    if selectedID == message.sessionID && NSApp.isActive {
                        Task { try? await value.markRead(message.sessionID) }
                    }
                    alert.updateBadge(value.store.sessions)
                }
                alert.openSession = { selectedID = $0 }
                connection = value
                showSetup = !settings.configured
                if settings.configured { value.start() }
            }
        }
        .onChange(of: settings.connectionRevision) { _, _ in
            showSetup = false
            if selectedID == nil { selectedID = main?.id ?? "main" }
            connection?.reconnect()
        }
        .onChange(of: sessions.count) { _, _ in
            if selectedID == nil, let main { selectedID = main.id }
        }
        .onChange(of: sessions.reduce(0) { $0 + $1.unreadCount }) { _, _ in
            alert.updateBadge(sessions)
        }
        .onChange(of: selectedID) { _, id in
            connection?.selectedSessionID = id
            guard let id, id != "main" else { return }
            Task { try? await connection?.loadHistory(id); try? await connection?.markRead(id); alert.updateBadge(connection?.store.sessions ?? []) }
        }
    }
    private func row(_ session: CachedSession) -> some View {
        HStack {
            Text(session.channel.capitalized).font(.caption2).padding(3).background(.quaternary, in: RoundedRectangle(cornerRadius: 4))
            Text(session.title).lineLimit(1)
            Spacer()
            if session.activity != "idle" { Text(session.activity.capitalized).font(.caption2).foregroundStyle(.orange) }
            if session.unreadCount > 0 { Text("\(session.unreadCount)").font(.caption2).bold() }
        }
        .tag(session.id)
        .help(session.lastActivity)
        .contextMenu {
            if session.channel == "app" && !session.isMain && session.endedAt == nil {
                Button("Rename…") { rename(session) }
            }
        }
    }
    private func rename(_ session: CachedSession) {
        let panel = NSAlert()
        panel.messageText = "Rename conversation"
        let field = NSTextField(string: session.title)
        field.frame = NSRect(x: 0, y: 0, width: 260, height: 24)
        panel.accessoryView = field
        panel.addButton(withTitle: "Rename"); panel.addButton(withTitle: "Cancel")
        if panel.runModal() == .alertFirstButtonReturn { Task { try? await connection?.renameSession(session.id, title: field.stringValue) } }
    }
}

struct TranscriptView: View {
    let session: CachedSession?
    let connection: BusConnection?
    let store: ChatStore?
    @State private var draft = ""
    @State private var files: [UploadedFile] = []
    @State private var error: String?
    @State private var showingImporter = false
    @State private var commands: [String] = []
    @Query private var allMessages: [CachedMessage]
    @Query private var allPending: [PendingSend]
    init(session: CachedSession?, connection: BusConnection?, store: ChatStore?) {
        self.session = session; self.connection = connection; self.store = store
        let id = session?.id ?? "__no_session__"
        _allMessages = Query(filter: #Predicate<CachedMessage> { $0.sessionID == id }, sort: \.createdAt)
    }
    private var messages: [CachedMessage] { allMessages }
    private var pending: [PendingSend] { allPending.filter { $0.targetID == session?.id || (session == nil && $0.targetKind == "main") } }
    private var target: BusTarget { session.map { .session($0.id) } ?? .main }
    private var writable: Bool { session?.endedAt == nil || session?.resumable == true || session == nil }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(session?.title ?? "Main").font(.title2).bold()
                Spacer()
                if let id = session?.id, let activity = connection?.activity[id], activity != "idle" {
                    Text(activity.capitalized).foregroundStyle(.orange)
                    Button("Stop") { Task { try? await connection?.send("/stop", target: target) } }
                }
            }.padding()
            if let connection, connection.state != .connected {
                HStack {
                    Text(connection.error.map { "Connection: \($0)" } ?? "Connecting to bus…")
                        .foregroundStyle(connection.error == nil ? Color.secondary : Color.red)
                    Spacer()
                    Button("Reconnect") { connection.reconnect() }
                }.font(.caption).padding(.horizontal).padding(.bottom, 8)
            }
            Divider()
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    if let session, !(session.historyComplete) {
                        Button("Load older messages") { Task { try? await connection?.loadHistory(session.id, older: true) } }
                    }
                    ForEach(messages) { message in MessageRow(message: message, sessionChannel: session?.channel ?? "app") }
                    ForEach(pending, id: \.id) { item in
                        HStack {
                            Text(item.body).foregroundStyle(.secondary)
                            Text(item.failure.map { "Failed: \($0)" } ?? (connection?.state == .connected ? "Sending…" : "Waiting for connection…"))
                                .font(.caption)
                            if item.failure != nil { Button("Retry") { Task { try? await connection?.retry(item.id) } } }
                        }.frame(maxWidth: .infinity, alignment: .trailing)
                    }
                    if let id = session?.id, let tools = connection?.toolTrail[id], !tools.isEmpty {
                        DisclosureGroup("Tools") { ForEach(Array(tools.enumerated()), id: \.offset) { entry in Text(entry.element).font(.caption) } }
                    }
                }.padding()
            }
            Divider()
            if !writable { Text("This Earlier session can no longer be resumed.").foregroundStyle(.secondary).padding() }
            else {
                VStack(alignment: .leading) {
                    if draft.hasPrefix("/") && !commands.isEmpty {
                        ScrollView(.horizontal) { HStack { ForEach(commands.filter { $0.hasPrefix(draft) }, id: \.self) { command in
                            Button(command) { draft = command + " " }
                        } } }
                    }
                    if !files.isEmpty { HStack { ForEach(files, id: \.id) { file in Text(file.originalFilename).font(.caption).padding(5).background(.quaternary) } } }
                    HStack(alignment: .bottom) {
                        TextEditor(text: $draft).frame(minHeight: 48, maxHeight: 110)
                            .onKeyPress { press in
                                guard press.key == .return else { return .ignored }
                                if press.modifiers.contains(.shift) { return .ignored }
                                send(); return .handled
                            }
                        Button { showingImporter = true } label: { Image(systemName: "paperclip") }.keyboardShortcut("o")
                        Button("Send") { send() }.disabled(draft.isEmpty && files.isEmpty)
                    }
                    if let error { Text(error).font(.caption).foregroundStyle(.red) }
                }.padding()
                .onDrop(of: [.fileURL], isTargeted: nil) { providers in
                    for provider in providers {
                        _ = provider.loadObject(ofClass: NSURL.self) { item, _ in
                            if let url = item as? NSURL { Task { @MainActor in await addFile(url as URL) } }
                        }
                    }
                    return !providers.isEmpty
                }
                .onPasteCommand(of: [.fileURL]) { providers in
                    for provider in providers {
                        _ = provider.loadObject(ofClass: NSURL.self) { item, _ in
                            if let url = item as? NSURL { Task { @MainActor in await addFile(url as URL) } }
                        }
                    }
                }
                .fileImporter(isPresented: $showingImporter, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
                    if case .success(let urls) = result { for url in urls { Task { await addFile(url) } } }
                    else if case .failure(let issue) = result { error = issue.localizedDescription }
                }
            }
        }
        .task { await loadCommands() }
    }
    private func send() {
        let body = draft; let ids = files.map(\.id)
        draft = ""; files = []
        Task { do { try await connection?.send(body, target: target, attachments: ids) }
            catch { self.error = error.localizedDescription } }
    }
    private func addFile(_ url: URL) async {
        do { if let uploaded = try await connection?.upload(url) { files.append(uploaded) } }
        catch { self.error = error.localizedDescription }
    }
    private func loadCommands() async {
        guard let data = try? await connection?.http.commands(),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let manifests = object["commands"] as? [[String: Any]] else { return }
        commands = manifests.compactMap { $0["name"] as? String }.map { "/" + $0 }
    }
}

struct MessageRow: View {
    let message: CachedMessage
    let sessionChannel: String
    var body: some View {
        VStack(alignment: message.direction == "inbound" ? .trailing : .leading, spacing: 5) {
            HStack {
                Text(message.scheduled ? "Scheduled" : message.direction == "inbound" ? "You" : "Agent").font(.caption).bold()
                if message.arrivalChannel != sessionChannel { Text(message.direction == "inbound" ? "from Mac" : "via \(message.arrivalChannel.capitalized)").font(.caption2) }
                Text(message.createdAt).font(.caption2).foregroundStyle(.secondary)
            }
            Text(.init(message.body)).textSelection(.enabled)
                .padding(10).background(message.direction == "inbound" ? Color.accentColor.opacity(0.12) : Color.secondary.opacity(0.09), in: RoundedRectangle(cornerRadius: 9))
            if message.body.contains("```") { Button("Copy code") { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(message.body, forType: .string) }.font(.caption) }
            ForEach(Array(message.attachments.enumerated()), id: \.offset) { entry in
                let attachment = entry.element
                Text((attachment.originalFilename ?? "Attachment") + (attachment.expired == true ? " (expired)" : ""))
                    .font(.caption).foregroundStyle(.secondary)
            }
        }.frame(maxWidth: .infinity, alignment: message.direction == "inbound" ? .trailing : .leading)
    }
}

import Foundation
import Network
import Security
import SwiftData
import AppKit
import Observation

enum ClientError: LocalizedError {
    case missingToken, invalidURL, server(Int, String), disconnected, oversized(Int)
    var errorDescription: String? {
        switch self {
        case .missingToken: "Enter an app token in Settings."
        case .invalidURL: "Enter a valid HTTP or HTTPS bus URL."
        case .server(let code, let text): "Bus returned \(code): \(text)"
        case .disconnected: "Connection closed. Reconnecting…"
        case .oversized(let limit): "File exceeds the bus limit of \(limit) bytes."
        }
    }
}

enum SecretStore {
    private static let service = "com.chrispatten.agentbus.mac"
    static func read(_ account: String) -> String {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service, kSecAttrAccount as String: account,
            kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data else { return "" }
        return String(data: data, encoding: .utf8) ?? ""
    }
    static func write(_ value: String, account: String) throws {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service, kSecAttrAccount as String: account]
        SecItemDelete(query as CFDictionary)
        guard !value.isEmpty else { return }
        let attributes = query.merging([kSecValueData as String: Data(value.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]) { _, new in new }
        let status = SecItemAdd(attributes as CFDictionary, nil)
        guard status == errSecSuccess else { throw ClientError.server(Int(status), "Could not save the token to Keychain") }
    }
}

@MainActor @Observable final class ClientSettings {
    var baseURL: String {
        didSet { UserDefaults.standard.set(baseURL, forKey: "busURL") }
    }
    var appToken: String
    var busToken: String
    var hidePreviews: Bool {
        didSet { UserDefaults.standard.set(hidePreviews, forKey: "hidePreviews") }
    }
    var openAtLogin: Bool {
        didSet { UserDefaults.standard.set(openAtLogin, forKey: "openAtLogin") }
    }
    init() {
        baseURL = UserDefaults.standard.string(forKey: "busURL") ?? "http://127.0.0.1:3000"
        appToken = SecretStore.read("app")
        busToken = SecretStore.read("bus")
        hidePreviews = UserDefaults.standard.bool(forKey: "hidePreviews")
        openAtLogin = UserDefaults.standard.bool(forKey: "openAtLogin")
    }
    func saveSecrets() throws {
        try SecretStore.write(appToken, account: "app")
        try SecretStore.write(busToken, account: "bus")
    }
    var configured: Bool { !appToken.isEmpty }
    func endpoint(_ path: String, websocket: Bool = false) throws -> URL {
        guard var components = URLComponents(string: baseURL.trimmingCharacters(in: .whitespacesAndNewlines)),
              let scheme = components.scheme?.lowercased(), ["http", "https"].contains(scheme),
              components.host != nil else { throw ClientError.invalidURL }
        if websocket { components.scheme = scheme == "https" ? "wss" : "ws" }
        let prefix = components.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        components.path = (prefix.isEmpty ? "" : "/" + prefix) + path
        components.query = nil; components.fragment = nil
        guard let url = components.url else { throw ClientError.invalidURL }
        return url
    }
    func request(_ path: String, websocket: Bool = false) throws -> URLRequest {
        guard configured else { throw ClientError.missingToken }
        var request = URLRequest(url: try endpoint(path, websocket: websocket))
        request.setValue("Bearer \(appToken)", forHTTPHeaderField: "Authorization")
        if !busToken.isEmpty { request.setValue(busToken, forHTTPHeaderField: "X-Bus-Token") }
        return request
    }
}

@MainActor protocol BusAPI {
    func health() async throws -> BusHealth
    func sessions(before: String?) async throws -> SessionsPage
    func messages(_ id: String, before: String?) async throws -> MessagesPage
    func commands() async throws -> Data
    func upload(_ url: URL, maxBytes: Int) async throws -> UploadedFile
}

@MainActor final class BusHTTP: BusAPI {
    let settings: ClientSettings
    init(settings: ClientSettings) { self.settings = settings }
    func get<T: Decodable>(_ path: String) async throws -> T {
        let (data, response) = try await URLSession.shared.data(for: settings.request(path))
        try validate(response, data)
        return try JSONDecoder().decode(T.self, from: data)
    }
    func health() async throws -> BusHealth { try await get("/api/v1/app/health") }
    func sessions(before: String? = nil) async throws -> SessionsPage {
        let suffix = before.map { "?state=all&limit=100&before=\($0.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? $0)" } ?? "?state=all&limit=100"
        return try await get("/api/v1/app/sessions\(suffix)")
    }
    func messages(_ id: String, before: String? = nil) async throws -> MessagesPage {
        let suffix = before.map { "&before=\($0.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? $0)" } ?? ""
        return try await get("/api/v1/app/sessions/\(id)/messages?limit=50\(suffix)")
    }
    func commands() async throws -> Data {
        let (data, response) = try await URLSession.shared.data(for: settings.request("/api/v1/app/commands"))
        try validate(response, data); return data
    }
    func upload(_ url: URL, maxBytes: Int) async throws -> UploadedFile {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let size = (try url.resourceValues(forKeys: [.fileSizeKey])).fileSize ?? 0
        guard size <= maxBytes else { throw ClientError.oversized(maxBytes) }
        let data = try Data(contentsOf: url)
        let boundary = UUID().uuidString
        let name = url.lastPathComponent.replacingOccurrences(of: "\"", with: "_")
        let mime = url.pathExtension.lowercased() == "pdf" ? "application/pdf" : "application/octet-stream"
        var body = Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(name)\"\r\nContent-Type: \(mime)\r\n\r\n".utf8)
        body.append(data); body.append(Data("\r\n--\(boundary)--\r\n".utf8))
        var request = try settings.request("/api/v1/app/attachments")
        request.httpMethod = "POST"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        let (reply, response) = try await URLSession.shared.upload(for: request, from: body)
        try validate(response, reply)
        return try JSONDecoder().decode(UploadedFile.self, from: reply)
    }
    private func validate(_ response: URLResponse, _ data: Data) throws {
        guard let http = response as? HTTPURLResponse else { throw ClientError.disconnected }
        guard (200..<300).contains(http.statusCode) else {
            let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            throw ClientError.server(http.statusCode, object?["error"] as? String ?? HTTPURLResponse.localizedString(forStatusCode: http.statusCode))
        }
    }
}

@MainActor protocol SocketTransport: AnyObject {
    func connect(_ request: URLRequest) async throws
    func send(_ data: Data) async throws
    func receive() async throws -> Data
    func close()
}

@MainActor final class URLSessionSocket: SocketTransport {
    private var task: URLSessionWebSocketTask?
    func connect(_ request: URLRequest) async throws {
        let socket = URLSession.shared.webSocketTask(with: request)
        task = socket; socket.resume()
    }
    func send(_ data: Data) async throws {
        guard let task else { throw ClientError.disconnected }
        try await task.send(.data(data))
    }
    func receive() async throws -> Data {
        guard let task else { throw ClientError.disconnected }
        switch try await task.receive() {
        case .data(let data): return data
        case .string(let text): return Data(text.utf8)
        @unknown default: throw ClientError.disconnected
        }
    }
    func close() { task?.cancel(with: .goingAway, reason: nil); task = nil }
}

@MainActor @Observable final class BusConnection {
    enum State: String { case offline, connecting, connected }
    private(set) var state: State = .offline
    private(set) var error: String?
    private(set) var health: BusHealth?
    private(set) var activity: [String: String] = [:]
    private(set) var toolTrail: [String: [String]] = [:]
    var selectedSessionID: String?
    var onAgentMessage: ((BusMessage, Bool) -> Void)?
    var onOpenSession: ((String) -> Void)?

    let settings: ClientSettings
    let http: any BusAPI
    let store: ChatStore
    private let socket: SocketTransport
    private var runTask: Task<Void, Never>?
    private var pathMonitor: NWPathMonitor?
    private var wakeObserver: NSObjectProtocol?
    private var generation = 0
    private var maxUploadBytes = 26_214_400
    private var resetBuffer: [ServerFrame] = []
    private var resetting = false
    private var replayThrough = 0

    init(settings: ClientSettings, store: ChatStore, socket: SocketTransport = URLSessionSocket(), api: (any BusAPI)? = nil) {
        self.settings = settings; self.store = store; self.socket = socket
        self.http = api ?? BusHTTP(settings: settings)
        wakeObserver = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.reconnect() }
        }
        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { [weak self] path in
            if path.status == .satisfied { Task { @MainActor in self?.reconnect() } }
        }
        monitor.start(queue: DispatchQueue(label: "AgentBus.NetworkPath"))
        pathMonitor = monitor
    }
    func start() { guard runTask == nil, settings.configured else { return }; reconnect() }
    func reconnect() {
        guard settings.configured else { state = .offline; return }
        generation += 1; let current = generation
        runTask?.cancel(); socket.close()
        runTask = Task { [weak self] in await self?.run(current) }
    }
    func stop() { generation += 1; runTask?.cancel(); runTask = nil; socket.close(); pathMonitor?.cancel(); state = .offline }

    private func run(_ current: Int) async {
        var delay: UInt64 = 1
        while !Task.isCancelled && current == generation {
            do {
                state = .connecting
                health = try await http.health()
                maxUploadBytes = health?.limits.maxUploadBytes ?? maxUploadBytes
                try await socket.connect(settings.request("/api/v1/app/ws", websocket: true))
                try await socket.send(ProtocolCodec.encode(.hello(store.cursor)))
                state = .connecting; error = nil; delay = 1
                while !Task.isCancelled && current == generation {
                    let frame = try ProtocolCodec.frame(try await socket.receive())
                    try await handle(frame, replay: true)
                }
            } catch {
                if !Task.isCancelled { self.error = error.localizedDescription }
            }
            guard !Task.isCancelled && current == generation else { break }
            socket.close(); state = .offline
            try? await Task.sleep(for: .seconds(delay))
            delay = min(delay * 2, 30)
        }
    }
    private func sendPending(_ row: PendingSend) async throws {
        try await socket.send(ProtocolCodec.encode(.send(row.id, target: row.target, body: row.body, attachments: row.attachmentIDs)))
    }
    func send(_ body: String, target: BusTarget, attachments: [String] = []) async throws {
        guard !body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty else { return }
        let row = PendingSend(target: target, body: body, attachments: attachments)
        try store.addPending(row)
        if state == .connected { try await sendPending(row) }
    }
    func retry(_ id: String) async throws {
        try store.retry(id)
        if state == .connected, let row = store.pending.first(where: { $0.id == id }) { try await sendPending(row) }
    }
    func createSession(title: String) async throws {
        let frame = ClientFrame(type: "create_session", title: title, requestID: UUID().uuidString)
        try await socket.send(ProtocolCodec.encode(frame))
    }
    func renameSession(_ id: String, title: String) async throws {
        let frame = ClientFrame(type: "rename_session", sessionID: id, title: title, requestID: UUID().uuidString)
        try await socket.send(ProtocolCodec.encode(frame))
    }
    func markRead(_ id: String) async throws {
        let seq = store.messages(id).filter { $0.direction == "outbound" }.map(\.seq).max() ?? 0
        guard seq > 0 else { return }
        try store.setRead(id, seq: seq)
        if state == .connected {
            try await socket.send(ProtocolCodec.encode(ClientFrame(type: "mark_read", sessionID: id, seq: seq, requestID: UUID().uuidString)))
        }
    }
    func upload(_ url: URL) async throws -> UploadedFile { try await http.upload(url, maxBytes: maxUploadBytes) }
    func loadSessions() async throws {
        var before: String? = nil
        repeat {
            let page = try await http.sessions(before: before)
            for session in page.sessions { try store.upsert(session) }
            before = page.sessions.count == 100 ? page.nextBefore : nil
        } while before != nil
    }
    func loadHistory(_ id: String, older: Bool = false) async throws {
        let before = older ? store.session(id)?.oldestCursor : nil
        if older && (store.session(id)?.historyComplete ?? true) { return }
        let page = try await http.messages(id, before: before)
        try store.setHistory(id, page: page, first: !older)
    }
    private func handle(_ frame: ServerFrame, replay: Bool) async throws {
        switch frame.type {
        case "welcome":
            guard frame.version == 1 else { throw ClientError.server(0, "Unsupported protocol version") }
            replayThrough = frame.latestSeq ?? 0
            if frame.reset == true {
                resetting = true
                try await reload(cursor: frame.latestSeq ?? 0)
                resetting = false
                for buffered in resetBuffer.sorted(by: { ($0.seq ?? 0) < ($1.seq ?? 0) }) { try await handle(buffered, replay: true) }
                resetBuffer.removeAll()
            } else if store.sessions.isEmpty {
                try await loadSessions()
            }
            state = .connected
            for row in store.pending where row.failure == nil { try await sendPending(row) }
            for session in store.sessions where session.readSeq > 0 {
                try await socket.send(ProtocolCodec.encode(ClientFrame(type: "mark_read", sessionID: session.id, seq: session.readSeq, requestID: UUID().uuidString)))
            }
        case "event":
            if resetting { resetBuffer.append(frame); return }
            if frame.event == "activity" {
                if let id = frame.data?.sessionID, let value = frame.data?.state {
                    activity[id] = value
                    if let tool = frame.data?.tool { toolTrail[id, default: []].append(tool) }
                }
                return
            }
            let inserted = try store.apply(frame)
            if inserted, let message = frame.data?.message, message.direction == "outbound" {
                activity[message.sessionID] = "idle"
                onAgentMessage?(message, (frame.seq ?? 0) <= replayThrough)
            }
        case "ack":
            if let id = frame.clientMsgID {
                _ = try store.acknowledge(id, status: frame.status ?? "rejected", reason: frame.reason)
                if let session = frame.sessionID { selectedSessionID = session; onOpenSession?(session) }
            } else if frame.status == "created", let session = frame.sessionID {
                selectedSessionID = session; onOpenSession?(session)
            }
        case "error": error = frame.code ?? "Protocol error"
        default: break
        }
    }
    private func reload(cursor: Int) async throws {
        var all: [BusSession] = [], before: String? = nil
        repeat {
            let page = try await http.sessions(before: before)
            all += page.sessions
            before = page.sessions.count == 100 ? page.nextBefore : nil
        } while before != nil
        var history: [String: [BusMessage]] = [:]
        for session in all { history[session.id] = try await http.messages(session.id, before: nil).messages }
        try store.replace(sessions: all, history: history, cursor: cursor)
    }
}

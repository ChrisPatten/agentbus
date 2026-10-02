#if DEBUG
import SwiftUI
import SwiftData

/// Serves fixed health and commands to previews; history is whatever was seeded.
@MainActor final class PreviewAPI: BusAPI {
    func health() async throws -> BusHealth { PreviewFixtures.health }
    func sessions(before: String?) async throws -> SessionsPage { SessionsPage(sessions: [], nextBefore: nil) }
    func messages(_ id: String, before: String?) async throws -> MessagesPage { MessagesPage(messages: [], nextBefore: nil) }
    func commands() async throws -> Data { Data(#"{"commands":[]}"#.utf8) }
    func upload(_ url: URL, maxBytes: Int) async throws -> UploadedFile { throw ClientError.disconnected }
}

/// The data shown in the design mockups (`_bmad-output/planning-artifacts/mac-client/design/`).
@MainActor enum PreviewFixtures {
    static let mainID = "00000000-0000-4000-8000-000000000001"
    static let pipelineID = "00000000-0000-4000-8000-000000000002"
    static let snowflakeID = "00000000-0000-4000-8000-000000000003"
    static let standupID = "00000000-0000-4000-8000-000000000004"
    static let vendorID = "00000000-0000-4000-8000-000000000005"
    static let siriID = "00000000-0000-4000-8000-000000000006"
    static let earlierMainID = "00000000-0000-4000-8000-000000000007"
    static let dbtID = "00000000-0000-4000-8000-000000000008"
    static let weekendID = "00000000-0000-4000-8000-000000000009"

    static let health: BusHealth = try! JSONDecoder().decode(BusHealth.self, from: Data(#"""
    {"ok":true,"contact":"contact:chris","agent":"agent:work","routed":true,"version":"0.14.0",
     "concurrency":[{"agent_id":"agent:work","running_user":4,"running_system":0,"waiting":1,"limit":5,"reserved_system_slots":1}],
     "limits":{"max_upload_bytes":26214400}}
    """#.utf8))

    static let commands = [
        SlashCommand(name: "stop", description: "Cancel this session's turn"),
        SlashCommand(name: "status", description: "Adapter status and queue depth"),
        SlashCommand(name: "sessions", description: "List recent sessions"),
    ]

    static func iso(_ date: Date) -> String { date.formatted(.iso8601) }
    static func ago(_ seconds: TimeInterval) -> String { iso(.now.addingTimeInterval(-seconds)) }
    static func today(_ hour: Int, _ minute: Int) -> String {
        iso(Calendar.current.date(bySettingHour: hour, minute: minute, second: 0, of: .now) ?? .now)
    }
    static func daysAgo(_ days: Int, _ hour: Int, _ minute: Int) -> String {
        let day = Calendar.current.date(byAdding: .day, value: -days, to: .now) ?? .now
        return iso(Calendar.current.date(bySettingHour: hour, minute: minute, second: 0, of: day) ?? day)
    }

    /// A preview model with the mockup sessions and messages.
    static func model(connected: Bool = true, empty: Bool = false) -> AppModel {
        let model = AppModel(inMemory: true, api: PreviewAPI(), live: false)
        if !empty { seed(model.connection.store) }
        let started = Date.now.addingTimeInterval(-24)
        model.connection.preview(
            state: connected ? .connected : .offline, health: health,
            live: empty ? [:] : [
                mainID: LiveActivity(state: "queued"),
                snowflakeID: LiveActivity(state: "queued"),
                pipelineID: LiveActivity(state: "running", startedAt: started),
                standupID: LiveActivity(state: "running", lines: [
                    "📖 Read `models/staging/schema.yml`",
                    "💻 Bash `dbt test --select stg_orders`",
                    "🔍 Grep `customer_id` in `models/marts/`",
                ], startedAt: started),
            ],
            nextRetry: connected ? nil : .now.addingTimeInterval(8),
            commands: commands)
        return model
    }

    private static func session(_ id: String, _ channel: String, _ topic: String, _ title: String, started: String,
                                last: String, ended: String? = nil, unread: Int = 0, resumable: Bool = true,
                                main: Bool = false, count: Int) -> BusSession {
        BusSession(sessionID: id, channel: channel, topic: topic, title: title, startedAt: started, lastActivity: last,
                   endedAt: ended, unreadCount: unread, resumable: resumable, isMain: main, activity: "idle",
                   messageCount: count, claudeSessionID: id == standupID ? "3f9a5c1e-7b2d-4c8a-9e10-a4d27c9f0e21" : nil)
    }

    private static var seq = 0
    private static func message(_ session: String, _ direction: String, _ body: String, at: String,
                                arrival: String = "app", attachments: [BusAttachment] = [], scheduled: Bool = false) -> BusMessage {
        seq += 1
        return BusMessage(messageID: "m\(seq)-\(session.suffix(2))", sessionID: session, seq: seq, cursor: "row-\(seq)",
                          direction: direction, arrivalChannel: arrival, body: body, createdAt: at,
                          scheduled: scheduled, attachments: attachments)
    }

    private static func file(_ name: String, expired: Bool = false) -> BusAttachment {
        BusAttachment(id: UUID().uuidString, type: "file", originalFilename: name, mimeType: nil, expired: expired)
    }

    static func seed(_ store: ChatStore) {
        let sessions = [
            session(mainID, "app", "general", "Main", started: daysAgo(3, 7, 0), last: ago(10), main: true, count: 142),
            session(pipelineID, "app", "thread:7a1c", "Pipeline migration plan", started: ago(3600), last: ago(120), count: 12),
            session(snowflakeID, "app", "thread:9d42", "Snowflake cost spike", started: ago(7200), last: ago(300), count: 6),
            session(standupID, "telegram", "8812345", "Standup notes", started: today(8, 2), last: ago(540), count: 64),
            session(vendorID, "email", "vendor-renewal", "Re: Vendor renewal terms", started: ago(86_400), last: ago(3600), unread: 2, count: 9),
            session(siriID, "siri", "siri", "What's on tomorrow?", started: ago(10_800), last: ago(10_800), count: 2),
            session(earlierMainID, "app", "general", "Main", started: daysAgo(10, 9, 0), last: daysAgo(10, 16, 31),
                    ended: daysAgo(10, 16, 31), resumable: false, main: true, count: 38),
            session(dbtID, "app", "thread:1f0b", "Q3 dbt upgrade", started: daysAgo(17, 10, 0), last: daysAgo(17, 15, 0),
                    ended: daysAgo(17, 15, 0), count: 21),
            session(weekendID, "app", "thread:52aa", "Weekend plans", started: daysAgo(19, 18, 0), last: daysAgo(19, 19, 0),
                    ended: daysAgo(19, 19, 0), count: 8),
        ]
        for value in sessions { try? store.upsert(value) }

        let reply = message(mainID, "outbound", """
            The nulls are guest checkouts from the new web flow; they arrive without a `customer_id` until the account merge job runs. The duplicates are replays from the 02:10 sync retry.

            Dedupe on the latest `_fivetran_synced` per order:

            ```sql
            select *
            from raw.shop.orders
            qualify row_number() over (
              partition by order_id
              order by _fivetran_synced desc
            ) = 1
            ```
            """, at: today(8, 15))
        let standupReply = message(standupID, "outbound", """
            **Yesterday**
            - Merged the Airflow DAG split for the finance loads
            - Reviewed the Glue job retry PR

            **Blocked**
            - Snowflake role grant for the new analytics share (waiting on IT)
            """, at: today(8, 51))
        let earlierReply = message(earlierMainID, "outbound", "Three connectors need changes before Q4: the Salesforce sync needs the new `Opportunity_Split` object, NetSuite should move to the incremental API, and the Zendesk connector can be retired once the support data lands in the lake.", at: daysAgo(10, 16, 13))
        let messages = [
            message(mainID, "outbound", """
                Morning. The overnight dbt run finished with 2 test failures, both in `stg_orders`:

                - `not_null_stg_orders_customer_id`: 14 rows
                - `unique_stg_orders_order_id`: 3 duplicate IDs from the late Fivetran sync

                Nothing downstream is blocked yet. Want me to dig in?
                """, at: today(7, 2)),
            message(mainID, "inbound", "Yes. Which source rows are the nulls? And draft a fix for the duplicates.",
                    at: today(8, 14), attachments: [file("dbt_run_0930.log")]),
            reply,
            message(mainID, "inbound", "Go with both. Open a PR against the staging models.", at: today(8, 21)),
            message(standupID, "inbound", "Standup in 10. Pull together what I shipped yesterday and what's blocked.",
                    at: today(8, 50), arrival: "telegram"),
            standupReply,
            message(standupID, "inbound", "Also add today's dbt failures. Here's the schema file.", at: today(9, 4),
                    attachments: [file("schema.yml")]),
            message(earlierMainID, "inbound", "Summarize the Fivetran connector changes we need for the Q4 sources.", at: daysAgo(10, 16, 12)),
            earlierReply,
            message(earlierMainID, "inbound", "Thanks. Attaching the vendor sheet for later.", at: daysAgo(10, 16, 20),
                    attachments: [file("connector_inventory.xlsx", expired: true)]),
            message(earlierMainID, "inbound", "/clear", at: daysAgo(10, 16, 31)),
        ]
        for value in messages { try? store.upsert(value) }
        try? store.attachTrail(reply.messageID, lines: Array(repeating: "📖 Read", count: 5), seconds: 41)
        try? store.attachTrail(standupReply.messageID, lines: Array(repeating: "📖 Read", count: 3), seconds: 22)
        try? store.attachTrail(earlierReply.messageID, lines: Array(repeating: "📖 Read", count: 2), seconds: 15)
        for row in store.sessions { row.historyComplete = true }
        try? store.context.save()
    }
}

#Preview("Main · light", traits: .fixedLayout(width: 1280, height: 800)) {
    let model = PreviewFixtures.model()
    MainWindow(model: model, initialSelection: PreviewFixtures.mainID)
        .modelContainer(model.container)
        .preferredColorScheme(.light)
}

#Preview("Telegram session · dark, inspector", traits: .fixedLayout(width: 1280, height: 800)) {
    let model = PreviewFixtures.model()
    MainWindow(model: model, initialSelection: PreviewFixtures.standupID, initialInspector: true)
        .modelContainer(model.container)
        .preferredColorScheme(.dark)
}

#Preview("Earlier read-only · offline", traits: .fixedLayout(width: 1280, height: 800)) {
    let model = PreviewFixtures.model(connected: false)
    MainWindow(model: model, initialSelection: PreviewFixtures.earlierMainID, initialShowEarlier: true)
        .modelContainer(model.container)
}

#Preview("Empty states", traits: .fixedLayout(width: 1100, height: 700)) {
    let model = PreviewFixtures.model(empty: true)
    MainWindow(model: model, initialSelection: BusTarget.mainSentinel, initialShowEarlier: true)
        .modelContainer(model.container)
}

#Preview("Settings · General") { GeneralSettings().frame(width: 640, height: 300) }

#Preview("Settings · Connection") {
    let model = PreviewFixtures.model()
    ConnectionSettings(settings: model.settings, connection: model.connection).frame(width: 640, height: 520)
}

#Preview("Settings · Notifications") {
    NotificationSettings(settings: PreviewFixtures.model().settings).frame(width: 640, height: 300)
}

#Preview("Composer · tokens and read-only") {
    let model = PreviewFixtures.model()
    let composer = ComposerModel()
    let folder = URL(fileURLWithPath: NSTemporaryDirectory())
    composer.files = [
        DraftFile(url: folder.appending(path: "orders_sample.csv"), name: "orders_sample.csv", size: 212_000,
                  state: .ready(UploadedFile(id: "f1", originalFilename: "orders_sample.csv", size: 212_000))),
        DraftFile(url: folder.appending(path: "warehouse_dump.parquet"), name: "warehouse_dump.parquet", size: 61_000_000, state: .oversized),
        DraftFile(url: folder.appending(path: "notes.md"), name: "notes.md", size: 4_000, state: .uploading),
        DraftFile(url: folder.appending(path: "big.zip"), name: "big.zip", size: 9_000_000, state: .failed("Bus returned 422")),
    ]
    return VStack(spacing: 20) {
        ComposerView(connection: model.connection, session: model.connection.store.session(PreviewFixtures.standupID),
                     target: .session(PreviewFixtures.standupID), model: composer, importing: .constant(false))
        ReadOnlyBar(newConversation: {})
    }
    .padding(30)
    .frame(width: 800)
    .modelContainer(model.container)
}

#Preview("Send states") {
    VStack(spacing: 16) {
        OperatorMessageView(text: "Sending while offline", attachments: [], status: .sending, source: nil, date: .now)
        OperatorMessageView(text: "Waiting for a slot", attachments: [], status: .label("Queued"), source: nil, date: .now)
        OperatorMessageView(text: "Accepted by the agent", attachments: [], status: .label("Delivered"), source: nil, date: .now)
        OperatorMessageView(text: "This one failed", attachments: [], status: .failed("not_resumable", retry: {}), source: nil, date: .now)
        OperatorMessageView(text: "/status", attachments: [], status: .label("Command"), source: nil, date: .now)
        OperatorMessageView(text: "Continuing a Telegram chat", attachments: [
            AttachmentInfo(id: "a", name: "schema.yml", size: 3_000, expired: false),
            AttachmentInfo(id: "b", name: "connector_inventory.xlsx", size: 88_000, expired: true),
        ], status: nil, source: "From Mac", date: .now)
        LiveActivityView(live: LiveActivity(state: "running", lines: ["📖 Read `schema.yml`", "💻 Bash `dbt test`"], startedAt: .now),
                         capacity: PreviewFixtures.health.capacity, sessionActivity: "running")
        LiveActivityView(live: LiveActivity(state: "queued"), capacity: PreviewFixtures.health.capacity, sessionActivity: "queued")
    }
    .padding(28)
    .frame(width: 760)
}

#Preview("Sidebar rows") {
    let model = PreviewFixtures.model()
    let store = model.connection.store
    return List {
        if let row = store.session(PreviewFixtures.pipelineID) { SessionRow(session: row, activity: "running", now: .now) }
        if let row = store.session(PreviewFixtures.snowflakeID) { SessionRow(session: row, activity: "queued", now: .now) }
        if let row = store.session(PreviewFixtures.vendorID) { SessionRow(session: row, activity: "idle", now: .now) }
        if let row = store.session(PreviewFixtures.earlierMainID) { SessionRow(session: row, activity: "idle", now: .now) }
        if let row = store.session(PreviewFixtures.dbtID) { SessionRow(session: row, activity: "idle", now: .now) }
    }
    .listStyle(.sidebar)
    .frame(width: 268, height: 320)
    .modelContainer(model.container)
}
#endif


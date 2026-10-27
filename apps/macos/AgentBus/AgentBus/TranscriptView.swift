import SwiftUI
import SwiftData
import AppKit
import QuickLook

/// One row of the transcript, in display order.
enum TranscriptItem: Identifiable {
    case day(String, id: String)
    case message(CachedMessage, status: String?)
    case note(String, id: String)
    case pending(PendingSend)
    case divider(ContextDivider)

    var id: String {
        switch self {
        case .day(_, let id), .note(_, let id): id
        case .message(let message, _): message.id
        case .pending(let row): "pending-" + row.id
        case .divider(let divider): divider.id
        }
    }

    /// Interleaves day labels, chooses the send-state label per operator message,
    /// and turns `/clear` and scheduled prompts into centered notes.
    @MainActor static func build(_ messages: [CachedMessage], pending: [PendingSend], session: CachedSession?, activity: String) -> [TranscriptItem] {
        var items: [TranscriptItem] = []
        let calendar = Calendar.current
        var lastDay: Date?
        let active = session?.endedAt == nil
        let operatorMessages = messages.filter { $0.isOperator && !$0.scheduled }
        let queuedID = activity == "queued" ? operatorMessages.last?.id : nil
        // "Delivered" marks the newest operator message the agent has accepted, unless a turn is visibly running.
        let deliveredID = active && activity != "running"
            ? operatorMessages.last(where: { $0.id != queuedID && $0.arrivalChannel == "app" })?.id : nil

        func dayLabel(_ date: Date?, id: String) {
            guard let date else { return }
            if let lastDay, calendar.isDate(lastDay, inSameDayAs: date) { return }
            lastDay = date
            items.append(.day(BusDate.dayLabel(date), id: "day-" + id))
        }

        for message in messages where !ContextDivider.hidesClearCommand(message, in: session) {
            dayLabel(message.date, id: message.id)
            let body = message.body.trimmingCharacters(in: .whitespacesAndNewlines)
            if message.isOperator && body == "/clear" {
                let when = message.date.map { " · " + BusDate.stamp($0) } ?? ""
                items.append(.note("Cleared with /clear" + when, id: message.id))
            } else if message.isOperator && message.scheduled {
                let when = message.date.map { " · " + BusDate.time($0) } ?? ""
                let firstLine = body.split(separator: "\n").first.map(String.init) ?? ""
                items.append(.note("Scheduled: " + firstLine + when, id: message.id))
            } else if message.isOperator {
                let status: String? = body.hasPrefix("/") ? "Command"
                    : message.id == queuedID ? "Queued" : message.id == deliveredID ? "Delivered" : nil
                items.append(.message(message, status: status))
            } else {
                items.append(.message(message, status: nil))
            }
        }
        for row in pending.sorted(by: { $0.createdAt < $1.createdAt }) {
            dayLabel(row.createdAt, id: row.id)
            items.append(.pending(row))
        }
        return items
    }
}

struct TranscriptView<Bar: View>: View {
    let connection: BusConnection
    let session: CachedSession?
    let bar: Bar
    @Query private var messages: [CachedMessage]
    @Query(sort: \PendingSend.createdAt) private var allPending: [PendingSend]
    @State private var position = ScrollPosition(edge: .bottom)
    /// True while the user is at (or near) the bottom; new content then keeps the view pinned there.
    @State private var following = true
    @State private var repinPending = false
    @State private var repinning = false
    @State private var metrics = ScrollBox()
    /// The message a reply note just scrolled to, highlighted for a moment.
    @State private var highlightedID: String?
    private let originID: String?

    init(connection: BusConnection, session: CachedSession?, @ViewBuilder bar: () -> Bar) {
        self.connection = connection; self.session = session; self.bar = bar()
        let origin = session.flatMap { connection.origin(of: $0.id) }
        originID = origin
        _messages = Query(filter: CachedMessage.transcript(of: session, origin: origin), sort: \.createdAt)
    }

    private var sessionChannel: String { session?.channel ?? "app" }
    private var activity: String { session.map { connection.activityState($0.id) } ?? "idle" }
    private var pending: [PendingSend] {
        allPending.filter { row in
            if let session { return (row.targetKind == "session" && row.targetID == session.id) || (session.isMain && !session.isEarlier && row.targetKind == "main") }
            return row.targetKind == "main"
        }
    }

    /// A resumed copy shows the Earlier session's history first, then a divider note.
    private var items: [TranscriptItem] {
        let own = messages.filter { $0.sessionID != originID }
        let current = TranscriptItem.build(own, pending: pending, session: session, activity: activity)
        guard let originID else { return ContextDivider.apply(current, messages: own, session: session) }
        let earlier = messages.filter { $0.sessionID == originID }
        guard !earlier.isEmpty else { return current }
        let original = connection.store.session(originID)
        let note = TranscriptItem.note("Resumed from \(original?.title ?? "an Earlier session") · earlier messages above", id: "resumed-" + originID)
        return TranscriptItem.build(earlier, pending: [], session: original, activity: "idle") + [note] + current
    }

    /// Scrolls to a replied-to message and highlights it, first paging in older history until it is cached
    /// (in this session, then in the one it was resumed from).
    private func reveal(_ id: String) {
        let sessionIDs = [session?.id, originID].compactMap { $0 }
        Task {
            for sessionID in sessionIDs where !connection.store.hasMessage(id) {
                while !connection.store.hasMessage(id), connection.store.session(sessionID)?.historyComplete == false {
                    let before = connection.store.session(sessionID)?.oldestCursor
                    try? await connection.loadHistory(sessionID, older: true)
                    if connection.store.session(sessionID)?.oldestCursor == before { break }
                }
            }
            guard connection.store.hasMessage(id) else { return }
            following = false
            withAnimation(.easeInOut(duration: 0.3)) { position.scrollTo(id: id, anchor: .center) }
            highlightedID = id
            try? await Task.sleep(for: .seconds(1.6))
            if highlightedID == id { highlightedID = nil }
        }
    }

    /// Scrolls to the bottom once layout settles. A lazy stack only estimates the height of rows it hasn't
    /// laid out, and in a long conversation the bottom edge it jumps to can be thousands of points short of
    /// the real end. So the last row is scrolled to by ID first, which makes the stack lay out the tail, and
    /// only then the bottom edge, which now includes the live-activity row and the padding below it.
    private func repin() {
        guard !repinPending, !repinning else { return }
        repinPending = true
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(50))
            repinPending = false
            guard following else { return }
            // The first step lands above the live-activity row and bottom padding, which can read as
            // "scrolled away" and unpin the view mid-way, so scrolling is not tracked until both steps finish.
            repinning = true
            if let last = items.last?.id {
                position.scrollTo(id: last, anchor: .bottom)
                try? await Task.sleep(for: .milliseconds(60))
            }
            position.scrollTo(edge: .bottom)
            try? await Task.sleep(for: .milliseconds(200))
            repinning = false
        }
    }

    /// PgUp/PgDn from the composer: one page of the transcript, less a little overlap.
    private func page(_ direction: Int) {
        let step = max(metrics.visible - metrics.inset - 80, 100)
        position.scrollTo(y: max(metrics.offset + CGFloat(direction) * step, -metrics.insetTop))
    }

    private var followToken: String {
        let live = session.flatMap { connection.live[$0.id] }
        return "\(messages.count)-\(pending.count)-\(live?.state ?? "")-\(live?.lines.count ?? 0)"
    }

    var body: some View {
        let items = items
        Group {
            if items.isEmpty && activity == "idle" {
                ContentUnavailableView {
                    Label(session?.isEarlier == true ? "No Messages" : "New Conversation", systemImage: "bubble.left.and.bubble.right")
                } description: {
                    Text(session?.isEarlier == true ? "This session has no stored messages." : "Send a message to start.")
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .safeAreaInset(edge: .bottom, spacing: 0) { bar }
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 20) {
                        if let session, !session.historyComplete, !messages.isEmpty {
                            ProgressView().controlSize(.small).frame(maxWidth: .infinity)
                                .onAppear { Task { try? await connection.loadHistory(session.id, older: true) } }
                        }
                        ForEach(items) { item in
                            TranscriptRow(item: item, connection: connection, sessionChannel: sessionChannel,
                                          highlighted: highlightedID == item.id)
                        }
                        if let session { LiveActivityView(live: connection.live[session.id], capacity: connection.capacity, sessionActivity: session.activity) }
                    }
                    .scrollTargetLayout()
                    .frame(maxWidth: 760)
                    .padding(.horizontal, 28).padding(.top, 16).padding(.bottom, 12)
                    .frame(maxWidth: .infinity)
                }
                .environment(\.revealMessage, reveal)
                .scrollPosition($position)
                .defaultScrollAnchor(.bottom)
                .safeAreaInset(edge: .bottom, spacing: 0) { bar }
                .environment(\.pageTranscript, page)
                // `following` tracks whether the reader is pinned to the bottom. It follows the user's scrolling
                // (an offset-only change). A layout change (the composer growing, a lazy row being measured and
                // the content estimate shifting) never unpins; it re-pins the view instead, so the newest
                // message neither hides under a taller composer nor drifts away when the estimate changes (E75).
                .onScrollGeometryChange(for: ScrollMetrics.self) { g in
                    ScrollMetrics(offset: g.contentOffset.y, content: g.contentSize.height,
                                  visible: g.visibleRect.height, inset: g.contentInsets.bottom,
                                  container: g.containerSize.height, insetTop: g.contentInsets.top)
                } action: { old, new in
                    metrics.offset = new.offset
                    metrics.visible = new.visible
                    metrics.inset = new.inset
                    metrics.insetTop = new.insetTop
                    if new.sameLayout(as: old) {
                        if !repinning { following = new.atBottom }
                    } else if following {
                        repin()
                    }
                }
                .onChange(of: followToken) {
                    guard following else { return }
                    repin()
                }
                .onChange(of: pending.count) { old, new in
                    // Your own send always jumps to the bottom.
                    guard new > old else { return }
                    following = true
                    repin()
                }
            }
        }
        .overlay {
            if connection.isResetting {
                ProgressView("Reloading conversations…")
                    .padding(16)
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
        }
    }
}

/// The scroll geometry `TranscriptView` uses to tell the reader scrolling from layout changing. At rest
/// at the bottom, `offset + visible == content + inset`.
private struct ScrollMetrics: Equatable {
    var offset: CGFloat
    var content: CGFloat
    var visible: CGFloat
    var inset: CGFloat
    var container: CGFloat
    var insetTop: CGFloat

    var atBottom: Bool { offset + visible >= content + inset - 60 }

    func sameLayout(as other: ScrollMetrics) -> Bool {
        abs(content - other.content) < 0.5 && abs(visible - other.visible) < 0.5
            && abs(inset - other.inset) < 0.5 && abs(container - other.container) < 0.5
    }
}

/// The latest scroll geometry, kept out of view state so reading it for a page jump never re-renders.
final class ScrollBox {
    var offset: CGFloat = 0
    var visible: CGFloat = 0
    var inset: CGFloat = 0
    var insetTop: CGFloat = 0
}

struct TranscriptRow: View {
    let item: TranscriptItem
    let connection: BusConnection
    let sessionChannel: String
    var highlighted = false

    var body: some View {
        content
            .background {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(Color.accentColor.opacity(highlighted ? 0.14 : 0))
                    .padding(-8)
            }
            .animation(.easeInOut(duration: 0.25), value: highlighted)
    }

    @ViewBuilder private var content: some View {
        switch item {
        case .day(let label, _):
            Text(label).font(.caption.weight(.semibold)).foregroundStyle(.secondary).frame(maxWidth: .infinity)
        case .note(let text, _):
            Text(text).font(.caption2).foregroundStyle(.secondary).multilineTextAlignment(.center).frame(maxWidth: .infinity)
        case .divider(let divider):
            ContextDividerView(divider: divider)
        case .message(let message, let status):
            if message.isOperator {
                OperatorMessageView(text: message.body, attachments: message.attachments.map { AttachmentInfo($0, local: connection.localFile($0.id)) },
                                    status: status.map { .label($0) }, source: sourceLabel(message.arrivalChannel),
                                    date: message.date, replyTarget: ReplyRef(message), replyNote: message.replyTo)
            } else {
                AgentMessageView(message: message)
            }
        case .pending(let row):
            OperatorMessageView(text: row.body, attachments: row.files.map { AttachmentInfo($0, local: connection.localFile($0.id)) },
                                status: row.failure == nil ? .sending : .failed(row.failure ?? "Rejected", retry: {
                                    Task { try? await connection.retry(row.id) }
                                }),
                                source: sourceLabel("app"), date: row.createdAt, replyNote: row.replyTo)
        }
    }

    /// "From Mac" in a foreign session; "via Telegram" when a foreign channel reached an app session.
    private func sourceLabel(_ arrival: String) -> String? {
        guard arrival != sessionChannel else { return nil }
        return arrival == "app" ? "From Mac" : "via \(Channel.name(arrival))"
    }
}

enum SendStatus {
    case label(String)
    case sending
    case failed(String, retry: () -> Void)

    static let replyTargetNotFound = "reply_target_not_found"

    /// Plain wording for the bus's rejection reasons.
    static func explain(_ reason: String) -> String {
        switch reason {
        case let text where text.contains("dedup"): "same text was just sent"
        case replyTargetNotFound: "the message you replied to is no longer available. Retry sends it without the reply"
        case "not_resumable": "this session can't be resumed"
        case "session_not_found": "session not found"
        case let text where text.localizedCaseInsensitiveContains("attachment"): "attachment expired"
        default: reason
        }
    }
}

struct OperatorMessageView: View {
    let text: String
    let attachments: [AttachmentInfo]
    let status: SendStatus?
    let source: String?
    let date: Date?
    /// This message as a reply target; nil for a send that hasn't been acknowledged yet.
    var replyTarget: ReplyRef? = nil
    /// The message this one replied to, shown above the bubble.
    var replyNote: ReplyRef? = nil
    @Environment(\.transcriptSelection) private var transcriptSelection

    var body: some View {
        VStack(alignment: .trailing, spacing: 6) {
            if let replyNote { ReplyNote(reply: replyNote) }
            if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                FractionalWidth(fraction: 0.7, trailing: true) {
                    MessageTextView(blocks: MarkdownParser.parse(text), kind: .operatorBubble,
                                    copyMessage: { copyToPasteboard(text) }, replyTarget: replyTarget)
                        .padding(.vertical, 8).padding(.horizontal, 13)
                        .background(Color.accentColor, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                }
            }
            ForEach(attachments) { AttachmentCard(info: $0) }
            meta
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .contextMenu {
            if let replyTarget, transcriptSelection?.canReply == true {
                Button("Reply") { transcriptSelection?.replyToMessage(replyTarget) }
                Divider()
            }
            Button("Copy Message") { copyToPasteboard(text) }
        }
        .accessibilityAction(named: "Copy Message") { copyToPasteboard(text) }
    }

    @ViewBuilder private var meta: some View {
        HStack(spacing: 4) {
            switch status {
            case .label(let text): Text(text); Text("·")
            case .sending: Text("Sending…"); Text("·")
            case .failed(let reason, let retry):
                Text("Not sent · \(SendStatus.explain(reason))").foregroundStyle(.red).help(reason)
                Button("Retry", action: retry).buttonStyle(.link).font(.caption2)
                Text("·")
            case nil: EmptyView()
            }
            if let source { Text(source); Text("·") }
            if let date { Text(BusDate.time(date)) }
        }
        .font(.caption2)
        .foregroundStyle(.secondary)
    }
}

/// "↩ Replying to you: first line", above a sent bubble. Click to scroll to the original.
struct ReplyNote: View {
    let reply: ReplyRef
    /// Trailing above an operator bubble, leading above an agent message.
    var alignment: Alignment = .trailing
    @Environment(\.revealMessage) private var reveal

    var body: some View {
        let firstLine = reply.text.split(separator: "\n", omittingEmptySubsequences: true).first.map(String.init) ?? ""
        Button { reveal?(reply.messageID) } label: {
            Label("Replying to \(reply.senderName): \(firstLine)", systemImage: "arrowshape.turn.up.left")
                .lineLimit(1)
                .truncationMode(.tail)
        }
        .buttonStyle(.plain)
        .font(.caption)
        .foregroundStyle(.secondary)
        .frame(maxWidth: 380, alignment: alignment)
        .help("Show the original message")
        .accessibilityLabel("Replying to \(reply.senderName): \(firstLine). Show the original message")
    }
}

extension EnvironmentValues {
    /// Scrolls the transcript to a message by ID and highlights it. Set by `TranscriptView`.
    @Entry var revealMessage: ((String) -> Void)?
    /// PgUp (-1) and PgDn (1) pressed in the composer scroll the transcript.
    @Entry var pageTranscript: ((Int) -> Void)?
}

struct AgentMessageView: View {
    let message: CachedMessage
    @State private var hovering = false
    @Environment(\.transcriptSelection) private var transcriptSelection

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let reply = message.replyTo { ReplyNote(reply: reply, alignment: .leading) }
            HStack(spacing: 6) {
                if let date = message.date {
                    Text(message.scheduled ? "Scheduled · " + BusDate.time(date) : BusDate.time(date))
                        .font(.caption2).foregroundStyle(.secondary)
                }
                CopyButton(text: message.body, help: "Copy Message as Markdown")
                    .font(.caption2)
                    .opacity(hovering ? 1 : 0)
            }
            let trail = message.toolTrail
            if !trail.isEmpty {
                DisclosureGroup {
                    ToolLines(lines: trail, highlightLast: false).padding(.top, 4)
                } label: {
                    Text("Used \(trail.count) tool\(trail.count == 1 ? "" : "s") · \(BusDate.duration(message.toolSeconds))")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            if !message.body.isEmpty { MarkdownView(message.body, replyTarget: ReplyRef(message)).equatable() }
            ForEach(message.attachments.map { AttachmentInfo($0) }) { AttachmentCard(info: $0) }
        }
        .frame(maxWidth: 680, alignment: .leading)
        .frame(maxWidth: .infinity, alignment: .leading)
        // Without a content shape only drawn content counts as the hover region, so the gap between the
        // timestamp and the copy button ended the hover before the button could be clicked.
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .contextMenu {
            if transcriptSelection?.canReply == true {
                Button("Reply") { transcriptSelection?.replyToMessage(ReplyRef(message)) }
                Divider()
            }
            Button("Copy Message") { copyToPasteboard(message.body) }
        }
        .accessibilityAction(named: "Copy Message") { copyToPasteboard(message.body) }
    }
}

struct ToolLines: View {
    let lines: [String]
    let highlightLast: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            ForEach(Array(lines.enumerated()), id: \.offset) { entry in
                Text(MarkdownParser.inline(entry.element))
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(highlightLast && entry.offset == lines.count - 1 ? .primary : .secondary)
                    .lineLimit(1).truncationMode(.middle)
            }
        }
    }
}

/// The session's current turn: working with a live tool trail, or waiting for a slot.
struct LiveActivityView: View {
    let live: LiveActivity?
    let capacity: BusCapacity?
    let sessionActivity: String

    private var state: String { live?.state ?? sessionActivity }

    var body: some View {
        switch state {
        case "running":
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        let seconds = live?.startedAt.map { context.date.timeIntervalSince($0) } ?? 0
                        Text("Working · " + BusDate.elapsed(seconds))
                    }
                    .font(.caption).foregroundStyle(.orange)
                }
                if let lines = live?.lines, !lines.isEmpty {
                    ToolLines(lines: lines, highlightLast: true).padding(.leading, 20)
                }
            }
            .accessibilityElement(children: .combine)
        case "queued":
            HStack(spacing: 6) {
                Image(systemName: "clock")
                if let capacity, capacity.userSlots > 0 {
                    Text("Waiting for a free slot · all \(capacity.userSlots) conversation slots are busy")
                } else {
                    Text("Waiting for a free slot")
                }
            }
            .font(.caption).foregroundStyle(.secondary)
        default:
            EmptyView()
        }
    }
}

struct AttachmentInfo: Identifiable {
    let id: String
    let name: String
    let size: Int?
    let expired: Bool
    let local: URL?

    init(_ attachment: BusAttachment, local: URL? = nil) {
        id = attachment.stableID; name = attachment.originalFilename ?? "Attachment"
        size = local.flatMap { try? $0.resourceValues(forKeys: [.fileSizeKey]).fileSize }
        expired = attachment.expired == true; self.local = local
    }
    init(_ file: UploadedFile, local: URL?) {
        id = file.id; name = file.originalFilename; size = file.size; expired = false; self.local = local
    }
    init(id: String, name: String, size: Int?, expired: Bool, local: URL? = nil) {
        self.id = id; self.name = name; self.size = size; self.expired = expired; self.local = local
    }
}

struct AttachmentCard: View {
    let info: AttachmentInfo
    @State private var preview: URL?

    var body: some View {
        HStack(spacing: 10) {
            icon.frame(width: 26, height: 26)
            VStack(alignment: .leading, spacing: 1) {
                Text(info.name).font(.callout.weight(.medium)).lineLimit(1).truncationMode(.middle)
                subtitle.font(.caption2).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 8).padding(.leading, 10).padding(.trailing, 14)
        .background(.fill.quaternary, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .contentShape(Rectangle())
        .onTapGesture(count: 2) { if let local = info.local { preview = local } }
        .quickLookPreview($preview)
        .accessibilityElement(children: .combine)
        .help(info.local == nil ? "" : "Double-click to preview")
        .accessibilityHint(info.local == nil ? "" : "Double-click to preview")
    }

    @ViewBuilder private var icon: some View {
        if let local = info.local, FileManager.default.fileExists(atPath: local.path) {
            Image(nsImage: NSWorkspace.shared.icon(forFile: local.path)).resizable().scaledToFit()
        } else {
            Image(systemName: "doc").font(.system(size: 20)).foregroundStyle(info.expired ? .secondary : .primary)
        }
    }

    private var subtitle: Text {
        let size = info.size.map(ByteSize.format)
        if info.expired {
            return Text("\(size.map { $0 + " · " } ?? "")\(Text("Expired").italic())")
        }
        return Text(size ?? "File")
    }
}

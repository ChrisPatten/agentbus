import SwiftUI
import AppKit
import UniformTypeIdentifiers

/// A file picked in the composer, from selection until the send that carries it.
struct DraftFile: Identifiable, Equatable {
    enum State: Equatable { case uploading, ready(UploadedFile), oversized, failed(String) }
    let id = UUID()
    let url: URL
    let name: String
    let size: Int
    var state: State
}

@MainActor @Observable final class ComposerModel {
    var files: [DraftFile] = []
    var error: String?
    /// Bumped to move focus to the composer with the insertion point at the end of the draft.
    var focusRequest = 0

    var uploading: Bool { files.contains { $0.state == .uploading } }
    var ready: [UploadedFile] {
        files.compactMap { if case .ready(let file) = $0.state { file } else { nil } }
    }

    /// Oversized files are rejected here, before any upload (FR-56).
    func add(_ url: URL, connection: BusConnection) {
        let size = (try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
        let tooBig = size > connection.maxUploadBytes
        let file = DraftFile(url: url, name: url.lastPathComponent, size: size, state: tooBig ? .oversized : .uploading)
        files.append(file)
        guard !tooBig else { return }
        Task {
            let state: DraftFile.State
            do { state = .ready(try await connection.upload(url)) }
            catch { state = .failed(error.localizedDescription) }
            if let index = files.firstIndex(where: { $0.id == file.id }) { files[index].state = state }
        }
    }
    func remove(_ id: UUID) { files.removeAll { $0.id == id } }

    // ⌘V reaches the text field before any SwiftUI paste handler, so files and rich text are
    // intercepted here: files become attachments, rich text is inserted as Markdown.
    @ObservationIgnored var focused = false
    @ObservationIgnored weak var window: NSWindow?
    @ObservationIgnored weak var textView: ComposerNSTextView?
    @ObservationIgnored private var monitor: Any?

    func focusChanged(_ isFocused: Bool, in view: NSTextView) {
        focused = isFocused
        if isFocused { window = view.window }
    }

    /// Focuses the composer with the insertion point at the end of the draft, taking focus from a
    /// selected message view if needed.
    func focusAtEnd() {
        guard let textView, let window = textView.window else { return }
        if window.firstResponder !== textView { window.makeFirstResponder(textView) }
        textView.moveInsertionPointToEnd()
    }

    func startPasteMonitor(_ connection: BusConnection) {
        guard monitor == nil else { return }
        monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            // TEMP E75 DIAGNOSTIC (PgUp/PgDn focus): remove before commit.
            if event.keyCode == 116 || event.keyCode == 121, let window = event.window {
                Self.log("key \(event.keyCode) before: \(type(of: window.firstResponder as Any)) composerFocused=\(self?.focused ?? false)")
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
                    Self.log("key \(event.keyCode) after: \(type(of: window.firstResponder as Any))")
                }
            }
            let handled = MainActor.assumeIsolated { self?.paste(event, connection: connection) ?? false }
            return handled ? nil : event
        }
    }
    nonisolated static func log(_ text: String) {
        let line = "\(Date().timeIntervalSince1970) \(text)\n"
        if let h = FileHandle(forWritingAtPath: "/tmp/agentbus-scroll.log") { h.seekToEndOfFile(); h.write(Data(line.utf8)); try? h.close() }
        else { try? line.write(toFile: "/tmp/agentbus-scroll.log", atomically: false, encoding: .utf8) }
    }
    func stopPasteMonitor() {
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
    }

    private func paste(_ event: NSEvent, connection: BusConnection) -> Bool {
        guard focused, event.window === window,
              event.modifierFlags.intersection(.deviceIndependentFlagsMask) == .command,
              event.charactersIgnoringModifiers?.lowercased() == "v" else { return false }
        let board = NSPasteboard.general
        if let urls = board.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL], !urls.isEmpty {
            urls.forEach { add($0, connection: connection) }
            return true
        }
        guard let rich = board.readObjects(forClasses: [NSAttributedString.self])?.first as? NSAttributedString,
              let editor = event.window?.firstResponder as? NSTextView else { return false }
        let markdown = MarkdownWriter.markdown(from: rich)
        guard markdown != rich.string else { return false }
        editor.insertText(markdown, replacementRange: editor.selectedRange())
        return true
    }
}

struct ComposerView: View {
    let connection: BusConnection
    let session: CachedSession?
    let target: BusTarget
    @Bindable var model: ComposerModel
    @Binding var importing: Bool
    @State private var selection = 0
    @State private var dismissedSlash = false
    @Environment(\.pageTranscript) private var pageTranscript

    private var draftKey: String { session?.draftKey ?? "main" }
    private var draft: Binding<String> {
        Binding(get: { connection.drafts[draftKey] ?? "" }, set: { connection.drafts[draftKey] = $0 })
    }
    private var replyTarget: ReplyRef? { connection.replyTargets[draftKey] }
    private var placeholder: String {
        if session?.isEarlier == true { return "Continue in a new conversation" }
        return "Message \(session?.title ?? "Main")"
    }
    private var canSend: Bool {
        !model.uploading && (!draft.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !model.ready.isEmpty)
    }
    private var matches: [SlashCommand] {
        let text = draft.wrappedValue
        guard text.hasPrefix("/"), !text.contains(" "), !text.contains("\n") else { return [] }
        return connection.commands.filter { $0.invocation.hasPrefix(text.lowercased()) }
    }
    private var showSlash: Binding<Bool> {
        Binding(get: { !dismissedSlash && !matches.isEmpty }, set: { if !$0 { dismissedSlash = true } })
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let replyTarget {
                ReplyBar(reply: replyTarget) { connection.replyTargets[draftKey] = nil }
                    .padding(.horizontal, 4).padding(.top, 2)
            }
            if !model.files.isEmpty {
                FlowLayout(spacing: 6) {
                    ForEach(model.files) { file in AttachmentToken(file: file, limit: connection.maxUploadBytes) { model.remove(file.id) } }
                }
                .padding(.horizontal, 4).padding(.top, 2)
            }
            HStack(alignment: .bottom, spacing: 8) {
                Button { importing = true } label: {
                    Image(systemName: "plus").font(.system(size: 14, weight: .medium))
                        .frame(width: 32, height: 32)
                        .background(.fill.quaternary, in: Circle())
                        .contentShape(Circle())
                        .help("Attach Files (⌘O)")
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Attach Files")

                ComposerTextView(text: draft, placeholder: placeholder, model: model, onKey: handleKey)
                    .overlay(alignment: .topLeading) {
                        if draft.wrappedValue.isEmpty {
                            Text(placeholder).foregroundStyle(.placeholder).lineLimit(1)
                                .padding(.vertical, ComposerTextView.inset)
                                .allowsHitTesting(false)
                        }
                    }

                Button(action: send) {
                    Image(systemName: "arrow.up").font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(.white)
                        .frame(width: 32, height: 32)
                        .background(canSend ? Color.accentColor : Color.secondary.opacity(0.5), in: Circle())
                        .contentShape(Circle())
                        .help(canSend ? "Send (Return)" : "Type a message or attach a file to send")
                }
                .buttonStyle(.plain)
                .disabled(!canSend)
                .accessibilityLabel("Send")
            }
            if let error = model.error {
                Text(error).font(.caption).foregroundStyle(.red).padding(.horizontal, 6)
            }
        }
        .padding(8)
        .glassEffect(.regular, in: .rect(cornerRadius: 22))
        // Anchored to a 320-pt strip at the capsule's leading edge so the popover lines up with it.
        .popover(isPresented: showSlash, attachmentAnchor: .rect(.rect(CGRect(x: 0, y: 0, width: 320, height: 1))),
                 arrowEdge: .top) { slashList }
        .onAppear { model.startPasteMonitor(connection) }
        .onDisappear { model.stopPasteMonitor() }
        .onChange(of: draft.wrappedValue) { old, new in
            if !new.hasPrefix("/") || old.isEmpty { dismissedSlash = false }
            selection = 0
        }
        // On the next turn, once the text view is in the window and holds the updated draft.
        .onAppear { Task { @MainActor in model.focusAtEnd() } }
        .onChange(of: model.focusRequest) { Task { @MainActor in model.focusAtEnd() } }
        .task { await connection.loadCommands() }
    }

    private var slashList: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(matches.prefix(8).enumerated()), id: \.element) { entry in
                let selected = entry.offset == selection
                HStack(spacing: 10) {
                    Text(entry.element.invocation).font(.system(.callout, design: .monospaced))
                    Text(entry.element.description).font(.callout)
                        .foregroundStyle(selected ? AnyShapeStyle(.white.opacity(0.85)) : AnyShapeStyle(.secondary))
                        .lineLimit(1)
                    Spacer(minLength: 0)
                }
                .foregroundStyle(selected ? AnyShapeStyle(.white) : AnyShapeStyle(.primary))
                .padding(.horizontal, 10).padding(.vertical, 5)
                .background(selected ? AnyShapeStyle(Color.accentColor) : AnyShapeStyle(.clear),
                            in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                .contentShape(Rectangle())
                .onTapGesture { complete(entry.element) }
            }
        }
        .padding(6)
        .frame(width: 320)
    }

    /// Shift/Option-Return newlines are handled by the text view itself.
    private func handleKey(_ key: ComposerKey) -> Bool {
        let options = Array(matches.prefix(8))
        let slash = showSlash.wrappedValue && !options.isEmpty
        switch key {
        case .up where slash: selection = (selection - 1 + options.count) % options.count; return true
        case .down where slash: selection = (selection + 1) % options.count; return true
        case .tab where slash: complete(options[min(selection, options.count - 1)]); return true
        case .escape where slash: dismissedSlash = true; return true
        // Clicking a message focuses its text view, and paging scrolls that row out of the lazy stack, which
        // hands focus to the composer. The next PgUp/PgDn then lands here, so it pages the transcript.
        case .pageUp: pageTranscript?(-1); return true
        case .pageDown: pageTranscript?(1); return true
        case .escape where replyTarget != nil: connection.replyTargets[draftKey] = nil; return true
        case .send:
            if slash { complete(options[min(selection, options.count - 1)]) } else { send() }
            return true
        default: return false
        }
    }

    private func complete(_ command: SlashCommand) {
        draft.wrappedValue = command.invocation + " "
        dismissedSlash = true
    }

    private func send() {
        guard canSend else { return }
        let body = draft.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let files = model.ready
        // A slash command is for the bus, not a reply to a message.
        let reply = body.hasPrefix("/") ? nil : replyTarget
        draft.wrappedValue = ""
        connection.replyTargets[draftKey] = nil
        model.files.removeAll { if case .ready = $0.state { true } else { false } }
        model.error = nil
        Task {
            do { try await connection.send(body, target: target, attachments: files.map(\.id), files: files, replyTo: reply) }
            catch { model.error = error.localizedDescription }
        }
    }
}

/// "Replying to you: first line ✕", above the field. Esc in the field or the ✕ cancels the reply.
struct ReplyBar: View {
    let reply: ReplyRef
    let cancel: () -> Void

    var body: some View {
        let firstLine = reply.text.split(separator: "\n", omittingEmptySubsequences: true).first.map(String.init) ?? ""
        HStack(spacing: 6) {
            Image(systemName: "arrowshape.turn.up.left").foregroundStyle(.secondary)
            (Text("Replying to \(reply.senderName): ").fontWeight(.medium) + Text(firstLine).foregroundStyle(.secondary))
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 8)
            Button(action: cancel) { Image(systemName: "xmark").font(.system(size: 9, weight: .bold)) }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .help("Cancel Reply (Esc)")
                .accessibilityLabel("Cancel Reply")
        }
        .font(.caption)
        .padding(.horizontal, 8)
        .frame(height: 26)
        .background(.fill.tertiary, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
}

struct AttachmentToken: View {
    let file: DraftFile
    let limit: Int
    let remove: () -> Void

    var body: some View {
        HStack(spacing: 5) {
            switch file.state {
            case .uploading: ProgressView().controlSize(.mini)
            case .oversized, .failed: Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.red)
            case .ready: Image(systemName: "doc").foregroundStyle(.secondary)
            }
            Text(file.name).lineLimit(1).truncationMode(.middle).frame(maxWidth: 180, alignment: .leading)
            switch file.state {
            case .oversized: Text("Over \(ByteSize.format(limit))").foregroundStyle(.red)
            case .failed(let reason): Text("Upload failed").foregroundStyle(.red).help(reason)
            default: Text(ByteSize.format(file.size)).foregroundStyle(.secondary)
            }
            Button(action: remove) { Image(systemName: "xmark").font(.system(size: 9, weight: .bold)) }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .help("Remove \(file.name)")
                .accessibilityLabel("Remove \(file.name)")
        }
        .font(.caption)
        .padding(.horizontal, 8)
        .frame(height: 26)
        .background(.fill.tertiary, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
}

/// Replaces the composer for an Earlier session whose Claude transcript is gone.
struct ReadOnlyBar: View {
    let newConversation: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "lock").foregroundStyle(.secondary)
            Text("This session can't be resumed. Its Claude transcript is no longer on disk.")
                .font(.callout).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 8)
            Button("New Conversation", action: newConversation).buttonStyle(.bordered)
        }
        .padding(.horizontal, 16).padding(.vertical, 10)
        .background(.fill.quaternary, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
    }
}

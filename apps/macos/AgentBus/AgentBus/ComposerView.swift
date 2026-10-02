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
    @ObservationIgnored private var monitor: Any?

    func startPasteMonitor(_ connection: BusConnection) {
        guard monitor == nil else { return }
        monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            let handled = MainActor.assumeIsolated { self?.paste(event, connection: connection) ?? false }
            return handled ? nil : event
        }
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

/// Converts pasted rich text (bold, italic, code, strikethrough, links, bullets) to the Markdown the bus sends.
enum MarkdownWriter {
    static func markdown(from text: NSAttributedString) -> String {
        var output = ""
        text.enumerateAttributes(in: NSRange(location: 0, length: text.length)) { attributes, range, _ in
            let run = (text.string as NSString).substring(with: range)
            output += styled(run, attributes)
        }
        // Rich-text lists arrive as "•\t" (or "◦\t") prefixes.
        return output.split(separator: "\n", omittingEmptySubsequences: false).map { line -> String in
            let trimmed = line.drop { $0 == " " || $0 == "\t" }
            for bullet in ["•", "◦", "▪", "-"] where trimmed.hasPrefix(bullet + "\t") {
                return "- " + trimmed.dropFirst(bullet.count + 1)
            }
            return String(line)
        }.joined(separator: "\n")
    }

    private static func styled(_ run: String, _ attributes: [NSAttributedString.Key: Any]) -> String {
        // Markers wrap each line's text, never its surrounding whitespace or line breaks.
        run.split(separator: "\n", omittingEmptySubsequences: false).map { line in
            let core = line.trimmingCharacters(in: .whitespaces)
            guard !core.isEmpty else { return String(line) }
            var value = core
            let traits = (attributes[.font] as? NSFont)?.fontDescriptor.symbolicTraits ?? []
            if traits.contains(.monoSpace) { value = "`" + value + "`" }
            else {
                if traits.contains(.bold) { value = "**" + value + "**" }
                if traits.contains(.italic) { value = "*" + value + "*" }
            }
            if (attributes[.strikethroughStyle] as? Int ?? 0) != 0 { value = "~~" + value + "~~" }
            if let link = attributes[.link] {
                let url = (link as? URL)?.absoluteString ?? (link as? String) ?? ""
                if !url.isEmpty { value = "[" + value + "](" + url + ")" }
            }
            let leading = line.prefix { $0 == " " || $0 == "\t" }
            let trailing = String(line.reversed().prefix { $0 == " " || $0 == "\t" })
            return leading + value + trailing
        }.joined(separator: "\n")
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
    @FocusState private var focused: Bool

    private var draftKey: String { session?.id ?? "main" }
    private var draft: Binding<String> {
        Binding(get: { connection.drafts[draftKey] ?? "" }, set: { connection.drafts[draftKey] = $0 })
    }
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

                TextField(placeholder, text: draft, axis: .vertical)
                    .textFieldStyle(.plain)
                    .lineLimit(1...8)
                    .padding(.vertical, 7)
                    .focused($focused)
                    .onKeyPress(keys: [.return, .upArrow, .downArrow, .tab, .escape], phases: .down, action: handleKey)
                    .onSubmit(send)

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
        .onChange(of: focused) { _, isFocused in
            model.focused = isFocused
            if isFocused { model.window = NSApp.keyWindow }
        }
        .onAppear { model.startPasteMonitor(connection) }
        .onDisappear { model.stopPasteMonitor() }
        .onChange(of: draft.wrappedValue) { old, new in
            if !new.hasPrefix("/") || old.isEmpty { dismissedSlash = false }
            selection = 0
        }
        .onAppear { focused = true }
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

    private func handleKey(_ press: KeyPress) -> KeyPress.Result {
        let options = Array(matches.prefix(8))
        let slash = showSlash.wrappedValue && !options.isEmpty
        switch press.key {
        case .upArrow where slash: selection = (selection - 1 + options.count) % options.count; return .handled
        case .downArrow where slash: selection = (selection + 1) % options.count; return .handled
        case .tab where slash: complete(options[min(selection, options.count - 1)]); return .handled
        case .escape where slash: dismissedSlash = true; return .handled
        case .return:
            if slash { complete(options[min(selection, options.count - 1)]); return .handled }
            if press.modifiers.contains(.shift) || press.modifiers.contains(.option) {
                draft.wrappedValue += "\n"; return .handled
            }
            send(); return .handled
        default: return .ignored
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
        draft.wrappedValue = ""
        model.files.removeAll { if case .ready = $0.state { true } else { false } }
        model.error = nil
        Task {
            do { try await connection.send(body, target: target, attachments: files.map(\.id), files: files) }
            catch { model.error = error.localizedDescription }
        }
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

import SwiftUI
import AppKit

/// Block-level Markdown. `AttributedString(markdown:)` renders the inline styles inside each block.
enum MarkdownBlock: Equatable {
    struct Item: Equatable { var level: Int; var marker: String; var text: String }
    case paragraph(String)
    case heading(Int, String)
    case list([Item])
    case code(language: String, text: String)
    case quote(String)
    case rule
}

enum MarkdownParser {
    static func parse(_ source: String) -> [MarkdownBlock] {
        var blocks: [MarkdownBlock] = []
        var paragraph: [String] = []
        var quote: [String] = []
        var items: [MarkdownBlock.Item] = []
        var fence: (marker: String, language: String, lines: [String])?

        func flush() {
            if !paragraph.isEmpty { blocks.append(.paragraph(paragraph.joined(separator: "\n"))); paragraph = [] }
            if !quote.isEmpty { blocks.append(.quote(quote.joined(separator: "\n"))); quote = [] }
            if !items.isEmpty { blocks.append(.list(items)); items = [] }
        }

        for line in source.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if var open = fence {
                if trimmed.hasPrefix(open.marker) && trimmed.drop(while: { $0 == open.marker.first }).isEmpty {
                    blocks.append(.code(language: open.language, text: open.lines.joined(separator: "\n")))
                    fence = nil
                } else {
                    open.lines.append(line); fence = open
                }
                continue
            }
            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                flush()
                let marker = String(trimmed.prefix(3))
                fence = (marker, String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespaces), [])
                continue
            }
            if trimmed.isEmpty { flush(); continue }
            if let heading = heading(trimmed) { flush(); blocks.append(heading); continue }
            if ["---", "***", "___"].contains(trimmed.replacingOccurrences(of: " ", with: "")) && paragraph.isEmpty {
                flush(); blocks.append(.rule); continue
            }
            if trimmed.hasPrefix(">") {
                if !paragraph.isEmpty || !items.isEmpty { flush() }
                quote.append(String(trimmed.dropFirst()).trimmingCharacters(in: .whitespaces)); continue
            }
            if let item = listItem(line) {
                if !paragraph.isEmpty || !quote.isEmpty { flush() }
                items.append(item); continue
            }
            if !items.isEmpty && line.hasPrefix(" ") {
                // An indented line continues the previous list item.
                items[items.count - 1].text += "\n" + trimmed; continue
            }
            if !items.isEmpty || !quote.isEmpty { flush() }
            paragraph.append(line)
        }
        if let open = fence { blocks.append(.code(language: open.language, text: open.lines.joined(separator: "\n"))) }
        flush()
        return blocks
    }

    private static func heading(_ line: String) -> MarkdownBlock? {
        let hashes = line.prefix { $0 == "#" }.count
        guard (1...6).contains(hashes), line.dropFirst(hashes).first == " " else { return nil }
        return .heading(hashes, String(line.dropFirst(hashes + 1)).trimmingCharacters(in: .whitespaces))
    }

    private static func listItem(_ line: String) -> MarkdownBlock.Item? {
        let indent = line.prefix { $0 == " " || $0 == "\t" }.reduce(0) { $0 + ($1 == "\t" ? 4 : 1) }
        let rest = line.drop { $0 == " " || $0 == "\t" }
        if let first = rest.first, "-*+".contains(first), rest.dropFirst().first == " " {
            return .init(level: indent / 2, marker: "•", text: String(rest.dropFirst(2)))
        }
        let digits = rest.prefix { $0.isNumber }
        guard !digits.isEmpty, digits.count < 4 else { return nil }
        let after = rest.dropFirst(digits.count)
        guard let delimiter = after.first, ".)".contains(delimiter), after.dropFirst().first == " " else { return nil }
        return .init(level: indent / 2, marker: String(digits) + ".", text: String(after.dropFirst(2)))
    }

    static func inline(_ text: String) -> AttributedString {
        (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(text)
    }
}

/// Equatable on its source, so `.equatable()` at the call site skips re-parsing and rebuilding when only
/// surrounding state (such as hover) changes.
struct MarkdownView: View, Equatable {
    let source: String
    /// The message this text belongs to, so its context menu can offer **Reply**.
    let replyTarget: ReplyRef?
    init(_ source: String, replyTarget: ReplyRef? = nil) {
        self.source = source
        self.replyTarget = replyTarget
    }

    /// A message is a run of text blocks in one selectable text view, then a code block, then another
    /// run. A selection can span a whole run but stops at a code block.
    enum Segment: Equatable {
        case text([MarkdownBlock])
        case code(language: String, text: String)
    }

    static func segments(_ blocks: [MarkdownBlock]) -> [Segment] {
        var segments: [Segment] = []
        var run: [MarkdownBlock] = []
        for block in blocks {
            if case .code(let language, let text) = block {
                if !run.isEmpty { segments.append(.text(run)); run = [] }
                segments.append(.code(language: language, text: text))
            } else {
                run.append(block)
            }
        }
        if !run.isEmpty { segments.append(.text(run)) }
        return segments
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(Self.segments(MarkdownParser.parse(source)).enumerated()), id: \.offset) { entry in
                switch entry.element {
                case .text(let blocks):
                    MessageTextView(blocks: blocks, kind: .agent, copyMessage: { copyToPasteboard(source) }, replyTarget: replyTarget)
                case .code(let language, let text):
                    CodeBlockView(language: language, code: text)
                }
            }
        }
    }
}

struct CodeBlockView: View {
    let language: String
    let code: String

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(language.isEmpty ? "Code" : language.uppercased())
                    .font(.caption).foregroundStyle(.secondary)
                Spacer()
                CopyButton(text: code, help: "Copy Code")
            }
            .padding(.horizontal, 12).padding(.top, 7).padding(.bottom, 2)
            ScrollView(.horizontal) {
                Text(code)
                    .font(.system(.callout, design: .monospaced))
                    .textSelection(.enabled)
                    .fixedSize()
                    .padding(.horizontal, 12).padding(.bottom, 10).padding(.top, 2)
            }
            .scrollIndicators(.automatic)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.fill.quaternary, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}

func copyToPasteboard(_ text: String) {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)
}

/// A borderless copy button that briefly shows a checkmark and "Copied".
struct CopyButton: View {
    let text: String
    let help: String
    @State private var copied = false

    var body: some View {
        Button {
            copyToPasteboard(text)
            copied = true
            Task { try? await Task.sleep(for: .seconds(1.5)); copied = false }
        } label: {
            HStack(spacing: 3) {
                Image(systemName: copied ? "checkmark" : "doc.on.doc").contentTransition(.symbolEffect(.replace))
                if copied { Text("Copied") }
            }
        }
        .buttonStyle(.borderless)
        .foregroundStyle(copied ? AnyShapeStyle(Color.green) : AnyShapeStyle(.secondary))
        .help(help)
        .accessibilityLabel(copied ? "Copied" : help)
        .animation(.default, value: copied)
    }
}

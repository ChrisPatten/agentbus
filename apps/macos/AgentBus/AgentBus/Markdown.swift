import SwiftUI
import AppKit

/// Block-level Markdown. `AttributedString(markdown:)` renders the inline styles inside each block.
enum MarkdownBlock: Equatable {
    struct Item: Equatable { var level: Int; var marker: String; var text: String }
    /// A GFM pipe table. Every row has exactly `header.count` cells; cell text is still inline Markdown.
    struct Table: Equatable {
        enum Alignment: Equatable { case leading, center, trailing }
        var header: [String]
        var alignments: [Alignment]
        var rows: [[String]]
    }
    case paragraph(String)
    case heading(Int, String)
    case list([Item])
    case code(language: String, text: String)
    case quote(String)
    case rule
    case table(Table)
}

enum MarkdownParser {
    static func parse(_ source: String) -> [MarkdownBlock] {
        var blocks: [MarkdownBlock] = []
        var paragraph: [String] = []
        var quote: [String] = []
        var items: [MarkdownBlock.Item] = []
        var table: MarkdownBlock.Table?
        var fence: (marker: String, language: String, lines: [String])?

        func flush() {
            if !paragraph.isEmpty { blocks.append(.paragraph(paragraph.joined(separator: "\n"))); paragraph = [] }
            if !quote.isEmpty { blocks.append(.quote(quote.joined(separator: "\n"))); quote = [] }
            if !items.isEmpty { blocks.append(.list(items)); items = [] }
            if let open = table { blocks.append(.table(open)); table = nil }
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
            if var open = table {
                // Body rows continue until a blank line or a line that isn't a row.
                if let cells = tableRow(trimmed) {
                    open.rows.append(fitted(cells, to: open.header.count)); table = open; continue
                }
                flush()
            }
            // A delimiter row turns the paragraph's last line into a table header when their cell counts match.
            if let alignments = tableDelimiter(trimmed), let last = paragraph.last,
               let header = tableRow(last.trimmingCharacters(in: .whitespaces)), header.count == alignments.count {
                paragraph.removeLast()
                flush()
                table = .init(header: header, alignments: alignments, rows: [])
                continue
            }
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

    /// A table row's cells, or nil when the line has no unescaped pipe. Leading and trailing pipes are
    /// optional. As in GFM, only `\|` keeps a pipe inside a cell, including inside a code span.
    static func tableRow(_ line: String) -> [String]? {
        guard !line.hasPrefix(">"), !line.hasPrefix("```"), !line.hasPrefix("~~~") else { return nil }
        var cells: [String] = []
        var cell = ""
        var escaped = false
        var sawPipe = false
        for character in line {
            if escaped {
                // `\|` becomes a literal pipe; any other escape is left for the inline parser.
                cell += character == "|" ? "|" : "\\" + String(character)
                escaped = false
            } else if character == "\\" {
                escaped = true
            } else if character == "|" {
                sawPipe = true
                cells.append(cell); cell = ""
            } else {
                cell.append(character)
            }
        }
        if escaped { cell += "\\" }
        guard sawPipe else { return nil }
        cells.append(cell)
        // An outer pipe leaves an empty first or last cell.
        if line.hasPrefix("|") { cells.removeFirst() }
        if line.hasSuffix("|") && !line.hasSuffix("\\|") && !cells.isEmpty { cells.removeLast() }
        return cells.map { $0.trimmingCharacters(in: .whitespaces) }
    }

    /// The column alignments of a delimiter row such as `| --- | :---: | ---: |`, or nil.
    static func tableDelimiter(_ line: String) -> [MarkdownBlock.Table.Alignment]? {
        guard let cells = tableRow(line), !cells.isEmpty else { return nil }
        var alignments: [MarkdownBlock.Table.Alignment] = []
        for cell in cells {
            let left = cell.hasPrefix(":"), right = cell.hasSuffix(":")
            let dashes = cell.dropFirst(left ? 1 : 0).dropLast(right && cell.count > 1 ? 1 : 0)
            guard !dashes.isEmpty, dashes.allSatisfy({ $0 == "-" }) else { return nil }
            alignments.append(left && right ? .center : right ? .trailing : .leading)
        }
        return alignments
    }

    /// Pads a ragged row with empty cells, or drops the extra ones.
    private static func fitted(_ cells: [String], to count: Int) -> [String] {
        cells.count >= count ? Array(cells.prefix(count)) : cells + Array(repeating: "", count: count - cells.count)
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

    /// A message is a run of text blocks in one selectable text view, then a code block or table, then
    /// another run. A selection can span a whole run but stops at a code block or table.
    enum Segment: Equatable {
        case text([MarkdownBlock])
        case code(language: String, text: String)
        case table(MarkdownBlock.Table)
    }

    static func segments(_ blocks: [MarkdownBlock]) -> [Segment] {
        var segments: [Segment] = []
        var run: [MarkdownBlock] = []
        for block in blocks {
            let standalone: Segment?
            switch block {
            case .code(let language, let text): standalone = .code(language: language, text: text)
            case .table(let table): standalone = .table(table)
            default: standalone = nil
            }
            if let standalone {
                if !run.isEmpty { segments.append(.text(run)); run = [] }
                segments.append(standalone)
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
                case .table(let table):
                    MarkdownTableView(table: table)
                }
            }
        }
    }
}

/// A GFM table as a grid: semibold header on a fill, a divider between rows, per-column alignment, and
/// inline Markdown in cells. Cells don't wrap; a table wider than the message column scrolls sideways.
struct MarkdownTableView: View {
    let table: MarkdownBlock.Table

    var body: some View {
        ScrollView(.horizontal) { MarkdownTableGrid(table: table) }
            .scrollIndicators(.automatic)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The table itself, at its natural width.
struct MarkdownTableGrid: View {
    let table: MarkdownBlock.Table

    var body: some View {
        Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
            GridRow {
                ForEach(Array(table.header.enumerated()), id: \.offset) { column, text in
                    cell(text, column: column).fontWeight(.semibold)
                        .gridColumnAlignment(alignment(column))
                }
            }
            .background(.fill.tertiary)
            ForEach(Array(table.rows.enumerated()), id: \.offset) { _, row in
                Divider()
                GridRow {
                    ForEach(Array(row.enumerated()), id: \.offset) { column, text in cell(text, column: column) }
                }
            }
        }
        .textSelection(.enabled)
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(.separator))
    }

    private func cell(_ text: String, column: Int) -> some View {
        Text(MarkdownParser.inline(text))
            .font(.body)
            .multilineTextAlignment(textAlignment(column))
            .fixedSize()
            .padding(.horizontal, 10).padding(.vertical, 5)
            .frame(maxWidth: .infinity, alignment: Alignment(horizontal: alignment(column), vertical: .center))
    }

    private func alignment(_ column: Int) -> HorizontalAlignment {
        switch table.alignments[column] {
        case .leading: .leading
        case .center: .center
        case .trailing: .trailing
        }
    }

    private func textAlignment(_ column: Int) -> TextAlignment {
        switch table.alignments[column] {
        case .leading: .leading
        case .center: .center
        case .trailing: .trailing
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

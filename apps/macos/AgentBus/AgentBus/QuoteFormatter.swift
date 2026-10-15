import Foundation

/// Turns selected Markdown into a block quote for the composer draft.
enum QuoteFormatter {
    /// Prefixes each line with `> ` (blank lines become `>`) after trimming leading and trailing blank
    /// lines, and ends with one empty line so the operator's own text starts a new paragraph. Nil when
    /// nothing but whitespace is left.
    static func quote(_ markdown: String) -> String? {
        var lines = markdown.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        func blank(_ line: String) -> Bool { line.trimmingCharacters(in: .whitespaces).isEmpty }
        while let first = lines.first, blank(first) { lines.removeFirst() }
        while let last = lines.last, blank(last) { lines.removeLast() }
        guard !lines.isEmpty else { return nil }
        return lines.map { blank($0) ? ">" : "> " + $0 }.joined(separator: "\n") + "\n\n"
    }

    /// An empty draft becomes the quote alone; otherwise the quote follows the existing text after a blank
    /// line. Quotes added one after another stay separate because each ends with a blank line.
    static func append(_ quote: String, to draft: String) -> String {
        guard !draft.isEmpty else { return quote }
        let separator = draft.hasSuffix("\n\n") ? "" : draft.hasSuffix("\n") ? "\n" : "\n\n"
        return draft + separator + quote
    }
}

extension BusConnection {
    /// Appends the selection, as a quote, to the draft for `key`. Returns false when there was nothing to quote.
    @discardableResult
    func appendQuote(_ markdown: String, toDraft key: String) -> Bool {
        guard let quote = QuoteFormatter.quote(markdown) else { return false }
        drafts[key] = QuoteFormatter.append(quote, to: drafts[key] ?? "")
        return true
    }
}

import AppKit

/// Converts attributed text to the Markdown the bus sends. Two sources feed it:
/// - pasted rich text: bold, italic, code, strikethrough, links, and bullets;
/// - a selection in a rendered message (`MessageTextBuilder`), which also carries headings, nested and
///   numbered lists, quotes, rules, and the breaks between blocks.
enum MarkdownWriter {
    static func markdown(from text: NSAttributedString) -> String {
        let string = text.string as NSString
        var output = ""
        text.enumerateAttributes(in: NSRange(location: 0, length: text.length)) { attributes, range, _ in
            if attributes[MessageTextBuilder.blockBreakKey] != nil { output += "\n\n"; return }
            if attributes[MessageTextBuilder.ruleKey] != nil { output += "---"; return }
            let startsParagraph = range.location == 0 || string.character(at: range.location - 1) == 10
            output += styled(string.substring(with: range), attributes, startsParagraph: startsParagraph)
        }
        // Rich-text lists arrive as "•\t" (or "◦\t") and "1.\t" prefixes. Leading spaces carry the nesting
        // of a rendered list; leading tabs from pasted text are dropped.
        return output.split(separator: "\n", omittingEmptySubsequences: false).map { line -> String in
            let indent = line.prefix { $0 == " " }
            let trimmed = line.drop { $0 == " " || $0 == "\t" }
            for bullet in ["•", "◦", "▪", "-"] where trimmed.hasPrefix(bullet + "\t") {
                return String(indent) + "- " + String(trimmed.dropFirst(bullet.count + 1))
            }
            let digits = trimmed.prefix { $0.isASCII && $0.isNumber }
            if !digits.isEmpty, digits.count < 4, trimmed.dropFirst(digits.count).hasPrefix(".\t") {
                return String(indent) + String(digits) + ". " + String(trimmed.dropFirst(digits.count + 2))
            }
            return String(line)
        }.joined(separator: "\n")
    }

    private static func styled(_ run: String, _ attributes: [NSAttributedString.Key: Any], startsParagraph: Bool) -> String {
        let heading = attributes[MessageTextBuilder.headingKey] as? Int
        let listLevel = attributes[MessageTextBuilder.listLevelKey] as? Int ?? 0
        let quoted = attributes[MessageTextBuilder.quoteKey] != nil
        // Markers wrap each line's text, never its surrounding whitespace or line breaks.
        return run.split(separator: "\n", omittingEmptySubsequences: false).enumerated().map { index, line in
            let core = line.trimmingCharacters(in: .whitespaces)
            guard !core.isEmpty else { return String(line) }
            var value = core
            let traits = (attributes[.font] as? NSFont)?.fontDescriptor.symbolicTraits ?? []
            if traits.contains(.monoSpace) { value = "`" + value + "`" }
            else {
                // A heading's font is bold; the `#` prefix already says so.
                if traits.contains(.bold) && heading == nil { value = "**" + value + "**" }
                if traits.contains(.italic) { value = "*" + value + "*" }
            }
            if (attributes[.strikethroughStyle] as? Int ?? 0) != 0 { value = "~~" + value + "~~" }
            if let link = attributes[.link] {
                let url = (link as? URL)?.absoluteString ?? (link as? String) ?? ""
                if !url.isEmpty { value = "[" + value + "](" + url + ")" }
            }
            var prefix = ""
            if startsParagraph || index > 0 {
                if let heading { prefix = String(repeating: "#", count: heading) + " " }
                else if quoted { prefix = "> " }
                else if listLevel > 0 { prefix = String(repeating: "  ", count: listLevel) }
            }
            let leading = line.prefix { $0 == " " || $0 == "\t" }
            let trailing = String(line.reversed().prefix { $0 == " " || $0 == "\t" })
            return prefix + leading + value + trailing
        }.joined(separator: "\n")
    }
}

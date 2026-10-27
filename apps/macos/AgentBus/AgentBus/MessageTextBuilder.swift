import AppKit

/// Renders Markdown blocks into one attributed string, so a whole message is a single selectable text
/// storage. Fonts use real bold/italic/monospace traits and link attributes, which `MarkdownWriter` reads
/// to turn a selection back into Markdown.
enum MessageTextBuilder {
    enum Kind: Equatable {
        case agent
        /// White text on the accent bubble. Code blocks stay inline as monospaced paragraphs.
        case operatorBubble
    }

    /// Marks a block quote's characters so `MessageLayoutManager` can draw its bar.
    static let quoteKey = NSAttributedString.Key("agentbus.quote")
    /// Marks the paragraph that stands for a horizontal rule.
    static let ruleKey = NSAttributedString.Key("agentbus.rule")
    /// The heading level (Int) of a heading's characters; `MarkdownWriter` turns it back into `#`s.
    static let headingKey = NSAttributedString.Key("agentbus.heading")
    /// The nesting level (Int) of a list item's characters.
    static let listLevelKey = NSAttributedString.Key("agentbus.listLevel")
    /// Marks the newline between two blocks, which Markdown writes as a blank line. Newlines inside a
    /// block (soft line breaks, between list items) are not marked.
    static let blockBreakKey = NSAttributedString.Key("agentbus.blockBreak")

    private static let blockGap: CGFloat = 10
    private static let itemGap: CGFloat = 4
    private static let indentStep: CGFloat = 18
    private static let markerWidth: CGFloat = 20
    private static let quoteInset: CGFloat = 14

    private struct Colors { let text: NSColor; let secondary: NSColor }

    private static func colors(_ kind: Kind) -> Colors {
        switch kind {
        case .agent: Colors(text: .labelColor, secondary: .secondaryLabelColor)
        case .operatorBubble: Colors(text: .white, secondary: NSColor.white.withAlphaComponent(0.8))
        }
    }

    static var bodyFont: NSFont { .preferredFont(forTextStyle: .body) }

    static func build(_ blocks: [MarkdownBlock], kind: Kind) -> NSAttributedString {
        let colors = colors(kind)
        let body = bodyFont
        let out = NSMutableAttributedString()
        func newline(blockBreak: Bool = false) {
            var attributes: [NSAttributedString.Key: Any] = [.font: body, .foregroundColor: colors.text]
            if blockBreak { attributes[blockBreakKey] = true }
            out.append(NSAttributedString(string: "\n", attributes: attributes))
        }

        for block in blocks {
            let gap = out.length == 0 ? 0 : blockGap
            if out.length > 0 { newline(blockBreak: true) }
            switch block {
            case .paragraph(let text):
                out.append(paragraphs(inline(text, font: body, color: colors.text)) { first in
                    style(before: first ? gap : 0)
                })
            case .heading(let level, let text):
                let heading = inline(text, font: headingFont(level), color: colors.text)
                heading.addAttribute(headingKey, value: level, range: NSRange(location: 0, length: heading.length))
                out.append(paragraphs(heading) { first in style(before: first ? gap + 2 : 0) })
            case .list(let items):
                for (index, item) in items.enumerated() {
                    if index > 0 { newline() }
                    let before = index == 0 ? gap : itemGap
                    let indent = CGFloat(item.level) * indentStep
                    let line = NSMutableAttributedString(string: item.marker + "\t", attributes: [
                        .font: NSFont.monospacedDigitSystemFont(ofSize: body.pointSize, weight: .regular),
                        .foregroundColor: colors.secondary,
                    ])
                    line.append(inline(item.text, font: body, color: colors.text))
                    line.addAttribute(listLevelKey, value: item.level, range: NSRange(location: 0, length: line.length))
                    out.append(paragraphs(line) { first in listStyle(first: first, indent: indent, before: before) })
                }
            case .quote(let text):
                let quote = inline(text, font: body, color: colors.secondary)
                quote.addAttribute(quoteKey, value: true, range: NSRange(location: 0, length: quote.length))
                out.append(paragraphs(quote) { first in style(before: first ? gap : 0, indent: quoteInset) })
            case .code(_, let text):
                let code = NSMutableAttributedString(string: text, attributes: [
                    .font: NSFont.monospacedSystemFont(ofSize: body.pointSize * 0.92, weight: .regular),
                    .foregroundColor: colors.text,
                ])
                out.append(paragraphs(code) { first in style(before: first ? gap : 0) })
            case .rule:
                out.append(NSAttributedString(string: " ", attributes: [
                    .font: body, ruleKey: true, .paragraphStyle: style(before: gap),
                ]))
            }
        }
        return out
    }

    /// Inline Markdown (bold, italic, code, strikethrough, links) as attributed text.
    static func inline(_ text: String, font: NSFont, color: NSColor) -> NSMutableAttributedString {
        let source = MarkdownParser.inline(text)
        let out = NSMutableAttributedString()
        for run in source.runs {
            let intent = run.inlinePresentationIntent ?? []
            var attributes: [NSAttributedString.Key: Any] = [.foregroundColor: color]
            if intent.contains(.code) {
                attributes[.font] = NSFont.monospacedSystemFont(ofSize: font.pointSize * 0.92, weight: .regular)
            } else {
                attributes[.font] = traitFont(font, bold: intent.contains(.stronglyEmphasized), italic: intent.contains(.emphasized))
            }
            if intent.contains(.strikethrough) { attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
            if let link = run.link { attributes[.link] = link }
            out.append(NSAttributedString(string: String(source[run.range].characters), attributes: attributes))
        }
        return out
    }

    static func traitFont(_ font: NSFont, bold: Bool, italic: Bool) -> NSFont {
        var traits = font.fontDescriptor.symbolicTraits
        if bold { traits.insert(.bold) }
        if italic { traits.insert(.italic) }
        return NSFont(descriptor: font.fontDescriptor.withSymbolicTraits(traits), size: font.pointSize) ?? font
    }

    private static func headingFont(_ level: Int) -> NSFont {
        let style: NSFont.TextStyle = level == 1 ? .title2 : level == 2 ? .title3 : .headline
        return traitFont(.preferredFont(forTextStyle: style), bold: true, italic: false)
    }

    /// Applies a paragraph style to each paragraph; the closure is told whether it is the block's first.
    private static func paragraphs(_ text: NSMutableAttributedString, style: (Bool) -> NSParagraphStyle) -> NSAttributedString {
        let string = text.string as NSString
        var ranges: [NSRange] = []
        string.enumerateSubstrings(in: NSRange(location: 0, length: string.length), options: .byParagraphs) { _, range, _, _ in
            ranges.append(range)
        }
        for (index, range) in ranges.enumerated() {
            text.addAttribute(.paragraphStyle, value: style(index == 0), range: range)
        }
        return text
    }

    private static func style(before: CGFloat, indent: CGFloat = 0) -> NSParagraphStyle {
        let style = NSMutableParagraphStyle()
        style.paragraphSpacingBefore = before
        style.firstLineHeadIndent = indent
        style.headIndent = indent
        return style
    }

    /// The marker sits at `indent`; the text, and any continuation line, hangs at `indent + markerWidth`.
    private static func listStyle(first: Bool, indent: CGFloat, before: CGFloat) -> NSParagraphStyle {
        let hanging = indent + markerWidth
        let style = NSMutableParagraphStyle()
        style.paragraphSpacingBefore = first ? before : 0
        style.firstLineHeadIndent = first ? indent : hanging
        style.headIndent = hanging
        style.tabStops = [NSTextTab(textAlignment: .left, location: hanging)]
        return style
    }
}

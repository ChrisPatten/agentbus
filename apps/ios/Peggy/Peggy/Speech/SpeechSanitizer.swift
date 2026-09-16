import Foundation

/// Strips residual Markdown from a reply before it becomes Siri dialog. The prompt
/// contract asks the agent for plain spoken prose; this is the safety net.
enum SpeechSanitizer {
    static func clean(_ text: String) -> String {
        var s = text

        // Fenced code blocks → drop the fences, keep the content on one line.
        s = s.replacingOccurrences(of: "```[a-zA-Z]*\\n?", with: "", options: .regularExpression)
        // Inline code → plain.
        s = s.replacingOccurrences(of: "`", with: "")
        // Markdown links [text](url) → text.
        s = s.replacingOccurrences(of: "\\[([^\\]]+)\\]\\([^)]*\\)", with: "$1", options: .regularExpression)
        // Bare URLs → spoken placeholder.
        s = s.replacingOccurrences(of: "https?://\\S+", with: "a link", options: .regularExpression)
        // Headings and list markers at line starts.
        s = s.replacingOccurrences(of: "(?m)^\\s{0,3}#{1,6}\\s*", with: "", options: .regularExpression)
        s = s.replacingOccurrences(of: "(?m)^\\s*(?:[-*+]|\\d+[.)])\\s+", with: "", options: .regularExpression)
        // Bold / italic markers.
        s = s.replacingOccurrences(of: "\\*\\*|__", with: "", options: .regularExpression)
        s = s.replacingOccurrences(of: "(?<!\\w)[*_](?=\\S)|(?<=\\S)[*_](?!\\w)", with: "", options: .regularExpression)
        // Collapse whitespace; newlines become sentence pauses.
        s = s.replacingOccurrences(of: "\\s*\\n+\\s*", with: " ", options: .regularExpression)
        s = s.replacingOccurrences(of: "[ \\t]{2,}", with: " ", options: .regularExpression)

        return s.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

import Foundation

/// Parses the bus's ISO 8601 timestamps (with or without fractional seconds) and bare dates.
enum BusDate {
    static func parse(_ value: String?) -> Date? {
        guard let value, !value.isEmpty else { return nil }
        if let date = try? Date(value, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true)) { return date }
        if let date = try? Date(value, strategy: .iso8601) { return date }
        let sqlite = value.replacingOccurrences(of: " ", with: "T")
        if let date = try? Date(sqlite + "Z", strategy: .iso8601) { return date }
        return try? Date(value, strategy: Date.ISO8601FormatStyle().year().month().day())
    }

    /// "Now", "2 min ago", "3 hr ago", "Yesterday", "Sep 21".
    static func relative(_ date: Date, now: Date = .now) -> String {
        let seconds = now.timeIntervalSince(date)
        if seconds < 60 { return "Now" }
        if seconds < 3600 { return "\(Int(seconds / 60)) min ago" }
        if Calendar.current.isDateInToday(date) { return "\(Int(seconds / 3600)) hr ago" }
        if Calendar.current.isDateInYesterday(date) { return "Yesterday" }
        return short(date)
    }

    /// "Sep 21"
    static func short(_ date: Date) -> String { date.formatted(.dateTime.month(.abbreviated).day()) }

    /// "8:14 AM"
    static func time(_ date: Date) -> String { date.formatted(date: .omitted, time: .shortened) }

    /// "Sep 30, 8:02 AM"
    static func stamp(_ date: Date) -> String {
        date.formatted(.dateTime.month(.abbreviated).day().hour().minute())
    }

    /// Transcript day label: "Today 7:02 AM", "Yesterday 4:12 PM", "Sunday, Sep 21 4:12 PM".
    static func dayLabel(_ date: Date) -> String {
        let calendar = Calendar.current
        if calendar.isDateInToday(date) { return "Today \(time(date))" }
        if calendar.isDateInYesterday(date) { return "Yesterday \(time(date))" }
        return date.formatted(.dateTime.weekday(.wide).month(.abbreviated).day()) + " " + time(date)
    }

    /// "0:24", "12:03"
    static func elapsed(_ seconds: TimeInterval) -> String {
        let total = max(Int(seconds), 0)
        return "\(total / 60):" + String(format: "%02d", total % 60)
    }

    /// "41s", "2m 5s"
    static func duration(_ seconds: Double) -> String {
        let total = max(Int(seconds.rounded()), 0)
        return total < 60 ? "\(total)s" : "\(total / 60)m \(total % 60)s"
    }
}

enum Channel {
    static func name(_ channel: String) -> String {
        switch channel {
        case "app": "Mac"
        case "telegram": "Telegram"
        case "email": "Email"
        case "siri": "Siri"
        default: channel.capitalized
        }
    }
    static func symbol(_ channel: String) -> String {
        switch channel {
        case "telegram": "paperplane"
        case "email": "envelope"
        case "siri": "waveform"
        default: "bubble.left"
        }
    }
}

enum ByteSize {
    static func format(_ bytes: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
    }
}

extension CachedSession {
    var isForeign: Bool { channel != "app" }
    var isEarlier: Bool { endedAt != nil }
    var isAppTopic: Bool { channel == "app" && !isMain }
    /// Earlier sessions accept a send (forked into a copy) only while their transcript survives.
    var isWritable: Bool { endedAt == nil || resumable }
    var started: Date? { BusDate.parse(startedAt) }
    var lastActive: Date? { BusDate.parse(lastActivity) }
    var ended: Date? { BusDate.parse(endedAt) }
}

extension CachedMessage {
    var date: Date? { BusDate.parse(createdAt) }
    var isOperator: Bool { direction == "inbound" }
}

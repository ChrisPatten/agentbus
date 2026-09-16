import os

/// Unified logging. Never log tokens or full reply bodies — only ids, timings, and outcomes.
/// Read on device with Console.app or `log stream --predicate 'subsystem == "com.chrispatten.peggy"'`.
enum PeggyLog {
    static let intent = Logger(subsystem: "com.chrispatten.peggy", category: "intent")
    static let settings = Logger(subsystem: "com.chrispatten.peggy", category: "settings")
}

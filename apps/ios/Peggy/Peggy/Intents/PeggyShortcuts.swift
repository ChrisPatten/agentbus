import AppIntents

/// Registers the spoken phrases. Every phrase must contain `\(.applicationName)`;
/// the display name is "Peggy", so "Ask Peggy" is the literal trigger (PRD FR-21).
struct PeggyShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: AskPeggyIntent(),
            phrases: [
                "Ask \(.applicationName)",
                "Ask \(.applicationName) a question",
                "Talk to \(.applicationName)",
                "Hey \(.applicationName)",
            ],
            shortTitle: "Ask Peggy",
            systemImageName: "bubble.left.and.text.bubble.right"
        )
    }

    static let shortcutTileColor: ShortcutTileColor = .navy
}

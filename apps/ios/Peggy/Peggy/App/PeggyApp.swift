import AppIntents
import SwiftUI

@main
struct PeggyApp: App {
    init() {
        // Keep the "Ask Peggy" phrases registered with Siri on every launch (PRD FR-21).
        PeggyShortcuts.updateAppShortcutParameters()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
        }
    }
}

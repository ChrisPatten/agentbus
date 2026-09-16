import SwiftUI

/// POC root: Settings only. History (SwiftData) arrives in E45.
struct RootView: View {
    var body: some View {
        NavigationStack {
            SettingsView()
        }
    }
}

#Preview {
    RootView()
}

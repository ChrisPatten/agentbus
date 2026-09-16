import AppIntents
import SwiftUI

/// Minimal setup screen (E44 / S44.4): bus URL, tokens, wait budget, "Test connection".
struct SettingsView: View {
    @AppStorage(Settings.Key.baseURL) private var baseURL = ""
    @AppStorage(Settings.Key.siriToken) private var siriToken = ""
    @AppStorage(Settings.Key.busToken) private var busToken = ""
    @AppStorage(Settings.Key.waitBudget) private var waitBudget = Settings.defaultWaitBudgetSeconds

    @State private var testing = false
    @State private var testResult: TestResult?
    @State private var showSiriTip = true

    enum TestResult: Equatable {
        case ok(HealthResponse)
        case failed(String)
    }

    var body: some View {
        Form {
            Section {
                TextField("https://mini.tailnet.ts.net", text: $baseURL)
                    .keyboardType(.URL)
                    .textContentType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                SecureField("Siri token", text: $siriToken)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                SecureField("Bus token (optional)", text: $busToken)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            } header: {
                Text("Bus")
            } footer: {
                Text("The bus URL is your Mac's Tailscale HTTPS name. The Siri token is SIRI_TOKEN_CHRIS from the bus's .env. Stored in UserDefaults for the POC.")
            }

            Section {
                HStack {
                    Text("Wait for a reply")
                    Spacer()
                    Text("\(Int(waitBudget)) s").monospacedDigit().foregroundStyle(.secondary)
                }
                Slider(value: $waitBudget, in: Settings.waitBudgetRange, step: 1)
            } header: {
                Text("Timing")
            } footer: {
                Text("How long the intent waits for Peggy before Siri says she's still working on it. Siri's own cutoff is measured in Gate 2.")
            }

            Section {
                Button {
                    Task { await testConnection() }
                } label: {
                    HStack {
                        Text("Test connection")
                        if testing { Spacer(); ProgressView() }
                    }
                }
                .disabled(testing || baseURL.isEmpty || siriToken.isEmpty)

                if let testResult {
                    switch testResult {
                    case .ok(let health):
                        Label(statusLine(for: health), systemImage: health.routed ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                            .foregroundStyle(health.routed ? .green : .orange)
                    case .failed(let message):
                        Label(message, systemImage: "xmark.octagon.fill").foregroundStyle(.red)
                    }
                }
            } header: {
                Text("Connection")
            }

            Section {
                SiriTipView(intent: AskPeggyIntent(), isVisible: $showSiriTip)
                ShortcutsLink()
            } header: {
                Text("Siri")
            } footer: {
                Text("Say “Hey Siri, ask Peggy”. Siri asks for the question, then speaks her answer.")
            }
        }
        .navigationTitle("Peggy")
    }

    private func statusLine(for health: HealthResponse) -> String {
        let agent = health.agent ?? "no route"
        let version = health.version ?? "?"
        let adapterState = health.adapters?.values.first ?? "unknown"
        return health.routed
            ? "Connected · routed to \(agent) (\(adapterState)) · bus \(version)"
            : "Reachable, but no pipeline route for channel siri · bus \(version)"
    }

    @MainActor
    private func testConnection() async {
        testing = true
        defer { testing = false }
        let settings = Settings.load()
        guard let url = settings.baseURL, let token = settings.siriToken else {
            testResult = .failed("Enter the bus URL and Siri token first.")
            return
        }
        let client = BusClient(baseURL: url, siriToken: token, busToken: settings.busToken, waitBudgetSeconds: 5)
        do {
            let health = try await client.health()
            testResult = .ok(health)
            PeggyLog.settings.info("health ok routed=\(health.routed, privacy: .public) agent=\(health.agent ?? "-", privacy: .public)")
        } catch BusError.unauthorized {
            testResult = .failed("Token rejected (401). Check SIRI_TOKEN_CHRIS.")
        } catch BusError.badResponse(let code) {
            testResult = .failed(code == 404
                ? "Bus reached, but /api/v1/siri is not mounted (404). Enable adapters.siri or check the tailscale serve path."
                : "Unexpected HTTP \(code).")
        } catch BusError.unreachable(let why) {
            testResult = .failed("Unreachable: \(why)")
        } catch {
            testResult = .failed("Failed: \(error.localizedDescription)")
        }
    }
}

#Preview {
    NavigationStack { SettingsView() }
}

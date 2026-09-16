import AppIntents
import Foundation

/// What one ask came to, independent of App Intents so it can be unit-tested
/// without AppIntentsTesting (not in the iOS 26 SDK — see spike-results.md).
enum AskPeggyOutcome: Equatable, Sendable {
    case answered(String)
    case pending(requestID: String)
    case notConfigured
    case unauthorized
    case duplicate
    case rateLimited
    case unreachable

    /// Exact dialog strings from PRD FR-20. `answered` is the reply body verbatim.
    var dialogText: String {
        switch self {
        case .answered(let body):
            return body
        case .pending:
            return "Peggy's still working on it — I'll notify you when she answers."
        case .notConfigured:
            return "Open the Peggy app to set up the connection first."
        case .unauthorized:
            return "Peggy rejected the token. Open the Peggy app to fix the setup."
        case .duplicate:
            return "I just asked Peggy that — give her a moment."
        case .rateLimited:
            return "Peggy is getting too many requests right now. Try again in a minute."
        case .unreachable:
            return "I can't reach Peggy right now. Check that Tailscale is connected."
        }
    }
}

struct AskPeggyIntent: AppIntent {
    static let title: LocalizedStringResource = "Ask Peggy"
    static let description = IntentDescription("Ask Peggy a question and hear her answer.")
    /// Never bring the app to the foreground — Siri speaks the dialog (iOS 26 API, verified in the SDK).
    static let supportedModes: IntentModes = .background
    static let isDiscoverable = true

    @Parameter(title: "Question", requestValueDialog: "What would you like to ask Peggy?")
    var question: String

    static var parameterSummary: some ParameterSummary {
        Summary("Ask Peggy \(\.$question)")
    }

    /// Test seam. Production resolves the client from Settings. `nonisolated(unsafe)` is
    /// acceptable here because the value is only ever reassigned by tests before an intent runs.
    nonisolated(unsafe) static var makeClient: @Sendable () throws -> any BusClientProtocol = {
        let settings = Settings.load()
        guard let baseURL = settings.baseURL, let token = settings.siriToken, !token.isEmpty else {
            throw BusError.notConfigured
        }
        return BusClient(
            baseURL: baseURL,
            siriToken: token,
            busToken: settings.busToken,
            waitBudgetSeconds: settings.waitBudgetSeconds
        )
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let performStarted = Date()
        PeggyLog.intent.info("perform start \(performStarted.timeIntervalSince1970, privacy: .public)")

        let text = question.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            throw $question.needsValueError("What would you like to ask Peggy?")
        }

        let outcome = await Self.run(question: text, waitBudgetSeconds: Settings.load().waitBudgetSeconds)
        let spoken = SpeechSanitizer.clean(outcome.dialogText)

        let elapsedMs = Int(Date().timeIntervalSince(performStarted) * 1000)
        PeggyLog.intent.info("perform return outcome=\(String(describing: outcome).prefix(24), privacy: .public) total_ms=\(elapsedMs, privacy: .public)")
        return .result(dialog: IntentDialog(full: "\(spoken)", supporting: "\(spoken)"))
    }

    /// The whole ask minus App Intents plumbing — what the unit tests exercise directly.
    static func run(question: String, waitBudgetSeconds: Double) async -> AskPeggyOutcome {
        let client: any BusClientProtocol
        do {
            client = try makeClient()
        } catch {
            return .notConfigured
        }

        let requestID = UUID().uuidString
        let started = Date()
        do {
            switch try await client.ask(question, requestID: requestID, waitSeconds: waitBudgetSeconds) {
            case .answered(let body, _):
                PeggyLog.intent.info("answered request_id=\(requestID.prefix(8), privacy: .public) client_ms=\(Int(Date().timeIntervalSince(started) * 1000), privacy: .public)")
                return .answered(body)
            case .pending(let id):
                PeggyLog.intent.info("pending request_id=\(id.prefix(8), privacy: .public) client_ms=\(Int(Date().timeIntervalSince(started) * 1000), privacy: .public)")
                return .pending(requestID: id)
            }
        } catch BusError.notConfigured {
            return .notConfigured
        } catch BusError.unauthorized {
            return .unauthorized
        } catch BusError.duplicate {
            return .duplicate
        } catch BusError.rateLimited {
            return .rateLimited
        } catch {
            PeggyLog.intent.error("ask failed: \(String(describing: error), privacy: .public)")
            return .unreachable
        }
    }
}

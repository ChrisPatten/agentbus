import Foundation

/// App settings.
///
/// POC ONLY: the Siri token and bus token are stored in `UserDefaults` alongside the
/// non-secret settings. That is deliberate for E44 (one device, one operator, fastest
/// path to a spoken answer) and is replaced by the Keychain wrapper in E45 / S45.1
/// (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, so a background intent can
/// still read it). Do not ship this beyond personal testing.
struct Settings: Sendable, Equatable {
    enum Key {
        static let baseURL = "baseURL"
        static let siriToken = "siriToken"
        static let busToken = "busToken"
        static let waitBudget = "waitBudget"
    }

    static let defaultWaitBudgetSeconds: Double = 20   // revisit after the Gate 2 cutoff sweep
    static let waitBudgetRange: ClosedRange<Double> = 5...25

    var baseURL: URL?
    var siriToken: String?
    var busToken: String?
    var waitBudgetSeconds: Double

    static func load(from defaults: UserDefaults = .standard) -> Settings {
        let raw = defaults.string(forKey: Key.baseURL)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let budget = defaults.object(forKey: Key.waitBudget) as? Double ?? defaultWaitBudgetSeconds
        return Settings(
            baseURL: raw.isEmpty ? nil : URL(string: raw),
            siriToken: defaults.string(forKey: Key.siriToken).flatMap { $0.isEmpty ? nil : $0 },
            busToken: defaults.string(forKey: Key.busToken).flatMap { $0.isEmpty ? nil : $0 },
            waitBudgetSeconds: min(max(budget, waitBudgetRange.lowerBound), waitBudgetRange.upperBound)
        )
    }

    func save(to defaults: UserDefaults = .standard) {
        defaults.set(baseURL?.absoluteString ?? "", forKey: Key.baseURL)
        defaults.set(siriToken ?? "", forKey: Key.siriToken)
        defaults.set(busToken ?? "", forKey: Key.busToken)
        defaults.set(waitBudgetSeconds, forKey: Key.waitBudget)
    }

    var isConfigured: Bool {
        baseURL != nil && !(siriToken ?? "").isEmpty
    }
}

# Peggy (iOS)

The smallest app that lets Siri ask Peggy a question and speak the answer: an
`Ask Peggy` App Shortcut whose `AskPeggyIntent` posts the spoken question to
the bus's `POST /api/v1/siri/ask` over Tailscale and returns Peggy's reply as
Siri dialog. The app never comes to the foreground when the intent runs. This
is the E44 proof of concept; hardening (Keychain, late-reply notifications,
history, TestFlight) is E45.

## Build

```bash
brew install xcodegen                                   # once
cd apps/ios/Peggy
export DEVELOPMENT_TEAM=ABCDE12345                      # your 10-character Apple Team ID (see below)
xcodegen generate                                       # writes Peggy.xcodeproj (git-ignored)
xcodebuild -project Peggy.xcodeproj -scheme Peggy \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro Max,OS=27.0' test
```

Requirements on the Mac: Xcode 27 with the iOS 27 simulator runtime
(`xcodebuild -downloadPlatform iOS`). The project targets iOS 27.0. Create
the simulator once if it does not exist:

```bash
xcrun simctl create "iPhone 16 Pro Max" "iPhone 16 Pro Max" com.apple.CoreSimulator.SimRuntime.iOS-27-0
```

### Finding your Team ID

`DEVELOPMENT_TEAM` is the 10-character alphanumeric Team ID, for example
`ABCDE12345`. It is not secret (it ships inside every app's entitlements),
but it is personal, so it is read from the environment rather than committed.
Where to read yours:

- Xcode → Settings → Accounts → select your Apple ID → the team list shows
  the ID next to each team name. A free Apple ID shows one "Personal Team".
- Or [developer.apple.com/account](https://developer.apple.com/account) →
  Membership details → Team ID (paid accounts).

Put it in your shell profile so `xcodegen generate` always picks it up:

```bash
echo 'export DEVELOPMENT_TEAM=ABCDE12345' >> ~/.zshrc
```

If you generate without it, the project still builds for the simulator; you
just pick the team in Xcode before the first device install.

## Install on your iPhone 16 Pro Max

The iPhone 16 Pro Max on iOS 27 supports Siri AI, so both the classic App
Shortcut path and the Siri AI one-shot test in Gate 2 apply.

1. `open Peggy.xcodeproj`, select the **Peggy** target → *Signing &
   Capabilities*, and confirm the team (a free Apple ID works for a personal
   device). If you exported `DEVELOPMENT_TEAM` before `xcodegen generate` it
   is already filled in.
2. Plug in the phone (or pair it over Wi-Fi), choose **iPhone 16 Pro Max**
   as the run destination, and press Run once. Turn on *Developer Mode* under
   *Settings → Privacy & Security* if iOS asks, and trust the developer
   certificate under *Settings → General → VPN & Device Management*.
   From the command line, once signing is set up:

   ```bash
   xcrun devicectl list devices                          # copy the phone's identifier
   xcodebuild -project Peggy.xcodeproj -scheme Peggy \
     -destination 'platform=iOS,id=<identifier>' -allowProvisioningUpdates build
   ```
3. Open the app and fill in **Settings**:
   - Bus URL: `https://<mac>.<tailnet>.ts.net` (see "Expose the bus" below).
   - Siri token: the value of `SIRI_TOKEN_CHRIS` in the bus's `.env`.
   - Bus token: only if `bus.auth_token` is set in `config.yaml`.
   - Wait for a reply: leave at 20 s until the Gate 2 sweep says otherwise.
4. Tap **Test connection**. Expected: "Connected · routed to agent:peggy
   (external) · bus 0.11.0" — `external` is the claude-code MCP connector, which
   runs outside the bus process.
5. Say **"Hey Siri, ask Peggy"**. Siri asks "What would you like to ask
   Peggy?", you answer, and Siri speaks her reply. Also try "Ask Peggy what
   day it is" in one breath to see whether Siri fills the question directly.

Tailscale must be connected on the phone (turn on *Connect on demand* so
cellular asks work).

## Expose the bus on the tailnet

On the Mac that runs bus-core:

```bash
tailscale serve --bg --https=443 --set-path /api/v1/siri http://127.0.0.1:3000/api/v1/siri
```

`config.yaml` needs `adapters.siri.enabled: true`, a `siri` token on your
contact, and a `pipeline.routes` rule for `channel: siri`. Details in
`docs/SIRI_ADAPTER.md`.

## Gate 2 measurements

Record everything in
`_bmad-output/planning-artifacts/siri-bridge/spike-results.md` → Gate 2:

- Hands-free ask with the screen locked, from AirPods, and (if available)
  CarPlay.
- Siri AI one-shot: "Ask Peggy what day it is" and two paraphrases; note
  whether the follow-up prompt is skipped.
- Cutoff sweep: set `adapters.siri.debug_delay_ms` on the bus to 10000, 15000,
  20000, 25000, 30000 in turn (restart each time), ask a trivial question, and
  note the largest delay at which Siri still speaks the reply. Set it back to
  0 afterwards.
- Siri overhead: the app logs `perform start` / `perform return` with
  timestamps under subsystem `com.chrispatten.peggy`; combine with the bus's
  `timing` field to get hand-off and TTS-start overhead. Read the log in
  Console.app or with
  `log stream --predicate 'subsystem == "com.chrispatten.peggy"'` while the
  phone is connected.
- Ask the same question twice within 30 s and confirm Siri says "I just asked
  Peggy that — give her a moment."

## Layout

```
project.yml                         XcodeGen spec (Peggy.xcodeproj is generated)
Peggy/App/                          PeggyApp, RootView
Peggy/Intents/                      AskPeggyIntent (+ AskPeggyOutcome), PeggyShortcuts
Peggy/Networking/                   BusClient (actor), BusModels (DTOs mirroring the bus contract)
Peggy/Storage/Settings.swift        UserDefaults-backed settings (POC; Keychain in E45)
Peggy/Speech/SpeechSanitizer.swift  Markdown → spoken prose
Peggy/Views/SettingsView.swift      Setup screen with Test connection, Siri tip, Shortcuts link
PeggyTests/                         AskPeggyIntentTests (dialog outcomes), AskPeggyIntentFrameworkTests (AppIntentsTesting),
                                    BusClientTests, SpeechSanitizerTests, MockBusClient
```

## Known limitations of the POC

- Tokens are in `UserDefaults`, not the Keychain.
- A `pending` answer is spoken but nothing fetches the late reply yet; the
  reply lands in the bus transcript only.
- No history screen.
- Requires the bus to be reachable at ask time; there is no offline queue.

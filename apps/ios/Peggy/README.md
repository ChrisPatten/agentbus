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
export DEVELOPMENT_TEAM=XXXXXXXXXX                      # your Apple team id, only for device builds
xcodegen generate                                       # writes Peggy.xcodeproj (git-ignored)
xcodebuild -project Peggy.xcodeproj -scheme Peggy \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test
```

Requirements on the Mac: Xcode 26.0.1 or newer with the iOS 26 simulator
runtime. The project targets iOS 26.0 today; installing on an iPhone running
iOS 27 needs Xcode 27.

## Install on your iPhone

1. `open Peggy.xcodeproj`, select the **Peggy** target → *Signing &
   Capabilities*, and pick your team (a free Apple ID works for a personal
   device). If you exported `DEVELOPMENT_TEAM` before `xcodegen generate` this
   is already set.
2. Plug in the phone (or pair it over Wi-Fi), pick it as the run destination,
   and press Run once. Trust the developer certificate on the phone under
   *Settings → General → VPN & Device Management* if iOS asks.
3. Open the app and fill in **Settings**:
   - Bus URL: `https://<mac>.<tailnet>.ts.net` (see "Expose the bus" below).
   - Siri token: the value of `SIRI_TOKEN_CHRIS` in the bus's `.env`.
   - Bus token: only if `bus.auth_token` is set in `config.yaml`.
   - Wait for a reply: leave at 20 s until the Gate 2 sweep says otherwise.
4. Tap **Test connection**. Expected: "Connected · routed to agent:peggy
   (online) · bus 0.11.0".
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
PeggyTests/                         AskPeggyIntentTests, BusClientTests, SpeechSanitizerTests, MockBusClient
```

## Known limitations of the POC

- Tokens are in `UserDefaults`, not the Keychain.
- A `pending` answer is spoken but nothing fetches the late reply yet; the
  reply lands in the bus transcript only.
- No history screen.
- Requires the bus to be reachable at ask time; there is no offline queue.

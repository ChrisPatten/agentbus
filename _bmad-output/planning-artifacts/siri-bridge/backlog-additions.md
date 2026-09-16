<!-- Append to _bmad-output/backlog.md under "## Ideas". These are the items the Siri Bridge planning deliberately left out. -->

### Siri Extensions / Model Delegation: expose Peggy as a third-party model in Siri's "Ask…" menu (blocked on Apple)
iOS 27 contains a Model Delegation API in App Intents that lets an app register as a Siri "extension" (a developer demonstrated Claude in it during the betas), but it requires the private `com.apple.developer.model-delegation` entitlement and is not in the GA release notes (see `_bmad-output/planning-artifacts/siri-bridge/research-ios27-siri.md` §4). When Apple opens it (rumoured ~27.4), the Peggy app could register the bus as the delegate model — Siri would hand whole conversations to Peggy rather than single intents. Revisit when the entitlement is public; the `siri` channel's `POST /ask` contract is the obvious backend.

### MCP in App Intents / Siri AI — watch item
Secondary sources claimed iOS 27 would make MCP servers callable from Siri AI; nothing in Apple's release notes or WWDC26 sessions confirms it (research §4). If an official API appears, AgentBus is already an MCP server (`src/mcp/server.ts`) and could register directly, bypassing the `siri` channel for tool-style calls. Check each point release's App Intents section.

### Peggy app: watchOS and macOS targets
Siri on Apple Watch and Mac runs the platform's own app intents. Adding `PeggyWatch` (watchOS 27) and a Mac Catalyst/macOS target to `apps/ios/Peggy/project.yml` reuses `BusClient` + `AskPeggyIntent` unchanged. Needs: Keychain sharing via App Group or per-device setup, and a Watch-appropriate hand-off (notification only).

### Siri Bridge: Cloudflare Tunnel (or other non-VPN exposure) as an alternative to Tailscale
If Tailscale on-demand proves flaky on cellular for Siri-triggered intents, expose only `/api/v1/siri/*` through a Cloudflare Tunnel with an Access service token (sent as an extra header by the app). Keep the per-contact bearer token as the identity; the tunnel only replaces the network boundary.

### Siri Bridge: tool-call status stream → Live Activity
`SiriAdapter.reportToolCall` already stores E29 status lines per request (`siri_requests.status_lines`). A `LongRunningIntent` variant (E45 spike) or a Live Activity started by the app could show "Checking your calendar…" while Peggy works. Only worth it if the hand-off path is common in the soak data.

### cc-headless: per-conversation (not per-contact) serialization queue for the `siri` channel
A Siri ask currently queues behind any in-flight Peggy turn for the same contact on another channel (`HeadlessInstance.enqueue` keys on contactId). If Gate 1/soak data shows this hurting spoken-answer latency and the fast-lane instance is undesirable, key the queue by `conversation_id` when the channel is `siri` (or generally, with the interrupt-and-combine item above in mind).

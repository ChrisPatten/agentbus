# Intercom core: implementation stack (memo for M0)

Nov 7, 2026. The question: the Mac app is native, so what is the core written in? By "core" I mean everything beneath the UI: the conversation store, the harness supervisor (tmux panes, `claude -p`, Codex, opencode), the scheduler, the MCP tool server, the Surface API server (HTTP and WebSocket) and the Telegram and email adapters.

Facts below were checked in the repo and on bobafett today. Opinions are marked *Peggy's view*.

## What exists

- **agentbus core:** TypeScript on Node (v25 here), about 45,000 non-test lines. Fastify, `ws`, `better-sqlite3`, Zod, Vitest.
- **Mac app (`apps/macos`) and iOS app (`apps/ios`):** Swift, 29 and 15 files. Your other tools (`calctl`, `scannerserver`, Haven) are Swift too.
- **Toolchains installed:** Node 25, Swift 6.4, tmux (Homebrew, not shipped with macOS).
- **Node is not shipped with macOS either.** A friend's Mac has neither Node nor tmux.

## What the stack has to carry

1. A friend installs one signed, notarized download and needs nothing else first. The app fixes missing dependencies (tmux, Claude Code).
2. The core supervises long-lived child processes and survives their crashes (the E88 lesson: never trust a name, keep state on disk).
3. It serves a documented HTTP and WebSocket API to the Compact, the Kindle and the Phase client, and speaks MCP to harnesses.
4. It runs on a laptop that sleeps: schedules fire late, inbound messages queue.
5. It is public and MIT licensed, so outside contributors should be able to build it.

## The options

**A. Swift app plus a TypeScript core, bundled.** The app embeds a Node runtime and the core, and spawns it as a child (the E77 design).
- For: the prototypes in agentbus carry over directly; the TypeScript is already tested; fastest to the walking skeleton.
- Against: two languages and two toolchains; the app must ship and notarize a Node binary and the native `better-sqlite3` module (large bundle, fiddly signing, security updates of Node become your job); the core's process model is still pm2-shaped.

**B. All Swift: one package with a core library, a headless daemon (`intercomd`) and the app.** *Peggy's view: the better long-term shape, with a spike first.*
- For: one toolchain and one signed bundle; no runtime to ship; the app and the core share types, so the Surface API shapes are written once; a headless daemon is still possible for testing and for hosting without the UI later; launchd and the menu bar are native.
- Against: nothing carries over as code, only as design (the fresh repo already implies this); Swift 6 concurrency has a learning curve; the server-side libraries (HTTP, WebSocket, SQLite, MCP) must be chosen and are less battle-tested than Node's; fewer open-source contributors know Swift than TypeScript.
- Not verified by me: the maturity of the Swift MCP SDK, the best WebSocket server library, and how well tmux and PTY control work from Swift. These are what the spike answers.

**C. Rust or Go core plus a Swift app.** One static binary, easy to sign, cross-platform later. Against: a third language for you, no code reuse, and no advantage over B on a Mac-first product. I would not choose it.

**D. TypeScript everywhere, in Electron or Tauri.** Contradicts the native app in the brief. Listed for completeness.

## Which parts the choice does not touch

- The Surface API is a wire protocol, so the Compact, Kindle and Phone clients are unaffected.
- Harnesses are separate processes behind the harness interface, in any option.
- The prototypes in agentbus are throwaway in every option; they validate concepts, not code.

## Recommendation

*Peggy's view:* Option B, decided after a short spike. A is faster for a week and slower for the whole project, because the bundling and signing cost lands exactly on the first-run experience the brief cares most about.

**The spike (M0 exit):** a small `intercomd` that (1) serves one conversation over WebSocket to a minimal client, (2) stores messages in SQLite, (3) launches Claude Code in a tmux pane and via `claude -p` and relays a round trip, (4) exposes one MCP tool, and (5) survives a killed child. If those five work cleanly in Swift, choose B. If MCP or process control fights back, fall back to A and bundle Node.

## Decision needed

Approve the spike, or choose A, B or another option now.

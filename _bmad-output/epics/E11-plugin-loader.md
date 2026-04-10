# E11 — Plugin Loader + Adapter Interface

| Field | Value |
|---|---|
| Epic ID | E11 |
| Build Order Position | 11 of 12 (but should be finalized before or alongside E3/E4 to ensure interface stability) |
| Dependencies | E1 (AdapterRegistry) |
| Story Count | 2 |
| Estimated Complexity | S |

---

## Epic Summary

E11 locks down the `AdapterInstance` TypeScript interface and adds config-driven adapter plugin support to the `AdapterRegistry`. This epic serves two purposes: ensuring all built-in adapters (Telegram, BlueBubbles, Claude Code) implement a stable, consistent contract, and laying the foundation for community or custom adapters to be declared in config and loaded at startup from npm packages.

Plugin loading is static and config-driven — plugins are declared in `config.yaml` and resolved at boot time using Node's ESM `import()`. Agents cannot load or register plugins at runtime; the bus surface is fixed once startup completes. After E11, the adapter surface is a defined, documented extension point.

---

## Entry Criteria

- E1 complete: `AdapterRegistry` exists with `register()`, `lookup()`, `list()`, `deregister()`
- E3 and E4 are complete (or at minimum their adapter classes exist as working code) so the interface can be finalized against real implementations
- E2 is complete so the Claude Code adapter's interface requirements are known
- A decision has been made on whether plugin packages are loaded from `node_modules` (npm install required first) or from a local path

---

## Exit Criteria

- `interface AdapterInstance` is exported from `/src/adapters/interface.ts` with full JSDoc
- All three built-in adapters (Telegram, BlueBubbles, Claude Code) implement the interface without TypeScript errors
- `AdapterRegistry.loadFromConfig()` successfully loads built-in adapters from config and logs a warning (not an error) when an npm plugin package is not found
- TypeScript compilation (`tsc --noEmit`) passes with `strict: true` across all adapter files
- Interface file is treated as stable: any future changes require a changelog entry (documented in the repo's `CHANGELOG.md`)

---

## Stories

### S11.1 — Finalize AdapterInstance Interface

**User story:** As a future adapter developer, I want a fully documented `AdapterInstance` TypeScript interface so that I can build a conforming adapter without reading the bus-core source code.

**Acceptance criteria:**
- `interface AdapterInstance` exported from `/src/adapters/interface.ts` includes:
  - `readonly id: string` — unique adapter identifier
  - `readonly capabilities: AdapterCapabilities` — capability flags
  - `start(): Promise<void>` — initialize connections, start loops; called once at startup
  - `stop(): Promise<void>` — graceful shutdown; called on SIGTERM/SIGINT
  - `sendMessage(envelope: Envelope): Promise<void>` — deliver an outbound message
  - `markRead?(messageId: string, context?: Record<string, unknown>): Promise<void>` — optional, if `canMarkRead`
  - `sendTyping?(chatId: string): Promise<void>` — optional, if `canTypingIndicator`
  - `react?(messageId: string, emoji: string): Promise<void>` — optional, if `canReact`
  - `registerCommands?(commands: CommandManifest[]): Promise<void>` — optional, if `canRegisterCommands`
- Every method and property has a JSDoc comment explaining parameters, return value, and expected error behavior
- `AdapterCapabilities` and `CommandManifest` interfaces are co-located in the same file and re-exported
- TypeScript compilation with `strict: true` confirms all three built-in adapters satisfy the interface (use `satisfies AdapterInstance` assertions in each adapter file)

**Complexity:** S

---

### S11.2 — Config-Driven Adapter Plugin Loading

**User story:** As a system operator, I want to declare a custom adapter in `config.yaml` and have it load at startup so that community or custom adapters can be added without modifying bus-core source code.

**Acceptance criteria:**
- `AdapterRegistry.loadFromConfig(config: AppConfig): Promise<void>` iterates `config.adapters[]` and for each entry:
  - If `plugin` field is absent: loads the built-in adapter by `type` (e.g., `type: "telegram"` → imports `/src/adapters/telegram/index.ts`)
  - If `plugin` field is present (e.g., `plugin: "@agentbus/adapter-discord"`): attempts `await import(plugin)` dynamically; expects default export to be a factory function `(config: AdapterConfig) => AdapterInstance`
- If dynamic import fails (package not installed), logs `warn: "Plugin not found: @agentbus/adapter-discord — skipping. Run npm install @agentbus/adapter-discord to enable."` and continues loading remaining adapters
- If dynamic import succeeds but default export is not a function, logs `error: "Plugin @agentbus/adapter-discord did not export a factory function — skipping."` and continues
- Successfully loaded plugin adapters are registered in `AdapterRegistry` exactly like built-in adapters
- Integration test: mock a local test plugin package → verify it loads and registers correctly; specify a non-existent package → verify warning logged and startup continues

**Complexity:** S

---

## Notes

- **Interface stability is the primary deliverable.** Once `AdapterInstance` is finalized and built-in adapters satisfy it, changes should be treated like breaking API changes. Add a note in the interface file: "Semver applies to this interface. Breaking changes require a major version bump."
- **`satisfies` vs. `implements`:** In TypeScript, using `satisfies AdapterInstance` on the adapter's exported object (if it's a plain object rather than a class) gives you interface checking without requiring a class. If adapters are classes, `implements AdapterInstance` is conventional. Either works — pick one approach and use it consistently.
- **Plugin factory pattern:** The plugin is expected to export a factory: `export default function createAdapter(config: AdapterConfig): AdapterInstance`. This allows the plugin to receive its config slice without needing to import `AppConfig` — it only sees its own section. Document this in the interface file and in a `PLUGIN_AUTHORING.md`.
- **Dynamic import and ESM:** Since the project uses TypeScript ESM, dynamic `import()` works naturally. The plugin package must also be ESM-compatible. Add a note to `PLUGIN_AUTHORING.md` about the `"type": "module"` requirement in the plugin's `package.json`.
- **Build order note:** Although E11 is listed as position 11, the `AdapterInstance` interface should be drafted (even if incomplete) before E3 and E4 are written, to guide those implementations. E11's formal completion (locking the interface, verifying all adapters comply) happens after E3 and E4 are done.
- **No runtime validation of plugin exports:** The plugin loader does not use Zod to validate the returned `AdapterInstance` at load time. Type checking is a build-time guarantee for built-in adapters; for third-party plugins, it's their responsibility. A future version could add a runtime capability probe.

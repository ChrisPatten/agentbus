# Writing a Custom AgentBus Adapter

AgentBus adapters connect an external messaging platform (Telegram, iMessage, Discord, SMS, etc.) to the bus. An adapter is a self-contained npm package that implements the `AdapterInstance` interface and exports a factory function. bus-core loads it dynamically at startup via the `plugin` field in `config.yaml`.

> **Interface stability:** `AdapterInstance` follows semver. Breaking changes to the interface require a major version bump. Check `CHANGELOG.md` before upgrading.

---

## Quick Start

```bash
# Scaffold a new adapter package
mkdir agentbus-adapter-myplatform
cd agentbus-adapter-myplatform
npm init
```

Your package needs:
- `"type": "module"` in `package.json` — bus-core uses ESM; your plugin must too
- A default export that is a factory function
- No dependency on bus-core internals — only import from the published types package (once available) or copy the interface types

---

## The Factory Pattern

bus-core loads your plugin with:

```ts
const { default: factory } = await import('@yourscope/agentbus-adapter-myplatform');
const adapter = factory(config);
registry.register(adapter);
```

Your `index.ts` must default-export a factory function:

```ts
import type { AdapterInstance, AdapterConfig } from './types.js';

export default function createAdapter(config: AdapterConfig): AdapterInstance {
  return new MyPlatformAdapter(config);
}
```

`AdapterConfig` is the config slice for your adapter — the object from `config.yaml` under `adapters.myplatform`. You define its shape; bus-core passes it through without validation.

---

## The AdapterInstance Interface

Implement all required members. Optional members are only called if the corresponding capability flag is `true`.

```ts
interface AdapterInstance {
  /** Unique identifier, e.g. "myplatform". Must match the key in config.yaml. */
  readonly id: string;

  /** Human-readable name for logging and health displays */
  readonly name: string;

  /** Declare what this adapter can do. Used by bus-core for routing decisions. */
  readonly capabilities: AdapterCapabilities;

  /**
   * Called once at startup. Initialize connections, start polling loops,
   * register webhooks, etc. Must resolve before bus-core marks the adapter ready.
   * Throw if the adapter cannot start (bus-core will log and skip registration).
   */
  start(): Promise<void>;

  /**
   * Called on SIGTERM/SIGINT. Stop polling loops, flush any pending sends,
   * close connections. Should resolve within ~5 seconds.
   */
  stop(): Promise<void>;

  /**
   * Return current health status. Called by GET /api/v1/health.
   * Return `{ status: 'unhealthy' }` if the upstream API is unreachable.
   */
  health(): Promise<HealthStatus>;

  /**
   * Deliver an outbound message to the platform. Called by bus-core's routing
   * layer. Throw or return `{ success: false, retryable: true }` on failure
   * — bus-core will handle retries and dead-lettering.
   */
  send(envelope: MessageEnvelope): Promise<DeliveryResult>;

  // ── Optional capabilities ──────────────────────────────────────────────────

  /** Only called if capabilities.markRead is true */
  markRead?(platformMessageId: string): Promise<void>;

  /** Only called if capabilities.react is true */
  react?(platformMessageId: string, reaction: string): Promise<void>;

  /** Typing indicator. Only called if capabilities.typing is true. */
  typing?(chatId: string): Promise<void>;
}
```

### AdapterCapabilities

```ts
interface AdapterCapabilities {
  send: true;              // All adapters must support send — always true
  markRead?: boolean;
  react?: boolean;         // Platform supports emoji reactions / tapbacks
  typing?: boolean;        // Platform supports typing indicators
  registerCommands?: boolean;
  /** All channel strings this adapter serves, e.g. ["myplatform"] */
  channels: string[];
}
```

### DeliveryResult

```ts
interface DeliveryResult {
  success: boolean;
  /** Platform-assigned message ID on success, if available */
  platformMessageId?: string;
  error?: string;
  /** true = transient failure, worth retrying; false = permanent */
  retryable?: boolean;
}
```

### HealthStatus

```ts
interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  latencyMs?: number;
  lastActivity?: string;  // ISO 8601
  details?: Record<string, unknown>;
}
```

---

## Submitting Inbound Messages

Your adapter receives inbound messages from the platform (via webhook or polling). To submit them to bus-core, POST to the HTTP API:

```ts
// Inside your adapter's polling loop or webhook handler:
await fetch('http://localhost:3000/api/v1/messages', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    channel: 'myplatform',
    topic: 'general',          // or derive from platform context
    sender: 'contact:chris',   // resolved contact ID
    recipient: 'agent:peggy',
    reply_to: null,
    priority: 'normal',
    payload: { type: 'text', body: messageText },
    metadata: { platform_message_id: rawMessage.id },
  }),
});
```

bus-core runs the full pipeline on submission. You don't need to normalize, dedup, or classify — the pipeline does it.

---

## Minimal Working Example

```ts
// src/index.ts
import type { AdapterInstance, AdapterCapabilities, DeliveryResult, HealthStatus } from './interface.js';
import type { MessageEnvelope } from './envelope.js';

interface MyConfig {
  api_key: string;
  webhook_port: number;
}

class MyPlatformAdapter implements AdapterInstance {
  readonly id = 'myplatform';
  readonly name = 'My Platform';
  readonly capabilities: AdapterCapabilities = {
    send: true,
    channels: ['myplatform'],
  };

  private config: MyConfig;
  private running = false;

  constructor(config: MyConfig) {
    this.config = config;
  }

  async start(): Promise<void> {
    this.running = true;
    // Start webhook listener, polling loop, etc.
    console.log('myplatform adapter started');
  }

  async stop(): Promise<void> {
    this.running = false;
    // Close connections, stop loops
  }

  async health(): Promise<HealthStatus> {
    // Ping your platform API
    return { status: 'healthy' };
  }

  async send(envelope: MessageEnvelope): Promise<DeliveryResult> {
    try {
      // Call your platform's send API using envelope.payload.body
      const result = await myPlatformSend(this.config.api_key, envelope.recipient, envelope.payload.body);
      return { success: true, platformMessageId: result.id };
    } catch (err) {
      return { success: false, error: String(err), retryable: true };
    }
  }
}

export default function createAdapter(config: MyConfig): AdapterInstance {
  return new MyPlatformAdapter(config);
}
```

---

## package.json Requirements

```json
{
  "name": "@yourscope/agentbus-adapter-myplatform",
  "version": "1.0.0",
  "type": "module",
  "main": "dist/index.js",
  "exports": {
    ".": "./dist/index.js"
  },
  "scripts": {
    "build": "tsc"
  }
}
```

Key requirements:
- `"type": "module"` is mandatory — bus-core uses ESM dynamic `import()` to load plugins
- The default export must be the factory function, not a class or object
- If you use TypeScript, compile to `.js` before publishing

---

## Configuring in config.yaml

```yaml
adapters:
  myplatform:
    plugin: "@yourscope/agentbus-adapter-myplatform"
    api_key: ${MY_PLATFORM_API_KEY}
    webhook_port: 3003
```

The entire `adapters.myplatform` object is passed to your factory function as `config`. The `plugin` field is consumed by bus-core's loader and stripped before passing config to your factory.

If `plugin` is absent, bus-core looks for a built-in adapter with that name in `src/adapters/`. For third-party plugins, `plugin` is always required.

---

## Testing Locally

Without publishing to npm, point `plugin` at a local path:

```yaml
adapters:
  myplatform:
    plugin: "/absolute/path/to/your/adapter/dist/index.js"
```

Or use `npm link`:

```bash
cd /path/to/your/adapter
npm link

cd /path/to/agentbus
npm link @yourscope/agentbus-adapter-myplatform
```

Then use the package name in `config.yaml` as normal.

**If bus-core can't load the plugin** (package not found, not installed), it logs a warning and skips the adapter — startup continues. Check `pm2 logs bus-core` for: `warn: Plugin not found: @yourscope/... — skipping`.

---

## Checklist Before Publishing

- [ ] `"type": "module"` in `package.json`
- [ ] Default export is a factory function `(config) => AdapterInstance`
- [ ] All `AdapterInstance` required methods implemented: `start`, `stop`, `health`, `send`
- [ ] `capabilities.channels` correctly lists your channel string(s)
- [ ] `stop()` resolves within ~5 seconds (bus-core won't wait forever on shutdown)
- [ ] `send()` never throws — returns `{ success: false }` on failure
- [ ] Tested with `npm link` before publishing

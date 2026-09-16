# Writing an adapter

An adapter connects one messaging platform to the bus. Adapters are TypeScript classes in this repository that implement `AdapterInstance` (`src/core/registry.ts`), are constructed from `config.yaml` in `src/index.ts`, and are registered in the `AdapterRegistry` before the HTTP server starts.

There is no dynamic plugin loader. The `plugin` field that the adapter config schemas accept is not read by anything. To add a platform, add code to `src/` as described here.

## What the bus does for you

- **Inbound.** Call `processInbound()` (`src/http/api.ts`) with a minimal message. The pipeline normalizes it, resolves the contact, relays, dedups, detects slash commands, classifies, prioritizes, routes, logs the transcript, and enqueues a copy per route target. Slash commands are dispatched and answered without reaching the agent.
- **Outbound.** The `DeliveryWorker` (`src/core/delivery.ts`) dequeues every message whose recipient starts with `contact:`, resolves your adapter from `metadata.adapter_id` or by channel, and calls `send(envelope)`. A `{ success: false }` result dead-letters the message.
- **Discovery.** `AdapterRegistry.lookupByChannel()` matches `capabilities.channels` and your optional `ownsChannel()` predicate. That is how slash-command replies, reactions, typing indicators, and `send_message` find you.

## The interface

```ts
interface AdapterInstance {
  readonly id: string;                      // "telegram", "email:work", ...
  readonly name: string;
  readonly capabilities: AdapterCapabilities;

  start(): Promise<void>;                   // open connections, start loops
  stop(): Promise<void>;                    // called on SIGTERM/SIGINT
  health(): Promise<HealthStatus>;          // reported by GET /api/v1/health
  send(envelope: MessageEnvelope): Promise<DeliveryResult>;

  // Optional. Implement what the platform supports and declare it in capabilities.
  ownsChannel?(channel: string): boolean;   // dynamic channels such as "telegram:x:group:<id>"
  react?(platformMessageId: string, reaction: string): Promise<void>;
  startTyping?(contactId: string, channel?: string, topic?: string): void;
  reportToolCall?(contactId: string, text: string, channel?: string, topic?: string): void;
  finalizeDraft?(contactId: string, note: string, channel?: string, topic?: string): boolean;
  registerCommands?(commands: CommandManifest[]): Promise<void>;
  createTopic?(channel: string, name: string, context?: string): Promise<...>;
  markRead?(platformMessageId: string): Promise<void>;
}

interface AdapterCapabilities {
  send: true;
  channels: string[];        // static channels you serve
  react?: boolean;
  typing?: boolean;
  toolStatus?: boolean;      // live tool-call status stream
  registerCommands?: boolean;
  markRead?: boolean;
  maxMessageLength?: number; // default 4096
}

interface DeliveryResult { success: boolean; platformMessageId?: string; error?: string; retryable?: boolean }
interface HealthStatus { status: 'healthy' | 'degraded' | 'unhealthy'; latencyMs?: number; lastActivity?: string; details?: Record<string, unknown> }
```

`retryable` is recorded but not acted on. A failed send is dead-lettered either way.

## Steps

1. **Config schema.** Add a Zod object for your adapter under `AdaptersConfigSchema` in `src/config/schema.ts`. For multiple instances, accept a named record and add a `get<Name>Instances()` normalizer like `getTelegramInstances()`.
2. **Adapter class.** Create `src/adapters/<name>.ts`. Take a deps object in the constructor (`config`, `queue`, `pipeline`, `db`, `registry`, `commandRegistry`, `pauseSet`, and your instance config) so `processInbound()` has everything it needs. Derive the sender allowlist and any contact-to-platform-ID map from `config.contacts`.
3. **Inbound.** For each platform event, build an `InboundMessage` (`channel`, `sender`, `payload`, and optional `topic`, `metadata`, `attachments`) and `await processInbound(message, this.deps)`. Put the platform's message ID in `metadata.platform_message_id` so reactions and reply quotes work. For threaded platforms, see [THREADING.md](THREADING.md).
4. **Outbound.** Implement `send()`. Resolve the destination from `envelope.recipient` (`contact:<id>`), `envelope.channel`, and `envelope.topic`. Split long bodies if the platform has a length limit.
5. **Wire it up.** Instantiate the adapter and call `registry.register()` in `src/index.ts`, next to the Telegram and email adapters.
6. **Route it.** Add a `pipeline.routes` rule for your channel in `config.yaml`.
7. **Contact resolution.** If the platform identifies senders by something other than `contact:<id>`, add a lookup map in `src/pipeline/stages/contact-resolve.ts` and a field under `ContactPlatformsSchema`.
8. **Tests and docs.** Add `src/adapters/<name>.test.ts`, a `docs/<NAME>_ADAPTER.md` page, and a `CHANGELOG.md` entry.

## Minimal example

```ts
import type { AdapterInstance, AdapterCapabilities, DeliveryResult, HealthStatus } from '../core/registry.js';
import type { MessageEnvelope } from '../types/envelope.js';
import { processInbound, type InboundMessage } from '../http/api.js';

export class EchoAdapter implements AdapterInstance {
  readonly id = 'echo';
  readonly name = 'echo';
  readonly capabilities: AdapterCapabilities = { send: true, channels: ['echo'] };

  constructor(private readonly deps: Parameters<typeof processInbound>[1]) {}

  async start(): Promise<void> {
    const message: InboundMessage = {
      channel: 'echo',
      sender: 'contact:alice',
      payload: { type: 'text', body: 'hello' },
      metadata: { platform_message_id: '1' },
    };
    await processInbound(message, this.deps);
  }

  async stop(): Promise<void> {}

  async health(): Promise<HealthStatus> {
    return { status: 'healthy' };
  }

  async send(envelope: MessageEnvelope): Promise<DeliveryResult> {
    if (envelope.payload.type !== 'text') {
      return { success: false, error: 'text only', retryable: false };
    }
    console.log(`[echo] -> ${envelope.recipient}: ${envelope.payload.body}`);
    return { success: true, platformMessageId: '1' };
  }
}
```

## Checklist

- [ ] `capabilities.channels` lists every static channel; `ownsChannel()` covers dynamic ones.
- [ ] Unknown senders are dropped before `processInbound()`. The contacts map is the allowlist.
- [ ] `metadata.platform_message_id` is set on inbound messages.
- [ ] `send()` never throws; it returns `{ success: false }`.
- [ ] `stop()` cancels loops and resolves quickly. Use an `AbortController` for sleeps.
- [ ] Log lines use a `[<adapter id>]` prefix.
- [ ] Registered in `src/index.ts`, routed in `config.yaml`, documented in `docs/`.

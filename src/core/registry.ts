import type { MessageEnvelope } from '../types/envelope.js';
import type { CommandManifest } from '../commands/registry.js';

/** Capabilities advertised by an adapter */
export interface AdapterCapabilities {
  /** All adapters must support send */
  send: true;
  markRead?: boolean;
  /** Tapbacks (BlueBubbles), emoji reactions (Telegram) */
  react?: boolean;
  /** Typing indicators */
  typing?: boolean;
  /** Can accept slash command registration */
  registerCommands?: boolean;
  /** Channels this adapter serves, e.g. ["telegram"] */
  channels: string[];
}

export interface DeliveryResult {
  success: boolean;
  /** Platform message ID returned on success */
  platformMessageId?: string;
  error?: string;
  retryable?: boolean;
}

export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  latencyMs?: number;
  /** ISO 8601 */
  lastActivity?: string;
  details?: Record<string, unknown>;
}

/**
 * A registered adapter instance.
 * Concrete adapters implement this interface.
 */
export interface AdapterInstance {
  /** Unique adapter identifier, e.g. "telegram" | "bluebubbles" | "claude-code" */
  readonly id: string;
  /** Human-readable display name */
  readonly name: string;
  readonly capabilities: AdapterCapabilities;

  start(): Promise<void>;
  stop(): Promise<void>;
  health(): Promise<HealthStatus>;
  send(envelope: MessageEnvelope): Promise<DeliveryResult>;
  poll?(): Promise<MessageEnvelope[]>;
  markRead?(platformMessageId: string): Promise<void>;
  react?(platformMessageId: string, reaction: string): Promise<void>;
  /** Start a typing indicator for a contact. Called when the agent confirms receipt. */
  startTyping?(contactId: string): void;
  /**
   * Register slash commands with the platform (e.g. Telegram setMyCommands).
   * Called at startup after all commands are registered. Failure is non-fatal.
   */
  registerCommands?(commands: CommandManifest[]): Promise<void>;
}

export type { CommandManifest };

/**
 * Registry of active adapter instances.
 *
 * The routing layer uses this to look up the correct adapter for any outbound
 * message without hardcoded conditionals.
 */
export class AdapterRegistry {
  private readonly adapters = new Map<string, AdapterInstance>();

  /**
   * Register an adapter.
   * Throws if an adapter with the same `id` is already registered.
   */
  register(adapter: AdapterInstance): void {
    if (this.adapters.has(adapter.id)) {
      throw new Error(`Adapter "${adapter.id}" is already registered`);
    }
    this.adapters.set(adapter.id, adapter);
  }

  /**
   * Look up an adapter by its ID.
   * Returns `undefined` if not found.
   */
  lookup(adapterId: string): AdapterInstance | undefined {
    return this.adapters.get(adapterId);
  }

  /**
   * Return all adapters that declare the given channel in their
   * `capabilities.channels[]`.
   */
  lookupByChannel(channel: string): AdapterInstance[] {
    return Array.from(this.adapters.values()).filter((a) =>
      a.capabilities.channels.includes(channel)
    );
  }

  /**
   * Return all registered adapters with their full capability objects.
   */
  list(): AdapterInstance[] {
    return Array.from(this.adapters.values());
  }

  /**
   * Remove an adapter from the registry (used during graceful shutdown).
   * Returns `true` if the adapter was found and removed, `false` otherwise.
   */
  deregister(adapterId: string): boolean {
    return this.adapters.delete(adapterId);
  }
}

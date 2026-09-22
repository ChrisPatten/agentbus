import type { MessageEnvelope } from '../types/envelope.js';
import type { CommandManifest } from '../commands/registry.js';
import type { ApprovalRequest } from '../approvals/types.js';

/** Capabilities advertised by an adapter */
export interface AdapterCapabilities {
  /** All adapters must support send */
  send: true;
  markRead?: boolean;
  /** Tapbacks (BlueBubbles), emoji reactions (Telegram) */
  react?: boolean;
  /** Typing indicators */
  typing?: boolean;
  /** Live tool-call status stream — a single evolving message showing what the
   * agent is doing mid-turn (E29). Telegram only today. */
  toolStatus?: boolean;
  /**
   * Can notify a human of a pending interactive-approval request (Approve/
   * Deny buttons or equivalent) and accept the human's answer back (E51).
   * Telegram only today — see src/approvals/dispatch.ts.
   */
  interactiveApproval?: boolean;
  /** Can accept slash command registration */
  registerCommands?: boolean;
  /** Maximum message length in characters. Default: 4096 (Telegram limit) */
  maxMessageLength?: number;
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
  /**
   * True if this adapter instance handles `channel`, beyond what's listed in
   * its static `capabilities.channels[]` — e.g. a Telegram group channel
   * derived per-message (`telegram:group:<chatId>`) that was never
   * statically registered (E28). The registry's channel lookups consult this
   * in addition to `capabilities.channels`.
   */
  ownsChannel?(channel: string): boolean;
  /**
   * Start a typing indicator for a contact. Called when the agent confirms
   * receipt. `channel` disambiguates which chat to target when a single
   * adapter instance serves more than one chat per contact (e.g. a Telegram
   * contact's DM vs. a group channel, E28) — omitted, it defaults to the
   * contact's primary chat. `topic` further disambiguates a specific forum
   * topic within a group channel, so the indicator lands in the topic being
   * discussed rather than just the right group — omitted, or a non-thread
   * topic, targets the group's general area.
   */
  startTyping?(contactId: string, channel?: string, topic?: string): void;
  /**
   * Report a live tool-call status line for a contact's in-flight turn (E29).
   * Fire-and-forget — called once per non-delivery tool call as the agent
   * works. No-op unless the adapter declares `capabilities.toolStatus`.
   * `channel`/`topic` disambiguate the target chat/topic, as with `startTyping`.
   * `placeholder: true` marks this call as a cold-start stand-in (e.g.
   * cc-pool's "One moment" line, posted before a pane has even launched) —
   * an implementing adapter should replace rather than append to it on the
   * next call for the same contact/channel/topic, since it's a stand-in for
   * real activity, not activity itself.
   */
  reportToolCall?(contactId: string, text: string, channel?: string, topic?: string, placeholder?: boolean): void;
  /**
   * Finalize the live tool-call status draft for a contact (E29 / `/stop`):
   * append `note` as a final line and stop treating the message as an
   * editable draft, so it persists in the conversation as-is. Returns true
   * if a draft was open and finalized, false if there was nothing to do —
   * callers use this to decide whether `note` already reached the user (so
   * they can skip sending a separate confirmation). `channel`/`topic`
   * disambiguate the target chat/topic, as with `startTyping`.
   */
  finalizeDraft?(contactId: string, note: string, channel?: string, topic?: string): boolean;
  /**
   * Register slash commands with the platform (e.g. Telegram setMyCommands).
   * Called at startup after all commands are registered. Failure is non-fatal.
   */
  registerCommands?(commands: CommandManifest[]): Promise<void>;
  /**
   * Create a new thread-scoped topic on this channel (E28 — Telegram forum
   * topics). Group-only; adapters without topic support simply don't
   * implement this. Always starts a brand-new session — the topic has never
   * existed before, so there is no prior conversation to inherit. `context`,
   * when given, is injected into the agent's first turn on this topic only
   * (one-shot). Returns the `thread:<hash>` topic the caller can target on a
   * later send.
   */
  createTopic?(
    channel: string,
    name: string,
    context?: string,
  ): Promise<{ ok: true; topic: string; message_thread_id: number; name: string } | { ok: false; error: string }>;
  /**
   * Put a pending interactive-approval request in front of the human it's
   * addressed to — Telegram's implementation sends Approve/Deny inline-
   * keyboard buttons (E51). Only called when `capabilities.interactiveApproval`
   * is true (src/approvals/dispatch.ts). Returns the platform channel +
   * message id the request landed on, stored back onto the
   * `approval_requests` row so `finalizeApproval` can find it again once the
   * request reaches a terminal state.
   */
  notifyApproval?(request: ApprovalRequest): Promise<{ channel: string; messageId: string }>;
  /**
   * Edit a previously-sent approval notification to remove any live
   * Approve/Deny controls and show the final outcome, once `request` has
   * reached a terminal status (approved/denied/expired/stale) — called by
   * the expiry sweep (E51 S51.6) for the case nobody tapped a button in
   * time. The interactive tap path (Telegram's own callback_query handler)
   * already has the message in hand and edits it directly without going
   * through this seam.
   */
  finalizeApproval?(request: ApprovalRequest): Promise<void>;
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
   * `capabilities.channels[]`, or whose `ownsChannel(channel)` returns true
   * (e.g. a dynamically-derived Telegram group channel, E28).
   */
  lookupByChannel(channel: string): AdapterInstance[] {
    return Array.from(this.adapters.values()).filter(
      (a) => a.capabilities.channels.includes(channel) || a.ownsChannel?.(channel) === true,
    );
  }

  /**
   * Return the primary adapter for a channel — the first registered adapter
   * that declares the channel in its `capabilities.channels[]`.
   *
   * This makes the "first registered wins" policy explicit and centralised.
   * Use this wherever a single adapter must be selected from a channel name,
   * e.g. command dispatch, pause checks, and fallback delivery.
   */
  lookupPrimaryByChannel(channel: string): AdapterInstance | undefined {
    return this.lookupByChannel(channel)[0];
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

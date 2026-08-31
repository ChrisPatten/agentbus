/**
 * Delivery worker — dequeues contact-bound messages and dispatches them
 * to the appropriate platform adapter's send() method.
 *
 * Runs as a background loop in bus-core. Only handles messages for platform
 * adapters (recipients starting with "contact:"). Messages for agent
 * connectors (recipients starting with "agent:") remain in the queue for
 * the CC adapter to poll via GET /api/v1/messages/pending.
 */
import type Database from 'better-sqlite3';
import type { MessageQueue } from './queue.js';
import type { AdapterRegistry, AdapterInstance } from './registry.js';
import {
  logOutboundTranscript,
  renderOutboundBody,
  resolveConversationForOutbound,
} from '../pipeline/outbound-transcript.js';

const POLL_INTERVAL_MS = 1000;
const BATCH_SIZE = 20;
const MAX_RETRIES = 3;

export interface DeliveryWorkerDeps {
  queue: MessageQueue;
  registry: AdapterRegistry;
  db: Database.Database;
}

export class DeliveryWorker {
  private readonly queue: MessageQueue;
  private readonly registry: AdapterRegistry;
  private readonly db: Database.Database;
  private stopping = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: DeliveryWorkerDeps) {
    this.queue = deps.queue;
    this.registry = deps.registry;
    this.db = deps.db;
  }

  start(): void {
    this.stopping = false;
    this.tick();
    console.log('[delivery] Worker started');
  }

  stop(): void {
    this.stopping = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    console.log('[delivery] Worker stopped');
  }

  private tick(): void {
    if (this.stopping) return;

    try {
      this.processBatch();
    } catch (err) {
      console.error(`[delivery] Batch error: ${String(err)}`);
    }

    this.timer = setTimeout(() => this.tick(), POLL_INTERVAL_MS);
  }

  private processBatch(): void {
    const messages = this.queue.dequeueByPrefix('contact:', BATCH_SIZE);
    if (messages.length === 0) return;

    // Dispatch each message — fire-and-forget per message so one slow
    // delivery doesn't block others. Errors are caught per-message.
    for (const msg of messages) {
      void this.deliver(msg.messageId, msg.envelope);
    }
  }

  private async deliver(
    messageId: string,
    envelope: import('../types/envelope.js').MessageEnvelope,
  ): Promise<void> {
    const adapter = this.resolveAdapter(envelope);
    if (!adapter) {
      const reason = `No adapter found for channel "${envelope.channel}" (adapter_id: ${String(envelope.metadata['adapter_id'] ?? 'none')})`;
      console.error(`[delivery] Dead-lettering ${messageId}: ${reason}`);
      this.queue.deadLetter(messageId, reason);
      return;
    }

    try {
      const result = await adapter.send(envelope);

      if (result.success) {
        this.queue.ack(messageId);
        this.logOutboundTranscript(messageId, envelope);
      } else if (result.retryable && (envelope.metadata['retry_count'] as number ?? 0) < MAX_RETRIES) {
        // Put back in queue for retry — reset to pending
        console.warn(`[delivery] Retryable failure for ${messageId}: ${result.error}`);
        // For now, dead-letter on failure; retry logic can be added later
        // when we have retry-count tracking in the delivery path
        this.queue.deadLetter(messageId, result.error ?? 'delivery failed (retryable)');
      } else {
        console.error(`[delivery] Dead-lettering ${messageId}: ${result.error}`);
        this.queue.deadLetter(messageId, result.error ?? 'delivery failed');
      }
    } catch (err) {
      console.error(`[delivery] Unexpected error delivering ${messageId}: ${String(err)}`);
      this.queue.deadLetter(messageId, String(err));
    }
  }

  /**
   * Resolve the target adapter for an outbound message.
   * Checks metadata.adapter_id first (set by pipeline fan-out), then
   * falls back to lookupByChannel (for direct-enqueued messages from
   * agent MCP tools like reply and send_message).
   */
  private resolveAdapter(
    envelope: import('../types/envelope.js').MessageEnvelope,
  ): AdapterInstance | undefined {
    // Prefer explicit adapter_id from pipeline routing
    const adapterId = envelope.metadata['adapter_id'] as string | undefined;
    if (adapterId) {
      const adapter = this.registry.lookup(adapterId);
      if (adapter) return adapter;
      console.warn(`[delivery] adapter_id "${adapterId}" not found in registry, falling back to channel lookup`);
    }

    // Fallback: resolve by channel
    return this.registry.lookupPrimaryByChannel(envelope.channel);
  }

  /**
   * Best-effort transcript log for a confirmed-delivered send (S31.2).
   * Errors here (including an unresolvable conversation/session) are caught
   * and logged, never allowed to affect delivery/ack/retry — this runs after
   * `queue.ack()` has already succeeded.
   */
  private logOutboundTranscript(
    messageId: string,
    envelope: import('../types/envelope.js').MessageEnvelope,
  ): void {
    try {
      const contactId = envelope.recipient.startsWith('contact:')
        ? envelope.recipient.slice('contact:'.length)
        : envelope.recipient;
      const { conversationId, sessionId } = resolveConversationForOutbound(
        this.db,
        contactId,
        envelope.channel,
      );
      logOutboundTranscript(this.db, {
        messageId,
        conversationId,
        sessionId,
        channel: envelope.channel,
        contactId,
        body: renderOutboundBody(envelope.payload),
        metadata: envelope.metadata,
      });
    } catch (err) {
      console.error(`[delivery] Failed to log outbound transcript for ${messageId}: ${String(err)}`);
    }
  }
}

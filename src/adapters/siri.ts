/**
 * Siri channel adapter (E42 spike).
 *
 * The `siri` channel is request/response: the Peggy iOS app POSTs a question
 * to `/api/v1/siri/ask` (src/http/siri-routes.ts) and the HTTP request stays
 * open until the agent's reply comes back or the wait elapses. This adapter is
 * the `send()` target that closes that loop. It is a full `AdapterInstance`
 * (unlike the receive-only Pebble webhook) because the existing
 * `DeliveryWorker` already dispatches every `contact:*` outbound message to
 * `registry.lookupPrimaryByChannel(envelope.channel)` — registering an
 * adapter with `channels: ['siri']` makes the normal delivery loop hand
 * Peggy's `reply` straight to `send()`. Nothing in `DeliveryWorker`,
 * `cc-headless`, the `reply` tool, or any pipeline stage changes.
 *
 * Correlation: the route pre-generates the inbound message id, registers a
 * waiter for it *before* submitting to `processInbound()`, and the agent's
 * `reply` tool sets `reply_to` to that same id. A reply with no `reply_to`
 * falls back to the oldest waiter for the same recipient. A reply that
 * matches no waiter (late, extra, or unsolicited) is logged and still
 * reported as delivered — `DeliveryWorker` then writes its outbound transcript
 * row, so nothing is lost even when nobody is waiting. Durable storage of
 * requests and late replies is E43.
 */
import type { MessageEnvelope } from '../types/envelope.js';
import type {
  AdapterCapabilities,
  AdapterInstance,
  DeliveryResult,
  HealthStatus,
} from '../core/registry.js';
import type { SiriAdapterConfig } from '../config/schema.js';

/** One in-flight ask, as registered by the route before `processInbound()`. */
export interface SiriPendingRequest {
  /** Client idempotency key (UUID) or server-generated. */
  requestId: string;
  /** Inbound envelope id — what the agent's `reply` uses as `reply_to`. */
  messageId: string;
  /** Canonical sender, e.g. `contact:chris` — matches the reply's `recipient`. */
  contactId: string;
  text: string;
  /** ISO timestamp the HTTP request was received. */
  receivedAt: string;
}

/** The first reply delivered for a pending request. */
export interface SiriReply {
  /** Outbound envelope id. */
  messageId: string;
  body: string;
  /** ISO timestamp `send()` received it. */
  receivedAt: string;
}

interface Entry {
  req: SiriPendingRequest;
  createdAt: number;
  /** Set once a reply has been delivered, whether or not anyone was waiting yet. */
  reply: SiriReply | null;
  /** Present only while `wait()` is blocked on this entry. */
  waiter: { resolve: (reply: SiriReply | null) => void; timer: ReturnType<typeof setTimeout> } | null;
}

function bodyOf(envelope: MessageEnvelope): string {
  const p = envelope.payload;
  if (p.type === 'reaction') {
    return `[reaction:${p.removed ? 'removed' : 'added'} ${p.emoji}]`;
  }
  return p.body;
}

export class SiriAdapter implements AdapterInstance {
  readonly id = 'siri';
  readonly name = 'Siri';
  readonly capabilities: AdapterCapabilities = {
    send: true,
    typing: false,
    toolStatus: false,
    maxMessageLength: 4000,
    channels: ['siri'],
  };

  /** Keyed by inbound message id. */
  private readonly entries = new Map<string, Entry>();
  private lastActivity: string | undefined;
  private readonly counters = { answered: 0, timed_out: 0, unmatched: 0 };

  constructor(private readonly cfg: SiriAdapterConfig) {
    if (cfg.debug_delay_ms > 0 && process.env['NODE_ENV'] === 'production') {
      throw new Error(
        `adapters.siri.debug_delay_ms is ${cfg.debug_delay_ms} but NODE_ENV=production — ` +
          'the artificial delay is a device-testing aid only (E44); set it to 0.',
      );
    }
  }

  async start(): Promise<void> {
    console.log(
      `[siri] adapter ready — reply_timeout_ms=${this.cfg.reply_timeout_ms}` +
        (this.cfg.debug_delay_ms > 0 ? ` debug_delay_ms=${this.cfg.debug_delay_ms} (testing aid, not for production)` : ''),
    );
  }

  async stop(): Promise<void> {
    for (const entry of this.entries.values()) {
      if (entry.waiter) {
        clearTimeout(entry.waiter.timer);
        entry.waiter.resolve(null);
      }
    }
    this.entries.clear();
  }

  async health(): Promise<HealthStatus> {
    return {
      status: 'healthy',
      ...(this.lastActivity ? { lastActivity: this.lastActivity } : {}),
      details: { pending: this.entries.size, ...this.counters },
    };
  }

  /** Number of asks registered and not yet settled. */
  pendingCount(): number {
    return this.entries.size;
  }

  /**
   * Register an in-flight ask. Call this *before* `processInbound()` so a
   * reply that arrives synchronously inside it (a bus-command response sent via
   * `sendCommandResponse`) is captured rather than logged as unmatched.
   */
  register(req: SiriPendingRequest): void {
    this.entries.set(req.messageId, { req, createdAt: Date.now(), reply: null, waiter: null });
  }

  /**
   * Wait up to `waitMs` for the reply to a registered ask. Resolves
   * immediately if the reply already arrived; resolves `null` on timeout (the
   * entry is removed either way — a reply after this point is "late" and is
   * only preserved via the outbound transcript until E43 adds the durable
   * store). Resolves `null` at once for an unknown/cancelled message id.
   */
  wait(messageId: string, waitMs: number): Promise<SiriReply | null> {
    const entry = this.entries.get(messageId);
    if (!entry) return Promise.resolve(null);
    if (entry.reply) {
      this.entries.delete(messageId);
      return Promise.resolve(entry.reply);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.entries.get(messageId) === entry) {
          this.entries.delete(messageId);
          this.counters.timed_out++;
          resolve(null);
        }
      }, waitMs);
      entry.waiter = { resolve, timer };
    });
  }

  /** Drop a registered ask that never made it into the queue (duplicate, pipeline abort). */
  cancel(messageId: string): void {
    const entry = this.entries.get(messageId);
    if (!entry) return;
    if (entry.waiter) {
      clearTimeout(entry.waiter.timer);
      entry.waiter.resolve(null);
    }
    this.entries.delete(messageId);
  }

  /**
   * `DeliveryWorker` → here. Never fails: there is nothing external to fail,
   * and a reply nobody is waiting for is still a delivered reply (the worker
   * acks it and logs the outbound transcript row).
   */
  async send(envelope: MessageEnvelope): Promise<DeliveryResult> {
    const receivedAt = new Date().toISOString();
    this.lastActivity = receivedAt;
    const entry = this.match(envelope);

    if (!entry) {
      this.counters.unmatched++;
      console.log(
        `[siri] unmatched reply (late or unsolicited) message_id=${envelope.id} ` +
          `reply_to=${envelope.reply_to ?? 'null'} recipient=${envelope.recipient} — kept in transcripts only`,
      );
      return { success: true, platformMessageId: envelope.id };
    }

    const reply: SiriReply = { messageId: envelope.id, body: bodyOf(envelope), receivedAt };
    entry.reply = reply;
    this.counters.answered++;
    if (entry.waiter) {
      clearTimeout(entry.waiter.timer);
      const { resolve } = entry.waiter;
      entry.waiter = null;
      this.entries.delete(entry.req.messageId);
      resolve(reply);
    }
    // No waiter yet: the route is still inside processInbound() (command
    // response) — wait() will pick the stored reply up immediately.
    return { success: true, platformMessageId: envelope.id };
  }

  /**
   * `reply_to` first. With no `reply_to`, the oldest unanswered ask for the same
   * recipient created within `reply_timeout_ms × 4` (the cc-headless stdout
   * fallback and the `reply` tool both set `reply_to`, so this is rare).
   */
  private match(envelope: MessageEnvelope): Entry | undefined {
    if (envelope.reply_to) {
      const byId = this.entries.get(envelope.reply_to);
      return byId && !byId.reply ? byId : undefined;
    }
    const horizon = Date.now() - this.cfg.reply_timeout_ms * 4;
    let oldest: Entry | undefined;
    for (const entry of this.entries.values()) {
      if (entry.reply || entry.req.contactId !== envelope.recipient || entry.createdAt < horizon) continue;
      if (!oldest || entry.createdAt < oldest.createdAt) oldest = entry;
    }
    return oldest;
  }
}

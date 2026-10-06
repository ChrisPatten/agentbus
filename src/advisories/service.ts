/**
 * Advisory service (E65 S65.3): the API producers call, and the delivery
 * decisions behind it.
 *
 * Delivery path per advisory, from the agent's runtime (E64 capabilities):
 *
 *   runtime has systemMessages   info / warning → inject into the next owner conversation
 *                                critical       → system-only turn in an owner's default
 *                                                 conversation; direct to the owners if
 *                                                 that can't be started
 *   no systemMessages, or the    every severity → direct: the bus messages each owner on
 *   agent has no runtime                          their channel, without the agent
 *
 * Injection waits for the owner to write. Proactive paths (system turn,
 * direct) run when an advisory is created or escalated, and are retried by
 * `retryPending()` until delivered or `maxAttempts` is reached.
 *
 * Any still-open advisory, whatever its severity, is also injected into the
 * next owner conversation on a runtime with systemMessages, so a critical
 * advisory whose proactive delivery failed still reaches the owner.
 */
import type { RuntimeResolver } from '../core/runtime-resolver.js';
import type { OwnerContact, OwnerConversation, OwnerDirectory } from '../core/owners.js';
import type { AdvisoryStore, ListFilter } from './store.js';
import { renderAdvisoryBlock, renderDirectMessage } from './render.js';
import type {
  AckResult,
  Advisory,
  AdvisoryDeliveryPath,
  AdvisoryInput,
  AdvisorySeverity,
  RaiseResult,
} from './types.js';

export type AdvisoryDeliveryPlan = 'inject' | 'system-turn' | 'direct';

/** How the service reaches the outside world. Bus wiring: `createBusAdvisoryTransport()`. */
export interface AdvisoryTransport {
  /** Send `text` to `owner` on their channel, without the agent. Throws on failure. */
  sendDirect(owner: OwnerContact, text: string, advisory: Advisory): Promise<void>;
  /**
   * Start a system-only turn for `agentId` in `owner`'s default
   * conversation. Resolves true when the turn was enqueued. The advisory
   * block itself is added by the advisory-inject pipeline stage.
   */
  startSystemTurn(owner: OwnerConversation, agentId: string, advisory: Advisory): Promise<boolean>;
}

export interface AdvisoryServiceDeps {
  store: AdvisoryStore;
  owners: OwnerDirectory;
  resolver: Pick<RuntimeResolver, 'resolve'>;
  /** Late-bound with `setTransport()` when the adapters it needs are built after the service. */
  transport?: AdvisoryTransport;
  now?: () => Date;
  /** Proactive attempts per (re)open before giving up. Default 5. */
  maxAttempts?: number;
  /** Wait between proactive attempts, multiplied by the attempt count. Default 60 s. */
  retryBackoffMs?: number;
}

export interface Injection {
  /** The rendered system block. */
  block: string;
  /** Advisories in the block, now marked delivered. */
  ids: string[];
}

export class AdvisoryService {
  private transport: AdvisoryTransport | undefined;
  private readonly inFlight = new Set<string>();
  private readonly maxAttempts: number;
  private readonly retryBackoffMs: number;

  constructor(private readonly deps: AdvisoryServiceDeps) {
    this.transport = deps.transport;
    this.maxAttempts = deps.maxAttempts ?? 5;
    this.retryBackoffMs = deps.retryBackoffMs ?? 60_000;
  }

  setTransport(transport: AdvisoryTransport): void {
    this.transport = transport;
  }

  // ── Producer API ──────────────────────────────────────────────────────────

  /**
   * Raise (or refresh) a condition for an agent. Synchronous; when the
   * advisory is new or escalated and needs proactive delivery, delivery
   * starts in the background. Use `raiseAndDeliver` to wait for it.
   */
  raise(input: AdvisoryInput): RaiseResult {
    const result = this.raiseOnly(input);
    if (this.needsProactive(result)) {
      void this.dispatch(result.advisory.id).catch((err: unknown) =>
        console.error(`[advisories] delivery of ${result.advisory.id} failed: ${String(err)}`));
    }
    return result;
  }

  /** `raise`, then wait for any proactive delivery it started. */
  async raiseAndDeliver(input: AdvisoryInput): Promise<RaiseResult & { delivered: AdvisoryDeliveryPath | null }> {
    const result = this.raiseOnly(input);
    const delivered = this.needsProactive(result) ? await this.dispatch(result.advisory.id) : null;
    return { ...result, advisory: this.deps.store.get(result.advisory.id) ?? result.advisory, delivered };
  }

  /** The condition cleared. Returns the resolved advisory, or null if none was active. */
  resolve(agentId: string, conditionKey: string): Advisory | null {
    return this.deps.store.resolve(this.deps.owners.logicalAgentId(agentId), conditionKey, this.now());
  }

  /** Acknowledge on behalf of `agentId` (a pane id is mapped to its pool). */
  ack(id: string, agentId: string): AckResult {
    return this.deps.store.ack(id, this.deps.owners.logicalAgentId(agentId), this.now());
  }

  get(id: string): Advisory | null {
    return this.deps.store.get(id);
  }

  list(filter: ListFilter = {}): Advisory[] {
    return this.deps.store.list({
      ...filter,
      ...(filter.agentId ? { agentId: this.deps.owners.logicalAgentId(filter.agentId) } : {}),
    });
  }

  listActive(agentId?: string): Advisory[] {
    return this.deps.store.listActive(agentId ? this.deps.owners.logicalAgentId(agentId) : undefined);
  }

  // ── Delivery ──────────────────────────────────────────────────────────────

  /** Which path an advisory of `severity` for `agentId` takes. */
  plan(agentId: string, severity: AdvisorySeverity): AdvisoryDeliveryPlan {
    const runtime = this.deps.resolver.resolve(this.deps.owners.logicalAgentId(agentId));
    if (!runtime || !runtime.capabilities.systemMessages) return 'direct';
    return severity === 'critical' ? 'system-turn' : 'inject';
  }

  /**
   * Called by the advisory-inject pipeline stage for each agent a message is
   * routed to. When the sender owns `agentId` on exactly `channel` and the
   * runtime takes injected blocks, returns one block with every open
   * advisory for the agent and marks them delivered. Otherwise null.
   */
  takeInjection(agentId: string, contactId: string, channel: string, opts: { systemTurn?: boolean } = {}): Injection | null {
    const logical = this.deps.owners.logicalAgentId(agentId);
    if (!this.deps.owners.isOwner(logical, contactId, channel)) return null;
    // Runtimes without system messages get everything directly instead.
    if (this.plan(logical, 'info') === 'direct') return null;
    const pending = this.deps.store.list({ agentId: logical, states: ['open'] });
    if (pending.length === 0) return null;
    const block = renderAdvisoryBlock(pending, { systemTurn: opts.systemTurn });
    const ids = pending.map((a) => a.id);
    this.deps.store.markDelivered(ids, opts.systemTurn ? 'system-turn' : 'injection', this.now());
    return { block, ids };
  }

  /**
   * Deliver one open advisory by its proactive path (system turn or direct).
   * Returns the path that delivered it, or null when nothing was delivered
   * (not open, waiting for injection, already in flight, or every attempt
   * failed — the error is recorded on the row).
   */
  async dispatch(id: string): Promise<AdvisoryDeliveryPath | null> {
    const advisory = this.deps.store.get(id);
    if (!advisory || advisory.state !== 'open') return null;
    const plan = this.plan(advisory.agent_id, advisory.severity);
    if (plan === 'inject' || this.inFlight.has(id)) return null;

    this.inFlight.add(id);
    try {
      const transport = this.transport;
      if (!transport) {
        this.deps.store.recordAttempt(id, 'advisory transport not ready', this.now());
        return null;
      }
      const owners = this.deps.owners.ownerConversations(advisory.agent_id);
      if (owners.length === 0) {
        this.deps.store.recordAttempt(id, 'no owners configured', this.now());
        console.warn(`[advisories] ${advisory.agent_id} has no owners; ${advisory.condition_key} stays open`);
        return null;
      }

      const errors: string[] = [];
      if (plan === 'system-turn') {
        for (const owner of owners) {
          try {
            if (await transport.startSystemTurn(owner, advisory.agent_id, advisory)
              && this.deps.store.get(id)?.state !== 'open') {
              this.deps.store.recordAttempt(id, null, this.now());
              return 'system-turn';
            }
            errors.push(`system turn via ${owner.channel} not started`);
          } catch (err) {
            errors.push(`system turn via ${owner.channel}: ${String(err)}`);
          }
        }
        // Fall through: message the owners directly.
      }

      let sent = 0;
      const text = renderDirectMessage(advisory);
      for (const owner of owners) {
        try {
          await transport.sendDirect(owner, text, advisory);
          sent++;
        } catch (err) {
          errors.push(`direct to ${owner.contactId} on ${owner.channel}: ${String(err)}`);
        }
      }
      if (sent > 0) this.deps.store.markDelivered([id], 'direct', this.now());
      this.deps.store.recordAttempt(id, errors.length > 0 ? errors.join('; ') : null, this.now());
      return sent > 0 ? 'direct' : null;
    } finally {
      this.inFlight.delete(id);
    }
  }

  /**
   * Retry proactive delivery for open advisories that need it, with a
   * linear backoff, up to `maxAttempts`. Called from the bus maintenance tick.
   */
  async retryPending(): Promise<void> {
    const now = this.now().getTime();
    for (const advisory of this.deps.store.list({ states: ['open'] })) {
      if (this.plan(advisory.agent_id, advisory.severity) === 'inject') continue;
      if (advisory.delivery_attempts >= this.maxAttempts) continue;
      if (advisory.last_attempt_at) {
        const wait = this.retryBackoffMs * advisory.delivery_attempts;
        if (now - new Date(advisory.last_attempt_at).getTime() < wait) continue;
      }
      await this.dispatch(advisory.id);
    }
  }

  private raiseOnly(input: AdvisoryInput): RaiseResult {
    return this.deps.store.raise({ ...input, agentId: this.deps.owners.logicalAgentId(input.agentId) }, this.now());
  }

  private needsProactive(result: RaiseResult): boolean {
    if (result.outcome !== 'created' && result.outcome !== 'escalated') return false;
    return this.plan(result.advisory.agent_id, result.advisory.severity) !== 'inject';
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }
}

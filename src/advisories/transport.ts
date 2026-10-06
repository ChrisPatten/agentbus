/**
 * Bus wiring for advisory delivery (E65 S65.3).
 *
 * - Direct: an outbound envelope from `system:bus` to `contact:<owner>` on
 *   the owner's channel, enqueued for the delivery worker like any agent
 *   reply. The channel's adapter must be registered.
 * - System turn: a system-only inbound message in the owner's default
 *   conversation, run through the normal pipeline (so routing, pool pane
 *   leasing and transcripts all apply) and fanned out only to the agent the
 *   advisory is about. The advisory-inject stage adds the block.
 */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { AppConfig } from '../config/schema.js';
import type { MessageQueue } from '../core/queue.js';
import type { AdapterRegistry } from '../core/registry.js';
import type { OwnerDirectory } from '../core/owners.js';
import type { PipelineEngine } from '../pipeline/engine.js';
import type { CommandRegistry } from '../commands/registry.js';
import { processInbound } from '../http/api.js';
import type { AdvisoryTransport } from './service.js';

export interface BusAdvisoryTransportDeps {
  queue: MessageQueue;
  registry: AdapterRegistry;
  owners: OwnerDirectory;
  pipeline: PipelineEngine;
  config: AppConfig;
  db: Database.Database;
  commandRegistry?: CommandRegistry;
  pauseSet?: Set<string>;
  /** Injectable for tests. Defaults to `processInbound`. */
  processInbound?: typeof processInbound;
}

/** Sender of bus-originated direct messages. */
export const ADVISORY_SENDER = 'system:bus';

export function createBusAdvisoryTransport(deps: BusAdvisoryTransportDeps): AdvisoryTransport {
  const inbound = deps.processInbound ?? processInbound;
  return {
    async sendDirect(owner, text, advisory) {
      const adapter = deps.registry.lookupPrimaryByChannel(owner.channel);
      if (!adapter) throw new Error(`no adapter for channel "${owner.channel}"`);
      deps.queue.enqueue({
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        channel: owner.channel,
        topic: 'general',
        sender: ADVISORY_SENDER,
        recipient: `contact:${owner.contactId}`,
        reply_to: null,
        priority: advisory.severity === 'critical' ? 'urgent' : 'normal',
        payload: { type: 'text', body: text },
        metadata: { adapter_id: adapter.id, bus_advisory: true, advisory_id: advisory.id },
      });
    },

    async startSystemTurn(owner, agentId, advisory) {
      const result = await inbound(
        {
          channel: owner.channel,
          sender: `contact:${owner.contactId}`,
          topic: owner.topic,
          // Logged to the transcript; not shown to the agent (system-only).
          payload: { type: 'text', body: `[AgentBus advisory turn ${advisory.id}]` },
          metadata: { bus_advisory: true, advisory_id: advisory.id },
        },
        {
          queue: deps.queue, pipeline: deps.pipeline, config: deps.config, db: deps.db,
          registry: deps.registry, commandRegistry: deps.commandRegistry, pauseSet: deps.pauseSet,
        },
        {
          systemOnly: true,
          routeFilter: (route) => route.recipientId.startsWith('agent:')
            && deps.owners.logicalAgentId(route.recipientId) === agentId,
        },
      );
      if (!result.queued) console.warn(`[advisories] system turn for ${agentId} not queued: ${result.reason}`);
      return result.queued && result.enqueued_count > 0;
    },
  };
}

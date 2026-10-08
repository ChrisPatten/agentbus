/**
 * Bus wiring for System Message journaling instructions (E66 S66.8): a
 * system-only inbound turn in the run's conversation, through the normal
 * pipeline (routing, pool pane leasing, transcripts), fanned out only to
 * the agent being journaled, carrying the instruction block and the run id.
 * Mirrors the advisory system turn (src/advisories/transport.ts).
 */
import type Database from 'better-sqlite3';
import type { AppConfig } from '../config/schema.js';
import type { MessageQueue } from '../core/queue.js';
import type { AdapterRegistry } from '../core/registry.js';
import type { OwnerDirectory } from '../core/owners.js';
import { JOURNAL_RUN_KEY } from '../core/system-block.js';
import type { PipelineEngine } from '../pipeline/engine.js';
import type { CommandRegistry } from '../commands/registry.js';
import { processInbound } from '../http/api.js';
import type { InstructionDelivery } from './journalers/system-message.js';

export interface JournalInstructionDeliveryDeps {
  queue: MessageQueue;
  registry: AdapterRegistry;
  owners: Pick<OwnerDirectory, 'logicalAgentId'>;
  pipeline: PipelineEngine;
  config: AppConfig;
  db: Database.Database;
  commandRegistry?: CommandRegistry;
  pauseSet?: Set<string>;
  processInbound?: typeof processInbound;
}

export function createJournalInstructionDelivery(deps: JournalInstructionDeliveryDeps): InstructionDelivery {
  const inbound = deps.processInbound ?? processInbound;
  return async ({ runId, agentId, target, block }) => {
    const result = await inbound(
      {
        channel: target.channel,
        sender: `contact:${target.contactId}`,
        topic: target.topic,
        // Logged to the transcript (hidden from user-facing views); not shown to the agent.
        payload: { type: 'text', body: `[AgentBus journal run ${runId}]` },
        metadata: { bus_journal: true },
      },
      {
        queue: deps.queue, pipeline: deps.pipeline, config: deps.config, db: deps.db,
        registry: deps.registry, commandRegistry: deps.commandRegistry, pauseSet: deps.pauseSet,
      },
      {
        systemOnly: true,
        blocks: [block],
        metadata: { [JOURNAL_RUN_KEY]: runId },
        routeFilter: (route) => route.recipientId.startsWith('agent:') && deps.owners.logicalAgentId(route.recipientId) === agentId,
      },
    );
    if (!result.queued) return { queued: false, reason: result.reason };
    if (result.enqueued_count === 0) return { queued: false, reason: 'no route to the agent' };
    const queued = deps.queue.getById(result.id);
    const conversationId = queued?.envelope.metadata['conversation_id'];
    return { queued: true, messageId: result.id, conversationId: typeof conversationId === 'string' ? conversationId : null };
  };
}

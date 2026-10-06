/**
 * Feedback producers (E68 S68.2): turn bus events into `feedback_events`.
 * Pure mapping plus the recorder call, so each producer is testable on its
 * own; `src/index.ts` wires them to the approval resolution path, the
 * cc-headless stream and the delivery worker.
 */
import type Database from 'better-sqlite3';
import type { ApprovalRequest } from '../approvals/types.js';
import type { HeadlessToolError } from '../adapters/cc-headless.js';
import type { MessageEnvelope } from '../types/envelope.js';
import { resolveConversationForOutbound } from '../pipeline/outbound-transcript.js';
import { latestAgentMessageId, type FeedbackInput, type FeedbackStore } from './feedback.js';

export interface FeedbackProducerDeps {
  db: Database.Database;
  feedback: Pick<FeedbackStore, 'record'>;
  /** Maps an agent id (bare, prefixed or a pool pane id) to its logical prefixed id. */
  logicalAgentId: (agentId: string) => string;
}

const bare = (id: string | null | undefined) => (id ? id.replace(/^contact:/, '') : null);

/** A denied approval request (E51), including a denied self-edit proposal (S68.3). */
export function deniedApprovalFeedback(deps: FeedbackProducerDeps, request: ApprovalRequest): FeedbackInput {
  const by = request.resolved_by && !['system', 'timeout', 'api'].includes(request.resolved_by) ? bare(request.resolved_by) : null;
  return {
    agentId: deps.logicalAgentId(request.agent_id),
    kind: 'denied-approval',
    text: `Denied ${request.tool_name}: ${request.summary}`,
    conversationId: request.conversation_id,
    refMessageId: request.conversation_id ? latestAgentMessageId(deps.db, request.conversation_id) : null,
    contactId: by ?? bare(request.contact_id),
    detail: { approval_id: request.id, adapter_id: request.adapter_id, tool_name: request.tool_name },
  };
}

/** `onResolved` for the approval resolution path: records denials. */
export function recordApprovalOutcome(deps: FeedbackProducerDeps, request: ApprovalRequest, status: 'approved' | 'denied'): void {
  if (status !== 'denied') return;
  deps.feedback.record(deniedApprovalFeedback(deps, request));
}

/** A failed tool call in a cc-headless turn. */
export function recordToolError(deps: FeedbackProducerDeps, e: HeadlessToolError): void {
  deps.feedback.record({
    agentId: deps.logicalAgentId(e.agentId),
    kind: 'tool-error',
    text: `${e.delivery ? 'Delivery tool' : 'Tool'} ${e.toolName} failed: ${e.error || 'no error text'}`,
    conversationId: e.conversationId,
    sessionId: e.sessionId,
    detail: { tool_name: e.toolName, delivery: e.delivery, source: 'headless-stream' },
  });
}

/**
 * A message that could not be delivered. Recorded only for messages an
 * agent sent (sender `agent:…`), not bus notices.
 */
export function recordDeliveryFailure(deps: FeedbackProducerDeps, envelope: MessageEnvelope, reason: string): void {
  if (!envelope.sender.startsWith('agent:')) return;
  if (envelope.metadata?.['bus_notice'] === true) return;
  let conversationId = typeof envelope.metadata?.['conversation_id'] === 'string' ? (envelope.metadata['conversation_id'] as string) : null;
  if (!conversationId && envelope.recipient.startsWith('contact:')) {
    conversationId = resolveConversationForOutbound(
      deps.db, bare(envelope.recipient)!, envelope.channel, envelope.channel === 'app' ? envelope.topic || 'general' : undefined,
    ).conversationId;
  }
  deps.feedback.record({
    agentId: deps.logicalAgentId(envelope.sender),
    kind: 'tool-error',
    text: `Message to ${bare(envelope.recipient)} on ${envelope.channel} could not be delivered: ${reason}`,
    conversationId,
    detail: { source: 'delivery', channel: envelope.channel, message_id: envelope.id },
  });
}

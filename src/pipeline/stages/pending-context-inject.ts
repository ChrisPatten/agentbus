/**
 * Stage 88 — Pending Context Inject (critical: false) (E83 S83.4)
 *
 * cc-headless prepends pending context (E69, E82) to a Main turn in
 * `runBatch`. A cc-pool pane is fed differently: its `cc.ts` polls
 * `GET /api/v1/messages/pending` and wakes the interactive session with a
 * channel event, so the block has to ride on the envelope. For each cc-pool
 * route whose conversation is primary (Main, or a channel an agent lists in
 * `pending_context.channels`), this stage builds the block with
 * `buildPendingContext` and attaches it, for that route's recipient only,
 * under the reserved `pending_context` key. `formatMessagesForSampling`
 * renders it ahead of the messages, outside any `<agentbus-system>` tag.
 *
 * The watermark does NOT advance here: the attachment carries it, and
 * `POST /api/v1/messages/:id/ack` advances it when the pane takes the
 * message. A message that is parked, dead-lettered or lost before the ack
 * leaves the context pending for the next delivery.
 *
 * Runs after pool-route-resolve (72), so each route already names its pane
 * (or the parked bucket, whose copy keeps the attachment when it is
 * re-enqueued), after transcript-log (80), so the block is never stored as
 * message text and this envelope's inbound row can be excluded from the
 * baseline, and after advisory-inject (86). Slash commands, system-only
 * turns, journaling instructions and reactions are skipped, as they are not
 * turns the agent answers.
 *
 * Registered as critical: false: a failure never blocks delivery.
 */
import type Database from 'better-sqlite3';
import type { AppConfig } from '../../config/schema.js';
import type { PipelineStage } from '../types.js';
import { JOURNAL_RUN_KEY, attachPendingContext, isSystemOnly } from '../../core/system-block.js';
import { pendingContextAgent, primaryConversationChannel } from '../../app/main.js';
import { buildPendingContext, pendingContextLimits } from '../../app/pending-context.js';

export function createPendingContextInject(db: Database.Database, config: AppConfig): PipelineStage {
  return async (ctx) => {
    if (ctx.isSlashCommand || !ctx.conversationId) return ctx;
    if (isSystemOnly(ctx.envelope.metadata) || ctx.envelope.metadata?.[JOURNAL_RUN_KEY]) return ctx;
    if (ctx.envelope.payload.type !== 'text') return ctx;
    const poolRoutes = ctx.routes.filter((r) => r.adapterId === 'cc-pool');
    if (poolRoutes.length === 0) return ctx;
    const channel = primaryConversationChannel(db, ctx.conversationId, config);
    if (!channel) return ctx;
    // Built once: every cc-pool route of this envelope is the same conversation against the same watermark.
    const built = buildPendingContext(db, ctx.conversationId, {
      limits: pendingContextLimits(config, pendingContextAgent(config, channel)),
      batchMessageIds: [ctx.envelope.id],
      // A pane's earlier messages count as seen only once acked (parked or dead-lettered ones never were).
      deliveredBaseline: true,
    });
    if (!built) return ctx;
    for (const route of poolRoutes) {
      attachPendingContext(ctx.envelope.metadata, route.recipientId, {
        conversation_id: ctx.conversationId, block: built.block, through: built.through,
      });
    }
    return ctx;
  };
}

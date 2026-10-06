/**
 * Stage 86 — Advisory Inject (critical: false) (E65 S65.3)
 *
 * For each agent a message is routed to, when the sender owns that agent on
 * this exact channel, attach one bus-originated system block listing the
 * agent's open advisories, for that route's recipient only, and mark them
 * delivered. Runs after pool-route-resolve (72), so a pool route already
 * names its leased pane, and after transcript-log (80), so the block is
 * never stored as message text.
 *
 * Slash commands and journaling instructions (E66) are skipped. A system-only envelope (a critical advisory's
 * system turn) gets the same block, worded for a turn with no message.
 *
 * Registered as critical: false — an injection failure never blocks delivery.
 */
import type { PipelineStage } from '../types.js';
import { JOURNAL_RUN_KEY, attachSystemBlock, isSystemOnly } from '../../core/system-block.js';
import type { AdvisoryService } from '../../advisories/service.js';

export function createAdvisoryInject(service: Pick<AdvisoryService, 'takeInjection'>): PipelineStage {
  return async (ctx) => {
    if (ctx.isSlashCommand || !ctx.contact?.id) return ctx;
    // E66 — a journaling instruction can't relay advisories (outbound is
    // blocked during the run), so it must not mark them delivered.
    if (ctx.envelope.metadata?.[JOURNAL_RUN_KEY]) return ctx;
    const systemTurn = isSystemOnly(ctx.envelope.metadata);
    for (const route of ctx.routes) {
      if (!route.recipientId.startsWith('agent:')) continue;
      const taken = service.takeInjection(route.recipientId, ctx.contact.id, ctx.envelope.channel, { systemTurn });
      if (taken) attachSystemBlock(ctx.envelope.metadata, taken.block, route.recipientId);
    }
    return ctx;
  };
}

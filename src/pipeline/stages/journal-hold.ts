/**
 * Stage 87 — Journal Hold notice (critical: false) (E66 S66.8)
 *
 * While a System Message journal run holds a conversation, a new message for
 * it waits in the queue (the pending poll skips it). This stage tells the
 * sender, once per hold, that the agent is busy: the first message routed to
 * the held agent in that conversation calls `notify`. Slash commands
 * (answered by the bus itself) and bus system-only turns are skipped.
 *
 * Registered as critical: false — a notice failure never blocks delivery.
 */
import type { PipelineStage } from '../types.js';
import { isSystemOnly } from '../../core/system-block.js';
import type { ActiveSystemRun, JournalRunGate } from '../../journaling/journalers/system-message.js';

export function createJournalHoldNotice(
  gate: Pick<JournalRunGate, 'runForConversation' | 'claimNotice'>,
  notify: (run: ActiveSystemRun, ctx: { contactId: string; channel: string; topic: string; conversationId: string }) => void,
): PipelineStage {
  return async (ctx) => {
    if (ctx.isSlashCommand || isSystemOnly(ctx.envelope.metadata) || !ctx.conversationId) return ctx;
    const run = gate.runForConversation(ctx.conversationId);
    if (!run || !ctx.routes.some((r) => r.recipientId === run.recipient)) return ctx;
    const claimed = gate.claimNotice(ctx.conversationId);
    if (claimed) {
      const sender = ctx.envelope.sender;
      notify(claimed, {
        contactId: sender.startsWith('contact:') ? sender.slice('contact:'.length) : sender,
        channel: ctx.envelope.channel,
        topic: ctx.envelope.topic,
        conversationId: ctx.conversationId,
      });
    }
    return ctx;
  };
}

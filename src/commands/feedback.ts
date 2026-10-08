/**
 * /feedback <text> (E68 S68.2): a correction for the agent, recorded as a
 * `user-feedback` event. The bus acknowledges it at once; it is never
 * delivered to the agent as a message and does not start a journal run. The
 * conversation's next journal run receives it (and may run below
 * `min_human_messages` because of it); consolidation counts it across
 * conversations. See docs/AGENT_LEARNING.md#feedback-events.
 */
import type Database from 'better-sqlite3';
import type { CommandDefinition, SlashCommandContext } from './registry.js';
import { commandConversationId } from './handlers.js';
import type { JournalEngine } from '../journaling/engine.js';
import { latestAgentMessageId } from '../journaling/feedback.js';

export interface FeedbackCommandDeps {
  db: Database.Database;
  engine: Pick<JournalEngine, 'sessionForConversation' | 'agentForSession' | 'allSettings' | 'feedback'>;
}

export const FEEDBACK_ACK = 'Thanks, noted. Your feedback is used the next time this conversation is journaled.';
export const FEEDBACK_USAGE = 'Usage: /feedback <what the agent should do differently>\nExample: /feedback Use 24-hour time when you list my meetings.';

function contactOf(ctx: SlashCommandContext): string {
  return ctx.sender.startsWith('contact:') ? ctx.sender.slice('contact:'.length) : ctx.sender;
}

export function createFeedbackCommand(deps: FeedbackCommandDeps): CommandDefinition {
  return {
    name: 'feedback',
    description: 'Tell the agent what to do differently (used when it next journals)',
    usage: '/feedback <text>',
    scope: 'bus',
    handler: async (_args, ctx) => {
      const text = ctx.argsRaw.trim();
      if (!text) return { body: FEEDBACK_USAGE };
      const contactId = contactOf(ctx);
      const conversationId = commandConversationId(ctx, deps.db, contactId);
      const session = deps.engine.sessionForConversation(conversationId);
      let agentId = session ? deps.engine.agentForSession(session)?.agentId ?? null : null;
      if (!agentId) {
        const all = deps.engine.allSettings();
        agentId = all.length === 1 ? all[0]!.agentId : null;
      }
      if (!agentId) return { body: 'Feedback needs journaling set up for this conversation\'s agent.' };
      deps.engine.feedback.record({
        agentId,
        kind: 'user-feedback',
        text,
        conversationId,
        sessionId: session?.id ?? null,
        refMessageId: latestAgentMessageId(deps.db, conversationId),
        contactId,
        detail: { channel: ctx.channel },
      });
      return { body: FEEDBACK_ACK };
    },
  };
}

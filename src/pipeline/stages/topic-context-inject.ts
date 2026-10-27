/**
 * Stage 85 — Topic Context Inject (critical: false)
 *
 * When transcript-log (80) has just created a brand-new session for a
 * thread-scoped topic (e.g. a Telegram forum topic), attach the topic's
 * context (name + pinned message, from the owning adapter's
 * `getTopicContext`) as `metadata.topic_context`. cc.ts renders it before
 * the first message of the turn, so the agent knows what the topic is about
 * without the user restating it. Later turns of the same session don't
 * create a session, so it is injected once; a new session (e.g. after
 * /clear) gets it again.
 *
 * Skipped for slash commands, system-only turns and journaling runs. The
 * adapter call is synchronous and local; any failure is swallowed so
 * delivery is never blocked.
 */
import type { PipelineStage } from '../types.js';
import { isThreadTopic } from '../types.js';
import { JOURNAL_RUN_KEY, isSystemOnly } from '../../core/system-block.js';
import type { AdapterRegistry } from '../../core/registry.js';

/** Envelope metadata key carrying the topic context block. */
export const TOPIC_CONTEXT_KEY = 'topic_context';

export function createTopicContextInject(registry: Pick<AdapterRegistry, 'lookupByChannel'>): PipelineStage {
  return async (ctx) => {
    const e = ctx.envelope;
    if (!ctx.sessionCreated || ctx.isSlashCommand) return ctx;
    if (!e.topic || !isThreadTopic(e.topic)) return ctx;
    if (isSystemOnly(e.metadata) || e.metadata?.[JOURNAL_RUN_KEY]) return ctx;
    try {
      for (const adapter of registry.lookupByChannel(e.channel)) {
        const text = adapter.getTopicContext?.(e.channel, e.topic);
        if (text) {
          e.metadata[TOPIC_CONTEXT_KEY] = text;
          break;
        }
      }
    } catch (err) {
      console.warn(`[pipeline:topic-context-inject] ${String(err)}`);
    }
    return ctx;
  };
}

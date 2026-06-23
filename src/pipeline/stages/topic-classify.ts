import type { AppConfig } from '../../config/schema.js';
import { isThreadTopic, type PipelineStage } from '../types.js';

/**
 * Stage 50 — Topic Classify
 *
 * If envelope.topic encodes a per-thread identity (thread:<hash>, e.g. an email
 * thread), it is preserved verbatim so per-thread sessions survive. Otherwise if
 * envelope.topic is already a recognized non-'general' value, keeps it. Otherwise
 * applies config.pipeline.topic_rules in order — first keyword or regex match
 * wins. Falls back to 'general'. Sets ctx.topics from the resolved topic.
 * Never aborts the pipeline.
 *
 * Regexes are compiled once at construction time (not per-message) to avoid
 * ReDoS risk from user-supplied patterns and to improve throughput.
 */
export function createTopicClassify(config: AppConfig): PipelineStage {
  // Pre-compile patterns at construction time — per-message RegExp construction
  // is both slow and a ReDoS vector when patterns come from config.
  const compiledRules = config.pipeline.topic_rules.map((rule) => ({
    topic: rule.topic,
    keywords: rule.keywords,
    pattern: rule.pattern != null ? new RegExp(rule.pattern, 'i') : null,
  }));

  return async (ctx) => {
    const e = ctx.envelope;

    // Per-thread topic (thread:<hash>) — preserve so each thread keeps its own
    // conversation_id. These are set by adapters (e.g. email), not config.topics.
    if (e.topic && isThreadTopic(e.topic)) {
      ctx.topics = [e.topic];
      return ctx;
    }

    // If already set to a non-default known topic, preserve it
    if (e.topic && e.topic !== 'general' && config.topics.includes(e.topic)) {
      ctx.topics = [e.topic];
      return ctx;
    }

    // Reactions carry no body to classify; fall through to default 'general'.
    if (e.payload.type === 'text' || e.payload.type === 'slash_command') {
      const body = e.payload.body.toLowerCase();

      for (const rule of compiledRules) {
        if (rule.keywords) {
          const matched = rule.keywords.some((kw) => body.includes(kw.toLowerCase()));
          if (matched) {
            e.topic = rule.topic;
            ctx.topics = [rule.topic];
            return ctx;
          }
        }
        if (rule.pattern) {
          if (rule.pattern.test(e.payload.body)) {
            e.topic = rule.topic;
            ctx.topics = [rule.topic];
            return ctx;
          }
        }
      }
    }

    // Default — normalize unrecognized topics to 'general'
    e.topic = 'general';
    ctx.topics = ['general'];
    return ctx;
  };
}

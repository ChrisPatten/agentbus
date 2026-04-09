import type { AppConfig } from '../../config/schema.js';
import type { PipelineStage } from '../types.js';

/**
 * Stage 60 — Priority Score
 *
 * Computes a numeric priority score (0–100) based on configurable weights.
 * Preserves explicit high/urgent priority values and maps them to scores.
 * Updates envelope.priority to match the computed score and stores
 * ctx.priorityScore + envelope.metadata.priority_score.
 * Never aborts the pipeline.
 */
export function createPriorityScore(config: AppConfig): PipelineStage {
  return async (ctx) => {
    const e = ctx.envelope;
    const w = config.pipeline.priority_weights;

    // If priority was already set to urgent/high upstream, preserve and map to score
    if (e.priority === 'urgent') {
      ctx.priorityScore = 100;
      e.metadata['priority_score'] = 100;
      return ctx;
    }
    if (e.priority === 'high') {
      ctx.priorityScore = 80;
      e.metadata['priority_score'] = 80;
      return ctx;
    }

    let score = w.base_score;

    // VIP sender bonus
    const senderId = e.sender.startsWith('contact:') ? e.sender.slice('contact:'.length) : e.sender;
    if (config.pipeline.vip_contacts.includes(senderId)) {
      score += w.vip_sender_bonus;
    }

    // Urgency keyword bonus
    const body = e.payload.body.toLowerCase();
    const hasUrgencyKeyword = config.pipeline.urgency_keywords.some((kw) =>
      body.includes(kw.toLowerCase()),
    );
    if (hasUrgencyKeyword) {
      score += w.urgency_keyword_bonus;
    }

    // Topic bonus: any non-general topic gets a boost — the assumption is that
    // classified messages (code, health, personal, etc.) are more relevant than
    // unclassified 'general' traffic.
    if (e.topic && e.topic !== 'general') {
      score += w.topic_bonus;
    }

    // Clamp 0–100
    score = Math.min(100, Math.max(0, score));

    // Map score to priority enum
    if (score >= 70) {
      e.priority = 'urgent';
    } else if (score >= 40) {
      e.priority = 'high';
    } else {
      e.priority = 'normal';
    }

    ctx.priorityScore = score;
    e.metadata['priority_score'] = score;
    return ctx;
  };
}

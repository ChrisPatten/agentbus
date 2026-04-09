import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { AppConfig } from '../../config/schema.js';
import type { PipelineStage, RouteTarget } from '../types.js';

/**
 * Stage 70 — Route Resolve
 *
 * Computes a stable conversation_id from sorted([contact_id, channel, topic]).
 * Matches the first route rule from config.pipeline.routes.
 * If no match and drop_unrouted: returns null (abort).
 * If no match: defaults to { adapterId: 'claude-code', recipientId: envelope.recipient }.
 * Sets ctx.routes and ctx.conversationId.
 */
export function createRouteResolve(config: AppConfig, _db: Database.Database): PipelineStage {
  const routes = config.pipeline.routes;

  // Warn at construction time if a non-last catch-all rule shadows subsequent rules.
  // A catch-all is a rule with match: {} — no sender, channel, or topic filter.
  for (let i = 0; i < routes.length - 1; i++) {
    const { match } = routes[i]!;
    if (!match.sender && !match.channel && !match.topic) {
      console.warn(
        `[pipeline:route-resolve] Catch-all route at index ${i} (match: {}) shadows all subsequent rules`,
      );
    }
  }

  return async (ctx) => {
    const e = ctx.envelope;

    // Compute conversation_id: sha256(sorted([contact_id, channel, topic]).join(':'))
    const contactId = e.sender.startsWith('contact:') ? e.sender.slice('contact:'.length) : e.sender;
    const parts = [contactId, e.channel, e.topic].sort();
    const conversationId = createHash('sha256').update(parts.join(':')).digest('hex');
    ctx.conversationId = conversationId;

    // Match first applicable route rule
    for (const rule of routes) {
      const { match } = rule;
      if (match.sender && match.sender !== e.sender) continue;
      if (match.channel && match.channel !== e.channel) continue;
      if (match.topic && match.topic !== e.topic) continue;

      const targets: RouteTarget[] = [rule.target];
      if (rule.also_notify) {
        targets.push(...rule.also_notify);
      }
      ctx.routes = targets;
      return ctx;
    }

    // No rule matched
    if (config.pipeline.drop_unrouted) {
      console.log('[pipeline:route-resolve] No matching route, dropping (drop_unrouted=true)');
      return null;
    }

    // Default route
    ctx.routes = [{ adapterId: 'claude-code', recipientId: e.recipient }];
    return ctx;
  };
}

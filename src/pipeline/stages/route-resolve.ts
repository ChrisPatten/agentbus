import type Database from 'better-sqlite3';
import type { AppConfig } from '../../config/schema.js';
import { computeConversationId } from '../conversation-id.js';
import { channelMatches, type PipelineStage, type RouteTarget } from '../types.js';

/**
 * Stage 70 — Route Resolve
 *
 * Computes a stable conversation_id from sorted([contact_id, channel, topic]).
 * Matches the first route rule from config.pipeline.routes.
 * If no match and drop_unrouted: returns null (abort).
 * If no match: defaults to { adapterId: 'claude-code', recipientId: envelope.recipient }.
 * Sets ctx.routes and ctx.conversationId.
 */
export function createRouteResolve(config: AppConfig, db: Database.Database): PipelineStage {
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

    const boundId = e.channel === 'app' ? e.metadata?.['bound_session_id'] : undefined;
    if (typeof boundId === 'string') {
      const contactId = e.sender.replace(/^contact:/, '');
      const bound = db.prepare(`SELECT s.id, s.conversation_id, s.agent_id, s.ended_at, cr.topic, cr.channel
        FROM sessions s JOIN conversation_registry cr ON cr.id = s.conversation_id
        WHERE s.id = ? AND s.contact_id = ? AND cr.contact_id = ?`)
        .get(boundId, contactId, contactId) as {id:string;conversation_id:string;agent_id:string|null;ended_at:string|null;topic:string;channel:string}|undefined;
      if (!bound || bound.ended_at || !bound.agent_id || bound.topic !== e.topic) return null;
      ctx.conversationId = bound.conversation_id;
      ctx.sessionId = bound.id;
      e.metadata['session_channel'] = typeof e.metadata['resumed_from_channel'] === 'string'
        ? e.metadata['resumed_from_channel'] : bound.channel;
      e.metadata['session_topic'] = bound.topic;
      e.metadata['conversation_id'] = bound.conversation_id;
      // The owner's configured transport is looked up by recipient. Route
      // matching on arrival channel would incorrectly choose the app default.
      const target = routes.find(rule => rule.target.recipientId === bound.agent_id &&
        (!rule.match.sender || rule.match.sender === e.sender) &&
        (!rule.match.channel || channelMatches(rule.match.channel, 'app')) &&
        (!rule.match.topic || rule.match.topic === 'general'))?.target;
      if (!target) return null;
      ctx.routes = [{ adapterId: target.adapterId, recipientId: bound.agent_id }];
      return ctx;
    }

    // Compute conversation_id: sha256(sorted([contact_id, channel, topic]).join(':'))
    const contactId = e.sender.startsWith('contact:') ? e.sender.slice('contact:'.length) : e.sender;
    const conversationId = computeConversationId(contactId, e.channel, e.topic);
    ctx.conversationId = conversationId;

    // Match first applicable route rule
    for (const rule of routes) {
      const { match } = rule;
      if (match.sender && match.sender !== e.sender) continue;
      if (match.channel && !channelMatches(match.channel, e.channel)) continue;
      if (match.topic && match.topic !== e.topic) continue;

      // Copy each target object rather than sharing the reference to the one
      // living inside `config.pipeline.routes[i]`/`.also_notify[i]` — later
      // stages (e.g. pool-route-resolve) mutate ctx.routes[n].recipientId in
      // place, and config is parsed once and reused for every envelope for
      // the lifetime of the process. Sharing the reference here would let
      // one envelope's resolution permanently corrupt the static route rule
      // for every subsequent envelope that matches it.
      const targets: RouteTarget[] = [{ ...rule.target }];
      if (rule.also_notify) {
        targets.push(...rule.also_notify.map((t) => ({ ...t })));
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

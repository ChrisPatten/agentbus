import type { PoolManager } from '../../pool/pool-manager.js';
import type { PipelineStage } from '../types.js';

/**
 * Stage ~72 — Pool Route Resolve. Runs after Stage 70 (route-resolve, which
 * sets ctx.routes/ctx.conversationId) and before Stage 80 (transcript-log,
 * which stamps sessions.agent_id from whatever ctx.routes' cc-pool
 * recipientId already is by the time it runs — so this stage MUST run first
 * and MUST mutate route.recipientId in place before returning).
 *
 * For every route target with adapterId === 'cc-pool', looks up the
 * matching PoolManager (keyed by the route's CURRENT recipientId, e.g.
 * "agent:peggy" — the pool's logical id, exactly as configured) and
 * rewrites that route's recipientId to the concrete pane PoolManager
 * resolved (or a parked-bucket id if none was available). A route whose
 * adapterId isn't 'cc-pool', or whose recipientId doesn't match any
 * configured pool, is left completely untouched.
 */
export function createPoolRouteResolve(poolManagers: Map<string, PoolManager>): PipelineStage {
  return async (ctx) => {
    if (ctx.routes.length === 0 || !ctx.conversationId) return ctx;
    const conversationId = ctx.conversationId;
    const contactId = ctx.envelope.sender.startsWith('contact:')
      ? ctx.envelope.sender.slice('contact:'.length)
      : ctx.envelope.sender;
    for (const route of ctx.routes) {
      if (route.adapterId !== 'cc-pool') continue;
      const manager = poolManagers.get(route.recipientId);
      if (!manager) {
        console.error(
          `[pipeline:pool-route-resolve] No cc-pool instance configured for recipient "${route.recipientId}" — leaving unresolved (message will not be picked up by any pane)`,
        );
        continue;
      }
      route.recipientId = await manager.resolveRoute(conversationId, {
        contact_id: contactId,
        channel: ctx.envelope.channel,
      });
    }
    return ctx;
  };
}

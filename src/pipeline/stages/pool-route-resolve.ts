import type { PoolManager } from '../../pool/pool-manager.js';
import type { PipelineStage } from '../types.js';

/**
 * Stage ~72 — Pool Route Resolve. Runs after Stage 70 (route-resolve, which
 * sets ctx.routes/ctx.conversationId) and before Stage 80 (transcript-log,
 * which stamps sessions.agent_id from whatever ctx.routes' cc-pool
 * recipientId already is by the time it runs — so this stage MUST run first
 * and MUST have the resolved recipientId visible on ctx.routes[n] before
 * returning).
 *
 * For every route target with adapterId === 'cc-pool', looks up the
 * matching PoolManager (keyed by the route's CURRENT recipientId, e.g.
 * "agent:peggy" — the pool's logical id, exactly as configured) and
 * replaces ctx.routes[n] with a fresh object carrying the concrete pane
 * PoolManager resolved (or a parked-bucket id if none was available), rather
 * than mutating the existing target object in place — defense in depth
 * against ctx.routes ever again sharing object identity with something
 * outside this call (route-resolve.ts now copies each target per envelope,
 * but a shared reference here previously let one envelope's resolution
 * permanently corrupt a static config route target for every subsequent
 * envelope matching that rule). A route whose adapterId isn't 'cc-pool', or
 * whose recipientId doesn't match any configured pool, is left completely
 * untouched.
 */
export function createPoolRouteResolve(poolManagers: Map<string, PoolManager>): PipelineStage {
  return async (ctx) => {
    if (ctx.routes.length === 0 || !ctx.conversationId) return ctx;
    const conversationId = ctx.conversationId;
    const contactId = ctx.envelope.sender.startsWith('contact:')
      ? ctx.envelope.sender.slice('contact:'.length)
      : ctx.envelope.sender;
    for (let i = 0; i < ctx.routes.length; i++) {
      const route = ctx.routes[i]!;
      if (route.adapterId !== 'cc-pool') continue;
      const manager = poolManagers.get(route.recipientId);
      if (!manager) {
        console.error(
          `[pipeline:pool-route-resolve] No cc-pool instance configured for recipient "${route.recipientId}" — leaving unresolved (message will not be picked up by any pane)`,
        );
        continue;
      }
      const recipientId = await manager.resolveRoute(conversationId, {
        contact_id: contactId,
        channel: ctx.envelope.channel,
        topic: ctx.envelope.topic,
      });
      // Replace the array element with a fresh object rather than mutating
      // `route` in place — defense in depth. Even with route-resolve.ts now
      // copying targets per envelope, this stage shouldn't itself rely on
      // being handed an object it's safe to mutate; if a future change to an
      // upstream stage ever reintroduces a shared reference, this stage
      // still won't corrupt it.
      ctx.routes[i] = { ...route, recipientId };
    }
    return ctx;
  };
}

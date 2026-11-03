/**
 * E96 S96.5 — agent publishing routes (main bus port, behind the shared
 * `X-Bus-Token` hook). The MCP surface tools call these.
 *
 *   GET    /api/v1/surface-publish/surfaces?agent_id=...   surfaces this agent may publish to
 *   PUT    /api/v1/surface-publish/:surface/events/:id     create or replace an Event (and its action jobs)
 *   DELETE /api/v1/surface-publish/:surface/events/:id     remove an Event and its jobs
 *   PUT    /api/v1/surface-publish/:surface/slots/:slot    set a slot override (primary: optional action; context: lines or widgets)
 *   DELETE /api/v1/surface-publish/:surface/slots/:slot    clear a slot override (and the job behind its button)
 *   PUT    /api/v1/surface-publish/:surface/faces/:id      change an existing face: enabled, order, layout
 *   POST   /api/v1/surface-publish/assets?agent_id=...     upload an image (raw body; PNG, JPEG, SVG); content-addressed
 *   PUT    /api/v1/surface-publish/:surface/widgets/:id    write widget data
 *   DELETE /api/v1/surface-publish/:surface/widgets/:id    remove a widget
 *   POST   /api/v1/surface-publish/answer-needed/clear     clear a conversation's answer-needed flag
 *
 * Identity: like the other agent routes (advisories, proposals), the caller
 * names itself with `agent_id` (body for PUT/POST, query for GET/DELETE); the
 * bus token is what authenticates the process. Authorisation: the agent id must
 * be listed in the surface's `publishers` (`*` = any agent). A pool pane id
 * (`peggy-pool-3`) also matches its pool's id (`peggy`).
 *
 * Errors: 400 with the validator's message (written for the agent), 403 when
 * the agent is not a publisher, 404 for an unknown surface.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import type Database from 'better-sqlite3';
import { BoundsError, BOUNDS, ID_RE, type JobStore, type ResourceHub, type ResourceName } from '../surface/types.js';
import { checkRingCapacity, SLOT_CONTEXT, validateEvent, validateFaceLayout, validateSlot, validateWidget, type FollowTarget } from '../surface/validate.js';
import { ASSET_TYPES, assetContentType, assetExists, storeAsset } from '../surface/assets.js';
import { clearAnswerNeeded } from '../surface/flags.js';
import { computeConversationId } from '../pipeline/conversation-id.js';

export const SURFACE_PUBLISH_PREFIX = '/api/v1/surface-publish';
const BODY_LIMIT = 16 * 1024;

export interface PublishableSurface { id: string; follow: FollowTarget; publishers: string[] }

export interface SurfacePublishDeps {
  surfaces: () => PublishableSurface[];
  hub: ResourceHub;
  jobs: JobStore;
  db: Database.Database;
  now?: () => number;
  /** Directory of content-addressed assets (`<db dir>/surface-assets`). Without it the upload route is not registered and `detail.image` is not checked. */
  assetDir?: string;
  /** Largest accepted upload, bytes (default 1 MiB). */
  assetMaxBytes?: number;
  /** Called after an answer-needed flag was cleared (e.g. to rebuild the sessions resource). */
  onAnswerNeededCleared?: (conversationId: string) => void;
}

const bare = (id: string) => id.replace(/^agent:/, '');

/** True when `agentId` (bare or prefixed) may publish given `publishers`. A pool pane matches its pool's id. */
export function isPublisher(publishers: readonly string[], agentId: string): boolean {
  if (!agentId) return false;
  const id = bare(agentId);
  const pool = /^(.+)-pool-\d+$/.exec(id)?.[1];
  return publishers.some((p) => p === '*' || bare(p) === id || (pool !== undefined && bare(p) === pool));
}

/** The surfaces `agentId` may publish to, with their follow target. */
export function publishableSurfaces(surfaces: readonly PublishableSurface[], agentId: string): { id: string; follow: FollowTarget }[] {
  return surfaces.filter((s) => isPublisher(s.publishers, agentId)).map((s) => ({ id: s.id, follow: s.follow }));
}

type Body = Record<string, unknown>;
const asBody = (b: unknown): Body => (b && typeof b === 'object' && !Array.isArray(b) ? (b as Body) : {});
const agentOf = (body: Body, query: Record<string, unknown>): string => {
  const v = body['agent_id'] ?? query['agent_id'];
  return typeof v === 'string' ? v.trim() : '';
};

export function registerSurfacePublishRoutes(server: FastifyInstance, deps: SurfacePublishDeps): void {
  const now = deps.now ?? Date.now;
  const P = SURFACE_PUBLISH_PREFIX;

  /** Resolves the surface and checks the caller; sends the error reply and returns null when it fails. */
  const authorize = (reply: FastifyReply, surfaceId: string, agentId: string): PublishableSurface | null => {
    if (!agentId) { void reply.code(400).send({ ok: false, error: 'agent_id is required' }); return null; }
    const surface = deps.surfaces().find((s) => s.id === surfaceId);
    if (!surface) {
      const known = publishableSurfaces(deps.surfaces(), agentId).map((s) => s.id);
      void reply.code(404).send({ ok: false, error: `unknown surface "${surfaceId}"${known.length ? `; you can publish to: ${known.join(', ')}` : ''}` });
      return null;
    }
    if (!isPublisher(surface.publishers, agentId)) {
      void reply.code(403).send({
        ok: false,
        error: `agent "${bare(agentId)}" may not publish to surface "${surfaceId}": add it to adapters.intercom.surfaces[id=${surfaceId}].publishers in the bus config`,
      });
      return null;
    }
    return surface;
  };

  /** Runs a write; a BoundsError becomes a 400 with its message. */
  const guarded = (reply: FastifyReply, fn: () => unknown) => {
    try {
      return fn();
    } catch (err) {
      if (err instanceof BoundsError) return reply.code(400).send({ ok: false, error: err.message });
      throw err;
    }
  };

  const checkId = (value: string, what: string) => {
    if (!ID_RE.test(value)) throw new BoundsError(`${what} "${value}" is invalid: use 1-64 lowercase letters, digits, - or _, starting with a letter or digit`);
  };

  /** Rejects a new item when the surface already holds `limit` of them (live ones only, for events). */
  const checkCapacity = (surfaceId: string, resource: ResourceName, itemId: string, limit: number, what: string, live?: (item: Record<string, unknown>) => boolean) => {
    if (deps.hub.get(surfaceId, resource, itemId)) return;
    const items = Object.values(deps.hub.snapshot(surfaceId, resource).items);
    const count = live ? items.filter(live).length : items.length;
    if (count >= limit) throw new BoundsError(`surface "${surfaceId}" already has ${count} ${what}; the limit is ${limit}. Remove one first.`);
  };

  const notBusOwned = (surfaceId: string, eventId: string) => {
    const existing = deps.hub.get(surfaceId, 'events', eventId);
    if (existing && (existing['kind'] === 'approval' || existing['source'] === 'bus')) {
      throw new BoundsError(`event "${eventId}" belongs to the bus (an approval); agents cannot change or remove it`);
    }
    return existing;
  };

  // ── List ───────────────────────────────────────────────────────────────────
  server.get<{ Querystring: { agent_id?: string } }>(`${P}/surfaces`, async (req, reply) => {
    const agentId = agentOf({}, req.query);
    if (!agentId) return reply.code(400).send({ ok: false, error: 'agent_id is required' });
    return { ok: true, surfaces: publishableSurfaces(deps.surfaces(), agentId) };
  });

  // ── Events ─────────────────────────────────────────────────────────────────
  server.put<{ Params: { surface: string; id: string }; Querystring: Record<string, string> }>(
    `${P}/:surface/events/:id`, { bodyLimit: BODY_LIMIT },
    async (req, reply) => {
      const body = asBody(req.body);
      const agentId = agentOf(body, req.query);
      const surface = authorize(reply, req.params.surface, agentId);
      if (!surface) return reply;
      return guarded(reply, () => {
        if (body['id'] !== undefined && body['id'] !== req.params.id) throw new BoundsError(`id in the body ("${String(body['id'])}") does not match the path ("${req.params.id}")`);
        const t = now();
        const { agent_id: _a, ...input } = body;
        const { event, jobs } = validateEvent({ ...input, id: req.params.id }, { follow: surface.follow, source: `agent:${bare(agentId)}`, now: t });
        const existing = notBusOwned(surface.id, event.id);
        checkRingCapacity(Object.values(deps.hub.snapshot(surface.id, 'events').items), event, t);
        const image = event.detail?.image;
        if (image && deps.assetDir && !assetExists(deps.assetDir, image)) {
          throw new BoundsError(`detail.image ${image} is not in the asset store; upload the file first (surface_upload_asset) and use the hash it returns`);
        }
        checkCapacity(surface.id, 'events', event.id, BOUNDS.eventsPerSurface, 'live events',
          (item) => typeof item['expires_at'] !== 'string' || Date.parse(item['expires_at']) > t);
        if (existing && typeof existing['created_at'] === 'string') event.created_at = existing['created_at'];
        const rev = deps.db.transaction(() => {
          deps.jobs.replaceForEvent(surface.id, event.id, jobs, `agent:${bare(agentId)}`);
          return deps.hub.apply(surface.id, 'events', [{ op: 'set', id: event.id, value: event as unknown as Record<string, unknown> }]);
        })();
        return reply.code(existing ? 200 : 201).send({ ok: true, surface: surface.id, id: event.id, created: !existing, rev, expires_at: event.expires_at, actions: event.actions.map((a) => a.id) });
      });
    },
  );

  server.delete<{ Params: { surface: string; id: string }; Querystring: Record<string, string> }>(
    `${P}/:surface/events/:id`,
    async (req, reply) => {
      const surface = authorize(reply, req.params.surface, agentOf(asBody(req.body), req.query));
      if (!surface) return reply;
      return guarded(reply, () => {
        checkId(req.params.id, 'id');
        const existing = notBusOwned(surface.id, req.params.id);
        const result = deps.db.transaction(() => {
          const jobsRemoved = deps.jobs.removeForEvent(surface.id, req.params.id);
          const rev = existing ? deps.hub.apply(surface.id, 'events', [{ op: 'remove', id: req.params.id }]) : null;
          return { jobsRemoved, rev };
        })();
        return { ok: true, surface: surface.id, id: req.params.id, removed: !!existing, jobs_removed: result.jobsRemoved, ...(result.rev !== null ? { rev: result.rev } : {}) };
      });
    },
  );

  // ── Slots ──────────────────────────────────────────────────────────────────
  server.put<{ Params: { surface: string; slot: string }; Querystring: Record<string, string> }>(
    `${P}/:surface/slots/:slot`, { bodyLimit: BODY_LIMIT },
    async (req, reply) => {
      const body = asBody(req.body);
      const agentId = agentOf(body, req.query);
      const surface = authorize(reply, req.params.surface, agentId);
      if (!surface) return reply;
      return guarded(reply, () => {
        const { agent_id: _a, ...input } = body;
        const { slot, jobs } = validateSlot({ ...input, id: req.params.slot }, {
          source: `agent:${bare(agentId)}`, now: now(), follow: surface.follow,
          widgetExists: (wid) => deps.hub.get(surface.id, 'widgets', wid) !== null,
        }, true);
        checkCapacity(surface.id, 'slots', slot.id, BOUNDS.slotsPerSurface, 'slot overrides');
        const rev = deps.db.transaction(() => {
          deps.jobs.replaceForSlot(surface.id, slot.id, jobs, `agent:${bare(agentId)}`);
          return deps.hub.apply(surface.id, 'slots', [{ op: 'set', id: slot.id, value: slot as unknown as Record<string, unknown> }]);
        })();
        return { ok: true, surface: surface.id, slot: slot.id, until: slot.until, rev, ...(slot.action ? { action: slot.action.id } : {}) };
      });
    },
  );

  server.delete<{ Params: { surface: string; slot: string }; Querystring: Record<string, string> }>(
    `${P}/:surface/slots/:slot`,
    async (req, reply) => {
      const surface = authorize(reply, req.params.surface, agentOf(asBody(req.body), req.query));
      if (!surface) return reply;
      return guarded(reply, () => {
        checkId(req.params.slot, 'slot');
        const existing = deps.hub.get(surface.id, 'slots', req.params.slot);
        const result = deps.db.transaction(() => {
          const jobsRemoved = deps.jobs.removeForSlot(surface.id, req.params.slot);
          const rev = existing ? deps.hub.apply(surface.id, 'slots', [{ op: 'remove', id: req.params.slot }]) : null;
          return { jobsRemoved, rev };
        })();
        return { ok: true, surface: surface.id, slot: req.params.slot, removed: !!existing, jobs_removed: result.jobsRemoved, ...(result.rev !== null ? { rev: result.rev } : {}) };
      });
    },
  );

  // ── Widgets ────────────────────────────────────────────────────────────────
  server.put<{ Params: { surface: string; id: string }; Querystring: Record<string, string> }>(
    `${P}/:surface/widgets/:id`, { bodyLimit: BODY_LIMIT },
    async (req, reply) => {
      const body = asBody(req.body);
      const agentId = agentOf(body, req.query);
      const surface = authorize(reply, req.params.surface, agentId);
      if (!surface) return reply;
      return guarded(reply, () => {
        const { agent_id: _a, ...input } = body;
        const widget = validateWidget({ ...input, id: req.params.id }, { source: `agent:${bare(agentId)}`, now: now() });
        checkCapacity(surface.id, 'widgets', widget.id, BOUNDS.widgetsPerSurface, 'widgets');
        const rev = deps.hub.apply(surface.id, 'widgets', [{ op: 'set', id: widget.id, value: widget as unknown as Record<string, unknown> }]);
        return { ok: true, surface: surface.id, id: widget.id, rev };
      });
    },
  );

  server.delete<{ Params: { surface: string; id: string }; Querystring: Record<string, string> }>(
    `${P}/:surface/widgets/:id`,
    async (req, reply) => {
      const surface = authorize(reply, req.params.surface, agentOf(asBody(req.body), req.query));
      if (!surface) return reply;
      return guarded(reply, () => {
        checkId(req.params.id, 'id');
        const existing = deps.hub.get(surface.id, 'widgets', req.params.id);
        const context = deps.hub.get(surface.id, 'slots', SLOT_CONTEXT);
        if (existing && Array.isArray(context?.['widgets']) && (context['widgets'] as unknown[]).includes(req.params.id)) {
          throw new BoundsError(`widget "${req.params.id}" is bound to the "${SLOT_CONTEXT}" slot; update or clear that slot first`);
        }
        const rev = existing ? deps.hub.apply(surface.id, 'widgets', [{ op: 'remove', id: req.params.id }]) : null;
        return { ok: true, surface: surface.id, id: req.params.id, removed: !!existing, ...(rev !== null ? { rev } : {}) };
      });
    },
  );

  // ── Faces ──────────────────────────────────────────────────────────────────
  // Faces are seeded by the bus; an agent may reorder, disable or give one a slot layout. Body: { enabled?, order?, layout? }
  // (`layout: null` removes the layout). Unknown faces are refused.
  server.put<{ Params: { surface: string; id: string }; Querystring: Record<string, string> }>(
    `${P}/:surface/faces/:id`, { bodyLimit: BODY_LIMIT },
    async (req, reply) => {
      const body = asBody(req.body);
      const agentId = agentOf(body, req.query);
      const surface = authorize(reply, req.params.surface, agentId);
      if (!surface) return reply;
      return guarded(reply, () => {
        checkId(req.params.id, 'id');
        const existing = deps.hub.get(surface.id, 'faces', req.params.id);
        if (!existing) {
          const known = Object.keys(deps.hub.snapshot(surface.id, 'faces').items);
          throw new BoundsError(`unknown face "${req.params.id}"${known.length ? `; faces on this surface: ${known.join(', ')}` : ''}`);
        }
        const patch: Record<string, unknown> = {};
        if (body['enabled'] !== undefined) {
          if (typeof body['enabled'] !== 'boolean') throw new BoundsError('enabled must be true or false');
          patch['enabled'] = body['enabled'];
        }
        if (body['order'] !== undefined) {
          if (!Number.isInteger(body['order']) || (body['order'] as number) < 0 || (body['order'] as number) > 99) throw new BoundsError('order must be a whole number from 0 to 99');
          patch['order'] = body['order'];
        }
        if (body['layout'] !== undefined) patch['layout'] = body['layout'] === null ? null : validateFaceLayout(body['layout']);
        if (Object.keys(patch).length === 0) throw new BoundsError('nothing to change: pass enabled, order or layout');
        const rev = deps.hub.apply(surface.id, 'faces', [{ op: 'patch', id: req.params.id, value: patch }]);
        return { ok: true, surface: surface.id, id: req.params.id, rev };
      });
    },
  );

  // ── Assets ─────────────────────────────────────────────────────────────────
  // Raw body, Content-Type image/png | image/jpeg | image/svg+xml. Any agent that publishes to at least one
  // surface may upload (the shared bus token authenticates the process; devices never reach this prefix).
  if (deps.assetDir) {
    const assetDir = deps.assetDir;
    const limit = deps.assetMaxBytes ?? 1_048_576;
    for (const type of Object.keys(ASSET_TYPES)) {
      if (!server.hasContentTypeParser(type)) server.addContentTypeParser(type, { parseAs: 'buffer', bodyLimit: limit }, (_req, body, done) => done(null, body));
    }
    server.post<{ Querystring: Record<string, string> }>(`${P}/assets`, { bodyLimit: limit }, async (req, reply) => {
      const agentId = agentOf({}, req.query);
      if (!agentId) return reply.code(400).send({ ok: false, error: 'agent_id is required' });
      if (publishableSurfaces(deps.surfaces(), agentId).length === 0) {
        return reply.code(403).send({ ok: false, error: `agent "${bare(agentId)}" is not a publisher of any surface, so it may not upload assets` });
      }
      const type = assetContentType(req.headers['content-type']);
      if (!type || !Buffer.isBuffer(req.body)) {
        return reply.code(415).send({ ok: false, error: `send the file as the raw request body with Content-Type ${Object.keys(ASSET_TYPES).join(', ')}` });
      }
      return guarded(reply, () => {
        const stored = storeAsset(assetDir, type, req.body as Buffer);
        return reply.code(stored.created ? 201 : 200).send({ ok: true, ...stored, reference: stored.hash });
      });
    });
  }

  // ── Answer needed ──────────────────────────────────────────────────────────
  // Body: { conversation_id } or { channel, contact, topic? }. Any agent with the bus token may clear.
  server.post(`${P}/answer-needed/clear`, async (req, reply) => {
    const body = asBody(req.body);
    let conversationId = typeof body['conversation_id'] === 'string' ? body['conversation_id'].trim() : '';
    if (!conversationId) {
      const channel = typeof body['channel'] === 'string' ? body['channel'].trim() : '';
      const contact = typeof body['contact'] === 'string' ? body['contact'].trim().replace(/^contact:/, '') : '';
      const topic = typeof body['topic'] === 'string' && body['topic'].trim() ? body['topic'].trim() : 'general';
      if (!channel || !contact) return reply.code(400).send({ ok: false, error: 'pass conversation_id, or channel and contact (and topic for a forum topic)' });
      conversationId = computeConversationId(contact, channel, topic);
    }
    const cleared = clearAnswerNeeded(deps.db, conversationId);
    if (cleared) deps.onAnswerNeededCleared?.(conversationId);
    return { ok: true, conversation_id: conversationId, cleared };
  });
}

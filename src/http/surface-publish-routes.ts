/**
 * E96 S96.5 — agent publishing routes (main bus port, behind the shared
 * `X-Bus-Token` hook). The MCP surface tools call these.
 *
 *   GET    /api/v1/surface-publish/surfaces?agent_id=...   surfaces this agent may publish to
 *   PUT    /api/v1/surface-publish/:surface/events/:id     create or replace an Event (and its action jobs)
 *   DELETE /api/v1/surface-publish/:surface/events/:id     end an Event (?reason=withdrawn|answered|cleared; it stays as a tombstone) and remove its jobs
 *   PUT    /api/v1/surface-publish/:surface/slots/:slot    set a slot override (primary: optional action; context: lines or widgets)
 *   DELETE /api/v1/surface-publish/:surface/slots/:slot    clear a slot override (and the job behind its button)
 *   PUT    /api/v1/surface-publish/:surface/faces/:id      change an existing face: enabled, order, layout
 *   POST   /api/v1/surface-publish/assets?agent_id=...     upload an image (raw body; PNG, JPEG, SVG); content-addressed
 *   PUT    /api/v1/surface-publish/:surface/widgets/:id    write widget data
 *   DELETE /api/v1/surface-publish/:surface/widgets/:id    remove a widget
 *   POST   /api/v1/surface-publish/answer-needed/clear     clear a conversation's answer-needed flag
 *   POST   /api/v1/surface-publish/:surface/command        device command {op, args?, ttl_s?, wait?} (the `device` tool); see docs/DEVICE_COMMANDS.md
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
import { isLiveEvent, isTerminal, REMOVE_REASONS, stateOf, tombstone, type RemoveReason } from '../surface/lifecycle.js';
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
  log?: (line: string) => void;
  /** Device commands: sends a `command` to the surface's device (the IntercomService method). Without it the command route is not registered. */
  sendCommand?: (surfaceId: string, input: { op: string; args?: unknown; ttlS?: number; wait?: boolean; extraOps?: { op: string; usage: string }[] }) => Promise<{ ok: boolean; reason?: string; data?: unknown }>;
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

  /**
   * Rejects a new item when the surface already holds `limit` of them (live ones only, for events). With `live`, an
   * existing item that is not live (an Event tombstone) counts as new: reviving it adds one.
   */
  const checkCapacity = (surfaceId: string, resource: ResourceName, itemId: string, limit: number, what: string, live?: (item: Record<string, unknown>) => boolean) => {
    const current = deps.hub.get(surfaceId, resource, itemId);
    if (current && (!live || live(current))) return;
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
        const stored = notBusOwned(surface.id, event.id);
        // E100: re-publishing an ended event (a tombstone) starts a new open life: new created_at, fresh jobs.
        const existing = stored && !isTerminal(stored) ? stored : null;
        checkRingCapacity(Object.values(deps.hub.snapshot(surface.id, 'events').items), event, t);
        const image = event.detail?.image;
        if (image && deps.assetDir && !assetExists(deps.assetDir, image)) {
          throw new BoundsError(`detail.image ${image} is not in the asset store; upload the file first (surface_upload_asset) and use the hash it returns`);
        }
        checkCapacity(surface.id, 'events', event.id, BOUNDS.eventsPerSurface, 'live events', (item) => isLiveEvent(item, t));
        if (existing && typeof existing['created_at'] === 'string') event.created_at = existing['created_at'];
        const rev = deps.db.transaction(() => {
          // A new life must not inherit fire counts: a one-shot button that fired before is armed again.
          if (stored && !existing) deps.jobs.removeForEvent(surface.id, event.id);
          deps.jobs.replaceForEvent(surface.id, event.id, jobs, `agent:${bare(agentId)}`);
          return deps.hub.apply(surface.id, 'events', [{ op: 'set', id: event.id, value: event as unknown as Record<string, unknown> }]);
        })();
        return reply.code(existing ? 200 : 201).send({
          ok: true, surface: surface.id, id: event.id, created: !existing, ...(stored && !existing ? { revived: true } : {}), state: 'open', rev,
          expires_at: event.expires_at, actions: event.actions.map((a) => a.id), kinds: Object.fromEntries(event.actions.map((a) => [a.id, a.kind])),
        });
      });
    },
  );

  server.delete<{ Params: { surface: string; id: string }; Querystring: Record<string, string> }>(
    `${P}/:surface/events/:id`,
    async (req, reply) => {
      const body = asBody(req.body);
      const surface = authorize(reply, req.params.surface, agentOf(body, req.query));
      if (!surface) return reply;
      return guarded(reply, () => {
        checkId(req.params.id, 'id');
        const rawReason = req.query['reason'] ?? body['reason'];
        if (rawReason !== undefined && rawReason !== '' && !(REMOVE_REASONS as readonly unknown[]).includes(rawReason)) {
          throw new BoundsError(`reason must be one of ${REMOVE_REASONS.join(', ')} (default withdrawn): withdrawn = no longer needed, answered = Chris answered it elsewhere, cleared = done or acknowledged`);
        }
        const reason: RemoveReason = rawReason ? (rawReason as RemoveReason) : 'withdrawn';
        const stored = notBusOwned(surface.id, req.params.id);
        // E100: the event stays as a tombstone with the reason as its state; an already-ended one is left as it is.
        const ending = stored && !isTerminal(stored) ? stored : null;
        const result = deps.db.transaction(() => {
          const jobsRemoved = deps.jobs.removeForEvent(surface.id, req.params.id);
          const at = new Date(now()).toISOString();
          const rev = ending ? deps.hub.apply(surface.id, 'events', [{ op: 'set', id: req.params.id, value: tombstone(ending, reason, at) }]) : null;
          return { jobsRemoved, rev };
        })();
        return {
          ok: true, surface: surface.id, id: req.params.id, removed: !!ending, ...(stored ? { state: ending ? reason : stateOf(stored) } : {}),
          jobs_removed: result.jobsRemoved, ...(result.rev !== null ? { rev: result.rev } : {}),
        };
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

  // ── Device commands ────────────────────────────────────────────────────────
  // One tool, any op. `help` and the bus ops below are answered here; every other op goes to the device as a
  // `command` frame. Same auth as the other routes: an agent listed in the surface's `publishers`.
  if (deps.sendCommand) {
    const sendCommand = deps.sendCommand;
    /** Phase 2: ops the bus runs itself by calling the existing publish routes (same validation, limits and ownership rules). */
    const BUS_OPS: { op: string; usage: string }[] = [
      { op: 'event.publish', usage: 'args {id,title,...} as surface_publish_event' },
      { op: 'event.remove', usage: 'args {id, reason?: withdrawn|answered|cleared}' },
      { op: 'widget.write', usage: 'args {id,type,data:{...}}' },
      { op: 'widget.remove', usage: 'args {id}' },
      ...(deps.assetDir ? [{ op: 'asset.upload', usage: 'args {data_base64, content_type: image/png|image/jpeg|image/svg+xml}' }] : []),
    ];
    const argObject = (args: unknown): Record<string, unknown> => {
      let v = args;
      if (typeof v === 'string') { try { v = JSON.parse(v); } catch { throw new BoundsError('args must be a JSON object'); } }
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new BoundsError('args must be a JSON object');
      return v as Record<string, unknown>;
    };
    const itemId = (a: Record<string, unknown>): string => {
      if (typeof a['id'] !== 'string' || !a['id']) throw new BoundsError('args.id is required');
      return encodeURIComponent(a['id']);
    };
    const REASON: Record<number, string> = { 400: 'bad_args', 403: 'forbidden', 404: 'unknown_surface', 415: 'bad_args', 413: 'bad_args' };

    server.post<{ Params: { surface: string } }>(`${P}/:surface/command`, { bodyLimit: deps.assetMaxBytes ? Math.ceil(deps.assetMaxBytes * 1.4) + 4096 : BODY_LIMIT }, async (req, reply) => {
      const body = asBody(req.body);
      const agentId = agentOf(body, req.query as Record<string, unknown>);
      const surface = authorize(reply, req.params.surface, agentId);
      if (!surface) return reply;
      const op = typeof body['op'] === 'string' ? body['op'].trim() : '';
      if (!op || op.length > 40) return reply.code(400).send({ ok: false, error: 'op is required (1-40 characters); op "help" lists what the device can do' });
      const ttl = typeof body['ttl_s'] === 'number' ? body['ttl_s'] : undefined;
      const wait = body['wait'] === false ? false : true;
      const send = async () => sendCommand(surface.id, {
        op, ...(body['args'] !== undefined ? { args: body['args'] } : {}), ...(ttl !== undefined ? { ttlS: ttl } : {}), wait, extraOps: BUS_OPS,
      });
      const bus = BUS_OPS.find((o) => o.op === op);
      if (!bus) {
        const r = await send();
        return reply.send({ ...r, surface: surface.id });
      }
      // Bus ops: logged like device commands, then routed to the existing handler with the caller's own identity.
      let target: { method: 'PUT' | 'DELETE' | 'POST'; url: string; payload?: unknown; headers?: Record<string, string> };
      try {
        const a = op === 'asset.upload' ? asBody(body['args']) : argObject(body['args']);
        const base = `${P}/${encodeURIComponent(surface.id)}`;
        const q = `agent_id=${encodeURIComponent(agentId)}`;
        const { id: _i, ...rest } = a;
        switch (op) {
          case 'event.publish': target = { method: 'PUT', url: `${base}/events/${itemId(a)}`, payload: { ...rest, agent_id: agentId } }; break;
          case 'event.remove': target = { method: 'DELETE', url: `${base}/events/${itemId(a)}?${q}${typeof a['reason'] === 'string' ? `&reason=${encodeURIComponent(a['reason'])}` : ''}` }; break;
          case 'widget.write': target = { method: 'PUT', url: `${base}/widgets/${itemId(a)}`, payload: { ...rest, agent_id: agentId } }; break;
          case 'widget.remove': target = { method: 'DELETE', url: `${base}/widgets/${itemId(a)}?${q}` }; break;
          default: {
            const type = typeof a['content_type'] === 'string' ? a['content_type'] : '';
            const data = typeof a['data_base64'] === 'string' ? a['data_base64'] : '';
            if (!type || !data) throw new BoundsError('args needs data_base64 and content_type');
            target = { method: 'POST', url: `${P}/assets?${q}`, payload: Buffer.from(data, 'base64'), headers: { 'content-type': type } };
          }
        }
      } catch (err) {
        if (err instanceof BoundsError) return reply.send({ ok: false, reason: 'bad_args', data: err.message, surface: surface.id });
        throw err;
      }
      const token = req.headers['x-bus-token'];
      const res = await server.inject({
        method: target.method, url: target.url,
        ...(target.payload !== undefined ? { payload: target.payload as string | Buffer | object } : {}),
        headers: { ...(typeof token === 'string' ? { 'x-bus-token': token } : {}), ...(target.headers ?? {}) },
      });
      let data: Record<string, unknown> = {};
      try { data = res.json() as Record<string, unknown>; } catch { /* non-JSON */ }
      const outcome = res.statusCode < 300 && data['ok'] !== false
        ? { ok: true, data: (({ ok: _o, ...r }) => r)(data) }
        : { ok: false, reason: REASON[res.statusCode] ?? 'failed', data: data['error'] ?? `HTTP ${res.statusCode}` };
      deps.log?.(JSON.stringify({ evt: 'device_command', surface_id: surface.id, op, bus: true, ok: outcome.ok, ...(outcome.ok ? {} : { reason: outcome.reason }) }));
      return reply.send({ ...outcome, surface: surface.id });
    });
  }
}

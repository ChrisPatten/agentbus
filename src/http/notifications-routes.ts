/**
 * E89 — notification HTTP API.
 *
 *   POST  /api/v1/notifications            create, or update in place by `key`
 *   PATCH /api/v1/notifications/:id        update (or PATCH /api/v1/notifications?key=...)
 *   GET   /api/v1/notifications?state=...  active | open (default) | all
 *
 * Auth: `Authorization: Bearer <token>`, where the token is the value of any env
 * var named in `notifications.api_tokens_env`. These routes bypass the shared
 * `X-Bus-Token` hook. The MCP tools use the same handlers under
 * `/api/v1/internal/notifications*`, which keep the shared bus auth instead.
 * Limits: 8 KB body, 30 writes per minute per source (429). Not for tailscale serve.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { NotificationsConfig } from '../config/schema.js';
import type { IntercomService } from '../intercom/service.js';
import { NotifyInput, UpdateInput, publicNotification, type StateFilter } from '../intercom/notifications-store.js';

export const NOTIFICATIONS_BODY_LIMIT = 8 * 1024;
const PUBLIC_PREFIX = '/api/v1/notifications';

/** True for URLs that carry their own Bearer auth (they skip the shared `X-Bus-Token` hook). */
export function isNotificationsApiUrl(url: string): boolean {
  const path = url.split('?')[0]!;
  return path === PUBLIC_PREFIX || path.startsWith(`${PUBLIC_PREFIX}/`);
}

const sha = (s: string) => createHash('sha256').update(s).digest();

export function registerNotificationRoutes(
  server: FastifyInstance,
  deps: { config: NotificationsConfig; service: IntercomService; env?: NodeJS.ProcessEnv },
): void {
  const { service, config } = deps;
  const env = deps.env ?? process.env;
  const tokens = config.api_tokens_env.map((name) => env[name]).filter((t): t is string => !!t && t.length >= 16).map(sha);

  const authorized = (req: FastifyRequest): boolean => {
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) return false;
    const given = sha(h.slice(7).trim());
    let ok = false;
    for (const t of tokens) if (timingSafeEqual(t, given)) ok = true;
    return ok;
  };

  const create = (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = NotifyInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: 'invalid_body', detail: parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
    if (!service.writeAllowed(parsed.data.source)) return reply.code(429).header('Retry-After', '60').send({ ok: false, error: 'rate_limited' });
    const res = service.raise(parsed.data);
    return reply.code(res.created ? 201 : 200).send({ ok: true, id: res.notification.id, key: res.notification.key, state: res.notification.state, created: res.created });
  };

  const update = (req: FastifyRequest<{ Params: { id?: string }; Querystring: { key?: string } }>, reply: FastifyReply) => {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const parsed = UpdateInput.safeParse({ ...body, ...(req.params.id ? { id: req.params.id } : {}), ...(req.query.key ? { key: req.query.key } : {}) });
    if (!parsed.success || (!parsed.data.id && !parsed.data.key)) {
      return reply.code(400).send({ ok: false, error: 'invalid_body', detail: parsed.success ? 'id or key is required' : parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
    }
    if (!service.writeAllowed(`patch:${parsed.data.id ?? parsed.data.key}`)) return reply.code(429).header('Retry-After', '60').send({ ok: false, error: 'rate_limited' });
    const res = service.patch(parsed.data);
    if ('error' in res) return reply.code(res.error === 'not_found' ? 404 : res.error === 'terminal' ? 409 : 400).send({ ok: false, error: res.error });
    return { ok: true, id: res.notification.id, key: res.notification.key, state: res.notification.state };
  };

  const list = (req: FastifyRequest<{ Querystring: { state?: string; limit?: string } }>, reply: FastifyReply) => {
    const state = req.query.state ?? 'open';
    if (state !== 'active' && state !== 'open' && state !== 'all') return reply.code(400).send({ ok: false, error: 'invalid_state' });
    const limit = req.query.limit === undefined ? 50 : Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1) return reply.code(400).send({ ok: false, error: 'invalid_limit' });
    return { ok: true, notifications: service.list(state as StateFilter, limit).map(publicNotification) };
  };

  const opts = { bodyLimit: NOTIFICATIONS_BODY_LIMIT };
  const guard = <T extends FastifyRequest>(fn: (req: T, reply: FastifyReply) => unknown) =>
    async (req: T, reply: FastifyReply) => (authorized(req) ? fn(req, reply) : reply.code(401).send({ ok: false, error: 'unauthorized' }));

  // Public, Bearer-token routes.
  server.post(PUBLIC_PREFIX, opts, guard(create));
  server.patch<{ Params: { id: string }; Querystring: { key?: string } }>(`${PUBLIC_PREFIX}/:id`, opts, guard(update));
  server.patch<{ Querystring: { key?: string } }>(PUBLIC_PREFIX, opts, guard(update as never));
  server.get<{ Querystring: { state?: string; limit?: string } }>(PUBLIC_PREFIX, guard(list));

  // Internal routes for the MCP tools: shared bus auth (X-Bus-Token when configured), same handlers.
  const internal = '/api/v1/internal/notifications';
  server.post(internal, opts, async (req, reply) => create(req, reply));
  server.patch<{ Params: { id: string }; Querystring: { key?: string } }>(`${internal}/:id`, opts, async (req, reply) => update(req, reply));
  server.patch<{ Querystring: { key?: string } }>(internal, opts, async (req, reply) => update(req as never, reply));
  server.get<{ Querystring: { state?: string; limit?: string } }>(internal, async (req, reply) => list(req, reply));
}

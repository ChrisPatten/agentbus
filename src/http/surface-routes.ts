/**
 * E96 — Surface API v2 routes (device-facing). Mounted on the main port and on the
 * separate TLS surface listener (S96.2); every route carries its own device auth,
 * so the bus `X-Bus-Token` hook skips `/api/v1/surface`.
 *
 *   GET  /api/v1/surface/health                 Bearer <device credential>
 *   GET  /api/v1/surface/state                  Bearer; every resource with its rev
 *   GET  /api/v1/surface/conversations/:id      Bearer; paged transcript (?before=&limit=)
 *   GET  /api/v1/surface/assets/:hash           Bearer; content-addressed file (sha256)
 *   POST /api/v1/surface/actions                Bearer; fire an action (same handler as the WS frame)
 *   POST /api/v1/surface/pair                   one-time code → device credential
 *   GET  /api/v1/surface/ws                     WebSocket, protocol v2 (v1 frames kept)
 *
 * See docs/SURFACE_API.md.
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import { z } from 'zod';
import type { IntercomAdapterConfig } from '../config/schema.js';
import type { IntercomService, Surface } from '../intercom/service.js';
import { RESOURCE_NAMES, type ConversationPage, type Device, type SurfaceState } from '../surface/types.js';
import { PairBody, redeemForDevice, surfaceSocketHandler } from './intercom-routes.js';

export const SURFACE_PATH_PREFIX = '/api/v1/surface';
/** True for URLs served by this module (they bypass the shared `X-Bus-Token` hook). */
export function isSurfaceUrl(url: string): boolean {
  const path = url.split('?')[0]!;
  return path === SURFACE_PATH_PREFIX || path.startsWith(`${SURFACE_PATH_PREFIX}/`);
}

const ASSET_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.json': 'application/json; charset=utf-8', '.bin': 'application/octet-stream',
};

export interface SurfaceRouteDeps {
  config: IntercomAdapterConfig;
  service: IntercomService;
  /** S96.7 — paged transcript for a conversation; null when unknown. */
  conversationPage?: (input: { conversationId: string; before?: string; limit?: number }) => ConversationPage | null;
  /** Conversations a surface may read (default: only the one it follows). */
  canReadConversation?: (surface: Surface, conversationId: string) => boolean;
  /** Directory of content-addressed assets, files named `<sha256>.<ext>`. */
  assetDir?: string;
}

const ConversationQuery = z.object({
  before: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export async function registerSurfaceRoutes(server: FastifyInstance, deps: SurfaceRouteDeps): Promise<void> {
  const { service, config } = deps;
  if (!service.surfaceApi) throw new Error('registerSurfaceRoutes needs the service built with surfaceApi');
  const api = service.surfaceApi;
  if (!server.hasDecorator('websocketServer')) await server.register(websocket);

  const auth = (req: FastifyRequest): { surface: Surface; device: Device } | null => {
    const h = req.headers.authorization;
    const found = service.authenticate(h?.startsWith('Bearer ') ? h.slice(7).trim() : undefined);
    return found?.device ? { surface: found.surface, device: found.device } : null;
  };

  server.post(`${SURFACE_PATH_PREFIX}/pair`, async (req, reply) => {
    if (!service.pairAllowed(req.ip)) return reply.code(429).header('Retry-After', '60').send({ ok: false, error: 'rate_limited' });
    const body = PairBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ ok: false, error: 'invalid_body' });
    return redeemForDevice(service, body.data.code, reply);
  });

  server.get(`${SURFACE_PATH_PREFIX}/health`, async (req, reply) => {
    const a = auth(req);
    if (!a) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    return service.health(a.surface, a.device);
  });

  server.get(`${SURFACE_PATH_PREFIX}/state`, async (req, reply) => {
    const a = auth(req);
    if (!a) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    api.hub.flush();
    const revs = api.hub.revs(a.surface.id);
    const resources = {} as SurfaceState['resources'];
    for (const name of RESOURCE_NAMES) {
      const snap = api.hub.snapshot(a.surface.id, name);
      resources[name] = snap.items;
      revs[name] = snap.rev;
    }
    const state: SurfaceState = { surface_id: a.surface.id, device_id: a.device.id, server_time: new Date().toISOString(), revs, resources };
    return reply.header('Cache-Control', 'no-store').send(state);
  });

  server.get(`${SURFACE_PATH_PREFIX}/conversations/:id`, async (req, reply) => {
    const a = auth(req);
    if (!a) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    const id = (req.params as { id: string }).id;
    const q = ConversationQuery.safeParse(req.query);
    if (!q.success || !/^[A-Za-z0-9_:-]{1,128}$/.test(id)) return reply.code(400).send({ ok: false, error: 'invalid_query' });
    const allowed = deps.canReadConversation ? deps.canReadConversation(a.surface, id) : id === a.surface.conversationId;
    if (!allowed || !deps.conversationPage) return reply.code(404).send({ ok: false, error: 'not_found' });
    const page = deps.conversationPage({ conversationId: id, ...(q.data.before ? { before: q.data.before } : {}), ...(q.data.limit ? { limit: q.data.limit } : {}) });
    if (!page) return reply.code(404).send({ ok: false, error: 'not_found' });
    return reply.header('Cache-Control', 'no-store').send(page);
  });

  server.get(`${SURFACE_PATH_PREFIX}/assets/:hash`, async (req, reply) => {
    const a = auth(req);
    if (!a) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    const hash = (req.params as { hash: string }).hash.toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hash) || !deps.assetDir || !existsSync(deps.assetDir)) return reply.code(404).send({ ok: false, error: 'not_found' });
    const name = readdirSync(deps.assetDir).find((f) => f.toLowerCase().startsWith(`${hash}.`) || f.toLowerCase() === hash);
    if (!name) return reply.code(404).send({ ok: false, error: 'not_found' });
    const file = join(deps.assetDir, name);
    // Content addressing is the cache key, so the content must match its name.
    if (createHash('sha256').update(readFileSync(file)).digest('hex') !== hash) return reply.code(404).send({ ok: false, error: 'not_found' });
    return reply
      .header('Cache-Control', 'public, max-age=31536000, immutable')
      .header('X-Content-Type-Options', 'nosniff')
      .type(ASSET_MIME[extname(name).toLowerCase()] ?? 'application/octet-stream')
      .send(createReadStream(file));
  });

  server.post(`${SURFACE_PATH_PREFIX}/actions`, async (req, reply) => {
    const a = auth(req);
    if (!a) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    const result = await service.handleAction(a.surface, a.device, req.body);
    const status = result.status === 'failed' && (result.reason === 'invalid') ? 400
      : result.status === 'failed' && result.reason === 'read_only' ? 403
      : result.status === 'failed' && result.reason === 'rate_limited' ? 429 : 200;
    return reply.code(status).send(result);
  });

  server.get(`${SURFACE_PATH_PREFIX}/ws`, { websocket: true }, surfaceSocketHandler(server, service, config));
}

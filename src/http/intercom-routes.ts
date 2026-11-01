/**
 * E90/E91 — Intercom HTTP and WebSocket routes.
 *
 *   GET  /intercom, /intercom/*            static web app (apps/intercom-web), no auth
 *   POST /api/v1/intercom/pair             exchange a one-time pairing code for the surface token
 *   GET  /api/v1/intercom/health           Bearer <surface token>
 *   GET  /api/v1/intercom/today            Bearer; calendar payload for the day-dial
 *   GET  /api/v1/intercom/ws               WebSocket, hello-token handshake (browsers cannot set headers)
 *
 * These routes carry their own auth (surface tokens), so the global
 * `bus.auth_token` hook skips `/intercom` and `/api/v1/intercom`. See docs/INTERCOM.md.
 */
import { createReadStream, existsSync, realpathSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import { z } from 'zod';
import type { IntercomAdapterConfig } from '../config/schema.js';
import { IntercomService, type Client, type SocketLike } from '../intercom/service.js';
import { createPairCode, redeemPairCode } from '../intercom/store.js';

export const INTERCOM_PATH_PREFIXES = ['/intercom', '/api/v1/intercom'] as const;
/** True for URLs served by this module (they bypass the shared `X-Bus-Token` hook). */
export function isIntercomUrl(url: string): boolean {
  const path = url.split('?')[0]!;
  return INTERCOM_PATH_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

export const DEFAULT_WEB_ROOT = fileURLToPath(new URL('../../apps/intercom-web', import.meta.url));

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
  '.otf': 'font/otf', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json; charset=utf-8',
};

/**
 * Resolve a request path under `root`. Returns null for anything that would
 * leave it: `..` segments, encoded separators, NUL bytes, absolute tricks and
 * symlinks that point outside.
 */
export function resolveStaticPath(root: string, rawPath: string): string | null {
  let rel: string;
  try { rel = decodeURIComponent(rawPath); } catch { return null; }
  if (rel.includes('\0') || rel.includes('\\')) return null;
  if (rel.split('/').includes('..')) return null;
  rel = rel.replace(/^\/+/, '');
  const absRoot = resolve(root);
  let target = resolve(absRoot, rel);
  if (target !== absRoot && !target.startsWith(absRoot + sep)) return null;
  try {
    if (statSync(target).isDirectory()) target = join(target, 'index.html');
    const real = realpathSync(target);
    const realRoot = realpathSync(absRoot);
    if (real !== realRoot && !real.startsWith(realRoot + sep)) return null;
    return statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

const PairBody = z.object({ code: z.string().min(1).max(64) });
const Hello = z.object({ type: z.literal('hello'), token: z.string().min(1), cursor: z.number().int().min(0).default(0), client: z.string().max(100).optional() });
const SendFrame = z.object({ type: z.literal('send'), client_msg_id: z.string().min(1).max(100), body: z.string() });

export interface IntercomRouteDeps {
  config: IntercomAdapterConfig;
  db: Database.Database;
  service: IntercomService;
  /** Directory served at /intercom/. Defaults to apps/intercom-web in the repo. */
  webRoot?: string;
}

export async function registerIntercomRoutes(server: FastifyInstance, deps: IntercomRouteDeps): Promise<void> {
  const { service, config } = deps;
  const webRoot = deps.webRoot ?? DEFAULT_WEB_ROOT;
  // The Mac app registers the plugin too (when enabled); it is a fastify-plugin, so register it only once.
  if (!server.hasDecorator('websocketServer')) await server.register(websocket);

  const bearer = (req: FastifyRequest) => {
    const h = req.headers.authorization;
    return service.surfaceForToken(h?.startsWith('Bearer ') ? h.slice(7).trim() : undefined);
  };

  // ── Static web app ─────────────────────────────────────────────────────────
  server.get('/intercom', async (_req, reply) => reply.redirect('/intercom/', 301));
  server.get('/intercom/*', async (req, reply) => {
    const raw = (req.params as { '*': string })['*'] ?? '';
    const file = existsSync(webRoot) ? resolveStaticPath(webRoot, raw) : null;
    if (!file) return reply.code(404).type('text/plain; charset=utf-8').send('Not found');
    return reply
      .header('Cache-Control', 'no-cache')
      .header('X-Content-Type-Options', 'nosniff')
      .type(MIME[extname(file).toLowerCase()] ?? 'application/octet-stream')
      .send(createReadStream(file));
  });

  // ── Pairing ────────────────────────────────────────────────────────────────
  server.post('/api/v1/intercom/pair', async (req, reply) => {
    if (!service.pairAllowed(req.ip)) return reply.code(429).header('Retry-After', '60').send({ ok: false, error: 'rate_limited' });
    const body = PairBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ ok: false, error: 'invalid_body' });
    const result = redeemPairCode(deps.db, body.data.code);
    if (!result.ok) return reply.code(result.reason === 'unknown' ? 404 : 410).send({ ok: false, error: result.reason });
    const token = service.tokenFor(result.surface_id);
    if (!token || !service.surfaces.has(result.surface_id)) return reply.code(503).send({ ok: false, error: 'surface_unavailable' });
    return { surface_id: result.surface_id, token };
  });

  // ── Authenticated HTTP ────────────────────────────────────────────────────
  server.get('/api/v1/intercom/health', async (req, reply) => {
    const surface = bearer(req);
    if (!surface) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    return service.health(surface);
  });

  server.get('/api/v1/intercom/today', async (req, reply) => {
    const surface = bearer(req);
    if (!surface) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    try { return await service.calendar.today(); }
    catch { return reply.code(503).send({ ok: false, error: 'calendar_unavailable' }); }
  });

  // ── WebSocket ─────────────────────────────────────────────────────────────
  const sockets = new Set<Client>();
  const heartbeat = setInterval(() => {
    for (const c of sockets) {
      if (Date.now() - c.lastPong > 2 * config.ping_interval_ms + 5000) c.socket.close(1001, 'ping timeout');
      else if (c.socket.readyState === 1) { try { c.socket.ping?.(); } catch { /* closing */ } }
    }
  }, config.ping_interval_ms);
  heartbeat.unref();
  server.addHook('onClose', async () => { clearInterval(heartbeat); service.stop(); });

  server.get('/api/v1/intercom/ws', { websocket: true }, (socket: SocketLike & { on: (e: string, l: (...a: any[]) => void) => void }) => {
    let client: Client | null = null;
    const helloTimer = setTimeout(() => { if (!client) socket.close(4401, 'hello timeout'); }, config.hello_timeout_ms);
    const send = (frame: Record<string, unknown>) => { try { if (socket.readyState === 1) socket.send(JSON.stringify(frame)); } catch { /* closing */ } };
    socket.on('close', () => { clearTimeout(helloTimer); if (client) { service.detach(client); sockets.delete(client); } });
    socket.on('error', () => { /* the close handler cleans up */ });
    socket.on('pong', () => { if (client) client.lastPong = Date.now(); });
    socket.on('message', (data: Buffer) => { void (async () => {
      let frame: Record<string, unknown>;
      try { frame = JSON.parse(data.toString()) as Record<string, unknown>; }
      catch { if (!client) { socket.close(4401, 'invalid hello'); return; } send({ type: 'error', code: 'invalid_frame' }); return; }
      if (!client) {
        const hello = Hello.safeParse(frame);
        const surface = hello.success ? service.surfaceForToken(hello.data.token) : null;
        if (!hello.success || !surface) { send({ type: 'error', code: 'unauthorized' }); socket.close(4401, 'unauthorized'); return; }
        clearTimeout(helloTimer);
        client = { socket, surface, ready: false, cursor: 0, lastPong: Date.now() };
        sockets.add(client);
        await service.attach(client, hello.data.cursor, hello.data.client);
        return;
      }
      if (frame['type'] === 'ping') { send({ type: 'pong' }); return; }
      if (!client.ready) { send({ type: 'error', code: 'unauthorized' }); return; }
      if (frame['type'] === 'send') {
        const parsed = SendFrame.safeParse(frame);
        if (!parsed.success) { send({ type: 'error', code: 'invalid_frame' }); return; }
        send(await service.handleSend(client.surface, parsed.data));
        return;
      }
      if (frame['type'] === 'notification_ack') {
        const err = service.handleNotificationAck(client.surface, frame);
        if (err) send(err);
        return;
      }
      if (frame['type'] === 'notification_action') {
        send(await service.handleNotificationAction(client.surface, frame));
        return;
      }
      if (frame['type'] === 'state') { service.setSurfaceState(client.surface, frame); return; }
      send({ type: 'error', code: 'invalid_frame' });
    })().catch(() => send({ type: 'error', code: 'internal_error' })); });
  });

  service.start();
}

/** CLI/test helper: write a pairing code for `surfaceId`. */
export function issuePairCode(db: Database.Database, surfaceId: string, ttlMs: number) {
  return createPairCode(db, surfaceId, ttlMs);
}

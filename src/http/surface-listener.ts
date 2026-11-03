/**
 * E96 S96.2 — the separate TLS listener for the surface API.
 *
 * A second Fastify instance, bound to `surface_api.host:port` (default 0.0.0.0:3443) with TLS,
 * that serves only:
 *
 *   /api/v1/surface, /api/v1/surface/*     surface API v2 (own device auth)
 *   /api/v1/intercom, /api/v1/intercom/*   v1 alias for existing clients
 *   /intercom, /intercom/*                 static web app
 *
 * Every other path gets 404 `{ok:false,error:'not_found'}` from an onRequest hook, before
 * routing, so bus routes (`/api/v1/status`, `/mcp`, ...) are unreachable even if a route
 * module mounts them here. The bus `X-Bus-Token` hook is not installed: surface routes carry
 * their own device auth.
 *
 * Path policy: the filter matches the raw request path (before percent-decoding), and refuses
 * anything that could be read two ways: `//`, `\`, NUL, `.`/`..` segments and the escapes
 * `%2e %2f %5c %00`. A request that spells a prefix with escapes (`/api/v1/%73urface/...`) is
 * refused, never decoded into a match. Other escapes (e.g. `%20`) are allowed under a prefix.
 */
import { readFileSync } from 'node:fs';
import type { Socket } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import type { SurfaceApiConfig } from '../config/schema.js';
import { certFingerprint } from '../surface/cert.js';

export const SURFACE_LISTENER_PREFIXES = ['/api/v1/surface', '/api/v1/intercom', '/intercom'] as const;

/** Small: surface requests are JSON actions and pairing; nothing uploads. */
export const SURFACE_BODY_LIMIT = 64 * 1024;

const AMBIGUOUS_ESCAPE = /%(2e|2f|5c|00)/i;

/** True when `url` (a raw request target, query allowed) may be served by the surface listener. */
export function isSurfaceListenerPath(url: string): boolean {
  if (typeof url !== 'string' || !url.startsWith('/')) return false; // also refuses absolute-form targets
  const end = url.search(/[?#]/);
  const path = end >= 0 ? url.slice(0, end) : url;
  if (path.length > 2048) return false;
  if (path.includes('//') || path.includes('\\') || path.includes('\0')) return false;
  if (AMBIGUOUS_ESCAPE.test(path)) return false;
  if (path.split('/').some((seg) => seg === '.' || seg === '..')) return false;
  return SURFACE_LISTENER_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

export interface SurfaceRateLimit {
  /** HTTP requests (including WebSocket upgrades) per remote address per minute. Default 600. */
  requestsPerMinute?: number;
  /** New TCP connections per remote address per minute; extra connections are dropped. Default 120. */
  connectionsPerMinute?: number;
}

export interface SurfaceListenerOptions {
  config: SurfaceApiConfig;
  /** Mounts the surface routes (the same function used on the main port). */
  register: (server: FastifyInstance) => Promise<void>;
  log?: (line: string) => void;
  /** PEM contents to use instead of reading `config.tls` (tests). */
  tlsOverride?: { cert: string | Buffer; key: string | Buffer };
  rateLimit?: SurfaceRateLimit;
}

export interface SurfaceListener {
  server: FastifyInstance;
  /** Start listening on `config.host:config.port`; resolves to the address, e.g. `https://0.0.0.0:3443`. */
  listen(): Promise<string>;
  close(): Promise<void>;
  /** SHA-256 fingerprint of the served (leaf) certificate, `AA:BB:...`. */
  fingerprint: string;
}

/** Fixed one-minute windows per key; the whole map is dropped at each rollover. */
class WindowCounter {
  private counts = new Map<string, number>();
  private windowStart = Date.now();
  constructor(private readonly limit: number) {}
  /** Count one hit; false when the key is over its limit for this window. */
  hit(key: string): boolean {
    const now = Date.now();
    if (now - this.windowStart >= 60_000) { this.counts.clear(); this.windowStart = now; }
    const n = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, n);
    return n <= this.limit;
  }
}

function readPem(path: string, field: string): Buffer {
  try {
    return readFileSync(path);
  } catch (err) {
    throw new Error(`surface_api.tls.${field}: cannot read ${path}: ${(err as Error).message}`);
  }
}

export async function createSurfaceListener(opts: SurfaceListenerOptions): Promise<SurfaceListener> {
  const { config } = opts;
  const log = opts.log ?? ((line: string) => console.log(line));

  let cert: string | Buffer; let key: string | Buffer;
  if (opts.tlsOverride) {
    ({ cert, key } = opts.tlsOverride);
  } else {
    if (!config.tls) throw new Error('surface_api.tls (cert, key) is required: the surface listener refuses to start without TLS');
    cert = readPem(config.tls.cert, 'cert');
    key = readPem(config.tls.key, 'key');
  }
  let fingerprint: string;
  try { fingerprint = certFingerprint(cert); }
  catch (err) { throw new Error(`surface_api.tls.cert: not a PEM certificate${config.tls ? ` (${config.tls.cert})` : ''}: ${(err as Error).message}`); }

  let fastify;
  try {
    fastify = Fastify({
      logger: false,
      bodyLimit: SURFACE_BODY_LIMIT,
      // Slow-request protection; does not apply to upgraded WebSockets.
      requestTimeout: 30_000,
      https: { cert, key, minVersion: 'TLSv1.2' },
    });
  } catch (err) {
    throw new Error(`surface_api.tls: key/cert rejected: ${(err as Error).message}`);
  }
  // Route modules are typed against the default (http) server; the routing API is identical.
  const server = fastify as unknown as FastifyInstance;

  const requests = new WindowCounter(opts.rateLimit?.requestsPerMinute ?? 600);
  const connections = new WindowCounter(opts.rateLimit?.connectionsPerMinute ?? 120);

  server.server.on('connection', (socket: Socket) => {
    if (!connections.hit(socket.remoteAddress ?? '?')) socket.destroy();
  });

  // Bounded logging of refusals, so a scan cannot flood the bus log.
  let logged = 0; let suppressed = 0; let logWindow = Date.now();
  const logRefusal = (line: string) => {
    const now = Date.now();
    if (now - logWindow >= 60_000) {
      if (suppressed) log(`[surface] ${suppressed} more refused requests not logged`);
      logged = 0; suppressed = 0; logWindow = now;
    }
    if (logged++ < 20) log(line); else suppressed++;
  };

  server.addHook('onRequest', async (req, reply) => {
    if (!requests.hit(req.ip)) {
      logRefusal(`[surface] 429 ${req.method} from ${req.ip}`);
      return reply.code(429).header('Retry-After', '60').send({ ok: false, error: 'rate_limited' });
    }
    const raw = req.raw.url ?? '';
    if (!isSurfaceListenerPath(raw)) {
      logRefusal(`[surface] 404 ${req.method} ${raw.slice(0, 200)} from ${req.ip}`);
      return reply.code(404).send({ ok: false, error: 'not_found' });
    }
  });

  server.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Strict-Transport-Security', 'max-age=86400');
    reply.header('Referrer-Policy', 'no-referrer');
    if ((req.raw.url ?? '').startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    return payload;
  });

  server.setNotFoundHandler(async (_req, reply) => reply.code(404).send({ ok: false, error: 'not_found' }));

  await opts.register(server);

  return {
    server,
    fingerprint,
    async listen() {
      const address = await server.listen({ host: config.host, port: config.port });
      log(`[surface] listening on ${address} (TLS, cert sha256 ${fingerprint})`);
      return address;
    },
    async close() {
      await server.close();
    },
  };
}

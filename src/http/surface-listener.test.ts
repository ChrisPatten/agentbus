import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { X509Certificate } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TLSSocket } from 'node:tls';
import websocket from '@fastify/websocket';
import WebSocket from 'ws';
import type { FastifyInstance } from 'fastify';
import { SurfaceApiConfigSchema } from '../config/schema.js';
import { classifyHosts, generateSurfaceCerts, opensslAvailable, surfaceApiYaml } from '../surface/cert-gen.js';
import { certFingerprint } from '../surface/cert.js';
import { createSurfaceListener, isSurfaceListenerPath, type SurfaceListener } from './surface-listener.js';

describe('isSurfaceListenerPath', () => {
  it.each([
    '/api/v1/surface', '/api/v1/surface/', '/api/v1/surface/health', '/api/v1/surface/ws',
    '/api/v1/surface/health?x=1', '/api/v1/surface?x=/api/v1/status',
    '/api/v1/intercom', '/api/v1/intercom/pair', '/api/v1/intercom/ws?cursor=3',
    '/intercom', '/intercom/', '/intercom/app.js', '/intercom/sub/index.html', '/intercom/my%20file.png',
  ])('allows %s', (url) => expect(isSurfaceListenerPath(url)).toBe(true));

  it.each([
    '/', '', 'api/v1/surface', '/api/v1/status', '/api/v1/health', '/mcp', '/api/v1/messages',
    '/api/v1/surfaceX', '/api/v1/surface-x/a', '/api/v1/intercomX', '/intercomX', '/intercom.html',
    '/API/v1/surface/health', '/api/v2/surface',
    // encoded prefix: refused, never decoded into a match
    '/api/v1/%73urface/health', '/api/v1/%73tatus', '/%61pi/v1/surface',
    // ambiguous escapes and traversal under an allowed prefix
    '/api/v1/surface/%2e%2e/status', '/api/v1/surface/%2E%2E%2Fstatus', '/api/v1/surface%2f..%2fstatus',
    '/api/v1/surface/..%2fstatus', '/api/v1/surface/%5c..', '/intercom/%00', '/api/v1/surface/../status',
    '/api/v1/surface/./health', '/intercom/..', '/intercom/sub/../../api/v1/status',
    // doubled slashes and backslashes
    '//api/v1/surface', '/api/v1/surface//health', '//api/v1/status', '/api/v1/surface\\..\\status',
    // absolute-form request targets
    'http://evil/api/v1/surface/health', 'https://127.0.0.1/api/v1/surface',
    '?/api/v1/surface', '#/api/v1/surface',
  ])('refuses %s', (url) => expect(isSurfaceListenerPath(url)).toBe(false));

  it('refuses very long paths', () => {
    expect(isSurfaceListenerPath(`/api/v1/surface/${'a'.repeat(3000)}`)).toBe(false);
  });
});

describe('classifyHosts', () => {
  it('splits DNS names and IPs and dedupes', () => {
    expect(classifyHosts(['Boba.local', 'boba.local', '127.0.0.1', '::1', 'localhost']))
      .toEqual({ dns: ['boba.local', 'localhost'], ip: ['127.0.0.1', '::1'] });
  });
  it('rejects names that could inject into the openssl config', () => {
    expect(() => classifyHosts(['ok.local\nDNS.9 = evil'])).toThrow(/Invalid host/);
    expect(() => classifyHosts(['a b'])).toThrow(/Invalid host/);
    expect(() => classifyHosts([])).toThrow(/At least one host/);
  });
});

const HAS_OPENSSL = opensslAvailable();
if (!HAS_OPENSSL) console.warn('[surface-listener.test] openssl not found on PATH: skipping the TLS listener and cert generator tests');

function get(url: string, ca: Buffer, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string; fingerprint?: string }> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { ca, headers }, (res) => {
      const fingerprint = (res.socket as TLSSocket).getPeerCertificate?.()?.fingerprint256;
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body, fingerprint }));
    });
    req.on('error', reject);
  });
}

describe.skipIf(!HAS_OPENSSL)('surface TLS listener', () => {
  let dir: string;
  let ca: Buffer;
  let listener: SurfaceListener;
  let port: number;
  let fingerprint: string;
  const logs: string[] = [];
  const sockets: WebSocket[] = [];

  async function register(server: FastifyInstance): Promise<void> {
    if (!server.hasDecorator('websocketServer')) await server.register(websocket);
    server.get('/api/v1/surface/health', async () => ({ ok: true }));
    server.post('/api/v1/surface/echo', async (req) => ({ got: req.body }));
    server.get('/intercom/*', async () => 'static');
    // A bus route mounted here by mistake must still be unreachable.
    server.get('/api/v1/status', async () => ({ ok: true, secret: 'bus' }));
    server.get('/api/v1/surface/ws', { websocket: true }, (socket) => {
      socket.send(JSON.stringify({ type: 'welcome' }));
    });
    server.get('/api/v1/status-ws', { websocket: true }, (socket) => { socket.send('leak'); });
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'surface-tls-'));
    const gen = generateSurfaceCerts({ outDir: dir, hosts: ['localhost', '127.0.0.1'], days: 30 });
    fingerprint = gen.fingerprint;
    ca = readFileSync(gen.paths.caCert);
    const config = { ...SurfaceApiConfigSchema.parse({ enabled: true, host: '127.0.0.1', port: 3443, tls: { cert: gen.paths.serverChain, key: gen.paths.serverKey } }), port: 0 };
    listener = await createSurfaceListener({ config, register, log: (l) => logs.push(l) });
    await listener.listen();
    port = (listener.server.server.address() as { port: number }).port;
  });

  afterAll(async () => {
    for (const s of sockets.splice(0)) s.terminate();
    await listener?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('serves surface routes over TLS with the CA, pinned fingerprint and security headers', async () => {
    const res = await get(`https://127.0.0.1:${port}/api/v1/surface/health`, ca);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
    expect(res.fingerprint).toBe(listener.fingerprint);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toMatch(/max-age=\d+/);
    expect(res.headers['cache-control']).toBe('no-store');
    // localhost SAN verifies too
    expect((await get(`https://localhost:${port}/api/v1/surface/health`, ca)).status).toBe(200);
  });

  it('reports the fingerprint of the leaf certificate', () => {
    expect(listener.fingerprint).toBe(fingerprint);
    expect(listener.fingerprint).toBe(new X509Certificate(readFileSync(join(dir, 'server.pem'))).fingerprint256);
    expect(listener.fingerprint).not.toBe(certFingerprint(ca));
  });

  it('refuses bus routes and path tricks with 404, before routing', async () => {
    for (const path of ['/api/v1/status', '/mcp', '/api/v1/%73tatus', '/api/v1/surface/%2e%2e/status', '//api/v1/status', '/api/v1/surfaceX', '/nope']) {
      const res = await get(`https://127.0.0.1:${port}${path}`, ca);
      expect(res.status, path).toBe(404);
      expect(JSON.parse(res.body), path).toEqual({ ok: false, error: 'not_found' });
      expect(res.body).not.toContain('secret');
    }
    expect(logs.some((l) => l.includes('404 GET /api/v1/status'))).toBe(true);
  });

  it('serves the static web app prefix without no-store', async () => {
    const res = await get(`https://127.0.0.1:${port}/intercom/app.js`, ca);
    expect(res.status).toBe(200);
    expect(res.body).toBe('static');
    expect(res.headers['cache-control']).toBeUndefined();
  });

  it('enforces the small body limit', async () => {
    const big = JSON.stringify({ x: 'a'.repeat(70 * 1024) });
    const status = await new Promise<number>((resolve, reject) => {
      const req = https.request(`https://127.0.0.1:${port}/api/v1/surface/echo`, { method: 'POST', ca, headers: { 'content-type': 'application/json' } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on('error', reject);
      req.end(big);
    });
    expect(status).toBe(413);
  });

  it('does not answer plain HTTP on the TLS port', async () => {
    const outcome = await new Promise<string>((resolve) => {
      const req = http.get(`http://127.0.0.1:${port}/api/v1/surface/health`, (res) => { res.resume(); resolve(`status ${res.statusCode}`); });
      req.on('error', (e) => resolve(`error ${e.message}`));
      req.setTimeout(3000, () => { req.destroy(new Error('timeout')); });
    });
    expect(outcome).not.toBe('status 200');
  });

  it('accepts a WebSocket upgrade on /api/v1/surface/ws and refuses one elsewhere', async () => {
    const first = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`wss://127.0.0.1:${port}/api/v1/surface/ws`, { ca });
      sockets.push(ws);
      ws.on('message', (d) => resolve(d.toString()));
      ws.on('error', reject);
    });
    expect(JSON.parse(first)).toEqual({ type: 'welcome' });

    const refused = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(`wss://127.0.0.1:${port}/api/v1/status-ws`, { ca });
      sockets.push(ws);
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('open', () => reject(new Error('upgrade should have been refused')));
      ws.on('error', () => resolve(-1));
    });
    expect(refused).toBe(404);
  });

  it('rate limits requests per remote address', async () => {
    const config = { ...SurfaceApiConfigSchema.parse({ host: '127.0.0.1' }), port: 0 };
    const limited = await createSurfaceListener({
      config, register: async (s) => { s.get('/api/v1/surface/health', async () => ({ ok: true })); },
      tlsOverride: { cert: readFileSync(join(dir, 'server-chain.pem')), key: readFileSync(join(dir, 'server.key')) },
      rateLimit: { requestsPerMinute: 2 }, log: () => {},
    });
    try {
      await limited.listen();
      const p = (limited.server.server.address() as { port: number }).port;
      const statuses = [];
      for (let i = 0; i < 3; i++) statuses.push((await get(`https://127.0.0.1:${p}/api/v1/surface/health`, ca)).status);
      expect(statuses).toEqual([200, 200, 429]);
    } finally {
      await limited.close();
    }
  });
});

describe.skipIf(!HAS_OPENSSL)('createSurfaceListener startup errors', () => {
  it('refuses to start without TLS', async () => {
    const config = SurfaceApiConfigSchema.parse({});
    await expect(createSurfaceListener({ config, register: async () => {} })).rejects.toThrow(/refuses to start without TLS/);
  });

  it('names the unreadable path', async () => {
    const config = SurfaceApiConfigSchema.parse({ tls: { cert: '/nonexistent/server.pem', key: '/nonexistent/server.key' } });
    await expect(createSurfaceListener({ config, register: async () => {} })).rejects.toThrow(/surface_api\.tls\.cert: cannot read \/nonexistent\/server\.pem/);
  });

  it('rejects a file that is not a certificate', async () => {
    const d = mkdtempSync(join(tmpdir(), 'surface-bad-'));
    try {
      writeFileSync(join(d, 'c.pem'), 'not a cert');
      writeFileSync(join(d, 'k.pem'), 'not a key');
      const config = SurfaceApiConfigSchema.parse({ tls: { cert: join(d, 'c.pem'), key: join(d, 'k.pem') } });
      await expect(createSurfaceListener({ config, register: async () => {} })).rejects.toThrow(/not a PEM certificate/);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});

describe.skipIf(!HAS_OPENSSL)('generateSurfaceCerts', () => {
  it('writes a CA and a server cert with SANs, serverAuth and 0600 keys; refuses overwrite without force', () => {
    const d = mkdtempSync(join(tmpdir(), 'surface-gen-'));
    try {
      const out = join(d, 'tls');
      const r = generateSurfaceCerts({ outDir: out, hosts: ['boba.local', '192.168.1.20', 'localhost'], days: 825 });
      for (const p of Object.values(r.paths)) expect(existsSync(p), p).toBe(true);
      expect(statSync(r.paths.caKey).mode & 0o777).toBe(0o600);
      expect(statSync(r.paths.serverKey).mode & 0o777).toBe(0o600);

      const caCert = new X509Certificate(readFileSync(r.paths.caCert));
      const leaf = new X509Certificate(readFileSync(r.paths.serverCert));
      expect(caCert.ca).toBe(true);
      expect(leaf.ca).toBe(false);
      expect(leaf.verify(caCert.publicKey)).toBe(true);
      expect(leaf.subjectAltName).toContain('DNS:boba.local');
      expect(leaf.subjectAltName).toContain('IP Address:192.168.1.20');
      expect(leaf.keyUsage ?? []).toContain('1.3.6.1.5.5.7.3.1'); // serverAuth
      expect(leaf.publicKey.asymmetricKeyDetails?.namedCurve).toBe('prime256v1');
      const days = (Date.parse(leaf.validTo) - Date.parse(leaf.validFrom)) / 86_400_000;
      expect(days).toBeLessThanOrEqual(825);
      expect(r.fingerprint).toBe(leaf.fingerprint256);
      expect(readFileSync(r.paths.serverChain, 'utf8')).toContain(readFileSync(r.paths.caCert, 'utf8').trim());
      expect(surfaceApiYaml(r.paths)).toContain(`cert: ${JSON.stringify(r.paths.serverChain)}`);

      expect(() => generateSurfaceCerts({ outDir: out, hosts: ['localhost'] })).toThrow(/Refusing to overwrite/);
      const again = generateSurfaceCerts({ outDir: out, hosts: ['localhost'], force: true });
      expect(again.fingerprint).not.toBe(r.fingerprint);
      expect(() => generateSurfaceCerts({ outDir: join(d, 'x'), hosts: ['localhost'], days: 900 })).toThrow(/825/);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});

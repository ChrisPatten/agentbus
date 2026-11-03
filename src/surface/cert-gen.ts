/**
 * E96 S96.2 — generate a private CA and a server certificate for the surface listener.
 *
 * Uses the `openssl` binary (OpenSSL 1.1+/3.x or LibreSSL 3.x) through execFileSync; no npm
 * dependencies. Only portable options are used: `ecparam -genkey`, `req` with a config file
 * (LibreSSL 3.3 has no `-addext`) and `x509 -req -extfile`. Private keys are captured from
 * openssl's stdout and written with mode 0600; they are never printed.
 *
 * CLI wrapper: scripts/surface-cert.ts.
 */
import { execFileSync } from 'node:child_process';
import { X509Certificate, createPrivateKey, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname, networkInterfaces, tmpdir } from 'node:os';
import { isIP } from 'node:net';
import { join, resolve } from 'node:path';
import { certFingerprint } from './cert.js';

/** Apple platforms reject TLS server certificates valid for longer than this. */
export const MAX_SERVER_CERT_DAYS = 825;
export const CA_DAYS = 3650;

export interface SurfaceCertPaths {
  dir: string;
  caKey: string;
  caCert: string;
  serverKey: string;
  serverCert: string;
  /** server.pem followed by ca.pem; point `surface_api.tls.cert` here. */
  serverChain: string;
}

export interface GenerateSurfaceCertsOptions {
  outDir: string;
  /** DNS names and IP addresses for the server certificate's subjectAltName. */
  hosts: string[];
  /** Server certificate lifetime, at most 825. Default 825. */
  days?: number;
  /** Replace existing files. Without it, any existing output file is an error. */
  force?: boolean;
  /** openssl binary. Default `openssl` from PATH. */
  openssl?: string;
}

export interface GenerateSurfaceCertsResult {
  paths: SurfaceCertPaths;
  /** SHA-256 fingerprint of server.pem (`AA:BB:...`), what devices pin. */
  fingerprint: string;
  hosts: { dns: string[]; ip: string[] };
}

export function surfaceCertPaths(outDir: string): SurfaceCertPaths {
  const dir = resolve(outDir);
  return {
    dir,
    caKey: join(dir, 'ca.key'),
    caCert: join(dir, 'ca.pem'),
    serverKey: join(dir, 'server.key'),
    serverCert: join(dir, 'server.pem'),
    serverChain: join(dir, 'server-chain.pem'),
  };
}

/** `os.hostname()`, `<short>.local`, `localhost`, `127.0.0.1` and every non-internal IPv4 address. */
export function defaultSurfaceHosts(): string[] {
  const out: string[] = [];
  const h = hostname().trim().toLowerCase();
  if (h) {
    out.push(h);
    const short = h.endsWith('.local') ? h.slice(0, -'.local'.length) : h.split('.')[0]!;
    if (short) { out.push(short, `${short}.local`); }
  }
  out.push('localhost', '127.0.0.1');
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (!a.internal && a.family === 'IPv4') out.push(a.address);
    }
  }
  return [...new Set(out)].filter((x) => isIP(x) || DNS_NAME.test(x));
}

const DNS_NAME = /^(\*\.)?[a-z0-9]([a-z0-9-]{0,62})(\.[a-z0-9]([a-z0-9-]{0,62}))*$/i;

/** Split hosts into DNS names and IPs; throws on anything that is neither (keeps the openssl config injection-free). */
export function classifyHosts(hosts: string[]): { dns: string[]; ip: string[] } {
  const dns: string[] = []; const ip: string[] = [];
  for (const raw of hosts) {
    const host = raw.trim();
    if (!host) continue;
    if (isIP(host)) { if (!ip.includes(host)) ip.push(host); continue; }
    if (host.length > 253 || !DNS_NAME.test(host)) throw new Error(`Invalid host for the certificate: "${raw}"`);
    const lower = host.toLowerCase();
    if (!dns.includes(lower)) dns.push(lower);
  }
  if (!dns.length && !ip.length) throw new Error('At least one host is required for the certificate');
  return { dns, ip };
}

function opensslConfig(cn: string, dns: string[], ip: string[], caName: string): string {
  const alt = [
    ...dns.map((d, i) => `DNS.${i + 1} = ${d}`),
    ...ip.map((a, i) => `IP.${i + 1} = ${a}`),
  ].join('\n');
  return `[req]
distinguished_name = dn
prompt = no

[dn]
CN = ${cn}

[ca_dn]
CN = ${caName}

[v3_ca]
basicConstraints = critical,CA:true
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash

[v3_server]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = serverAuth
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid,issuer
subjectAltName = @alt

[alt]
${alt}
`;
}

function writeKey(path: string, pem: Buffer): void {
  if (existsSync(path)) unlinkSync(path);
  writeFileSync(path, pem, { mode: 0o600, flag: 'wx' });
  chmodSync(path, 0o600);
}

/** True when an `openssl` binary runs. */
export function opensslAvailable(openssl = 'openssl'): boolean {
  try { execFileSync(openssl, ['version'], { stdio: ['ignore', 'pipe', 'ignore'] }); return true; } catch { return false; }
}

export function generateSurfaceCerts(opts: GenerateSurfaceCertsOptions): GenerateSurfaceCertsResult {
  const openssl = opts.openssl ?? 'openssl';
  const days = opts.days ?? MAX_SERVER_CERT_DAYS;
  if (!Number.isInteger(days) || days < 1 || days > MAX_SERVER_CERT_DAYS) {
    throw new Error(`--days must be an integer between 1 and ${MAX_SERVER_CERT_DAYS} (Apple rejects longer server certificates)`);
  }
  const { dns, ip } = classifyHosts(opts.hosts);
  const paths = surfaceCertPaths(opts.outDir);
  const outputs = [paths.caKey, paths.caCert, paths.serverKey, paths.serverCert, paths.serverChain];
  const existing = outputs.filter((p) => existsSync(p));
  if (existing.length && !opts.force) {
    throw new Error(`Refusing to overwrite existing files (use --force): ${existing.join(', ')}`);
  }
  if (!opensslAvailable(openssl)) throw new Error(`openssl not found (tried "${openssl}")`);

  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  const work = mkdtempSync(join(tmpdir(), 'surface-cert-'));
  const run = (args: string[]): Buffer => {
    try {
      return execFileSync(openssl, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      const e = err as { stderr?: Buffer; message: string };
      throw new Error(`openssl ${args[0]} failed: ${e.stderr?.toString().trim() || e.message}`);
    }
  };
  try {
    const cn = dns[0] ?? ip[0]!;
    const caName = `AgentBus Surface CA (${(dns[0] ?? 'agentbus').slice(0, 30)})`;
    const conf = join(work, 'openssl.cnf');
    writeFileSync(conf, opensslConfig(cn, dns, ip, caName));
    const caConf = join(work, 'ca.cnf');
    writeFileSync(caConf, opensslConfig(caName, dns, ip, caName).replace('distinguished_name = dn', 'distinguished_name = ca_dn'));

    // CA: EC P-256, 10 years.
    writeKey(paths.caKey, run(['ecparam', '-name', 'prime256v1', '-genkey', '-noout']));
    run(['req', '-x509', '-new', '-sha256', '-key', paths.caKey, '-days', String(CA_DAYS),
      '-config', caConf, '-extensions', 'v3_ca', '-out', paths.caCert]);

    // Server: EC P-256, SANs, serverAuth, signed by the CA.
    writeKey(paths.serverKey, run(['ecparam', '-name', 'prime256v1', '-genkey', '-noout']));
    const csr = join(work, 'server.csr');
    run(['req', '-new', '-sha256', '-key', paths.serverKey, '-config', conf, '-out', csr]);
    const serial = BigInt(`0x${randomBytes(16).toString('hex')}`) >> 1n; // positive, < 2^127
    run(['x509', '-req', '-sha256', '-in', csr, '-CA', paths.caCert, '-CAkey', paths.caKey,
      '-set_serial', serial.toString(10), '-days', String(days),
      '-extfile', conf, '-extensions', 'v3_server', '-out', paths.serverCert]);

    const serverPem = readFileSync(paths.serverCert);
    const caPem = readFileSync(paths.caCert);
    writeFileSync(paths.serverChain, Buffer.concat([serverPem, caPem]));

    // Sanity: the server cert is signed by the CA and matches its key.
    const leaf = new X509Certificate(serverPem);
    const ca = new X509Certificate(caPem);
    if (!leaf.verify(ca.publicKey)) throw new Error('generated server certificate does not verify against the CA');
    if (!leaf.checkPrivateKey(createPrivateKey(readFileSync(paths.serverKey)))) throw new Error('generated server key does not match the certificate');

    return { paths, fingerprint: certFingerprint(serverPem), hosts: { dns, ip } };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** YAML for the bus config, pointing at the generated files. */
export function surfaceApiYaml(paths: SurfaceCertPaths, port = 3443): string {
  return [
    'surface_api:',
    '  enabled: true',
    "  host: '0.0.0.0'",
    `  port: ${port}`,
    '  tls:',
    `    cert: ${JSON.stringify(paths.serverChain)}`,
    `    key: ${JSON.stringify(paths.serverKey)}`,
  ].join('\n');
}

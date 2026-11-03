/**
 * E96 S96.2 — generate a private CA and a TLS server certificate for the surface listener.
 *
 *   npx tsx scripts/surface-cert.ts [--out ~/.agentbus/surface-tls] [--host bobafett.local --host 192.168.1.20 ...]
 *                                   [--days 825] [--force]
 *
 *   --out <dir>    output directory (default ~/.agentbus/surface-tls, created 0700)
 *   --host <name>  DNS name or IP for the certificate; repeat for more. Default: this machine's
 *                  hostname, <hostname>.local, localhost, 127.0.0.1 and every non-internal IPv4.
 *   --days <n>     server certificate lifetime, at most 825 (Apple's limit). The CA lasts 10 years.
 *   --force        replace existing files
 *
 * Writes ca.key (0600), ca.pem, server.key (0600), server.pem and server-chain.pem. Install
 * ca.pem on devices that verify by CA, or pin the printed fingerprint. Keys are never printed.
 * Requires the `openssl` binary (OpenSSL or LibreSSL).
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { defaultSurfaceHosts, generateSurfaceCerts, MAX_SERVER_CERT_DAYS, surfaceApiYaml } from '../src/surface/cert-gen.js';

const USAGE = 'Usage: npx tsx scripts/surface-cert.ts [--out dir] [--host name ...] [--days 825] [--force]';

function parseArgs(argv: string[]): { out: string; hosts: string[]; days: number; force: boolean } {
  let out = join(homedir(), '.agentbus', 'surface-tls');
  const hosts: string[] = [];
  let days = MAX_SERVER_CERT_DAYS;
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--out') out = value().replace(/^~(?=$|\/)/, homedir());
    else if (a === '--host') hosts.push(value());
    else if (a === '--days') days = Number(value());
    else if (a === '--force') force = true;
    else if (a === '--help' || a === '-h') { console.log(USAGE); process.exit(0); }
    else throw new Error(`Unknown argument "${a}"`);
  }
  return { out: resolve(out), hosts: hosts.length ? hosts : defaultSurfaceHosts(), days, force };
}

try {
  const args = parseArgs(process.argv.slice(2));
  const result = generateSurfaceCerts({ outDir: args.out, hosts: args.hosts, days: args.days, force: args.force });
  const { paths } = result;
  console.log(`Surface TLS files written to ${paths.dir}`);
  console.log(`  CA key        ${paths.caKey}  (0600, keep private)`);
  console.log(`  CA cert       ${paths.caCert}  (install on devices that verify by CA)`);
  console.log(`  server key    ${paths.serverKey}  (0600)`);
  console.log(`  server cert   ${paths.serverCert}`);
  console.log(`  server chain  ${paths.serverChain}`);
  console.log('');
  console.log(`Names:  ${[...result.hosts.dns, ...result.hosts.ip].join(', ')}`);
  console.log(`Valid:  ${args.days} days`);
  console.log(`Server certificate SHA-256 fingerprint:\n  ${result.fingerprint}`);
  console.log('');
  console.log('Add to the bus config, then restart bus-core:');
  console.log('');
  console.log(surfaceApiYaml(paths));
} catch (err) {
  console.error(`surface-cert: ${(err as Error).message}`);
  console.error(USAGE);
  process.exit(1);
}

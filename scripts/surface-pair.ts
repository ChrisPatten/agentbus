/**
 * E96 S96.1 — mint a one-time pairing code for a new device on a surface (successor of
 * scripts/intercom-pair.ts, which keeps working for v1 codes).
 *
 *   AGENTBUS_CONFIG=~/workspace/peggy-claude-code/agentbus-config.yaml \
 *     npx tsx scripts/surface-pair.ts <surface_id> [--name "Kitchen Compact"] [--profile round466] \
 *       [--scope interactive|read_only] [--ttl 12h] [--base https://host:3443]
 *
 *   --name <text>     device name shown in `surface-devices list` (default: "paired <date>")
 *   --profile <p>     display profile hint (default: the surface's profile)
 *   --scope <s>       interactive (default) or read_only
 *   --config <path>   config file (default: $AGENTBUS_CONFIG or ./config.yaml)
 *   --db <path>       database file (default: bus.db_path from the config)
 *   --ttl <d>         lifetime, e.g. 90m, 12h, 2d (default: adapters.intercom.pair_ttl_hours, 12h)
 *   --base <url>      origin for the printed URL (default: https://<hostname>:<surface_api.port> when
 *                     surface_api.enabled, else $INTERCOM_BASE_URL or http://127.0.0.1:<http_port>)
 *
 * The code is stored hashed in the bus database (SQLite WAL, safe while bus-core runs) and works
 * once. The surfaces table is synced from the config first; legacy tokens are left alone, so the
 * surfaces' token env vars do not have to be set here.
 */
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { loadConfig } from '../src/config/loader.js';
import { openDb } from '../src/db/client.js';
import { runMigrations } from '../src/db/schema.js';
import { certFingerprintFile } from '../src/surface/cert.js';
import { createDeviceStore } from '../src/surface/devices.js';
import type { DeviceScope } from '../src/surface/types.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Same rules as scripts/intercom-pair.ts (which runs on import, so it is not imported here). */
function parseTtl(text: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)?$/i.exec(text.trim());
  if (!m) throw new Error(`Bad --ttl "${text}" (use e.g. 90m, 12h, 2d)`);
  const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[(m[2] ?? 'h').toLowerCase() as 's' | 'm' | 'h' | 'd'];
  return Math.round(Number(m[1]) * unit);
}

const surfaceId = process.argv[2];
if (!surfaceId || surfaceId.startsWith('--')) {
  console.error('Usage: npx tsx scripts/surface-pair.ts <surface_id> [--name "Kitchen Compact"] [--profile round466] [--scope interactive|read_only] [--ttl 12h] [--base https://host:3443] [--config path] [--db path]');
  process.exit(2);
}

try {
  const configPath = resolve(arg('config') ?? process.env['AGENTBUS_CONFIG'] ?? 'config.yaml');
  const config = loadConfig(configPath);
  const intercom = config.adapters.intercom;
  if (!intercom) throw new Error('adapters.intercom is not configured');
  if (!intercom.surfaces.some((s) => s.id === surfaceId)) {
    throw new Error(`Unknown surface "${surfaceId}". Configured: ${intercom.surfaces.map((s) => s.id).join(', ') || '(none)'}`);
  }
  const scope = (arg('scope') ?? 'interactive') as DeviceScope;
  if (scope !== 'interactive' && scope !== 'read_only') throw new Error(`Bad --scope "${scope}" (interactive or read_only)`);
  const ttlMs = arg('ttl') ? parseTtl(arg('ttl')!) : intercom.pair_ttl_hours * 3_600_000;
  const name = arg('name') ?? `paired ${new Date().toISOString().slice(0, 10)}`;

  const db = openDb(resolve(arg('db') ?? config.bus.db_path));
  let code: string; let expires_at: string; let profile: string;
  try {
    runMigrations(db);
    const store = createDeviceStore({ db, log: () => {} });
    store.syncFromConfig(intercom.surfaces, process.env, { legacy: false });
    ({ code, expires_at } = store.createPairCode({ surfaceId, name, profile: arg('profile'), scope, ttlMs }));
    profile = arg('profile') ?? store.surface(surfaceId)!.profile;
  } finally {
    db.close();
  }

  const api = config.surface_api;
  const defaultBase = api.enabled
    ? `https://${hostname()}:${api.port}`
    : process.env['INTERCOM_BASE_URL'] ?? `http://127.0.0.1:${config.bus.http_port}`;
  const base = (arg('base') ?? defaultBase).replace(/\/+$/, '');
  const fingerprint = certFingerprintFile(api.tls?.cert);

  console.log(`Surface:      ${surfaceId}`);
  console.log(`Device:       ${name} (${profile}, ${scope})`);
  console.log(`Code:         ${code}`);
  console.log(`Expires:      ${expires_at}`);
  console.log(`URL:          ${base}/intercom/#pair=${code}`);
  if (fingerprint) console.log(`TLS SHA-256:  ${fingerprint}`);
} catch (err) {
  console.error(`surface-pair: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

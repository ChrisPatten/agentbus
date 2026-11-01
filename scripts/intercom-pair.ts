/**
 * E91 — mint a one-time Intercom pairing code and print the pairing URL.
 *
 *   AGENTBUS_CONFIG=~/workspace/peggy-claude-code/agentbus-config.yaml \
 *     npx tsx scripts/intercom-pair.ts <surface_id> [--ttl 12h] [--base https://bobafett.tail64ec4d.ts.net]
 *
 * The code is stored as a sha256 hash in the bus database (SQLite WAL, so this is safe while
 * bus-core is running) and works once. Open the printed URL on the device; the code travels in
 * the URL fragment, which is never sent to a server.
 *
 *   --config <path>   config file (default: $AGENTBUS_CONFIG or ./config.yaml)
 *   --db <path>       database file (default: bus.db_path from the config)
 *   --ttl <d>         lifetime, e.g. 90m, 12h, 2d (default: adapters.intercom.pair_ttl_hours, 12h)
 *   --base <url>      origin for the printed URL (default: $INTERCOM_BASE_URL or http://127.0.0.1:<http_port>)
 *
 * The config must load, so the env vars it references (and the sibling .env) must be available,
 * as for bus-core itself. The surface's token env var does not have to be set here.
 */
import { resolve } from 'node:path';
import { loadConfig } from '../src/config/loader.js';
import { openDb } from '../src/db/client.js';
import { runMigrations } from '../src/db/schema.js';
import { createPairCode } from '../src/intercom/store.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export function parseTtl(text: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)?$/i.exec(text.trim());
  if (!m) throw new Error(`Bad --ttl "${text}" (use e.g. 90m, 12h, 2d)`);
  const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[(m[2] ?? 'h').toLowerCase() as 's' | 'm' | 'h' | 'd'];
  return Math.round(Number(m[1]) * unit);
}

const surfaceId = process.argv[2];
if (!surfaceId || surfaceId.startsWith('--')) {
  console.error('Usage: npx tsx scripts/intercom-pair.ts <surface_id> [--ttl 12h] [--base https://host] [--config path] [--db path]');
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
  const ttlMs = arg('ttl') ? parseTtl(arg('ttl')!) : intercom.pair_ttl_hours * 3_600_000;
  const db = openDb(resolve(arg('db') ?? config.bus.db_path));
  runMigrations(db);
  const { code, expires_at } = createPairCode(db, surfaceId, ttlMs);
  db.close();
  const base = (arg('base') ?? process.env['INTERCOM_BASE_URL'] ?? `http://127.0.0.1:${config.bus.http_port}`).replace(/\/+$/, '');
  console.log(`Surface:  ${surfaceId}`);
  console.log(`Code:     ${code}`);
  console.log(`Expires:  ${expires_at}`);
  console.log(`URL:      ${base}/intercom/#pair=${code}`);
} catch (err) {
  console.error(`intercom-pair: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

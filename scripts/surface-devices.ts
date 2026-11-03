/**
 * E96 S96.1 — list and revoke devices paired to surfaces.
 *
 *   npx tsx scripts/surface-devices.ts list [surface_id] [--all]
 *   npx tsx scripts/surface-devices.ts revoke <device_id>
 *
 *   --all             include revoked devices
 *   --config <path>   config file (default: $AGENTBUS_CONFIG or ./config.yaml)
 *   --db <path>       database file (default: bus.db_path from the config; with --db the config is not loaded)
 *
 * A revoked credential stops authenticating at once. bus-core runs in another process and
 * closes the revoked device's open sockets within a few seconds.
 */
import { resolve } from 'node:path';
import { loadConfig } from '../src/config/loader.js';
import { openDb } from '../src/db/client.js';
import { runMigrations } from '../src/db/schema.js';
import { createDeviceStore, legacyDeviceId } from '../src/surface/devices.js';
import type { Device } from '../src/surface/types.js';

const USAGE = 'Usage: npx tsx scripts/surface-devices.ts list [surface_id] [--all] | revoke <device_id>   [--config path] [--db path]';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Positional args (flags and their values removed). */
function positionals(): string[] {
  const out: string[] = [];
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--all') continue;
    if (a.startsWith('--')) { i++; continue; }
    out.push(a);
  }
  return out;
}

const short = (ts: string | null) => (ts ? ts.slice(0, 16).replace('T', ' ') : '-');

function table(devices: Device[]): string {
  const head = ['ID', 'SURFACE', 'NAME', 'PROFILE', 'SCOPE', 'LEGACY', 'CREATED', 'LAST SEEN', 'REVOKED'];
  const rows = devices.map((d) => [d.id, d.surface_id, d.name, d.profile, d.scope, d.legacy ? 'yes' : '', short(d.created_at), short(d.last_seen_at), short(d.revoked_at)]);
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  return [head, ...rows].map((r) => r.map((c, i) => c.padEnd(widths[i]!)).join('  ').trimEnd()).join('\n');
}

const [command, target] = positionals();
if (command !== 'list' && command !== 'revoke') { console.error(USAGE); process.exit(2); }
if (command === 'revoke' && !target) { console.error(USAGE); process.exit(2); }

try {
  const dbPath = arg('db') ?? loadConfig(resolve(arg('config') ?? process.env['AGENTBUS_CONFIG'] ?? 'config.yaml')).bus.db_path;
  const db = openDb(resolve(dbPath));
  try {
    runMigrations(db);
    const store = createDeviceStore({ db, log: () => {} });
    if (command === 'list') {
      const devices = store.list(target, process.argv.includes('--all'));
      console.log(devices.length ? table(devices) : `No ${process.argv.includes('--all') ? '' : 'active '}devices${target ? ` on surface "${target}"` : ''}.`);
    } else {
      const existing = store.get(target!);
      if (!existing) throw new Error(`Unknown device "${target}"`);
      const revoked = store.revoke(target!);
      if (!revoked) { console.log(`Device ${target} was already revoked (${existing.revoked_at}).`); }
      else {
        console.log(`Revoked ${revoked.id} (${revoked.name}) on surface "${revoked.surface_id}" at ${revoked.revoked_at}.`);
        console.log('Its credential no longer authenticates; bus-core closes its open sockets within a few seconds.');
        if (revoked.legacy && revoked.id === legacyDeviceId(revoked.surface_id)) {
          console.log('Note: this is the legacy token device. It is recreated from token_env at the next bus-core start; remove or rotate token_env to keep it out.');
        }
      }
    }
  } finally {
    db.close();
  }
} catch (err) {
  console.error(`surface-devices: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

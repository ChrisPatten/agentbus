/**
 * bus-core — the central orchestrator process.
 *
 * AgentBus runs as four independent processes. This is the only one that owns
 * shared state: the SQLite database, message queue, and adapter registry. All
 * other processes (telegram-adapter, bluebubbles-adapter, claude-code-adapter)
 * are separate daemons that communicate exclusively over the HTTP API on
 * localhost:${config.bus.http_port}. They do not import from this package.
 *
 * Startup sequence:
 *   1. Load and validate config.yaml — exits non-zero on any error
 *   2. Open SQLite, apply pending migrations
 *   3. (optional) Rebuild FTS indices if --rebuild-fts flag is present
 *   4. Instantiate MessageQueue and AdapterRegistry
 *   5. Register SIGTERM/SIGINT handlers for graceful shutdown
 *   6. (E12) Start Fastify HTTP API and memory subsystem
 *
 * Implementation status:
 *   - E1 (this file): config, SQLite, queue, registry — COMPLETE
 *   - E12: Fastify HTTP API — PENDING (routes not wired yet)
 *   - Adapters register themselves over HTTP after bus-core is reachable;
 *     nothing in this file loads or spawns adapter processes.
 */
import { resolve } from 'node:path';
import { loadConfig } from './config/loader.js';
import { getDb, closeDb } from './db/client.js';
import { runMigrations, rebuildFts } from './db/schema.js';
import { MessageQueue } from './core/queue.js';
import { AdapterRegistry } from './core/registry.js';

const configPath = process.env['AGENTBUS_CONFIG'] ?? resolve(process.cwd(), 'config.yaml');

const config = loadConfig(configPath);
const db = getDb(config.bus.db_path);

runMigrations(db);

if (process.argv.includes('--rebuild-fts')) {
  rebuildFts(db);
}

const queue = new MessageQueue(db);
const registry = new AdapterRegistry();

function shutdown() {
  console.log('AgentBus shutting down…');
  const stops = registry.list().map((a) => a.stop().catch(() => {}));
  Promise.allSettled(stops).finally(() => {
    closeDb();
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

console.log(`AgentBus bus-core ready — HTTP :${config.bus.http_port}`);

export { config, queue, registry };

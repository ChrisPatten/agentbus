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
 *   6. Start Fastify HTTP API on localhost:${config.bus.http_port}
 */
import { resolve } from 'node:path';
import { loadConfig } from './config/loader.js';
import { getDb, closeDb } from './db/client.js';
import { runMigrations, rebuildFts } from './db/schema.js';
import { MessageQueue } from './core/queue.js';
import { AdapterRegistry } from './core/registry.js';
import { createHttpServer } from './http/api.js';

const configPath = process.env['AGENTBUS_CONFIG'] ?? resolve(process.cwd(), 'config.yaml');

const config = loadConfig(configPath);
const db = getDb(config.bus.db_path);

runMigrations(db);

if (process.argv.includes('--rebuild-fts')) {
  rebuildFts(db);
}

const queue = new MessageQueue(db);
const registry = new AdapterRegistry();

const httpServer = await createHttpServer(queue, registry, config);

// Periodic maintenance: sweep expired messages and recover stuck-processing ones.
// Stuck threshold: messages in `processing` for > 5 minutes are reset to `pending`.
const STUCK_THRESHOLD_MS = 5 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;
const maintenanceTimer = setInterval(() => {
  const recovered = queue.recoverStuck(STUCK_THRESHOLD_MS);
  if (recovered > 0) console.log(`[agentbus] Recovered ${recovered} stuck processing message(s)`);
  const swept = queue.sweepExpired();
  if (swept > 0) console.log(`[agentbus] Swept ${swept} expired message(s)`);
}, SWEEP_INTERVAL_MS);

function shutdown() {
  console.log('AgentBus shutting down…');
  clearInterval(maintenanceTimer);
  const stops = registry.list().map((a) => a.stop().catch(() => {}));
  Promise.allSettled(stops).finally(() => {
    httpServer.close().finally(() => {
      closeDb();
      process.exit(0);
    });
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await httpServer.listen({ port: config.bus.http_port, host: '127.0.0.1' });
console.log(`AgentBus bus-core ready — HTTP :${config.bus.http_port}`);

export { config, queue, registry };

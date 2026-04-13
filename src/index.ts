/**
 * bus-core — the central orchestrator process.
 *
 * Owns all shared state: SQLite database, message queue, adapter registry.
 * Platform adapters (Telegram, BlueBubbles) run in-process and are registered
 * in the AdapterRegistry at startup. Agent connectors (Claude Code) are
 * separate processes that communicate via the HTTP API.
 *
 * Startup sequence:
 *   1. Load and validate config.yaml — exits non-zero on any error
 *   2. Open SQLite, apply pending migrations
 *   3. (optional) Rebuild FTS indices if --rebuild-fts flag is present
 *   4. Instantiate MessageQueue, AdapterRegistry, PipelineEngine
 *   5. Instantiate and register platform adapters from config
 *   6. Start Fastify HTTP API on localhost:${config.bus.http_port}
 *   7. Start platform adapters (inbound loops)
 *   8. Register SIGTERM/SIGINT handlers for graceful shutdown
 */
import { resolve } from 'node:path';
import { loadConfig } from './config/loader.js';
import { getDb, closeDb } from './db/client.js';
import { runMigrations, rebuildFts } from './db/schema.js';
import { MessageQueue } from './core/queue.js';
import { AdapterRegistry } from './core/registry.js';
import { createHttpServer } from './http/api.js';
import { PipelineEngine } from './pipeline/engine.js';
import { normalize } from './pipeline/stages/normalize.js';
import { createContactResolve } from './pipeline/stages/contact-resolve.js';
import { createDedup } from './pipeline/stages/dedup.js';
import { slashCommandDetect } from './pipeline/stages/slash-command.js';
import { createTopicClassify } from './pipeline/stages/topic-classify.js';
import { createPriorityScore } from './pipeline/stages/priority-score.js';
import { createRouteResolve } from './pipeline/stages/route-resolve.js';
import { createTranscriptLog } from './pipeline/stages/transcript-log.js';
import { TelegramAdapter } from './adapters/telegram.js';
import { DeliveryWorker } from './core/delivery.js';

const configPath = process.env['AGENTBUS_CONFIG'] ?? resolve(process.cwd(), 'config.yaml');

const config = loadConfig(configPath);
const db = getDb(config.bus.db_path);

runMigrations(db);

if (process.argv.includes('--rebuild-fts')) {
  rebuildFts(db);
}

const queue = new MessageQueue(db);
const registry = new AdapterRegistry();

const pipeline = new PipelineEngine();
pipeline.use({ slot: 10, name: 'normalize',        stage: normalize });
pipeline.use({ slot: 20, name: 'contact-resolve',  stage: createContactResolve(config) });
pipeline.use({ slot: 30, name: 'dedup',            stage: createDedup(db, config.pipeline.dedup_window_ms) });
pipeline.use({ slot: 40, name: 'slash-command',    stage: slashCommandDetect });
pipeline.use({ slot: 50, name: 'topic-classify',   stage: createTopicClassify(config) });
pipeline.use({ slot: 60, name: 'priority-score',   stage: createPriorityScore(config) });
pipeline.use({ slot: 70, name: 'route-resolve',    stage: createRouteResolve(config, db) });
pipeline.use({ slot: 80, name: 'transcript-log',   stage: createTranscriptLog(db, config), critical: false });

const httpServer = await createHttpServer({ queue, registry, config, pipeline, db });

// ── Platform adapter registration ────────────────────────────────────────────
// Platform adapters run in-process. They are instantiated from config,
// registered in the AdapterRegistry, and started after the HTTP server is
// ready. Agent connectors (CC adapter) are separate processes — they
// communicate via the HTTP API and are not registered here.

const adapterDeps = { config, queue, pipeline, db };

if (config.adapters.telegram) {
  const telegram = new TelegramAdapter(adapterDeps);
  registry.register(telegram);
}

// ── Delivery worker ──────────────────────────────────────────────────────────
// Dequeues contact-bound messages and dispatches to platform adapters.
// Agent-bound messages (agent:*) stay in the queue for CC adapter to poll.

const deliveryWorker = new DeliveryWorker({ queue, registry });

// ── Periodic maintenance ─────────────────────────────────────────────────────
// Sweep expired messages and recover stuck-processing ones.
// Stuck threshold: messages in `processing` for > 5 minutes are reset to `pending`.
const STUCK_THRESHOLD_MS = 5 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;
const maintenanceTimer = setInterval(() => {
  const recovered = queue.recoverStuck(STUCK_THRESHOLD_MS);
  if (recovered > 0) console.log(`[agentbus] Recovered ${recovered} stuck processing message(s)`);
  const swept = queue.sweepExpired();
  if (swept > 0) console.log(`[agentbus] Swept ${swept} expired message(s)`);
}, SWEEP_INTERVAL_MS);

// ── Shutdown ─────────────────────────────────────────────────────────────────

function shutdown() {
  console.log('AgentBus shutting down…');
  deliveryWorker.stop();
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

// ── Start ────────────────────────────────────────────────────────────────────

await httpServer.listen({ port: config.bus.http_port, host: '127.0.0.1' });
console.log(`AgentBus bus-core ready — HTTP :${config.bus.http_port}`);

// Start platform adapters and delivery worker after HTTP server is listening
for (const adapter of registry.list()) {
  await adapter.start();
}
deliveryWorker.start();

export { config, queue, registry };

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
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from './config/loader.js';
import { getTelegramInstances, getEmailInstances } from './config/schema.js';
import { getDb, closeDb } from './db/client.js';
import { runMigrations, rebuildFts } from './db/schema.js';
import { MessageQueue } from './core/queue.js';
import { AdapterRegistry } from './core/registry.js';
import { createHttpServer } from './http/api.js';
import { PipelineEngine } from './pipeline/engine.js';
import { normalize } from './pipeline/stages/normalize.js';
import { createContactResolve } from './pipeline/stages/contact-resolve.js';
import { createChannelRelay } from './pipeline/stages/channel-relay.js';
import { createDedup } from './pipeline/stages/dedup.js';
import { slashCommandDetect } from './pipeline/stages/slash-command.js';
import { createTopicClassify } from './pipeline/stages/topic-classify.js';
import { createPriorityScore } from './pipeline/stages/priority-score.js';
import { createRouteResolve } from './pipeline/stages/route-resolve.js';
import { createTranscriptLog } from './pipeline/stages/transcript-log.js';
import { createMemoryInject } from './pipeline/stages/memory-inject.js';
import { TelegramAdapter } from './adapters/telegram.js';
import { EmailAdapter } from './adapters/email.js';
import { SiriAdapter } from './adapters/siri.js';
import { startHeadless, stopHeadless } from './adapters/cc-headless.js';
import { createPoolManagers } from './pool/pool-manager.js';
import { createPoolRouteResolve } from './pipeline/stages/pool-route-resolve.js';
import { DeliveryWorker } from './core/delivery.js';
import { createCommandSystem } from './commands/index.js';
import { createTorrentCommand } from './commands/torrent.js';
import { createCostCommand } from './commands/cost.js';
import { Summarizer } from './memory/summarizer.js';
import { SessionTracker } from './memory/session-tracker.js';
import { Scheduler } from './scheduler/scheduler.js';
import { AttachmentSweeper } from './media/attachment-sweeper.js';

const configPath = process.env['AGENTBUS_CONFIG'] ?? resolve(process.cwd(), 'config.yaml');

const config = loadConfig(configPath);

// Ensure per-agent media download directories exist (E17)
for (const [agentId, agentCfg] of Object.entries(config.agents)) {
  if (agentCfg.media) {
    mkdirSync(agentCfg.media.download_path, { recursive: true });
    console.log(
      `[agentbus] Ensured media download path for ${agentId}: ${agentCfg.media.download_path}`,
    );
  }
}

const db = getDb(config.bus.db_path);

runMigrations(db);

if (process.argv.includes('--rebuild-fts')) {
  rebuildFts(db);
}

const queue = new MessageQueue(db);
const registry = new AdapterRegistry();

// ── Interactive session pool (E48) ───────────────────────────────────────────
// One PoolManager per configured cc-pool instance. Constructed early —
// unlike cc-headless (started late, after the HTTP server is listening),
// pool-route-resolve needs poolManagers at pipeline-construction time below,
// and the command system / HTTP server both need it too, so this is built
// before anything that depends on it rather than late-bound.
const busBaseUrl = `http://127.0.0.1:${config.bus.http_port}`;
const poolManagers = createPoolManagers(config, db, busBaseUrl, queue);

const { registry: commandRegistry, pauseSet, headlessControl } = createCommandSystem({
  adapterRegistry: registry,
  queue,
  db,
  config,
  poolManagers,
});

// ── Custom commands ───────────────────────────────────────────────────────────

commandRegistry.register(createTorrentCommand({ commandRegistry, db, registry }));
commandRegistry.register(createCostCommand({ db, headlessControl }));

const pipeline = new PipelineEngine();
pipeline.use({ slot: 10, name: 'normalize',        stage: normalize });
pipeline.use({ slot: 20, name: 'contact-resolve',  stage: createContactResolve(config) });
pipeline.use({ slot: 25, name: 'channel-relay',    stage: createChannelRelay(config, { queue, pipeline, config, db, registry, commandRegistry, pauseSet }) });
pipeline.use({ slot: 30, name: 'dedup',            stage: createDedup(db, config.pipeline.dedup_window_ms) });
pipeline.use({ slot: 40, name: 'slash-command',    stage: slashCommandDetect });
pipeline.use({ slot: 50, name: 'topic-classify',   stage: createTopicClassify(config) });
pipeline.use({ slot: 60, name: 'priority-score',   stage: createPriorityScore(config) });
pipeline.use({ slot: 70, name: 'route-resolve',    stage: createRouteResolve(config, db) });
// E48 — rewrites a cc-pool route's recipientId from the pool's logical agent
// id to a concrete leased pane's id before transcript-log (below) stamps
// sessions.agent_id from it, and before fan-out enqueues. critical: false —
// a bug here must not take down transcript logging or delivery to other
// route targets (e.g. an also_notify entry).
pipeline.use({ slot: 72, name: 'pool-route-resolve', stage: createPoolRouteResolve(poolManagers), critical: false });
pipeline.use({ slot: 80, name: 'transcript-log',   stage: createTranscriptLog(db, config), critical: false });
pipeline.use({ slot: 85, name: 'memory-inject',    stage: createMemoryInject(db, config),  critical: false });

// ── Siri channel (E42) ───────────────────────────────────────────────────────
// Registered before the HTTP server is built because the /api/v1/siri routes
// complete their long-poll through this adapter's send(). Started and stopped
// with the other platform adapters below.
const siri = config.adapters.siri?.enabled ? new SiriAdapter(config.adapters.siri) : undefined;
if (siri) registry.register(siri);

const httpServer = await createHttpServer({ queue, registry, config, pipeline, db, commandRegistry, pauseSet, siri, poolManagers });

// ── Platform adapter registration ────────────────────────────────────────────
// Platform adapters run in-process. They are instantiated from config,
// registered in the AdapterRegistry, and started after the HTTP server is
// ready. Agent connectors (CC adapter) are separate processes — they
// communicate via the HTTP API and are not registered here.

const adapterDeps = { config, queue, pipeline, db, registry, commandRegistry, pauseSet };

for (const inst of getTelegramInstances(config)) {
  const telegram = new TelegramAdapter({
    ...adapterDeps,
    instanceName: inst.name ?? undefined,
    instanceConfig: inst,
  });
  registry.register(telegram);
}

for (const inst of getEmailInstances(config)) {
  const email = new EmailAdapter({
    ...adapterDeps,
    instanceName: inst.name ?? undefined,
    instanceConfig: inst,
  });
  registry.register(email);
}

// ── Delivery worker ──────────────────────────────────────────────────────────
// Dequeues contact-bound messages and dispatches to platform adapters.
// Agent-bound messages (agent:*) stay in the queue for CC adapter to poll.

const deliveryWorker = new DeliveryWorker({ queue, registry, db });

// ── Memory system ─────────────────────────────────────────────────────────────
// Summarizer calls the Claude API to extract memories from completed sessions.
// SessionTracker runs a background loop to close idle sessions and trigger
// summarization. Both degrade gracefully when ANTHROPIC_API_KEY is not set.

const summarizer = new Summarizer({ db, config });
const sessionTracker = new SessionTracker({ db, config, summarizer });

// ── Attachment sweeper (E17) ──────────────────────────────────────────────────
// Periodically deletes expired image files + their DB rows. Runs on a fixed
// 10-minute interval with an immediate tick on startup.

const attachmentSweeper = new AttachmentSweeper({ db });

// ── Scheduler ─────────────────────────────────────────────────────────────────
// Fires scheduled messages into the inbound pipeline on a configurable tick.
// Config-defined schedules are upserted on startup; dynamic schedules are
// created via the HTTP API or MCP tools.

const scheduler = new Scheduler({
  db,
  config,
  queue,
  pipeline,
  registry,
  commandRegistry,
  pauseSet,
});

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
  scheduler.stop();
  sessionTracker.stop();
  attachmentSweeper.stop();
  deliveryWorker.stop();
  stopHeadless();
  for (const pool of poolManagers.values()) pool.stop();
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

await httpServer.listen({ port: config.bus.http_port, host: config.bus.host });
console.log(`AgentBus bus-core ready — HTTP ${config.bus.host}:${config.bus.http_port}`);

// Start platform adapters and delivery worker after HTTP server is listening
for (const adapter of registry.list()) {
  await adapter.start();
}
deliveryWorker.start();

// Start every configured cc-headless instance before the session tracker so
// their journaling runners are wired in before the tracker's first tick
// (E20). Each instance registers its own runner, keyed by agent_id, so a
// multi-agent deployment (E23) journals each session with its owning agent.
for (const [agentId, headless] of startHeadless(db)) {
  sessionTracker.registerJournalingRunner(agentId, headless.runJournalingTurn);
  // Let /clear reach the owning instance's journaling hook.
  headlessControl.journalResumeId.set(agentId, headless.journalResumeId);
  // Let /stop reach the owning instance's in-flight turn.
  headlessControl.stopTurn.set(agentId, headless.stopTurn);
}

// Start every configured cc-pool instance (E48): seed pane rows (idempotent
// — a no-op if they already exist from a prior run), adopt any live panes
// left over from before a restart / release any whose window actually
// vanished (reconcileLiveness — see src/pool/pool-manager.ts's doc comment:
// a free pane with no tmux window yet is normal and is NOT touched here),
// then start the recurring hard-idle/park-drain sweep. Registering a
// journaling runner per pool is currently inert (SessionTracker's dispatch
// only recognizes cc-headless instances — see the maintenance backlog) but
// costs nothing and keeps parity with cc-headless's own wiring above.
for (const [agentId, pool] of poolManagers) {
  await pool.ensureStarted();
  await pool.reconcileLiveness();
  pool.start();
  sessionTracker.registerJournalingRunner(agentId, pool.journalingRunner);
}

sessionTracker.start();
attachmentSweeper.start();
scheduler.loadConfig();
if (config.scheduler.enabled) scheduler.start();

// Push command manifests to adapters that support native command registration
// (e.g. Telegram's setMyCommands for autocomplete). Non-fatal on failure.
const commandManifests = commandRegistry.manifests();
for (const adapter of registry.list()) {
  if (adapter.capabilities.registerCommands && adapter.registerCommands) {
    adapter.registerCommands(commandManifests).catch((err: unknown) => {
      console.warn(`[agentbus] Failed to register commands with ${adapter.id}: ${String(err)}`);
    });
  }
}

export { config, queue, registry };

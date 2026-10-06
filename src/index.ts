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
import { randomUUID } from 'node:crypto';
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
import { TelegramAdapter } from './adapters/telegram.js';
import { EmailAdapter } from './adapters/email.js';
import { SiriAdapter } from './adapters/siri.js';
import { AppAdapter } from './adapters/app.js';
import { routedAgent } from './app/store.js';
import { startHeadless, stopHeadless, getHeadlessSnapshots, buildMcpConfig } from './adapters/cc-headless.js';
import { createPoolManagers } from './pool/pool-manager.js';
import { RuntimeResolver } from './core/runtime-resolver.js';
import { createPoolRouteResolve } from './pipeline/stages/pool-route-resolve.js';
import { DeliveryWorker } from './core/delivery.js';
import { createCommandSystem } from './commands/index.js';
import { createTorrentCommand } from './commands/torrent.js';
import { createCostCommand } from './commands/cost.js';
import { createPoolCommand } from './commands/pool.js';
import { createPaneCommand } from './commands/pane.js';
import { createRcCommand } from './commands/rc.js';
import { createJournalCommand } from './commands/journal.js';
import { SessionTracker } from './memory/session-tracker.js';
import { Scheduler } from './scheduler/scheduler.js';
import { AttachmentSweeper } from './media/attachment-sweeper.js';
import { ApprovalStore } from './approvals/store.js';
import { resolveApproval, type ApprovalResolveHooks } from './approvals/resolve.js';
import { sweepApprovals } from './approvals/sweep.js';
import type { ApprovalDecision } from './approvals/types.js';
import { OwnerDirectory } from './core/owners.js';
import { AdvisoryStore } from './advisories/store.js';
import { AdvisoryService } from './advisories/service.js';
import { createBusAdvisoryTransport } from './advisories/transport.js';
import { createAdvisoryInject } from './pipeline/stages/advisory-inject.js';
import { resolveJournalingSettings } from './journaling/config.js';
import { reviewChains } from './journaling/advisories.js';
import { JournalEngine } from './journaling/engine.js';
import { JournalerRegistry } from './journaling/registry.js';
import { CcHeadlessJournaler } from './journaling/journalers/cc-headless.js';
import { ScriptJournaler } from './journaling/journalers/script.js';
import { JournalRunGate, SystemMessageJournaler, BUSY_NOTICE_TEXT, type ActiveSystemRun } from './journaling/journalers/system-message.js';
import { createJournalInstructionDelivery } from './journaling/delivery.js';
import { createJournalHoldNotice } from './pipeline/stages/journal-hold.js';
import { HarnessEvents, createHookHealthTicker } from './journaling/events.js';
import { RecentMemory } from './memory/recent-service.js';
import { ConsolidationScheduler } from './journaling/consolidation.js';
import { recordApprovalOutcome, recordDeliveryFailure, recordToolError, type FeedbackProducerDeps } from './journaling/feedback-producers.js';
import { createFeedbackCommand } from './commands/feedback.js';
import { RecentFreshness } from './memory/recent-freshness.js';
import { checkMemorySetup } from './memory/setup-check.js';

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

// E64 — one agent_id → runtime lookup (cc-headless, cc-pool, claude-code,
// mcp-polled) with live capability checks. Shown in /status and health.
const runtimeResolver = new RuntimeResolver(config, { poolManagers, db });

// E65 — owner contacts and bus advisories. Producers (E66 journaling, E68
// protected files, …) call advisories.raise()/resolve(). The transport
// needs the pipeline and adapters, so it is bound further down.
const ownerDirectory = new OwnerDirectory(config);
const advisoryStore = new AdvisoryStore(db);
const advisories = new AdvisoryService({ store: advisoryStore, owners: ownerDirectory, resolver: runtimeResolver });
for (const agentId of ownerDirectory.agentsWithOwners()) {
  if (!runtimeResolver.resolve(agentId)) {
    console.warn(`[agentbus] agents.${agentId}.owners: ${agentId} has no runtime; its advisories go directly to owners`);
  }
}

// E66 — per-agent journaling settings (agents.<id>.journaling, or the
// deprecated cc-headless block). A chain that can run out of options raises
// an advisory to the agent's owners.
const journalingSettings = resolveJournalingSettings(config);
reviewChains(journalingSettings.values(), runtimeResolver, advisories);

// E66 — one journaling engine for every runtime: bus-side triggers (pause,
// ceiling, close, /clear, pool evict/release, shutdown) and harness hook
// events feed it; it walks each agent's journaler chain. Journalers are
// registered once their runtimes start (below).
const journalers = new JournalerRegistry();
const headlessJournaler = new CcHeadlessJournaler({ resolver: runtimeResolver, toolsMcpConfig: buildMcpConfig });
journalers.register(headlessJournaler);
journalers.register(new ScriptJournaler({ busUrl: busBaseUrl }));
// E66 S66.8 — System Message journaler: the live agent journals in its own
// session. The gate holds the conversation's new messages, blocks the
// agent's outbound sends and takes journal_complete. Delivery needs the
// pipeline, built further down, so it is late-bound.
const journalGate = new JournalRunGate();
let deliverJournalInstruction: ReturnType<typeof createJournalInstructionDelivery> | null = null;
journalers.register(new SystemMessageJournaler({
  db, resolver: runtimeResolver, gate: journalGate, owners: ownerDirectory, poolManagers,
  deliver: (req) => deliverJournalInstruction
    ? deliverJournalInstruction(req)
    : Promise.resolve({ queued: false, reason: 'bus is still starting' }),
  withdraw: (messageId, reason) => {
    const row = db.prepare('SELECT status FROM message_queue WHERE id = ?').get(messageId) as { status: string } | undefined;
    if (row?.status === 'pending') queue.deadLetter(messageId, reason);
  },
}));
// E67 — bus-generated memory/recent.md for every agent with a memory layout:
// at startup, after each successful journal run and at local midnight.
const recentMemory = new RecentMemory({ config, resolver: runtimeResolver });
const journalEngine = new JournalEngine({
  db, config, resolver: runtimeResolver, registry: journalers, advisories, owners: ownerDirectory, settings: journalingSettings,
  onJournaled: (result) => { if (result.agentId) recentMemory.regenerate(result.agentId, 'journaled'); },
});
journalEngine.addTicker(() => recentMemory.tick());
// E68 S68.1 — nightly (per-agent cron) consolidation, on the engine tick.
const consolidationScheduler = new ConsolidationScheduler({ engine: journalEngine });
journalEngine.addTicker(() => { consolidationScheduler.tick(); });
// E68 S68.2 — feedback events: denied approvals, /feedback, tool errors.
const feedbackProducers: FeedbackProducerDeps = {
  db, feedback: journalEngine.feedback, logicalAgentId: (id) => ownerDirectory.logicalAgentId(id),
};
const safeFeedback = (fn: () => void) => { try { fn(); } catch (err) { console.error(`[feedback] failed to record: ${String(err)}`); } };
// Shared by every approval resolution path (Telegram taps, POST /api/v1/approvals/:id/resolve).
const approvalHooks: ApprovalResolveHooks = {
  onResolved: (request, status) => safeFeedback(() => recordApprovalOutcome(feedbackProducers, request, status)),
};
// E67 S67.5 — memory setup checks: /journal shows them; startup logs them.
const memorySetup = (agentId: string) => checkMemorySetup(recentMemory.layoutFor(agentId), runtimeResolver.resolve(recentMemory.layoutFor(agentId).agentId));
// Harness hook events (POST /api/v1/journal/events) and hook health.
const journalEvents = new HarnessEvents({ db, engine: journalEngine, store: journalEngine.store, poolManagers });
journalEngine.addTicker(createHookHealthTicker({
  db, store: journalEngine.store, advisories,
  agents: () => journalEngine.allSettings().map((s) => ({ agentId: s.agentId, runtime: runtimeResolver.resolve(s.agentId) })),
}));
for (const [poolAgentId, pool] of poolManagers) {
  // E66 S66.9 — hard-idle release waits for the conversation's journal
  // run, bounded by the journaling timeout, before the pane is cleared or
  // killed. LRU eviction only fires the trigger (post-E66 decision): the
  // lease has already moved, so the journal runs in the background from the
  // transcript on disk while the pane is reused.
  pool.setReleaseHook(async ({ reason, conversationId }) => {
    const handle = journalEngine.trigger({ reason, conversationId });
    if (handle.status === 'unknown-session') {
      console.warn(`[journaling] ${poolAgentId}: no session for released conversation ${conversationId.slice(0, 8)}`);
      return;
    }
    if (reason === 'evict') return;
    if (handle.status !== 'queued' && handle.status !== 'merged') return;
    const settings = journalEngine.settingsFor(poolAgentId);
    const bound = Math.max(settings?.timeoutMs ?? 0, settings?.journalers['system-message'].timeoutMs ?? 0) || 300_000;
    const outcome = await Promise.race([
      handle.done.then((r) => r.status),
      new Promise<'timeout'>((resolve) => { const t = setTimeout(() => resolve('timeout'), bound); t.unref?.(); }),
    ]);
    if (outcome === 'timeout') {
      console.warn(`[journaling] ${poolAgentId}: journal for ${conversationId.slice(0, 8)} still running after ${bound} ms; releasing the pane`);
    }
  });
}

const { registry: commandRegistry, pauseSet, headlessControl } = createCommandSystem({
  adapterRegistry: registry,
  queue,
  db,
  config,
  poolManagers,
  runtimeResolver,
  advisories,
  journal: journalEngine,
});

// ── Custom commands ───────────────────────────────────────────────────────────

commandRegistry.register(createTorrentCommand({ commandRegistry, db, registry }));
commandRegistry.register(createCostCommand({ db, headlessControl }));
commandRegistry.register(createPoolCommand({ poolManagers }));
commandRegistry.register(createPaneCommand({ poolManagers }));
commandRegistry.register(createRcCommand({ poolManagers }));
commandRegistry.register(createFeedbackCommand({ db, engine: journalEngine }));
commandRegistry.register(createJournalCommand({
  db, engine: journalEngine, resolver: runtimeResolver, advisories, gate: journalGate, memorySetup, consolidation: consolidationScheduler,
}));

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
// E65 — open advisories ride along with an owner's next message, as a
// bus-originated system block for the owned agent's route only.
pipeline.use({ slot: 86, name: 'advisory-inject',  stage: createAdvisoryInject(advisories), critical: false });
// E66 — a message held by a System Message journal run tells its sender,
// once per hold, that the agent is busy.
pipeline.use({ slot: 87, name: 'journal-hold',     stage: createJournalHoldNotice(journalGate, (run, target) => notifyBusy(run, target)), critical: false });

// ── Siri channel (E42) ───────────────────────────────────────────────────────
// Registered before the HTTP server is built because the /api/v1/siri routes
// complete their long-poll through this adapter's send(). Started and stopped
// with the other platform adapters below.
const siri = config.adapters.siri?.enabled ? new SiriAdapter(config.adapters.siri) : undefined;
if (siri) registry.register(siri);
const app = config.adapters.app?.enabled
  ? new AppAdapter(db, (contactId) => routedAgent(config, contactId), getHeadlessSnapshots) : undefined;
if (app) registry.register(app);

const journalStatus = { db, engine: journalEngine, resolver: runtimeResolver, advisories, gate: journalGate, memorySetup };
// E67 — UserPromptSubmit freshness hook: recent.md for a live session, only when it changed.
const memoryRecent = new RecentFreshness({
  db,
  recent: recentMemory,
  resolveAgent: (harnessSessionId) => {
    const session = journalEvents.findSession(harnessSessionId);
    const agent = session ? journalEngine.agentForSession(session) : null;
    if (agent?.runtime) return agent.agentId;
    for (const [poolAgentId, manager] of poolManagers) {
      if (manager.leaseStore.list(manager.poolId).some((p) => p.claude_session_id === harnessSessionId)) return poolAgentId;
    }
    return null;
  },
  knownAgent: (agentId) => runtimeResolver.resolve(agentId.startsWith('agent:') ? agentId : `agent:${agentId}`) !== undefined,
});
const httpServer = await createHttpServer({ queue, registry, config, pipeline, db, commandRegistry, pauseSet, siri, app, poolManagers, getHeadlessSnapshots, runtimeResolver, advisories, journalEvents, journalGate, journalStatus, memoryRecent, approvalHooks });

// E66 — busy notice for a held message: the channel's native queued/status
// signal where it has one, a short text elsewhere, nothing on email.
const appNoticeRuns = new Map<string, { agentId: string; conversationId: string }>();
function notifyBusy(run: ActiveSystemRun, target: { contactId: string; channel: string; topic: string; conversationId: string }): void {
  const { contactId, channel, topic, conversationId } = target;
  // Email waits silently. Siri answers each ask once, so a notice would take the reply's place.
  if (channel === 'email' || channel.startsWith('email:') || channel === 'siri') return;
  const adapter = registry.lookupPrimaryByChannel(channel);
  if (!adapter) return;
  try {
    if (app && adapter.id === 'app') {
      const agentId = routedAgent(config, contactId) ?? run.agentId;
      appNoticeRuns.set(run.runId, { agentId, conversationId });
      app.publishActivity({
        agent_id: agentId, conversation_id: conversationId, state: 'queued', turn_class: 'user',
        running_user: 0, running_system: 1, waiting: 1, limit: 0, reserved_system_slots: 0,
      });
      return;
    }
    if (adapter.capabilities.toolStatus && adapter.reportToolCall) {
      adapter.reportToolCall(contactId, BUSY_NOTICE_TEXT, channel, topic, true, conversationId);
      return;
    }
    void adapter.send({
      id: randomUUID(), timestamp: new Date().toISOString(), channel, topic, sender: 'system:bus',
      recipient: `contact:${contactId}`, reply_to: null, priority: 'normal',
      payload: { type: 'text', body: BUSY_NOTICE_TEXT }, metadata: { adapter_id: adapter.id, bus_notice: true },
    }).catch((err: unknown) => console.warn(`[journaling] busy notice on ${channel} failed: ${String(err)}`));
  } catch (err) {
    console.warn(`[journaling] busy notice on ${channel} failed: ${String(err)}`);
  }
}
journalGate.onChange((run, event) => {
  if (event !== 'end' || !app) return;
  const notice = appNoticeRuns.get(run.runId);
  if (!notice) return;
  appNoticeRuns.delete(run.runId);
  app.publishActivity({
    agent_id: notice.agentId, conversation_id: notice.conversationId, state: 'idle', turn_class: 'user',
    running_user: 0, running_system: 0, waiting: 0, limit: 0, reserved_system_slots: 0,
  });
});

// ── Platform adapter registration ────────────────────────────────────────────
// Platform adapters run in-process. They are instantiated from config,
// registered in the AdapterRegistry, and started after the HTTP server is
// ready. Agent connectors (CC adapter) are separate processes — they
// communicate via the HTTP API and are not registered here.

const adapterDeps = { config, queue, pipeline, db, registry, commandRegistry, pauseSet };

// Interactive approvals (E51): one store, shared by the Telegram button
// handler, the HTTP routes (which build their own over the same db), and the
// expiry sweep below.
const approvalStore = new ApprovalStore(db);
const resolveApprovalFn = (id: string, decision: ApprovalDecision, resolvedBy: string, onlyContactId?: string) =>
  resolveApproval({ store: approvalStore, poolManagers, ...approvalHooks }, id, decision, resolvedBy, undefined, onlyContactId);

for (const inst of getTelegramInstances(config)) {
  const telegram = new TelegramAdapter({
    ...adapterDeps,
    instanceName: inst.name ?? undefined,
    instanceConfig: inst,
    resolveApproval: resolveApprovalFn,
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

const deliveryWorker = new DeliveryWorker({
  queue, registry, db,
  onFailed: (envelope, reason) => safeFeedback(() => recordDeliveryFailure(feedbackProducers, envelope, reason)),
});

// E65 — proactive advisory delivery: system-only turns through the pipeline,
// or direct messages to owners through the delivery worker above.
advisories.setTransport(createBusAdvisoryTransport({
  queue, registry, owners: ownerDirectory, pipeline, config, db, commandRegistry, pauseSet,
}));
// E66 — journaling instructions use the same system-only turn path.
deliverJournalInstruction = createJournalInstructionDelivery({
  queue, registry, owners: ownerDirectory, pipeline, config, db, commandRegistry, pauseSet,
});

// ── Session tracker ───────────────────────────────────────────────────────────
// Closes idle legacy (MCP-adapter) sessions and reports every close to the
// journaling engine. (E66 retired the Anthropic-API summarizer.)

const sessionTracker = new SessionTracker({
  db, config,
  onSessionClosed: (session) => { journalEngine.trigger({ reason: 'close', sessionId: session.id }); },
});

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
  sweepApprovals({ registry, store: approvalStore }).catch((err) =>
    console.error(`[agentbus] Approval sweep failed: ${String(err)}`),
  );
  advisories.retryPending().catch((err) =>
    console.error(`[agentbus] Advisory retry failed: ${String(err)}`),
  );
}, SWEEP_INTERVAL_MS);

// ── Shutdown ─────────────────────────────────────────────────────────────────

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('AgentBus shutting down…');
  scheduler.stop();
  sessionTracker.stop();
  // E66 — persist a `shutdown` trigger for sessions with unjournaled human
  // content (journaled after restart) and give in-flight runs a moment.
  const marked = await journalEngine.shutdown().catch(() => [] as string[]);
  if (marked.length > 0) console.log(`[journaling] ${marked.length} session(s) will be journaled after restart`);
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

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

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
for (const [agentId, headless] of startHeadless(db, {
  onToolError: (event) => safeFeedback(() => recordToolError(feedbackProducers, event)),
})) {
  // E66 — the cc-headless journaler runs this instance's journaling turns
  // through its handle (serialized with live turns on the same session).
  headlessJournaler.addHandle(agentId, headless);
  // Let /stop reach the owning instance's in-flight turn.
  headlessControl.stopTurn.set(agentId, headless.stopTurn);
  headlessControl.snapshots?.set(agentId, headless.snapshot);
  if (app) headless.subscribeActivity(app.publishActivity.bind(app));
}

// Start every configured cc-pool instance (E48): seed pane rows (idempotent
// — a no-op if they already exist from a prior run), adopt any live panes
// left over from before a restart / release any whose window actually
// vanished (reconcileLiveness — see src/pool/pool-manager.ts's doc comment:
// a free pane with no tmux window yet is normal and is NOT touched here),
// then start the recurring hard-idle/park-drain sweep. Pool journaling goes
// through the journaling engine (release hook above, harness hook events).
for (const pool of poolManagers.values()) {
  await pool.ensureStarted();
  await pool.reconcileLiveness();
  pool.start();
}

sessionTracker.start();
recentMemory.regenerateAll('startup');
for (const layout of recentMemory.layouts()) {
  for (const warning of memorySetup(layout.agentId).warnings) console.warn(`[memory] ${layout.agentId}: ${warning}`);
}
journalEngine.start();
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

export { config, queue, registry, advisories };

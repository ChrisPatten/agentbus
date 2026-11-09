/**
 * E96 — Surface API v2 runtime: builds the device store, resource hub, job store and
 * action handler for bus-core, binds them to the Intercom service, keeps the computed
 * resources in sync on the service's 5 s tick and runs the sweeps. index.ts owns one.
 */
import type Database from 'better-sqlite3';
import type { AppConfig } from '../config/schema.js';
import type { InboundAbort, InboundMessage, InboundResult, InboundSystemOptions } from '../http/api.js';
import type { IntercomService, SurfaceApiDeps } from '../intercom/service.js';
import { certFingerprintFile } from './cert.js';
import { createDeviceStore, type SurfaceDeviceStore } from './devices.js';
import { createResourceHub, type ResourceHubImpl } from './resources.js';
import { createActionHandler, createJobStore, sweepJobs } from './actions.js';
import type { JobStore } from './types.js';
import type { DeskSessionDetail } from '../intercom/desk.js';
import type { ResolveApprovalDeps } from '../approvals/resolve.js';
import { buildSurfaceSessions, diffItems, sessionsAsItems } from './sessions.js';
import { resolveApprovalFromSurface, syncApprovalEvents } from './approvals.js';
import { clearAnswerNeededOnInbound, onAnswerNeededCleared } from './answer-needed.js';
import { onInboundAccepted } from './inbound-hook.js';
import { createConversationAction } from './conversation-actions.js';
import { ChoiceStore } from '../choices/store.js';
import type { AdapterRegistry } from '../core/registry.js';

export interface SurfaceRuntimeDeps {
  config: AppConfig;
  db: Database.Database;
  submitInbound: (message: InboundMessage, system?: InboundSystemOptions) => Promise<InboundResult | InboundAbort>;
  /** S96.6 — the cc-pool panes as E94 classifies them (`collectDeskSessionDetails`). */
  deskSessions?: () => DeskSessionDetail[];
  /** S96.7 — the approvals resolution path (store, pools, hooks), read when a device answers. */
  approvals?: () => ResolveApprovalDeps;
  /** Adapter registry, to clear the Telegram keyboard of a prompt answered from a surface (optional). */
  registry?: Pick<AdapterRegistry, 'lookupPrimaryByChannel'>;
  log?: (line: string) => void;
}

export interface SurfaceRuntime {
  devices: SurfaceDeviceStore;
  hub: ResourceHubImpl;
  jobs: JobStore;
  surfaceApi: SurfaceApiDeps;
  /** Connect the hub's deltas and notice actions to the service, and register the tick work. */
  bind(service: IntercomService): void;
  /** Rebuild the sessions resource now (after an answer-needed or subject change). */
  refreshSessions(): void;
  /** Maintenance every minute: expired events (to tombstones) and slots, old tombstones, old jobs and action keys, spent pairing codes. */
  sweep(): void;
  stop(): void;
}

const SWEEP_MS = 60_000;

export function createSurfaceRuntime(deps: SurfaceRuntimeDeps): SurfaceRuntime {
  const cfg = deps.config.surface_api;
  const log = deps.log ?? ((l: string) => console.log(`[surface] ${l}`));
  let service: IntercomService | null = null;
  const devices = createDeviceStore({ db: deps.db, log });
  const hub = createResourceHub({
    db: deps.db, coalesceMs: cfg.delta_coalesce_ms, logRetentionRevs: cfg.log_retention_revs, tombstoneHours: cfg.event_tombstone_hours, log,
    sink: (surfaceId, frame) => service?.pushDelta(surfaceId, frame),
  });
  const jobs = createJobStore(deps.db);
  const conversationAction = createConversationAction({
    db: deps.db, choices: new ChoiceStore(deps.db), submitInbound: deps.submitInbound, log,
    surfaceOf: (device) => {
      const surface = service?.surfaces.get(device.surface_id);
      if (!surface || !service) return null;
      return { contact: surface.follow.contact, canRead: (conversationId) => service!.canReadConversation(surface, conversationId) };
    },
    clearKeyboard: async (prompt) => {
      const adapter = deps.registry?.lookupPrimaryByChannel(prompt.channel);
      await adapter?.finalizeChoicePrompt?.(prompt);
    },
  });
  const actions = createActionHandler({
    db: deps.db, hub, jobs, submitInbound: deps.submitInbound, log,
    rateLimitPerMin: cfg.action_rate_limit_per_min, keyTtlHours: cfg.action_key_ttl_hours,
    noticeAction: async (device, id, actionId, key) => service
      ? service.noticeAction(device, id, actionId, key)
      : { type: 'action_result', idempotency_key: key, status: 'failed', reason: 'internal_error' },
    conversationAction,
    approvalAction: async (device, approvalId, decision, key) => {
      const base = { type: 'action_result' as const, idempotency_key: key };
      const surface = service?.surfaces.get(device.surface_id);
      if (!deps.approvals || !surface) return { ...base, status: 'failed', reason: 'not_found' };
      const out = await resolveApprovalFromSurface(deps.approvals(), { approvalId, decision, deviceId: device.id, contactId: surface.follow.contact });
      syncApprovals();
      return { ...base, status: out.status, ...(out.reason ? { reason: out.reason } : {}) };
    },
    onEventFired: (info) => service?.noteEventFired(info),
  });
  const certFingerprint = cfg.tls ? certFingerprintFile(cfg.tls.cert) : null;
  if (cfg.enabled && !certFingerprint) log(`warn: could not read the surface certificate ${cfg.tls?.cert}; pairing payloads carry no fingerprint`);

  const sweep = () => {
    try {
      // Expired Events become tombstones (E100) and old tombstones are purged. Jobs behind them stay:
      // sweepJobs keeps expired ones a day; a tap on a tombstone answers `expired` either way.
      hub.sweepExpired();
      sweepJobs(deps.db, Date.now(), cfg.action_key_ttl_hours);
      devices.sweepPairCodes();
    } catch (err) { log(`warn: sweep failed: ${String(err)}`); }
  };
  let sweepTimer: NodeJS.Timeout | null = null;

  /** The contact of a conversation, from the registry (null when unknown). */
  const contactOf = (conversationId: string | null): string | null => {
    if (!conversationId) return null;
    try {
      const row = deps.db.prepare(`SELECT contact_id FROM conversation_registry WHERE id = ?`).get(conversationId) as { contact_id: string } | undefined;
      return row ? row.contact_id.replace(/^contact:/, '') : null;
    } catch { return null; }
  };

  /** Sessions are computed once per tick and filtered per surface. */
  const syncSessions = () => {
    if (!service) return;
    const list = buildSurfaceSessions({
      db: deps.db, desk: deps.deskSessions?.() ?? [], now: Date.now(),
      activityTimeoutMin: cfg.sessions.activity_timeout_min, includeSystem: cfg.sessions.include_system,
    });
    // A surface lists only its followed contact's sessions (they also decide which transcripts it may read).
    for (const s of service.surfaces.values()) {
      const mine = list.filter((x) => contactOf(x.conversation_id) === null || contactOf(x.conversation_id) === s.follow.contact);
      service.applyResource(s.id, 'sessions', diffItems(hub.snapshot(s.id, 'sessions').items, sessionsAsItems(mine)));
    }
  };
  const syncApprovals = () => {
    if (!service || !deps.approvals) return;
    for (const s of service.surfaces.values()) {
      try { syncApprovalEvents(hub, s.id, deps.db, { contactId: s.follow.contact }); }
      catch (err) { log(`warn: approval sync failed for ${s.id}: ${String(err)}`); }
    }
  };
  const unsubscribe: (() => void)[] = [];

  /** A surface reads the conversation it follows and any listed in its sessions resource. */
  const canReadConversation = (surface: { id: string; conversationId: string }, conversationId: string): boolean =>
    conversationId === surface.conversationId
    || Object.values(hub.snapshot(surface.id, 'sessions').items).some((s) => s['conversation_id'] === conversationId);

  return {
    devices, hub, jobs,
    surfaceApi: { devices, hub, actions, certFingerprint, canReadConversation },
    bind(svc) {
      service = svc;
      svc.onSurfaceTick(syncSessions);
      svc.onSurfaceTick(syncApprovals);
      unsubscribe.push(onAnswerNeededCleared(() => syncSessions()));
      unsubscribe.push(onInboundAccepted((envelope, conversationId, systemOnly) => {
        if (!systemOnly) {
          clearAnswerNeededOnInbound(deps.db, {
            channel: envelope.channel, contactId: envelope.sender, topic: envelope.topic, conversationId, metadata: envelope.metadata,
          });
        }
        svc.liveAppend(envelope, conversationId);
      }));
      syncSessions();
      syncApprovals();
      sweep();
      sweepTimer = setInterval(sweep, SWEEP_MS);
      sweepTimer.unref();
    },
    refreshSessions: () => { try { syncSessions(); } catch (err) { log(`warn: sessions refresh failed: ${String(err)}`); } },
    sweep,
    stop() {
      for (const u of unsubscribe.splice(0)) u();
      if (sweepTimer) clearInterval(sweepTimer);
      sweepTimer = null;
      hub.flush();
      hub.stop();
    },
  };
}

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

export interface SurfaceRuntimeDeps {
  config: AppConfig;
  db: Database.Database;
  submitInbound: (message: InboundMessage, system?: InboundSystemOptions) => Promise<InboundResult | InboundAbort>;
  /** S96.6 — the cc-pool panes as E94 classifies them (`collectDeskSessionDetails`). */
  deskSessions?: () => DeskSessionDetail[];
  /** S96.7 — the approvals resolution path (store, pools, hooks), read when a device answers. */
  approvals?: () => ResolveApprovalDeps;
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
  /** Hourly maintenance: expired events/slots (and their jobs), old jobs and keys, spent pairing codes. */
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
    db: deps.db, coalesceMs: cfg.delta_coalesce_ms, logRetentionRevs: cfg.log_retention_revs, log,
    sink: (surfaceId, frame) => service?.pushDelta(surfaceId, frame),
  });
  const jobs = createJobStore(deps.db);
  const actions = createActionHandler({
    db: deps.db, hub, jobs, submitInbound: deps.submitInbound, log,
    rateLimitPerMin: cfg.action_rate_limit_per_min, keyTtlHours: cfg.action_key_ttl_hours,
    noticeAction: async (device, id, actionId, key) => service
      ? service.noticeAction(device, id, actionId, key)
      : { type: 'action_result', idempotency_key: key, status: 'failed', reason: 'internal_error' },
    approvalAction: async (device, approvalId, decision, key) => {
      const base = { type: 'action_result' as const, idempotency_key: key };
      const surface = service?.surfaces.get(device.surface_id);
      if (!deps.approvals || !surface) return { ...base, status: 'failed', reason: 'not_found' };
      const out = await resolveApprovalFromSurface(deps.approvals(), { approvalId, decision, deviceId: device.id, contactId: surface.follow.contact });
      syncApprovals();
      return { ...base, status: out.status, ...(out.reason ? { reason: out.reason } : {}) };
    },
  });
  const certFingerprint = cfg.tls ? certFingerprintFile(cfg.tls.cert) : null;
  if (cfg.enabled && !certFingerprint) log(`warn: could not read the surface certificate ${cfg.tls?.cert}; pairing payloads carry no fingerprint`);

  const sweep = () => {
    try {
      for (const item of hub.sweepExpired()) if (item.resource === 'events') jobs.removeForEvent(item.surface, item.id);
      sweepJobs(deps.db, Date.now(), cfg.action_key_ttl_hours);
      devices.sweepPairCodes();
    } catch (err) { log(`warn: sweep failed: ${String(err)}`); }
  };
  let sweepTimer: NodeJS.Timeout | null = null;

  /** Sessions are the same on every surface; computed once per tick. */
  const syncSessions = () => {
    if (!service) return;
    const list = buildSurfaceSessions({
      db: deps.db, desk: deps.deskSessions?.() ?? [], now: Date.now(),
      activityTimeoutMin: cfg.sessions.activity_timeout_min, includeSystem: cfg.sessions.include_system,
    });
    const next = sessionsAsItems(list);
    for (const s of service.surfaces.values()) service.applyResource(s.id, 'sessions', diffItems(hub.snapshot(s.id, 'sessions').items, next));
  };
  const syncApprovals = () => {
    if (!service || !deps.approvals) return;
    for (const s of service.surfaces.values()) {
      try { syncApprovalEvents(hub, s.id, deps.db, { contactId: s.follow.contact }); }
      catch (err) { log(`warn: approval sync failed for ${s.id}: ${String(err)}`); }
    }
  };
  const unsubscribe: (() => void)[] = [];

  return {
    devices, hub, jobs,
    surfaceApi: { devices, hub, actions, certFingerprint },
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

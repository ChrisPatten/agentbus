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
import type { ActionResult, Device, JobStore } from './types.js';

export interface SurfaceRuntimeDeps {
  config: AppConfig;
  db: Database.Database;
  submitInbound: (message: InboundMessage, system?: InboundSystemOptions) => Promise<InboundResult | InboundAbort>;
  /** S96.7 — approve/deny a passed-through bus approval from a device. */
  approvalAction?: (device: Device, approvalId: string, decision: 'approve' | 'deny', idempotencyKey: string) => Promise<ActionResult>;
  log?: (line: string) => void;
}

export interface SurfaceRuntime {
  devices: SurfaceDeviceStore;
  hub: ResourceHubImpl;
  jobs: JobStore;
  surfaceApi: SurfaceApiDeps;
  /** Connect the hub's deltas and notice actions to the service, and register the tick work. */
  bind(service: IntercomService): void;
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
    ...(deps.approvalAction ? { approvalAction: deps.approvalAction } : {}),
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

  return {
    devices, hub, jobs,
    surfaceApi: { devices, hub, actions, certFingerprint },
    bind(svc) {
      service = svc;
      sweep();
      sweepTimer = setInterval(sweep, SWEEP_MS);
      sweepTimer.unref();
    },
    sweep,
    stop() {
      if (sweepTimer) clearInterval(sweepTimer);
      sweepTimer = null;
      hub.flush();
      hub.stop();
    },
  };
}

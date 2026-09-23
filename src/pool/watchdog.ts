/**
 * E52 (S52.1) — observe-only stall detector for leased pool panes.
 *
 * A pane is stalled when it has unhandled work older than `stall_after_ms`,
 * its captured screen has not changed for `stall_after_ms`, and no E51
 * approval request is pending for it. A stall is recorded as a
 * `pane_incidents` row. This class never sends keys to a pane: it only calls
 * `tmux.capturePane`.
 */
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { LeaseStore } from './lease-store.js';
import type { TmuxController } from './tmux.js';
import { toBareAgentId, type PoolLeaseRow } from './types.js';
import { getUnhandledSince as defaultGetUnhandledSince } from './unhandled-work.js';
import type { ResolvedWatchdogConfig } from './watchdog-config.js';
import type { IncidentClass, IncidentResolution, IncidentStore } from './watchdog-store.js';

/** Lines captured per pane per sample. */
const CAPTURE_LINES = 40;

export interface StallSummary {
  id: string;
  class: IncidentClass;
  pattern: string | null;
  detectedAt: string;
  unhandledSince: string | null;
}

export interface PaneWatchdogDeps {
  poolId: string;
  leaseStore: LeaseStore;
  tmux: TmuxController;
  db: Database.Database;
  incidentStore: IncidentStore;
  cfg: ResolvedWatchdogConfig;
  now?: () => Date;
  getUnhandledSince?: (db: Database.Database, row: PoolLeaseRow) => string | null;
}

interface PaneTrack {
  conversationId: string | null;
  screenHash: string;
  screenChangedAt: number;
  /** Screen hash when the open incident was detected (or first seen after a restart). */
  incidentHash?: string;
}

export class PaneWatchdog {
  private readonly deps: PaneWatchdogDeps;
  private readonly now: () => Date;
  private readonly getUnhandledSince: (db: Database.Database, row: PoolLeaseRow) => string | null;
  private readonly tracks = new Map<string, PaneTrack>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private sampling = false;

  constructor(deps: PaneWatchdogDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
    this.getUnhandledSince = deps.getUnhandledSince ?? defaultGetUnhandledSince;
  }

  /** Starts the recurring sample. No-op when disabled or already started. */
  start(): void {
    if (!this.deps.cfg.enabled || this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.sampleOnce();
    }, this.deps.cfg.sample_interval_ms);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** The pane's open incident, or null. */
  stallFor(paneId: string): StallSummary | null {
    const inc = this.deps.incidentStore.findOpen(this.deps.poolId, paneId);
    if (!inc) return null;
    return {
      id: inc.id,
      class: inc.class,
      pattern: inc.pattern,
      detectedAt: inc.detected_at,
      unhandledSince: inc.unhandled_since,
    };
  }

  /** One pass over every pane in the pool. A failure on one pane never aborts the pass. */
  async sampleOnce(): Promise<void> {
    if (this.sampling) return;
    this.sampling = true;
    try {
      const rows = this.deps.leaseStore.list(this.deps.poolId);
      const leasedIds = new Set<string>();
      for (const row of rows) {
        try {
          if (row.state === 'leased') {
            leasedIds.add(row.pane_id);
            await this.samplePane(row);
          } else {
            this.releaseIfOpen(row.pane_id);
          }
        } catch (err) {
          console.error(`[pool:${this.deps.poolId}] watchdog: failed to sample ${row.pane_id}:`, err);
        }
      }
      for (const paneId of [...this.tracks.keys()]) {
        if (!leasedIds.has(paneId)) this.tracks.delete(paneId);
      }
    } finally {
      this.sampling = false;
    }
  }

  private resolveOpen(paneId: string, resolution: IncidentResolution): void {
    const open = this.deps.incidentStore.findOpen(this.deps.poolId, paneId);
    if (open) this.deps.incidentStore.resolve(open.id, resolution, this.now());
  }

  private releaseIfOpen(paneId: string): void {
    this.resolveOpen(paneId, 'released');
  }

  private hasPendingApproval(row: PoolLeaseRow): boolean {
    const hit = this.deps.db
      .prepare(
        `SELECT 1 FROM approval_requests
         WHERE status = 'pending' AND adapter_id = 'cc-pool' AND agent_id = ? LIMIT 1`,
      )
      .get(toBareAgentId(row.agent_id));
    return hit !== undefined;
  }

  private async samplePane(row: PoolLeaseRow): Promise<void> {
    const { poolId, incidentStore, cfg } = this.deps;
    const paneId = row.pane_id;

    // A different conversation on the same pane invalidates prior tracking and any open incident.
    const prior = this.tracks.get(paneId);
    const open = incidentStore.findOpen(poolId, paneId);
    if (open && open.conversation_id !== row.conversation_id) {
      incidentStore.resolve(open.id, 'released', this.now());
    }
    if (prior && prior.conversationId !== row.conversation_id) {
      this.tracks.delete(paneId);
    }

    let text: string;
    try {
      text = await this.deps.tmux.capturePane(paneId, CAPTURE_LINES);
    } catch (err) {
      console.error(`[pool:${poolId}] watchdog: capturePane failed for ${paneId}:`, err);
      return; // leave tracking untouched
    }

    const nowDate = this.now();
    const nowMs = nowDate.getTime();
    const hash = createHash('sha256').update(text).digest('hex');

    let track = this.tracks.get(paneId);
    if (!track) {
      track = { conversationId: row.conversation_id, screenHash: hash, screenChangedAt: nowMs };
      this.tracks.set(paneId, track);
    } else if (track.screenHash !== hash) {
      track.screenHash = hash;
      track.screenChangedAt = nowMs;
    }

    const stillOpen = incidentStore.findOpen(poolId, paneId);
    if (stillOpen && track.incidentHash === undefined) track.incidentHash = hash;

    const unhandledSince = this.getUnhandledSince(this.deps.db, row);

    if (stillOpen) {
      if (track.incidentHash !== hash || unhandledSince === null) {
        incidentStore.resolve(stillOpen.id, 'recovered', nowDate);
        track.incidentHash = undefined;
      }
      return;
    }

    if (unhandledSince === null) return;
    const unhandledAge = nowMs - new Date(unhandledSince).getTime();
    if (!(unhandledAge > cfg.stall_after_ms)) return;
    if (nowMs - track.screenChangedAt < cfg.stall_after_ms) return;
    if (this.hasPendingApproval(row)) return;

    incidentStore.insert(
      {
        poolId,
        paneId,
        conversationId: row.conversation_id,
        class: 'unknown_blocked',
        unhandledSince,
        screenSnapshot: text,
      },
      nowDate,
    );
    track.incidentHash = hash;
    console.warn(
      `[pool:${poolId}] watchdog: ${paneId} stalled (conversation ${row.conversation_id ?? 'none'}, ` +
        `${Math.floor(unhandledAge / 60_000)}m unhandled, screen static ${Math.floor((nowMs - track.screenChangedAt) / 60_000)}m)`,
    );
  }
}

/**
 * E18 — Scheduler (S18.2 + S18.3 config loading)
 *
 * Background worker that fires scheduled messages into the inbound pipeline.
 * Each tick:
 *   1. Query scheduled_items WHERE status='active' AND fire_at <= now.
 *   2. For each due item, call processInbound() — the agent sees the message
 *      as if the configured contact sent it on the configured channel.
 *   3. Update fire_count, last_fired_at. Mark one-shots 'completed'. Advance
 *      fire_at for recurring cron items; mark 'completed' when max_fires hit.
 *
 * Config loading (loadConfig, called on start regardless of enabled flag):
 *   - Upserts all config.schedules entries by stable ID.
 *   - Cancels config-managed schedules whose IDs no longer appear in config
 *     (i.e. the user removed them from config.yaml).
 *
 * Delivery semantics: at-least-once. processInbound() fires before the DB
 * update. A process crash between the two causes the item to re-fire on the
 * next tick. One-shot schedules should be considered best-effort-once; cron
 * schedules are expected to tolerate the rare duplicate.
 *
 * Note: croner is used with { paused: true } exclusively for next-fire
 * calculation — it never actually schedules a background job.
 */
import { randomUUID } from 'node:crypto';
import { Cron } from 'croner';
import type Database from 'better-sqlite3';
import type { AppConfig } from '../config/schema.js';
import type { MessageQueue } from '../core/queue.js';
import type { AdapterRegistry } from '../core/registry.js';
import type { PipelineEngine } from '../pipeline/engine.js';
import type { CommandRegistry } from '../commands/registry.js';
import { processInbound as defaultProcessInbound } from '../http/api.js';
import type { InboundMessage, InboundResult, InboundAbort } from '../http/api.js';
import type { ScheduledItem } from './types.js';

export interface ProcessInboundDeps {
  queue: MessageQueue;
  pipeline: PipelineEngine;
  registry: AdapterRegistry;
  commandRegistry: CommandRegistry;
  pauseSet: Set<string>;
  config: AppConfig;
  db: Database.Database;
}

export type ProcessInboundFn = (
  msg: InboundMessage,
  deps: ProcessInboundDeps,
) => Promise<InboundResult | InboundAbort>;

export interface SchedulerDeps {
  db: Database.Database;
  config: AppConfig;
  queue: MessageQueue;
  pipeline: PipelineEngine;
  registry: AdapterRegistry;
  commandRegistry: CommandRegistry;
  pauseSet: Set<string>;
  /** Override for testing — defaults to the real processInbound */
  processInbound?: ProcessInboundFn;
}

/**
 * Calculate the next fire time for a cron expression after a given date.
 * Returns null if the expression is valid but has no future occurrences.
 * Throws if the expression cannot be parsed.
 */
function nextCronFire(cronExpr: string, timezone: string, after?: Date): string | null {
  const job = new Cron(cronExpr, { timezone, paused: true, startAt: after });
  const next = job.nextRun(after);
  job.stop();
  return next ? next.toISOString() : null;
}

/** Maximum items processed per tick — prevents runaway catch-up bursts. */
const TICK_ITEM_LIMIT = 50;

export class Scheduler {
  private db: Database.Database;
  private config: AppConfig;
  private deps: SchedulerDeps;
  private processInbound: ProcessInboundFn;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Prevents concurrent tick() executions if processInbound() is slow. */
  private isRunning = false;

  constructor(deps: SchedulerDeps) {
    this.db = deps.db;
    this.config = deps.config;
    this.deps = deps;
    this.processInbound = deps.processInbound ?? defaultProcessInbound;
  }

  /**
   * Load config-defined schedules into the DB.
   *
   * Called unconditionally on startup — even when scheduler.enabled = false —
   * so that config schedules are persisted and queryable via the HTTP API.
   * The tick loop (start/stop) is independent of this.
   */
  loadConfig(): void {
    this.upsertConfigSchedules();
    this.cancelRemovedConfigSchedules();
  }

  /**
   * Start the tick loop. Runs one immediate tick before the first interval.
   * Call loadConfig() separately (index.ts does this unconditionally).
   */
  start(): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.config.scheduler.tick_interval_ms);
  }

  /** Stop the tick loop. In-flight processInbound calls complete on their own. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Run one scheduler tick. Exposed for testing.
   * Skipped (no-op) if a previous tick is still in progress.
   */
  async tick(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    try {
      await this._runTick();
    } finally {
      this.isRunning = false;
    }
  }

  private async _runTick(): Promise<void> {
    let due: ScheduledItem[];
    try {
      due = this.db
        .prepare(
          // Use strftime ISO format so the comparison is lexicographically
          // correct against fire_at values stored as 'YYYY-MM-DDTHH:MM:SS.sssZ'.
          // datetime('now') returns 'YYYY-MM-DD HH:MM:SS' (space separator);
          // 'T' (0x54) > ' ' (0x20) so same-day past items would be skipped.
          `SELECT * FROM scheduled_items
           WHERE status = 'active'
             AND fire_at <= strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
           ORDER BY fire_at ASC LIMIT ${TICK_ITEM_LIMIT}`,
        )
        .all() as ScheduledItem[];
    } catch (err) {
      console.error('[scheduler] Failed to query due items:', err);
      return;
    }

    if (due.length === TICK_ITEM_LIMIT) {
      console.warn(
        `[scheduler] Tick hit the ${TICK_ITEM_LIMIT}-item cap — some overdue items deferred to next tick`,
      );
    }

    for (const item of due) {
      try {
        await this.fireItem(item);
      } catch (err) {
        console.error(`[scheduler] Unhandled error firing item ${item.id.slice(0, 8)}:`, err);
      }
    }
  }

  /** Fire a single scheduled item through the inbound pipeline. */
  private async fireItem(item: ScheduledItem): Promise<void> {
    const result = await this.processInbound(
      {
        channel: item.channel,
        sender: item.sender,
        payload: { type: 'text', body: item.payload_body },
        topic: item.topic,
        priority: item.priority,
        metadata: {
          scheduled: true,
          schedule_id: item.id,
          ...(item.label ? { schedule_label: item.label } : {}),
        },
      },
      {
        queue: this.deps.queue,
        pipeline: this.deps.pipeline,
        config: this.deps.config,
        db: this.deps.db,
        registry: this.deps.registry,
        commandRegistry: this.deps.commandRegistry,
        pauseSet: this.deps.pauseSet,
      },
    );

    const now = new Date().toISOString();
    const newFireCount = item.fire_count + 1;
    const maxReached = item.max_fires !== null && newFireCount >= item.max_fires;

    if (item.type === 'once' || maxReached) {
      this.db
        .prepare(
          `UPDATE scheduled_items
           SET last_fired_at = ?, fire_count = ?, status = 'completed'
           WHERE id = ?`,
        )
        .run(now, newFireCount, item.id);
      console.log(
        `[scheduler] Fired and completed schedule ${item.id.slice(0, 8)}` +
          (item.label ? ` (${item.label})` : ''),
      );
    } else {
      // Cron: advance to next fire time
      let nextFire: string | null;
      try {
        nextFire = nextCronFire(item.cron_expr!, item.timezone);
      } catch (err) {
        console.error(
          `[scheduler] Schedule ${item.id.slice(0, 8)} has an unparseable cron expression` +
            ` — marking completed:`,
          err,
        );
        this.db
          .prepare(
            `UPDATE scheduled_items
             SET last_fired_at = ?, fire_count = ?, status = 'completed'
             WHERE id = ?`,
          )
          .run(now, newFireCount, item.id);
        return;
      }

      if (!nextFire) {
        // Valid expression but no future occurrences — exhausted
        this.db
          .prepare(
            `UPDATE scheduled_items
             SET last_fired_at = ?, fire_count = ?, status = 'completed'
             WHERE id = ?`,
          )
          .run(now, newFireCount, item.id);
        console.log(`[scheduler] Schedule ${item.id.slice(0, 8)} exhausted — no future occurrences`);
      } else {
        this.db
          .prepare(
            `UPDATE scheduled_items
             SET last_fired_at = ?, fire_count = ?, fire_at = ?
             WHERE id = ?`,
          )
          .run(now, newFireCount, nextFire, item.id);
        console.log(
          `[scheduler] Fired schedule ${item.id.slice(0, 8)}` +
            (item.label ? ` (${item.label})` : '') +
            ` — next fire: ${nextFire}`,
        );
      }
    }

    if (!result.queued) {
      console.warn(
        `[scheduler] Schedule ${item.id.slice(0, 8)} fired but pipeline did not enqueue` +
          ` (reason: ${result.reason})`,
      );
    }
  }

  /**
   * Upsert all schedules from config.yaml into the DB.
   *
   * ON CONFLICT: update payload/label/cron_expr but NOT fire_at for existing
   * active items — overwriting fire_at would cause an immediate re-fire.
   *
   * Important: once a config schedule is manually cancelled (via /schedule cancel
   * or DELETE /api/v1/schedules/:id), the WHERE status != 'cancelled' guard
   * prevents it from being re-activated on restart. To revive a cancelled
   * config schedule, update its id in config.yaml to force a fresh insert.
   */
  private upsertConfigSchedules(): void {
    const entries = this.config.schedules;
    if (entries.length === 0) return;

    const now = new Date().toISOString();

    for (const entry of entries) {
      const type: 'once' | 'cron' = entry.cron ? 'cron' : 'once';

      // Calculate initial fire_at for new insertions only
      let initialFireAt: string;
      if (type === 'cron') {
        let next: string | null;
        try {
          next = nextCronFire(entry.cron!, entry.timezone);
        } catch (err) {
          console.warn(
            `[scheduler] Config schedule "${entry.id}" has an invalid cron expression` +
              ` "${entry.cron}": ${String(err)}`,
          );
          continue;
        }
        if (!next) {
          console.warn(
            `[scheduler] Config schedule "${entry.id}" cron "${entry.cron}"` +
              ` has no future occurrences — skipping`,
          );
          continue;
        }
        initialFireAt = next;
      } else {
        initialFireAt = entry.fire_at!;
      }

      // Insert new rows. For existing rows: update payload/label/cron but
      // preserve fire_at (so we don't re-trigger an already-scheduled item).
      // Skips cancelled items — see doc comment above.
      this.db
        .prepare(
          `INSERT INTO scheduled_items
             (id, type, cron_expr, timezone, fire_at, channel, sender, payload_body,
              topic, priority, label, created_at, created_by, fire_count, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'config', 0, 'active')
           ON CONFLICT(id) DO UPDATE SET
             cron_expr    = excluded.cron_expr,
             timezone     = excluded.timezone,
             payload_body = excluded.payload_body,
             topic        = excluded.topic,
             priority     = excluded.priority,
             label        = excluded.label
           WHERE status != 'cancelled'`,
        )
        .run(
          entry.id,
          type,
          entry.cron ?? null,
          entry.timezone,
          initialFireAt,
          entry.channel,
          entry.sender,
          entry.prompt,
          entry.topic,
          entry.priority,
          entry.label ?? null,
          now,
        );
    }

    console.log(`[scheduler] Upserted ${entries.length} config schedule(s)`);
  }

  /**
   * Cancel config-managed schedules whose IDs no longer appear in config.yaml.
   * This handles the case where the user removes an entry from config.
   */
  private cancelRemovedConfigSchedules(): void {
    const configIds = this.config.schedules.map((e) => e.id);
    if (configIds.length === 0) {
      // All config schedules removed — cancel any that remain
      const result = this.db
        .prepare(
          `UPDATE scheduled_items SET status = 'cancelled'
           WHERE created_by = 'config'
             AND status NOT IN ('completed', 'cancelled')`,
        )
        .run();
      if (result.changes > 0) {
        console.log(`[scheduler] Cancelled ${result.changes} removed config schedule(s)`);
      }
      return;
    }

    // Cancel config schedules not in the current config ID list
    const placeholders = configIds.map(() => '?').join(', ');
    const result = this.db
      .prepare(
        `UPDATE scheduled_items SET status = 'cancelled'
         WHERE created_by = 'config'
           AND id NOT IN (${placeholders})
           AND status NOT IN ('completed', 'cancelled')`,
      )
      .run(...configIds);

    if (result.changes > 0) {
      console.log(`[scheduler] Cancelled ${result.changes} removed config schedule(s)`);
    }
  }
}

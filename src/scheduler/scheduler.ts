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
 * Config loading (on start):
 *   - Upserts all config.schedules entries by stable ID.
 *   - Cancels config-managed schedules whose IDs no longer appear in config
 *     (i.e. the user removed them from config.yaml).
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
import { processInbound } from '../http/api.js';
import type { ScheduledItem } from './types.js';

export interface SchedulerDeps {
  db: Database.Database;
  config: AppConfig;
  queue: MessageQueue;
  pipeline: PipelineEngine;
  registry: AdapterRegistry;
  commandRegistry: CommandRegistry;
  pauseSet: Set<string>;
}

/**
 * Calculate the next fire time for a cron expression after a given date.
 * Returns null if the expression has no future occurrences.
 */
function nextCronFire(cronExpr: string, timezone: string, after?: Date): string | null {
  try {
    const job = new Cron(cronExpr, { timezone, paused: true, startAt: after });
    const next = job.nextRun(after);
    job.stop();
    return next ? next.toISOString() : null;
  } catch {
    return null;
  }
}

export class Scheduler {
  private db: Database.Database;
  private config: AppConfig;
  private deps: SchedulerDeps;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: SchedulerDeps) {
    this.db = deps.db;
    this.config = deps.config;
    this.deps = deps;
  }

  /**
   * Start the scheduler. Upserts config schedules, then begins the tick loop.
   * Runs one immediate tick before the interval fires.
   */
  start(): void {
    this.upsertConfigSchedules();
    this.cancelRemovedConfigSchedules();
    this.tick();
    this.timer = setInterval(() => this.tick(), this.config.scheduler.tick_interval_ms);
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
   * Queries all due items and fires them sequentially.
   */
  async tick(): Promise<void> {
    let due: ScheduledItem[];
    try {
      due = this.db
        .prepare(
          `SELECT * FROM scheduled_items
           WHERE status = 'active' AND fire_at <= datetime('now')
           ORDER BY fire_at ASC LIMIT 50`,
        )
        .all() as ScheduledItem[];
    } catch (err) {
      console.error('[scheduler] Failed to query due items:', err);
      return;
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
    const result = await processInbound(
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
      const nextFire = nextCronFire(item.cron_expr!, item.timezone);
      if (!nextFire) {
        // No future occurrences — mark completed
        this.db
          .prepare(
            `UPDATE scheduled_items
             SET last_fired_at = ?, fire_count = ?, status = 'completed'
             WHERE id = ?`,
          )
          .run(now, newFireCount, item.id);
        console.log(`[scheduler] Schedule ${item.id.slice(0, 8)} exhausted — no future fires`);
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
        const next = nextCronFire(entry.cron!, entry.timezone);
        if (!next) {
          console.warn(`[scheduler] Config schedule "${entry.id}" cron has no future fires — skipping`);
          continue;
        }
        initialFireAt = next;
      } else {
        initialFireAt = entry.fire_at!;
      }

      // Insert new rows. For existing rows: update payload/label/cron but
      // preserve fire_at (so we don't re-trigger an already-scheduled item).
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

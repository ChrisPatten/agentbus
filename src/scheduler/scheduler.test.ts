import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';
import { Scheduler } from './scheduler.js';
import type { AppConfig } from '../config/schema.js';
import type { ProcessInboundFn } from './scheduler.js';

// ── Test helpers ───────────────────────────────────────────────────────────────

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  runMigrations(db);
  return db;
}

const baseConfig: AppConfig = {
  bus: { http_port: 0, db_path: ':memory:', log_level: 'info' },
  adapters: {},
  contacts: {},
  topics: ['general'],
  memory: {
    summarizer_interval_ms: 60000,
    session_idle_threshold_ms: 900000,
    context_window_hours: 48,
    claude_api_model: 'claude-sonnet-4-6',
    summary_max_tokens: 8192,
  },
  scheduler: { tick_interval_ms: 30000, enabled: true },
  schedules: [],
  pipeline: {
    dedup_window_ms: 30000,
    drop_unrouted: false,
    topic_rules: [],
    priority_weights: { base_score: 0, topic_bonus: 40, vip_sender_bonus: 20, urgency_keyword_bonus: 15 },
    urgency_keywords: [],
    vip_contacts: [],
    routes: [],
  },
} as unknown as AppConfig;

const successResult = { ok: true as const, queued: true as const, id: 'mock-msg', enqueued_count: 1 };

function makeDeps(
  db: Database.Database,
  mockFn: ProcessInboundFn,
  configOverride?: Partial<AppConfig>,
) {
  const config = configOverride ? { ...baseConfig, ...configOverride } : baseConfig;
  return {
    db,
    config,
    queue: {} as never,
    pipeline: {} as never,
    registry: {} as never,
    commandRegistry: {} as never,
    pauseSet: new Set<string>(),
    processInbound: mockFn,
  };
}

/** Insert a scheduled item directly into the DB. */
function insertItem(
  db: Database.Database,
  opts: {
    id?: string;
    type?: 'once' | 'cron';
    cron_expr?: string | null;
    timezone?: string;
    fire_at?: string;   // ISO; default: 1 second ago (due)
    channel?: string;
    sender?: string;
    payload_body?: string;
    topic?: string;
    priority?: 'normal' | 'high' | 'urgent';
    label?: string | null;
    created_by?: string;
    fire_count?: number;
    max_fires?: number | null;
    status?: 'active' | 'paused' | 'cancelled' | 'completed';
  } = {},
): string {
  const id = opts.id ?? `sched-${Math.random().toString(36).slice(2)}`;
  const fireAt = opts.fire_at ?? new Date(Date.now() - 1000).toISOString();
  db.prepare(
    `INSERT INTO scheduled_items
       (id, type, cron_expr, timezone, fire_at, channel, sender, payload_body,
        topic, priority, label, created_at, created_by, fire_count, max_fires, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?)`,
  ).run(
    id,
    opts.type ?? 'once',
    opts.cron_expr ?? null,
    opts.timezone ?? 'UTC',
    fireAt,
    opts.channel ?? 'telegram',
    opts.sender ?? 'contact:chris',
    opts.payload_body ?? 'Hello',
    opts.topic ?? 'general',
    opts.priority ?? 'normal',
    opts.label ?? null,
    opts.created_by ?? 'http',
    opts.fire_count ?? 0,
    opts.max_fires ?? null,
    opts.status ?? 'active',
  );
  return id;
}

function getItem(db: Database.Database, id: string) {
  return db.prepare(`SELECT * FROM scheduled_items WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
}

// ── Scheduler.tick() ──────────────────────────────────────────────────────────

describe('Scheduler.tick()', () => {
  let db: Database.Database;
  let processInbound: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    db = makeDb();
    processInbound = vi.fn().mockResolvedValue(successResult);
  });

  it('fires a due once-item and marks it completed', async () => {
    const id = insertItem(db, { type: 'once' });
    const scheduler = new Scheduler(makeDeps(db, processInbound as ProcessInboundFn));

    await scheduler.tick();

    expect(processInbound).toHaveBeenCalledOnce();
    const row = getItem(db, id);
    expect(row!['status']).toBe('completed');
    expect(row!['fire_count']).toBe(1);
    expect(row!['last_fired_at']).toBeTruthy();
  });

  it('skips items that are not yet due', async () => {
    const futureAt = new Date(Date.now() + 60_000).toISOString();
    insertItem(db, { type: 'once', fire_at: futureAt });
    const scheduler = new Scheduler(makeDeps(db, processInbound as ProcessInboundFn));

    await scheduler.tick();

    expect(processInbound).not.toHaveBeenCalled();
  });

  it('skips paused and cancelled items', async () => {
    insertItem(db, { status: 'paused' });
    insertItem(db, { status: 'cancelled' });
    insertItem(db, { status: 'completed' });
    const scheduler = new Scheduler(makeDeps(db, processInbound as ProcessInboundFn));

    await scheduler.tick();

    expect(processInbound).not.toHaveBeenCalled();
  });

  it('advances fire_at for a cron item after firing', async () => {
    // Every minute — will always have a next occurrence
    const id = insertItem(db, {
      type: 'cron',
      cron_expr: '* * * * *',
      timezone: 'UTC',
    });
    const scheduler = new Scheduler(makeDeps(db, processInbound as ProcessInboundFn));

    await scheduler.tick();

    const row = getItem(db, id);
    expect(row!['status']).toBe('active');
    expect(row!['fire_count']).toBe(1);
    // fire_at should be in the future now
    expect(new Date(row!['fire_at'] as string).getTime()).toBeGreaterThan(Date.now());
  });

  it('completes a cron item when max_fires is reached', async () => {
    const id = insertItem(db, {
      type: 'cron',
      cron_expr: '* * * * *',
      timezone: 'UTC',
      fire_count: 4,
      max_fires: 5,
    });
    const scheduler = new Scheduler(makeDeps(db, processInbound as ProcessInboundFn));

    await scheduler.tick();

    const row = getItem(db, id);
    expect(row!['status']).toBe('completed');
    expect(row!['fire_count']).toBe(5);
  });

  it('gracefully handles an unparseable cron_expr by marking completed', async () => {
    const id = insertItem(db, {
      type: 'cron',
      cron_expr: 'NOT_A_CRON',
      timezone: 'UTC',
    });
    const scheduler = new Scheduler(makeDeps(db, processInbound as ProcessInboundFn));

    await scheduler.tick();

    // The item should be marked completed, not crash the scheduler
    const row = getItem(db, id);
    expect(row!['status']).toBe('completed');
  });

  it('passes scheduled metadata to processInbound', async () => {
    const id = insertItem(db, { label: 'My schedule' });
    const scheduler = new Scheduler(makeDeps(db, processInbound as ProcessInboundFn));

    await scheduler.tick();

    const call = processInbound.mock.calls[0]![0] as { metadata: Record<string, unknown> };
    expect(call.metadata).toMatchObject({
      scheduled: true,
      schedule_id: id,
      schedule_label: 'My schedule',
    });
  });

  it('omits schedule_label when label is null', async () => {
    insertItem(db, { label: null });
    const scheduler = new Scheduler(makeDeps(db, processInbound as ProcessInboundFn));

    await scheduler.tick();

    const call = processInbound.mock.calls[0]![0] as { metadata: Record<string, unknown> };
    expect(call.metadata['schedule_label']).toBeUndefined();
  });

  it('logs a warning when processInbound returns queued:false', async () => {
    processInbound.mockResolvedValue({ ok: true, queued: false, reason: 'no_routes' });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    insertItem(db);
    const scheduler = new Scheduler(makeDeps(db, processInbound as ProcessInboundFn));

    await scheduler.tick();

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('did not enqueue'));
    warnSpy.mockRestore();
  });

  it('reentrancy guard: a second concurrent tick() is a no-op', async () => {
    insertItem(db, { type: 'once' });
    insertItem(db, { type: 'once' });

    // Slow processInbound to make ticks overlap if guard is absent
    processInbound.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve(successResult), 20),
        ),
    );

    const scheduler = new Scheduler(makeDeps(db, processInbound as ProcessInboundFn));
    // Fire two ticks concurrently
    await Promise.all([scheduler.tick(), scheduler.tick()]);

    // Only the first tick ran; second was skipped by isRunning guard
    expect(processInbound).toHaveBeenCalledTimes(2); // 2 items from first tick
  });

  it('continues processing remaining items when one throws', async () => {
    const id1 = insertItem(db, { type: 'once' });
    const id2 = insertItem(db, { type: 'once' });
    let callCount = 0;
    processInbound.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.reject(new Error('boom'));
      return Promise.resolve(successResult);
    });

    const scheduler = new Scheduler(makeDeps(db, processInbound as ProcessInboundFn));
    await scheduler.tick();

    // Both items were attempted
    expect(processInbound).toHaveBeenCalledTimes(2);
    // The second item (no throw) should be completed
    const statuses = [getItem(db, id1)!['status'], getItem(db, id2)!['status']];
    expect(statuses.filter((s) => s === 'completed')).toHaveLength(1);
  });
});

// ── Scheduler.loadConfig() ────────────────────────────────────────────────────

describe('Scheduler.loadConfig()', () => {
  let db: Database.Database;
  // loadConfig never calls processInbound — use a spy just to satisfy types
  const noop: ProcessInboundFn = vi.fn() as unknown as ProcessInboundFn;

  beforeEach(() => {
    db = makeDb();
  });

  it('upserts a once schedule from config', () => {
    const config = {
      ...baseConfig,
      schedules: [
        {
          id: 'cfg-once',
          fire_at: new Date(Date.now() + 60_000).toISOString(),
          timezone: 'UTC',
          channel: 'telegram',
          sender: 'contact:chris',
          prompt: 'Hello from config',
          topic: 'general',
          priority: 'normal' as const,
        },
      ],
    } as unknown as AppConfig;

    new Scheduler(makeDeps(db, noop, config)).loadConfig();

    const row = getItem(db, 'cfg-once');
    expect(row).toBeTruthy();
    expect(row!['status']).toBe('active');
    expect(row!['created_by']).toBe('config');
    expect(row!['payload_body']).toBe('Hello from config');
  });

  it('upserts a cron schedule from config', () => {
    const config = {
      ...baseConfig,
      schedules: [
        {
          id: 'cfg-cron',
          cron: '0 8 * * 1-5',
          timezone: 'UTC',
          channel: 'telegram',
          sender: 'contact:chris',
          prompt: 'Morning',
          topic: 'general',
          priority: 'normal' as const,
        },
      ],
    } as unknown as AppConfig;

    new Scheduler(makeDeps(db, noop, config)).loadConfig();

    const row = getItem(db, 'cfg-cron');
    expect(row).toBeTruthy();
    expect(row!['type']).toBe('cron');
    expect(row!['cron_expr']).toBe('0 8 * * 1-5');
  });

  it('is idempotent — re-running loadConfig does not change fire_at', () => {
    const config = {
      ...baseConfig,
      schedules: [
        {
          id: 'cfg-idem',
          cron: '0 8 * * 1-5',
          timezone: 'UTC',
          channel: 'telegram',
          sender: 'contact:chris',
          prompt: 'Morning',
          topic: 'general',
          priority: 'normal' as const,
        },
      ],
    } as unknown as AppConfig;

    new Scheduler(makeDeps(db, noop, config)).loadConfig();
    const firstFireAt = (getItem(db, 'cfg-idem') as Record<string, unknown>)['fire_at'];

    new Scheduler(makeDeps(db, noop, config)).loadConfig();
    const secondFireAt = (getItem(db, 'cfg-idem') as Record<string, unknown>)['fire_at'];

    expect(firstFireAt).toBe(secondFireAt);
  });

  it('cancels a config schedule that was removed from config', () => {
    const configWith = {
      ...baseConfig,
      schedules: [
        {
          id: 'cfg-removable',
          cron: '0 8 * * *',
          timezone: 'UTC',
          channel: 'telegram',
          sender: 'contact:chris',
          prompt: 'Hi',
          topic: 'general',
          priority: 'normal' as const,
        },
      ],
    } as unknown as AppConfig;
    new Scheduler(makeDeps(db, noop, configWith)).loadConfig();

    const configWithout = { ...baseConfig, schedules: [] } as unknown as AppConfig;
    new Scheduler(makeDeps(db, noop, configWithout)).loadConfig();

    const row = getItem(db, 'cfg-removable');
    expect(row!['status']).toBe('cancelled');
  });

  it('warns on invalid cron expression and skips the entry', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config = {
      ...baseConfig,
      schedules: [
        {
          id: 'cfg-bad-cron',
          cron: 'NOT_VALID',
          timezone: 'UTC',
          channel: 'telegram',
          sender: 'contact:chris',
          prompt: 'Bad',
          topic: 'general',
          priority: 'normal' as const,
        },
      ],
    } as unknown as AppConfig;

    new Scheduler(makeDeps(db, noop, config)).loadConfig();

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('invalid cron expression'));
    expect(getItem(db, 'cfg-bad-cron')).toBeUndefined();
    warnSpy.mockRestore();
  });

  it('does not revive a manually cancelled config schedule on restart', () => {
    const config = {
      ...baseConfig,
      schedules: [
        {
          id: 'cfg-manual-cancel',
          cron: '0 8 * * *',
          timezone: 'UTC',
          channel: 'telegram',
          sender: 'contact:chris',
          prompt: 'Hi',
          topic: 'general',
          priority: 'normal' as const,
        },
      ],
    } as unknown as AppConfig;
    new Scheduler(makeDeps(db, noop, config)).loadConfig();

    // Simulate /schedule cancel
    db.prepare(`UPDATE scheduled_items SET status = 'cancelled' WHERE id = ?`).run(
      'cfg-manual-cancel',
    );

    // Restart — loadConfig runs again with same config
    new Scheduler(makeDeps(db, noop, config)).loadConfig();

    expect(getItem(db, 'cfg-manual-cancel')!['status']).toBe('cancelled');
  });
});

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';
import { AppConfigSchema, type AppConfig } from '../config/schema.js';
import { RuntimeResolver } from '../core/runtime-resolver.js';
import { JournalEngine } from './engine.js';
import { JournalerRegistry } from './registry.js';
import { ConsolidationScheduler, nextConsolidationAt } from './consolidation.js';
import { resolveJournalingSettings } from './config.js';
import { buildScriptPayload } from './journalers/script.js';
import { CONSOLIDATION_EXHAUSTED_CONDITION } from './advisories.js';
import type { Journaler, JournalJob, JournalOutcome } from './types.js';

let db: Database.Database;
let clock: number;

function makeConfig(consolidation: Record<string, unknown> | undefined = {}): AppConfig {
  return AppConfigSchema.parse({
    bus: { db_path: ':memory:' },
    adapters: { 'cc-headless': { agent_id: 'baxter', system_prompt: 'x', working_dir: '/agents/baxter' } },
    memory: {},
    agents: { 'agent:baxter': { journaling: { chain: ['cc-headless', 'script'], script: { command: '/bin/true' }, ...(consolidation ? { consolidation } : {}) } } },
  });
}

function fake(outcomes: JournalOutcome[] = ['done'], id: 'cc-headless' | 'script' = 'cc-headless') {
  const jobs: JournalJob[] = [];
  const j: Journaler & { jobs: JournalJob[] } = {
    id, requires: [], supportsKinds: ['session', 'consolidate'], jobs,
    canJournal: () => ({ ok: true }),
    run: vi.fn(async (job: JournalJob) => { jobs.push(job); return { outcome: outcomes.shift() ?? 'done' }; }),
  };
  return j;
}

function engineFor(config: AppConfig, journalers: Journaler[], extra: Partial<ConstructorParameters<typeof JournalEngine>[0]> = {}) {
  const registry = new JournalerRegistry();
  for (const j of journalers) registry.register(j);
  return new JournalEngine({ db, config, resolver: new RuntimeResolver(config), registry, now: () => new Date(clock), log: () => {}, ...extra });
}

function sessionRun(minAgo: number, outcome = 'done') {
  db.prepare(`INSERT INTO journal_runs (run_id, agent_id, kind, trigger, journaler, chain_position, outcome, message_count, started_at)
    VALUES (?, 'agent:baxter', 'session', 'pause', 'cc-headless', 0, ?, 2, ?)`)
    .run(`r-${minAgo}-${outcome}`, outcome, new Date(clock - minAgo * 60_000).toISOString());
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  clock = Date.UTC(2026, 9, 6, 12, 0);
});

describe('consolidation settings (S68.1)', () => {
  it('defaults to a nightly pass for agents.<id>.journaling and off for the legacy alias', () => {
    const s = resolveJournalingSettings(makeConfig(undefined)).get('agent:baxter')!;
    expect(s.consolidation).toMatchObject({ enabled: true, cron: '0 3 * * *', timezone: null, maxMemoryLines: 200, timeoutMs: 300_000 });
    expect(s.consolidation.prompt).toContain('Recurring-correction check');
    const legacy = resolveJournalingSettings(AppConfigSchema.parse({
      bus: { db_path: ':memory:' }, adapters: { 'cc-headless': { agent_id: 'old', system_prompt: 'x' } }, memory: {},
    })).get('agent:old')!;
    expect(legacy.consolidation.enabled).toBe(false);
  });

  it('rejects an invalid cron at load', () => {
    expect(() => makeConfig({ cron: 'not a cron' })).toThrow(/consolidation cron/);
  });
});

describe('JournalEngine.consolidate (S68.1)', () => {
  it('skips a scheduled pass when no session journal completed since the last one', async () => {
    const j = fake();
    const engine = engineFor(makeConfig(), [j]);
    const r = await engine.consolidate('baxter', 'scheduled').done;
    expect(r.status).toBe('nothing');
    expect(j.jobs).toHaveLength(0);
    expect(engine.store.listRuns({ agentId: 'agent:baxter' })).toHaveLength(0);
  });

  it('runs a scheduled pass after a session journal, as a consolidate job through the chain', async () => {
    sessionRun(60);
    sessionRun(30, 'nothing-to-do');
    const onJournaled = vi.fn();
    const j = fake();
    const engine = engineFor(makeConfig({ max_memory_lines: 150 }), [j], { onJournaled });
    const r = await engine.consolidate('agent:baxter', 'scheduled').done;
    expect(r).toMatchObject({ status: 'journaled', agentId: 'agent:baxter' });
    const job = j.jobs[0]!;
    expect(job).toMatchObject({
      kind: 'consolidate', trigger: 'scheduled', agentId: 'agent:baxter', runtime: 'cc-headless', workingDir: '/agents/baxter',
      memoryDir: '/agents/baxter/memory', sessionId: '', conversationId: '', messages: [], humanMessageCount: 0,
    });
    expect(job.consolidation).toMatchObject({
      lastPassAt: null, sessionRunsSince: 1, indexPath: '/agents/baxter/memory/MEMORY.md', dailyDir: '/agents/baxter/memory/daily',
      archiveDir: '/agents/baxter/memory/archive', archiveBefore: '2026-09-06', maxMemoryLines: 150, maxMemoryBytes: 25 * 1024,
    });
    expect(job.prompt).toContain('memory/archive');
    expect(job.prompt).toContain('dated before 2026-09-06');
    expect(job.prompt).toContain('at most 150 lines');
    const runs = engine.store.listRuns({ agentId: 'agent:baxter' }).filter((row) => row.kind === 'consolidate');
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ trigger: 'scheduled', outcome: 'done', session_id: null, conversation_id: null });
    expect(onJournaled).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'agent:baxter', status: 'journaled' }));
    expect(engine.store.lastConsolidation('agent:baxter')).toBe(runs[0]!.started_at);
  });

  it('runs a manual pass even with nothing new, and the next scheduled pass is skipped', async () => {
    const j = fake();
    const engine = engineFor(makeConfig(), [j]);
    expect((await engine.consolidate('baxter', 'manual').done).status).toBe('journaled');
    expect(j.jobs[0]!.trigger).toBe('manual');
    clock += 60_000;
    expect((await engine.consolidate('baxter', 'scheduled').done).status).toBe('nothing');
    sessionRun(0);
    clock += 60_000;
    expect((await engine.consolidate('baxter', 'scheduled').done).status).toBe('journaled');
    expect(j.jobs[1]!.consolidation?.lastPassAt).not.toBeNull();
  });

  it('falls back along the chain and raises a warning advisory when every journaler fails', async () => {
    const raise = vi.fn();
    const resolve = vi.fn();
    const a = fake(['failed-after-start']);
    const b = fake(['unavailable'], 'script');
    const engine = engineFor(makeConfig(), [a, b], { advisories: { raise, resolve } as never });
    const r = await engine.consolidate('baxter', 'manual').done;
    expect(r.status).toBe('exhausted');
    expect(raise).toHaveBeenCalledWith(expect.objectContaining({ conditionKey: CONSOLIDATION_EXHAUSTED_CONDITION, severity: 'warning' }));
    // Session bookkeeping is untouched.
    expect(engine.store.getAgentState('agent:baxter')).toBeNull();
    const ok = fake(['done']);
    const engine2 = engineFor(makeConfig(), [ok], { advisories: { raise, resolve } as never });
    await engine2.consolidate('baxter', 'manual').done;
    expect(resolve).toHaveBeenCalledWith('agent:baxter', CONSOLIDATION_EXHAUSTED_CONDITION);
  });

  it('shares the agent lane with session runs and merges a second request', async () => {
    let release!: () => void;
    const j = fake();
    j.run = vi.fn(async (job: JournalJob) => { j.jobs.push(job); await new Promise<void>((r) => { release = r; }); return { outcome: 'done' as const }; });
    const engine = engineFor(makeConfig(), [j]);
    const first = engine.consolidate('baxter', 'manual');
    const second = engine.consolidate('baxter', 'manual');
    expect(first.status).toBe('queued');
    expect(second.status).toBe('merged');
    expect(engine.isAgentBusy('baxter')).toBe(true);
    expect(engine.isConsolidating('baxter')).toBe(true);
    await new Promise((r) => setImmediate(r));
    release();
    await first.done;
    expect(j.jobs).toHaveLength(1);
    expect(engine.isConsolidating('baxter')).toBe(false);
  });

  it('is disabled when consolidation.enabled is false', async () => {
    const engine = engineFor(makeConfig({ enabled: false }), [fake()]);
    expect(engine.consolidate('baxter').status).toBe('disabled');
    expect(engineFor(makeConfig(), [fake()]).consolidate('nobody').status).toBe('not-configured');
  });

  it('passes the consolidation context to scripts', async () => {
    const j = fake();
    const engine = engineFor(makeConfig(), [j]);
    await engine.consolidate('baxter', 'manual').done;
    const payload = buildScriptPayload(j.jobs[0]!);
    expect(payload.kind).toBe('consolidate');
    expect(payload.consolidation).toMatchObject({ archive_dir: '/agents/baxter/memory/archive', archive_before: '2026-09-06', max_memory_lines: 200 });
  });
});

describe('ConsolidationScheduler (S68.1)', () => {
  it('computes the next fire time in the configured zone', () => {
    const next = nextConsolidationAt('0 3 * * *', 'UTC', new Date(Date.UTC(2026, 9, 6, 12, 0)));
    expect(next?.toISOString()).toBe('2026-10-07T03:00:00.000Z');
  });

  it('fires when due, then waits for the next occurrence', () => {
    const consolidate = vi.fn(() => ({ status: 'queued' as const, done: Promise.resolve({ status: 'nothing' as const }) }));
    const settings = [...resolveJournalingSettings(makeConfig({ cron: '0 3 * * *', timezone: 'UTC' })).values()];
    const scheduler = new ConsolidationScheduler({
      engine: { allSettings: () => settings, consolidate, store: { lastConsolidation: () => null } },
      now: () => new Date(clock),
    });
    scheduler.tick();
    expect(consolidate).not.toHaveBeenCalled();
    expect(scheduler.nextRunAt('agent:baxter')?.toISOString()).toBe('2026-10-07T03:00:00.000Z');
    clock = Date.UTC(2026, 9, 7, 3, 0, 30);
    scheduler.tick();
    expect(consolidate).toHaveBeenCalledExactlyOnceWith('agent:baxter', 'scheduled');
    scheduler.tick();
    expect(consolidate).toHaveBeenCalledTimes(1);
    expect(scheduler.nextRunAt('baxter')?.toISOString()).toBe('2026-10-08T03:00:00.000Z');
  });

  it('catches up a pass missed while the bus was down', () => {
    const consolidate = vi.fn(() => ({ status: 'queued' as const, done: Promise.resolve({ status: 'nothing' as const }) }));
    const settings = [...resolveJournalingSettings(makeConfig({ timezone: 'UTC' })).values()];
    const scheduler = new ConsolidationScheduler({
      engine: { allSettings: () => settings, consolidate, store: { lastConsolidation: () => '2026-10-04T03:00:05.000Z' } },
      now: () => new Date(clock),
    });
    scheduler.tick();
    expect(consolidate).toHaveBeenCalledOnce();
  });

  it('ignores agents with consolidation off', () => {
    const consolidate = vi.fn();
    const settings = [...resolveJournalingSettings(makeConfig({ enabled: false })).values()];
    const scheduler = new ConsolidationScheduler({
      engine: { allSettings: () => settings, consolidate: consolidate as never, store: { lastConsolidation: () => '2026-01-01T00:00:00.000Z' } },
      now: () => new Date(clock),
    });
    scheduler.tick();
    expect(consolidate).not.toHaveBeenCalled();
    expect(scheduler.nextRunAt('baxter')).toBeNull();
  });
});

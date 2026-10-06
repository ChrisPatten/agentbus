import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';
import { AppConfigSchema } from '../config/schema.js';
import { runtimeCapabilities } from '../core/runtime-capabilities.js';
import { CHAIN_EXHAUSTED_CONDITION } from './advisories.js';
import { resolveJournalingSettings } from './config.js';
import { JournalerRegistry } from './registry.js';
import { runChain } from './runner.js';
import { JournalStore } from './store.js';
import type { Journaler, JournalJob, JournalOutcome, JournalerId } from './types.js';

let db: Database.Database;
let store: JournalStore;
let registry: JournalerRegistry;
let advisories: { raise: ReturnType<typeof vi.fn>; resolve: ReturnType<typeof vi.fn> };

const settings = resolveJournalingSettings(AppConfigSchema.parse({
  bus: { db_path: ':memory:' }, adapters: {}, memory: {},
  agents: { 'agent:peggy': { journaling: { chain: ['system-message', 'cc-headless', 'script'], script: { command: '/bin/true' } } } },
})).get('agent:peggy')!;

function job(overrides: Partial<JournalJob> = {}): JournalJob {
  return {
    runId: 'run-1', kind: 'session', trigger: 'pause', agentId: 'agent:peggy', sessionAgentId: 'agent:peggy-pool-1',
    runtime: 'cc-pool', workingDir: '/agents/peggy', memoryDir: '/agents/peggy/memory', sessionId: 's1', conversationId: 'conv-1',
    channel: 'telegram', contactId: 'chris', topic: null, claudeSessionId: 'claude-1', harnessSessionId: null,
    harnessTranscriptPath: null, sessionOpen: true,
    window: { cursorAt: null, from: '2026-10-06T10:00:00.000Z', to: '2026-10-06T10:05:00.000Z', advanceTo: '2026-10-06T10:06:00.000Z' },
    messages: [], humanMessageCount: 2, snapshots: [], prompt: 'journal', model: null, timeoutMs: 1000, settings, ...overrides,
  };
}

function journaler(id: JournalerId, outcome: JournalOutcome | 'throw' | 'unavailable-check', extra: Partial<Journaler> = {}): Journaler {
  return {
    id, requires: [], supportsKinds: ['session'],
    canJournal: () => (outcome === 'unavailable-check' ? { ok: false, reason: 'pane released' } : { ok: true }),
    run: vi.fn(async () => {
      if (outcome === 'throw') throw new Error('boom');
      return { outcome: outcome as JournalOutcome, fidelity: 'full-session' as const, filesChanged: ['memory/daily/x.md'] };
    }),
    ...extra,
  };
}

const ctx = (chain: JournalerId[] = ['system-message', 'cc-headless', 'script'], kind: 'cc-pool' | 'cc-headless' = 'cc-pool') =>
  ({ chain, capabilities: runtimeCapabilities(kind), backlogSince: null });

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  db.prepare(`INSERT INTO sessions (id, conversation_id, channel, contact_id, started_at, last_activity, agent_id)
    VALUES ('s1', 'conv-1', 'telegram', 'chris', 'x', 'x', 'agent:peggy-pool-1')`).run();
  store = new JournalStore(db);
  registry = new JournalerRegistry();
  advisories = { raise: vi.fn(), resolve: vi.fn() };
});

const deps = () => ({ store, registry, advisories: advisories as never, log: () => {} });

describe('runChain (E66 S66.5)', () => {
  it('stops at the first done, advances the cursor, consumes snapshots and resolves the advisory', async () => {
    registry.register(journaler('system-message', 'done'));
    const later = journaler('cc-headless', 'done');
    registry.register(later);
    const snap = store.addSnapshot('s1', 'pre-compact', '/snap.jsonl');
    const summary = await runChain(job({ snapshots: [{ id: snap.id, event: 'pre-compact', path: snap.path, created_at: snap.created_at }] }), ctx(), deps());
    expect(summary).toMatchObject({ outcome: 'done', journaler: 'system-message', cursorAdvanced: true });
    expect(later.run).not.toHaveBeenCalled();
    expect(store.getCursor('s1')).toBe('2026-10-06T10:06:00.000Z');
    expect(store.pendingSnapshots('s1')).toEqual([]);
    expect(advisories.resolve).toHaveBeenCalledWith('agent:peggy', CHAIN_EXHAUSTED_CONDITION);
    const runs = store.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ run_id: 'run-1', journaler: 'system-message', outcome: 'done', chain_position: 0, fidelity: 'full-session' });
  });

  it('nothing-to-do also advances the cursor', async () => {
    registry.register(journaler('system-message', 'nothing-to-do'));
    expect((await runChain(job(), ctx(), deps())).outcome).toBe('nothing-to-do');
    expect(store.getCursor('s1')).toBe('2026-10-06T10:06:00.000Z');
  });

  it('advances on unavailable, failed-before-start and failed-after-start, recording fallback_from', async () => {
    registry.register(journaler('system-message', 'unavailable-check'));
    registry.register(journaler('cc-headless', 'failed-before-start'));
    registry.register(journaler('script', 'done'));
    const summary = await runChain(job(), ctx(), deps());
    expect(summary.attempts.map((a) => a.outcome)).toEqual(['unavailable', 'failed-before-start', 'done']);
    const runs = store.listRuns().reverse();
    expect(runs.map((r) => [r.journaler, r.chain_position, r.fallback_from, r.outcome])).toEqual([
      ['system-message', 0, null, 'unavailable'],
      ['cc-headless', 1, 'system-message', 'failed-before-start'],
      ['script', 2, 'cc-headless', 'done'],
    ]);
    expect(runs[0]!.error).toBe('pane released');
    expect(store.getAgentState('agent:peggy')).toMatchObject({ consecutive_exhaustions: 0, last_failure: expect.stringContaining('cc-headless') });
  });

  it('a thrown run is failed-after-start; unregistered journalers are unavailable', async () => {
    registry.register(journaler('system-message', 'throw'));
    registry.register(journaler('script', 'done'));
    const summary = await runChain(job(), ctx(), deps());
    expect(summary.attempts.map((a) => [a.journaler, a.outcome, a.error])).toEqual([
      ['system-message', 'failed-after-start', 'boom'],
      ['cc-headless', 'unavailable', 'journaler cc-headless is not registered'],
      ['script', 'done', null],
    ]);
  });

  it('skips statically incompatible entries without a row (system-message on cc-headless)', async () => {
    registry.register(journaler('system-message', 'done'));
    registry.register(journaler('cc-headless', 'done'));
    const summary = await runChain(job({ runtime: 'cc-headless' }), ctx(['system-message', 'cc-headless'], 'cc-headless'), deps());
    expect(summary.journaler).toBe('cc-headless');
    expect(store.listRuns().map((r) => r.journaler)).toEqual(['cc-headless']);
  });

  it('exhausted: cursor stays, attempts are counted, warning then critical after 3', async () => {
    registry.register(journaler('system-message', 'failed-after-start'));
    for (let i = 1; i <= 3; i++) {
      const summary = await runChain(job({ runId: `r${i}` }), ctx(['system-message']), deps());
      expect(summary).toMatchObject({ outcome: 'exhausted', cursorAdvanced: false, advisory: i < 3 ? 'warning' : 'critical' });
    }
    expect(store.getCursor('s1')).toBeNull();
    expect(store.attemptsFor('s1', '2026-10-06T10:06:00.000Z')).toBe(3);
    expect(advisories.raise).toHaveBeenLastCalledWith(expect.objectContaining({ conditionKey: CHAIN_EXHAUSTED_CONDITION, severity: 'critical' }));
  });

  it('escalates to critical when eligible content has waited 24 h', async () => {
    registry.register(journaler('system-message', 'failed-after-start'));
    const backlogSince = new Date(Date.now() - 25 * 3_600_000).toISOString();
    const summary = await runChain(job(), { ...ctx(['system-message']), backlogSince }, deps());
    expect(summary.advisory).toBe('critical');
  });

  it('a success after exhaustions resets the streak', async () => {
    const flaky = journaler('system-message', 'failed-after-start');
    registry.register(flaky);
    await runChain(job(), ctx(['system-message']), deps());
    (flaky.run as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ outcome: 'done' });
    await runChain(job(), ctx(['system-message']), deps());
    expect(store.getAgentState('agent:peggy')!.consecutive_exhaustions).toBe(0);
  });
});

describe('settle timeout (S66.6)', () => {
  it('aborts the attempt signal so the journaler can kill its work, and moves on', async () => {
    let seen: AbortSignal | undefined;
    const stuck = journaler('system-message', 'done', {
      run: vi.fn((_job: JournalJob, runCtx?: { signal: AbortSignal }) => {
        seen = runCtx?.signal;
        return new Promise<never>(() => {});
      }),
    });
    registry.register(stuck);
    registry.register(journaler('script', 'done'));
    const summary = await runChain(job({ timeoutMs: 5 }), ctx(['system-message', 'script']), deps());
    expect(seen?.aborted).toBe(true);
    expect(summary.attempts.map((a) => a.outcome)).toEqual(['failed-after-start', 'done']);
    expect(summary.attempts[0]!.error).toContain('did not settle');
  });
});

import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';
import { LeaseStore } from './lease-store.js';
import type { AcquireOptions, AcquireResult } from './types.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function baseOpts(overrides: Partial<AcquireOptions> = {}): AcquireOptions {
  return {
    poolAgentId: 'peggy',
    panes: 1,
    maxPanes: 1,
    growth: 'fixed',
    idleEvictMs: 15 * 60 * 1000,
    ...overrides,
  };
}

/** Narrows an AcquireResult to a specific `kind`, failing the test with a clear message if it doesn't match. */
function assertKind<K extends AcquireResult['kind']>(
  result: AcquireResult,
  kind: K,
): Extract<AcquireResult, { kind: K }> {
  expect(result.kind).toBe(kind);
  if (result.kind !== kind) {
    throw new Error(`expected acquire() kind "${kind}", got "${result.kind}"`);
  }
  return result as Extract<AcquireResult, { kind: K }>;
}

describe('LeaseStore', () => {
  describe('seedPanes', () => {
    it('is idempotent: repeat calls with the same pane list never duplicate or reset existing rows', () => {
      const db = makeDb();
      const store = new LeaseStore(db);
      const panes = [
        { paneId: 'peggy-pool:1', agentId: 'agent:peggy-pool-1' },
        { paneId: 'peggy-pool:2', agentId: 'agent:peggy-pool-2' },
      ];

      store.seedPanes('peggy-pool', panes);
      expect(store.list('peggy-pool')).toHaveLength(2);

      const bound = assertKind(store.acquire('peggy-pool', 'conv-1', baseOpts({ maxPanes: 2 })), 'bound');

      store.seedPanes('peggy-pool', panes);

      const rows = store.list('peggy-pool');
      expect(rows).toHaveLength(2);
      const mutated = rows.find((r) => r.pane_id === bound.lease.pane_id);
      expect(mutated?.state).toBe('launching');
      expect(mutated?.conversation_id).toBe('conv-1');
    });
  });

  describe('acquire', () => {
    it('reuse: finds an existing leased row for the conversation and touches it instead of re-claiming', () => {
      const db = makeDb();
      const store = new LeaseStore(db);
      store.seedPanes('peggy-pool', [{ paneId: 'peggy-pool:1', agentId: 'agent:peggy-pool-1' }]);

      const t0 = new Date('2026-01-01T00:00:00.000Z');
      const bound = assertKind(store.acquire('peggy-pool', 'conv-1', baseOpts({ now: () => t0 })), 'bound');
      store.confirmReady('peggy-pool', bound.lease.pane_id);

      const t1 = new Date('2026-01-01T00:05:00.000Z');
      const reused = assertKind(store.acquire('peggy-pool', 'conv-1', baseOpts({ now: () => t1 })), 'reuse');

      expect(reused.lease.pane_id).toBe(bound.lease.pane_id);
      expect(reused.lease.last_activity_at).toBe(t1.toISOString());
      expect(reused.lease.last_activity_at).not.toBe(bound.lease.last_activity_at);

      // Still exactly one row, still leased — not re-claimed.
      const rows = store.list('peggy-pool');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.state).toBe('leased');
      expect(rows[0]?.last_activity_at).toBe(t1.toISOString());
    });

    it('bound: claims a free pane, transitioning it to launching with the right fields', () => {
      const db = makeDb();
      const store = new LeaseStore(db);
      store.seedPanes('peggy-pool', [
        { paneId: 'peggy-pool:1', agentId: 'agent:peggy-pool-1' },
        { paneId: 'peggy-pool:2', agentId: 'agent:peggy-pool-2' },
      ]);

      const now = new Date('2026-01-01T00:00:00.000Z');
      const result = assertKind(store.acquire('peggy-pool', 'conv-1', baseOpts({ maxPanes: 2, now: () => now })), 'bound');

      // Deterministic tie-break: lowest pane_id.
      expect(result.lease.pane_id).toBe('peggy-pool:1');
      expect(result.lease.state).toBe('launching');
      expect(result.lease.conversation_id).toBe('conv-1');
      expect(result.lease.claude_session_id).toBeNull();
      expect(result.lease.leased_at).toBe(now.toISOString());
      expect(result.lease.last_activity_at).toBe(now.toISOString());

      const row = store.findByAgent('peggy-pool', 'agent:peggy-pool-1');
      expect(row?.state).toBe('launching');
      expect(row?.conversation_id).toBe('conv-1');
    });

    it('grow: inserts a new pane when dynamic and under maxPanes, synthesizing pane_id/agent_id', () => {
      const db = makeDb();
      const store = new LeaseStore(db);
      store.seedPanes('peggy-pool', [{ paneId: 'peggy-pool:1', agentId: 'agent:peggy-pool-1' }]);

      // Claim the only free pane first so the second call must grow.
      assertKind(store.acquire('peggy-pool', 'conv-1', baseOpts({ growth: 'dynamic', maxPanes: 3 })), 'bound');

      const before = store.list('peggy-pool');
      expect(before).toHaveLength(1);

      const result = assertKind(store.acquire('peggy-pool', 'conv-2', baseOpts({ growth: 'dynamic', maxPanes: 3 })), 'grow');

      expect(result.lease.pane_id).toBe('peggy-pool:grow-1');
      // paneIndex = total existing rows (1) + 1 = 2 -> derivePaneAgentId('peggy', 2)
      expect(result.lease.agent_id).toBe('agent:peggy-pool-2');
      expect(result.lease.state).toBe('launching');
      expect(result.lease.conversation_id).toBe('conv-2');
      expect(result.lease.claude_session_id).toBeNull();

      const after = store.list('peggy-pool');
      expect(after).toHaveLength(before.length + 1);
    });

    it('grow is refused under growth: fixed even when maxPanes would allow it, falling through to evict-or-exhausted', () => {
      const db = makeDb();
      const store = new LeaseStore(db);
      store.seedPanes('peggy-pool', [{ paneId: 'peggy-pool:1', agentId: 'agent:peggy-pool-1' }]);

      const now = new Date('2026-01-01T00:00:00.000Z');
      assertKind(store.acquire('peggy-pool', 'conv-1', baseOpts({ growth: 'fixed', now: () => now })), 'bound');

      const before = store.list('peggy-pool');
      const result = store.acquire(
        'peggy-pool',
        'conv-2',
        baseOpts({ growth: 'fixed', maxPanes: 10, now: () => now }),
      );

      expect(result.kind).toBe('exhausted');
      expect(store.list('peggy-pool')).toEqual(before);
    });

    it('evict: claims the least-recently-active idle leased pane and reports what was displaced', () => {
      const db = makeDb();
      const store = new LeaseStore(db);
      store.seedPanes('peggy-pool', [
        { paneId: 'peggy-pool:1', agentId: 'agent:peggy-pool-1' },
        { paneId: 'peggy-pool:2', agentId: 'agent:peggy-pool-2' },
      ]);

      const t0 = new Date('2026-01-01T00:00:00.000Z');
      const b1 = assertKind(store.acquire('peggy-pool', 'conv-1', baseOpts({ maxPanes: 2, now: () => t0 })), 'bound');
      store.confirmReady('peggy-pool', b1.lease.pane_id);
      store.setClaudeSessionId('peggy-pool', b1.lease.pane_id, 'sess-1');

      const t1 = new Date('2026-01-01T00:01:00.000Z');
      const b2 = assertKind(store.acquire('peggy-pool', 'conv-2', baseOpts({ maxPanes: 2, now: () => t1 })), 'bound');
      store.confirmReady('peggy-pool', b2.lease.pane_id);
      store.setClaudeSessionId('peggy-pool', b2.lease.pane_id, 'sess-2');

      // 1 hour later: pane 1 (idle since t0) and pane 2 (idle since t1) are
      // BOTH past a 30-minute idle threshold; pane 1 is the least recently
      // active of the two and must be the one evicted.
      const tNow = new Date('2026-01-01T01:00:00.000Z');
      const idleEvictMs = 30 * 60 * 1000;

      const result = assertKind(
        store.acquire('peggy-pool', 'conv-3', baseOpts({ maxPanes: 2, now: () => tNow, idleEvictMs })),
        'evict',
      );

      expect(result.lease.pane_id).toBe(b1.lease.pane_id);
      expect(result.evicted.conversationId).toBe('conv-1');
      expect(result.evicted.claudeSessionId).toBe('sess-1');
      expect(result.lease.conversation_id).toBe('conv-3');
      expect(result.lease.claude_session_id).toBeNull();
      expect(result.lease.state).toBe('launching');

      // Pane 2 must be untouched.
      const pane2 = store.findByAgent('peggy-pool', 'agent:peggy-pool-2');
      expect(pane2?.state).toBe('leased');
      expect(pane2?.conversation_id).toBe('conv-2');
      expect(pane2?.claude_session_id).toBe('sess-2');
    });

    it('reuse: finds an existing DRAINING (mid-turn) row for the conversation, not just leased', () => {
      const db = makeDb();
      const store = new LeaseStore(db);
      store.seedPanes('peggy-pool', [{ paneId: 'peggy-pool:1', agentId: 'agent:peggy-pool-1' }]);

      const bound = assertKind(store.acquire('peggy-pool', 'conv-1', baseOpts()), 'bound');
      store.confirmReady('peggy-pool', bound.lease.pane_id);
      store.beginTurn('agent:peggy-pool-1');

      const reused = assertKind(store.acquire('peggy-pool', 'conv-1', baseOpts()), 'reuse');
      expect(reused.lease.pane_id).toBe(bound.lease.pane_id);
      expect(reused.lease.state).toBe('draining');
    });

    it('a DRAINING pane is never evict-eligible, however long past idleEvictMs it is — regression for the "stale sender" bug: a pane mid-turn on a single-shot delivery (e.g. a scheduled brief) must not be reassigned before it can reply', () => {
      const db = makeDb();
      const store = new LeaseStore(db);
      store.seedPanes('peggy-pool', [{ paneId: 'peggy-pool:1', agentId: 'agent:peggy-pool-1' }]);

      const t0 = new Date('2026-01-01T06:30:00.000Z');
      const bound = assertKind(store.acquire('peggy-pool', 'conv-1', baseOpts({ now: () => t0 })), 'bound');
      store.confirmReady('peggy-pool', bound.lease.pane_id);
      // Turn starts right at claim time, same as the real pending-poll -> beginTurn wiring.
      store.beginTurn('agent:peggy-pool-1', () => t0);

      // Long past idleEvictMs later, a second conversation needs a pane —
      // with no free/growable pane, the only candidate is still mid-turn.
      const tLater = new Date('2026-01-01T08:00:00.000Z'); // 90 minutes later
      const idleEvictMs = 30 * 60 * 1000; // 30 minutes

      const result = store.acquire('peggy-pool', 'conv-2', baseOpts({ now: () => tLater, idleEvictMs }));

      expect(result.kind).toBe('exhausted');
      const row = store.findByAgent('peggy-pool', 'agent:peggy-pool-1');
      expect(row?.state).toBe('draining');
      expect(row?.conversation_id).toBe('conv-1');
    });

    it('exhausted: all panes leased and none idle past threshold mutates nothing', () => {
      const db = makeDb();
      const store = new LeaseStore(db);
      store.seedPanes('peggy-pool', [{ paneId: 'peggy-pool:1', agentId: 'agent:peggy-pool-1' }]);

      const now = new Date('2026-01-01T00:00:00.000Z');
      const bound = assertKind(store.acquire('peggy-pool', 'conv-1', baseOpts({ now: () => now })), 'bound');
      store.confirmReady('peggy-pool', bound.lease.pane_id);

      const before = store.list('peggy-pool');

      const result = store.acquire(
        'peggy-pool',
        'conv-2',
        baseOpts({ growth: 'fixed', now: () => now, idleEvictMs: 999_999_999 }),
      );

      expect(result.kind).toBe('exhausted');
      expect(store.list('peggy-pool')).toEqual(before);
    });

    it('race safety: two synchronous acquire calls for different conversations never double-claim the one free pane', () => {
      const db = makeDb();
      const store = new LeaseStore(db);
      store.seedPanes('peggy-pool', [{ paneId: 'peggy-pool:1', agentId: 'agent:peggy-pool-1' }]);

      const opts = baseOpts({ growth: 'fixed' });
      const first = store.acquire('peggy-pool', 'conv-1', opts);
      const second = store.acquire('peggy-pool', 'conv-2', opts);

      expect(first.kind).toBe('bound');
      expect(second.kind).toBe('exhausted');
      expect(store.list('peggy-pool')).toHaveLength(1);
    });
  });

  describe('state transition helpers', () => {
    it('confirmReady transitions launching -> leased and no-ops (with a logged error) otherwise', () => {
      const db = makeDb();
      const store = new LeaseStore(db);
      store.seedPanes('peggy-pool', [{ paneId: 'peggy-pool:1', agentId: 'agent:peggy-pool-1' }]);
      const bound = assertKind(store.acquire('peggy-pool', 'conv-1', baseOpts()), 'bound');

      store.confirmReady('peggy-pool', bound.lease.pane_id);
      expect(store.findByAgent('peggy-pool', 'agent:peggy-pool-1')?.state).toBe('leased');

      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // Already leased: no-op, but logs.
      store.confirmReady('peggy-pool', bound.lease.pane_id);
      expect(store.findByAgent('peggy-pool', 'agent:peggy-pool-1')?.state).toBe('leased');
      expect(errSpy).toHaveBeenCalledTimes(1);

      // Doesn't exist: no-op, doesn't throw, logs.
      expect(() => store.confirmReady('peggy-pool', 'does-not-exist')).not.toThrow();
      expect(errSpy).toHaveBeenCalledTimes(2);

      errSpy.mockRestore();
    });

    it('markDead sets state to dead without clearing conversation_id', () => {
      const db = makeDb();
      const store = new LeaseStore(db);
      store.seedPanes('peggy-pool', [{ paneId: 'peggy-pool:1', agentId: 'agent:peggy-pool-1' }]);
      const bound = assertKind(store.acquire('peggy-pool', 'conv-1', baseOpts()), 'bound');

      store.markDead('peggy-pool', bound.lease.pane_id);

      const row = store.findByAgent('peggy-pool', 'agent:peggy-pool-1');
      expect(row?.state).toBe('dead');
      expect(row?.conversation_id).toBe('conv-1');
    });

    it('release transitions to free and clears conversation_id, claude_session_id, and leased_at', () => {
      const db = makeDb();
      const store = new LeaseStore(db);
      store.seedPanes('peggy-pool', [{ paneId: 'peggy-pool:1', agentId: 'agent:peggy-pool-1' }]);
      const bound = assertKind(store.acquire('peggy-pool', 'conv-1', baseOpts()), 'bound');
      store.confirmReady('peggy-pool', bound.lease.pane_id);
      store.setClaudeSessionId('peggy-pool', bound.lease.pane_id, 'sess-1');

      store.release('peggy-pool', bound.lease.pane_id);

      const row = store.findByAgent('peggy-pool', 'agent:peggy-pool-1');
      expect(row?.state).toBe('free');
      expect(row?.conversation_id).toBeNull();
      expect(row?.claude_session_id).toBeNull();
      expect(row?.leased_at).toBeNull();
    });

    it('markDraining transitions leased -> draining', () => {
      const db = makeDb();
      const store = new LeaseStore(db);
      store.seedPanes('peggy-pool', [{ paneId: 'peggy-pool:1', agentId: 'agent:peggy-pool-1' }]);
      const bound = assertKind(store.acquire('peggy-pool', 'conv-1', baseOpts()), 'bound');
      store.confirmReady('peggy-pool', bound.lease.pane_id);

      store.markDraining('peggy-pool', bound.lease.pane_id);
      expect(store.findByAgent('peggy-pool', 'agent:peggy-pool-1')?.state).toBe('draining');
    });

    it('beginTurn transitions leased -> draining by agent_id and bumps last_activity_at; no-op when not leased', () => {
      const db = makeDb();
      const store = new LeaseStore(db);
      store.seedPanes('peggy-pool', [{ paneId: 'peggy-pool:1', agentId: 'agent:peggy-pool-1' }]);
      const t0 = new Date('2026-01-01T00:00:00.000Z');
      const bound = assertKind(store.acquire('peggy-pool', 'conv-1', baseOpts({ now: () => t0 })), 'bound');
      store.confirmReady('peggy-pool', bound.lease.pane_id);

      const t1 = new Date('2026-01-01T00:10:00.000Z');
      const changed = store.beginTurn('agent:peggy-pool-1', () => t1);

      expect(changed).toBe(true);
      const row = store.findByAgent('peggy-pool', 'agent:peggy-pool-1');
      expect(row?.state).toBe('draining');
      expect(row?.last_activity_at).toBe(t1.toISOString());

      // Already draining: no-op.
      expect(store.beginTurn('agent:peggy-pool-1')).toBe(false);
      // No matching row at all: no-op, doesn't throw.
      expect(store.beginTurn('agent:no-such-pane')).toBe(false);
    });

    it('endTurn transitions draining -> leased by agent_id and bumps last_activity_at; no-op when not draining', () => {
      const db = makeDb();
      const store = new LeaseStore(db);
      store.seedPanes('peggy-pool', [{ paneId: 'peggy-pool:1', agentId: 'agent:peggy-pool-1' }]);
      const bound = assertKind(store.acquire('peggy-pool', 'conv-1', baseOpts()), 'bound');
      store.confirmReady('peggy-pool', bound.lease.pane_id);
      store.beginTurn('agent:peggy-pool-1');

      const t1 = new Date('2026-01-01T00:20:00.000Z');
      const changed = store.endTurn('agent:peggy-pool-1', () => t1);

      expect(changed).toBe(true);
      const row = store.findByAgent('peggy-pool', 'agent:peggy-pool-1');
      expect(row?.state).toBe('leased');
      expect(row?.last_activity_at).toBe(t1.toISOString());

      // Already leased (not draining): no-op.
      expect(store.endTurn('agent:peggy-pool-1')).toBe(false);
    });
  });

  describe('lookups', () => {
    it('findByAgent matches only the exact prefixed agent_id', () => {
      const db = makeDb();
      const store = new LeaseStore(db);
      store.seedPanes('peggy-pool', [{ paneId: 'peggy-pool:1', agentId: 'agent:peggy-pool-1' }]);

      expect(store.findByAgent('peggy-pool', 'agent:peggy-pool-1')?.pane_id).toBe('peggy-pool:1');
      expect(store.findByAgent('peggy-pool', 'peggy-pool-1')).toBeNull(); // bare form must not match
      expect(store.findByAgent('peggy-pool', 'agent:peggy-pool-2')).toBeNull();
    });

    it('findByAgentAnyPool finds a row for its agent_id with no pool_id filter', () => {
      const db = makeDb();
      const store = new LeaseStore(db);
      store.seedPanes('peggy-pool', [{ paneId: 'peggy-pool:1', agentId: 'agent:peggy-pool-1' }]);

      expect(store.findByAgentAnyPool('agent:peggy-pool-1')?.pane_id).toBe('peggy-pool:1');
    });

    it('findByAgentAnyPool returns null when no row matches', () => {
      const db = makeDb();
      const store = new LeaseStore(db);
      store.seedPanes('peggy-pool', [{ paneId: 'peggy-pool:1', agentId: 'agent:peggy-pool-1' }]);

      expect(store.findByAgentAnyPool('agent:no-such-agent')).toBeNull();
    });

    it("findByAgentAnyPool does not collide two different pools' distinct agent ids", () => {
      const db = makeDb();
      const store = new LeaseStore(db);
      store.seedPanes('peggy-pool', [{ paneId: 'peggy-pool:1', agentId: 'agent:peggy-pool-1' }]);
      store.seedPanes('jarvis-pool', [{ paneId: 'jarvis-pool:1', agentId: 'agent:jarvis-pool-1' }]);

      expect(store.findByAgentAnyPool('agent:peggy-pool-1')?.pane_id).toBe('peggy-pool:1');
      expect(store.findByAgentAnyPool('agent:jarvis-pool-1')?.pane_id).toBe('jarvis-pool:1');
    });

    it('findByConversation finds the current row for a conversation, or null', () => {
      const db = makeDb();
      const store = new LeaseStore(db);
      store.seedPanes('peggy-pool', [{ paneId: 'peggy-pool:1', agentId: 'agent:peggy-pool-1' }]);

      expect(store.findByConversation('peggy-pool', 'conv-1')).toBeNull();

      const bound = assertKind(store.acquire('peggy-pool', 'conv-1', baseOpts()), 'bound');
      expect(store.findByConversation('peggy-pool', 'conv-1')?.pane_id).toBe(bound.lease.pane_id);
    });

    it('list returns every row for the pool', () => {
      const db = makeDb();
      const store = new LeaseStore(db);
      store.seedPanes('peggy-pool', [
        { paneId: 'peggy-pool:1', agentId: 'agent:peggy-pool-1' },
        { paneId: 'peggy-pool:2', agentId: 'agent:peggy-pool-2' },
      ]);

      expect(store.list('peggy-pool').map((r) => r.pane_id).sort()).toEqual(['peggy-pool:1', 'peggy-pool:2']);
    });

    it('findIdleOlderThan returns only leased rows idle past the cutoff', () => {
      const db = makeDb();
      const store = new LeaseStore(db);
      store.seedPanes('peggy-pool', [
        { paneId: 'peggy-pool:1', agentId: 'agent:peggy-pool-1' },
        { paneId: 'peggy-pool:2', agentId: 'agent:peggy-pool-2' },
      ]);

      const t0 = new Date('2026-01-01T00:00:00.000Z');
      const b1 = assertKind(store.acquire('peggy-pool', 'conv-1', baseOpts({ maxPanes: 2, now: () => t0 })), 'bound');
      store.confirmReady('peggy-pool', b1.lease.pane_id);

      const t1 = new Date('2026-01-01T00:30:00.000Z');
      const b2 = assertKind(store.acquire('peggy-pool', 'conv-2', baseOpts({ maxPanes: 2, now: () => t1 })), 'bound');
      store.confirmReady('peggy-pool', b2.lease.pane_id);

      const cutoff = new Date('2026-01-01T00:15:00.000Z').toISOString();
      const idle = store.findIdleOlderThan('peggy-pool', cutoff);

      expect(idle).toHaveLength(1);
      expect(idle[0]?.pane_id).toBe(b1.lease.pane_id);
    });

    it('findIdleOlderThan also includes DRAINING rows past the cutoff — the hard-idle backstop for a turn that never calls back out', () => {
      const db = makeDb();
      const store = new LeaseStore(db);
      store.seedPanes('peggy-pool', [{ paneId: 'peggy-pool:1', agentId: 'agent:peggy-pool-1' }]);

      const t0 = new Date('2026-01-01T00:00:00.000Z');
      const bound = assertKind(store.acquire('peggy-pool', 'conv-1', baseOpts({ now: () => t0 })), 'bound');
      store.confirmReady('peggy-pool', bound.lease.pane_id);
      store.beginTurn('agent:peggy-pool-1', () => t0);

      const cutoff = new Date('2026-01-01T01:00:00.000Z').toISOString();
      const idle = store.findIdleOlderThan('peggy-pool', cutoff);

      expect(idle).toHaveLength(1);
      expect(idle[0]?.pane_id).toBe(bound.lease.pane_id);
      expect(idle[0]?.state).toBe('draining');
    });
  });

  describe('pool isolation', () => {
    it('never lets two different pool_id values see or affect each other rows', () => {
      const db = makeDb();
      const store = new LeaseStore(db);
      store.seedPanes('pool-a', [{ paneId: 'pool-a:1', agentId: 'agent:peggy-pool-1' }]);
      store.seedPanes('pool-b', [{ paneId: 'pool-b:1', agentId: 'agent:peggy-pool-1' }]);

      assertKind(store.acquire('pool-a', 'conv-1', baseOpts()), 'bound');

      expect(store.list('pool-a')).toHaveLength(1);
      expect(store.list('pool-b')).toHaveLength(1);
      expect(store.list('pool-b')[0]?.state).toBe('free');
      expect(store.findByConversation('pool-b', 'conv-1')).toBeNull();
      expect(store.findByAgent('pool-b', 'agent:peggy-pool-1')?.state).toBe('free');
    });
  });
});

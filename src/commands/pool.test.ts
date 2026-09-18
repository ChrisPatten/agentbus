import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';
import { MessageQueue } from '../core/queue.js';
import { createPoolCommand } from './pool.js';
import { PoolManager } from '../pool/pool-manager.js';
import type { CcPoolInstanceConfig } from '../config/schema.js';
import type { SlashCommandContext } from './registry.js';
import type { MessageEnvelope } from '../types/envelope.js';
import { createSafeDatabase } from '../db/safe-database.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

/** Mirrors pool-manager.test.ts's own makeCfg — a fully-populated CcPoolInstanceConfig fixture. */
function makeCfg(overrides: Partial<CcPoolInstanceConfig> = {}): CcPoolInstanceConfig {
  return {
    name: null,
    agent_id: 'peggy',
    tmux_session: 'peggy-pool',
    panes: 2,
    growth: 'fixed',
    max_panes: 2,
    claude_bin: '/usr/local/bin/claude',
    model: undefined,
    working_dir: '/work/dir',
    launch_args: [],
    poll_interval_ms: 1000,
    system_prompt: undefined,
    lease: { idle_evict_ms: 1_800_000, hard_idle_ms: 21_600_000, park_timeout_ms: 300_000 },
    on_evict: 'clear',
    launch_ack_delay_ms: 500,
    launch_ack_max_attempts: 3,
    launch_ack_pattern: 'experimental',
    pane_env: {},
    ...overrides,
  };
}

/** A no-op PaneLauncher stub — these tests only exercise leaseStore/parkedStatus
 *  reads, never launch()/release(), so a fake is enough (mirrors pool-manager.test.ts). */
function makeFakePaneLauncher() {
  return { launch: async () => {}, release: async () => {} };
}

function makeManager(db: Database.Database, cfgOverrides: Partial<CcPoolInstanceConfig> = {}): PoolManager {
  const cfg = makeCfg(cfgOverrides);
  return new PoolManager({ cfg, db, busBaseUrl: 'http://127.0.0.1:3000', paneLauncher: makeFakePaneLauncher() });
}

function makeCtx(db: Database.Database): SlashCommandContext {
  const envelope: MessageEnvelope = {
    id: 'test-id',
    timestamp: new Date().toISOString(),
    channel: 'telegram',
    topic: 'general',
    sender: 'contact:chris',
    recipient: 'agent:claude',
    reply_to: null,
    priority: 'normal',
    payload: { type: 'text', body: '/pool' },
    metadata: {},
  };
  return {
    channel: 'telegram',
    sender: 'contact:chris',
    adapterId: 'telegram',
    argsRaw: '',
    envelope,
    db: createSafeDatabase(db),
    config: {} as unknown as SlashCommandContext['config'],
  };
}

describe('/pool', () => {
  it('reports no instances configured when poolManagers is empty', async () => {
    const db = makeDb();
    const cmd = createPoolCommand({ poolManagers: new Map() });
    const result = await cmd.handler([], makeCtx(db));
    expect(result.body).toBe('No cc-pool instances configured.');
  });

  it('renders each pane with its state for a pool with mixed pane states', async () => {
    const db = makeDb();
    const manager = makeManager(db);
    manager.leaseStore.seedPanes('peggy', [
      { paneId: 'peggy-pool:1', agentId: 'agent:peggy-pool-1' },
      { paneId: 'peggy-pool:2', agentId: 'agent:peggy-pool-2' },
    ]);
    const acquired = manager.leaseStore.acquire('peggy', 'conv-abcdef1234', {
      poolAgentId: 'peggy',
      panes: 2,
      maxPanes: 2,
      growth: 'fixed',
      idleEvictMs: 1_800_000,
    });
    if (acquired.kind !== 'bound') throw new Error(`test setup: expected "bound", got "${acquired.kind}"`);
    manager.leaseStore.confirmReady('peggy', acquired.lease.pane_id);

    const poolManagers = new Map([['agent:peggy', manager]]);
    const cmd = createPoolCommand({ poolManagers, now: () => new Date('2026-01-01T00:00:00.000Z') });
    const result = await cmd.handler([], makeCtx(db));

    expect(result.body).toContain('Pool peggy (agent:peggy)');
    expect(result.body).toContain('peggy-pool:1: leased');
    expect(result.body).toContain('conv=conv-abc'); // conversation_id sliced to first 8 chars
    expect(result.body).toContain('peggy-pool:2: free');
    expect(result.body).toContain('parked: 0');
  });

  it('filters to one pool when args[0] matches (bare or "agent:"-prefixed form)', async () => {
    const db = makeDb();
    const peggy = makeManager(db, { agent_id: 'peggy', tmux_session: 'peggy-pool' });
    const otherbot = makeManager(db, { agent_id: 'otherbot', tmux_session: 'otherbot-pool' });
    peggy.leaseStore.seedPanes('peggy', [{ paneId: 'peggy-pool:1', agentId: 'agent:peggy-pool-1' }]);
    otherbot.leaseStore.seedPanes('otherbot', [{ paneId: 'otherbot-pool:1', agentId: 'agent:otherbot-pool-1' }]);
    const poolManagers = new Map([
      ['agent:peggy', peggy],
      ['agent:otherbot', otherbot],
    ]);
    const cmd = createPoolCommand({ poolManagers });

    const bareResult = await cmd.handler(['peggy'], makeCtx(db));
    expect(bareResult.body).toContain('Pool peggy');
    expect(bareResult.body).not.toContain('Pool otherbot');

    const prefixedResult = await cmd.handler(['agent:otherbot'], makeCtx(db));
    expect(prefixedResult.body).toContain('Pool otherbot');
    expect(prefixedResult.body).not.toContain('Pool peggy');
  });

  it('reports no matching pool for a filter that matches nothing', async () => {
    const db = makeDb();
    const manager = makeManager(db);
    manager.leaseStore.seedPanes('peggy', [{ paneId: 'peggy-pool:1', agentId: 'agent:peggy-pool-1' }]);
    const poolManagers = new Map([['agent:peggy', manager]]);
    const cmd = createPoolCommand({ poolManagers });

    const result = await cmd.handler(['ghost'], makeCtx(db));
    expect(result.body).toBe('No cc-pool instance for "ghost".');
  });

  it('shows the oldest parked age when the pool has parked messages', async () => {
    const db = makeDb();
    const manager = makeManager(db);
    manager.leaseStore.seedPanes('peggy', [{ paneId: 'peggy-pool:1', agentId: 'agent:peggy-pool-1' }]);

    const queue = new MessageQueue(db);
    const messageId = queue.enqueue({
      id: 'parked-msg-1',
      timestamp: new Date().toISOString(),
      channel: 'telegram',
      topic: 'general',
      sender: 'contact:bob',
      recipient: manager.parkedRecipientId(),
      reply_to: null,
      priority: 'normal',
      payload: { type: 'text', body: 'hi' },
      metadata: {},
    });
    // Backdate created_at so the "oldest parked" age is deterministic — enqueue()
    // always stamps real wall-clock time, which formatDurationMs would otherwise
    // render as "0s" (this test runs far faster than 42s).
    db.prepare(`UPDATE message_queue SET created_at = ? WHERE id = ?`).run('2026-01-01T00:00:18.000Z', messageId);

    const poolManagers = new Map([['agent:peggy', manager]]);
    const cmd = createPoolCommand({ poolManagers, now: () => new Date('2026-01-01T00:01:00.000Z') });
    const result = await cmd.handler([], makeCtx(db));

    expect(result.body).toContain('parked: 1 (oldest 42s)');
  });
});

import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';
import { MessageQueue } from '../core/queue.js';
import { createPoolCommand } from './pool.js';
import { PoolManager } from '../pool/pool-manager.js';
import type { CcPoolInstanceConfig } from '../config/schema.js';
import type { SlashCommandContext } from './registry.js';
import type { MessageEnvelope } from '../types/envelope.js';
import { computeConversationId } from '../pipeline/conversation-id.js';
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

  it('shows the leased pane\'s model (E53), and omits model= for a free pane / a leased pane with no model', async () => {
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
    manager.leaseStore.setModel('peggy', acquired.lease.pane_id, 'claude-haiku-5');

    const poolManagers = new Map([['agent:peggy', manager]]);
    const cmd = createPoolCommand({ poolManagers, now: () => new Date('2026-01-01T00:00:00.000Z') });
    const result = await cmd.handler([], makeCtx(db));

    expect(result.body).toContain('model=claude-haiku-5');
    // Free pane line has no model= segment at all.
    const freeLine = (result.body ?? '').split('\n').find((l) => l.includes('peggy-pool:2'))!;
    expect(freeLine).not.toContain('model=');
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

  describe('E80: serving-window marker and /pool kill', () => {
    const CONV = computeConversationId('chris', 'telegram', 'general');

    /** Two-pane pool with CONV leased on pane 1 and another conversation on pane 2. */
    async function setup() {
      const db = makeDb();
      const launcher = { launch: vi.fn(async () => {}), release: vi.fn(async () => {}) };
      const manager = new PoolManager({
        cfg: makeCfg(), db, busBaseUrl: 'http://127.0.0.1:3000', paneLauncher: launcher, transcriptExists: () => true,
      });
      await manager.ensureStarted();
      await manager.resolveRoute(CONV, { contact_id: 'chris', channel: 'telegram' });
      await manager.resolveRoute('other-conversation', { contact_id: 'bob', channel: 'telegram' });
      const cmd = createPoolCommand({ poolManagers: new Map([['agent:peggy', manager]]) });
      return { db, manager, launcher, cmd };
    }

    it('marks only the pane serving this chat', async () => {
      const { db, cmd } = await setup();
      const lines = ((await cmd.handler([], makeCtx(db))).body ?? '').split('\n');
      const mine = lines.find((l) => l.includes(`conv=${CONV.slice(0, 8)}`))!;
      const theirs = lines.find((l) => l.includes('conv=other-co'))!;
      expect(mine).toContain('◀ this chat');
      expect(theirs).not.toContain('◀ this chat');
      expect(lines.join('\n')).not.toContain('no pane is serving');
    });

    it('says so when no pane serves this chat', async () => {
      const { db, manager, cmd } = await setup();
      manager.killConversation(CONV);
      const body = (await cmd.handler([], makeCtx(db))).body ?? '';
      expect(body).not.toContain('◀ this chat');
      expect(body).toContain('This chat: no pane is serving it');
    });

    it('/pool kill kills this chat\'s pane, names it, and leaves others alone', async () => {
      const { db, manager, launcher, cmd } = await setup();
      const pane = manager.leaseStore.findByConversation(manager.poolId, CONV)!;
      const result = await cmd.handler(['kill'], makeCtx(db));
      expect(result.body).toContain(`Killed ${pane.pane_id}`);
      expect(result.body).toContain('fresh window');
      await new Promise((r) => setTimeout(r, 0));
      expect(launcher.release).toHaveBeenCalledWith(pane.pane_id, 'kill');
      expect(manager.leaseStore.findByConversation(manager.poolId, 'other-conversation')?.state).toBe('leased');
    });

    it('/pool kill with no serving pane does nothing', async () => {
      const { db, manager, launcher, cmd } = await setup();
      manager.killConversation(CONV);
      await new Promise((r) => setTimeout(r, 0));
      launcher.release.mockClear();
      const result = await cmd.handler(['kill'], makeCtx(db));
      expect(result.body).toBe('No pane is serving this chat; nothing to kill.');
      expect(launcher.release).not.toHaveBeenCalled();
    });

    it('/pool kill mid-turn says the turn was cut off, and the next message gets a fresh pane', async () => {
      const { db, manager, launcher, cmd } = await setup();
      const pane = manager.leaseStore.findByConversation(manager.poolId, CONV)!;
      const queue = new MessageQueue(db);
      queue.enqueue({
        id: 'turn-1', timestamp: new Date().toISOString(), channel: 'telegram', topic: 'general',
        sender: 'contact:chris', recipient: pane.agent_id, reply_to: null, priority: 'normal',
        payload: { type: 'text', body: 'work on it' }, metadata: { conversation_id: CONV },
      });
      queue.dequeue(pane.agent_id);
      const result = await cmd.handler(['kill'], makeCtx(db));
      expect(result.body).toContain('a turn was in flight');
      await new Promise((r) => setTimeout(r, 0));
      launcher.launch.mockClear();
      const recipient = await manager.resolveRoute(CONV, { contact_id: 'chris', channel: 'telegram' });
      expect(recipient).toBe(pane.agent_id);
      expect(launcher.launch).toHaveBeenCalledTimes(1);
    });

    it('rejects extra arguments to kill', async () => {
      const { db, cmd } = await setup();
      expect((await cmd.handler(['kill', 'peggy'], makeCtx(db))).body).toBe('Usage: /pool kill');
    });
  });
});

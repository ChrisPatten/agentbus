import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';
import { PoolManager, createPoolManagers, type PaneLauncher } from './pool-manager.js';
import type { LaunchParams } from './pane.js';
import type { AppConfig, CcPoolAdapterConfig, CcPoolInstanceConfig } from '../config/schema.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

/** Mirrors pane.test.ts's own makeCfg — a fully-populated CcPoolInstanceConfig fixture. */
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

/** Same shape as makeCfg but without `name` — matches what getCcPoolInstances() consumes per named-record entry. */
function makeAdapterEntry(overrides: Partial<CcPoolAdapterConfig> = {}): CcPoolAdapterConfig {
  const { name: _name, ...rest } = makeCfg(overrides);
  return rest;
}

/** No explicit return-type annotation — keeps `.mock` accessible with the right tuple types (mirrors pane.test.ts's makeTmux rationale). */
function makeFakeLauncher() {
  return {
    launch: vi.fn(async (_params: LaunchParams) => {}),
    release: vi.fn(async (_paneId: string, _onEvict: 'clear' | 'kill') => {}),
  };
}

function makeManager(cfgOverrides: Partial<CcPoolInstanceConfig> = {}, db: Database.Database = makeDb()) {
  const cfg = makeCfg(cfgOverrides);
  const paneLauncher = makeFakeLauncher();
  const manager = new PoolManager({ cfg, db, busBaseUrl: 'http://127.0.0.1:3000', paneLauncher });
  return { manager, paneLauncher, db, cfg };
}

describe('PoolManager', () => {
  describe('ensureStarted', () => {
    it('seeds exactly cfg.panes free rows with correctly-derived pane/agent ids', async () => {
      const { manager } = makeManager({ panes: 3, tmux_session: 'peggy-pool', agent_id: 'peggy' });

      await manager.ensureStarted();

      const rows = manager.leaseStore.list(manager.poolId);
      expect(rows).toHaveLength(3);
      expect(rows.every((r) => r.state === 'free')).toBe(true);
      const byPane = new Map(rows.map((r) => [r.pane_id, r]));
      expect(byPane.get('peggy-pool:1')?.agent_id).toBe('agent:peggy-pool-1');
      expect(byPane.get('peggy-pool:2')?.agent_id).toBe('agent:peggy-pool-2');
      expect(byPane.get('peggy-pool:3')?.agent_id).toBe('agent:peggy-pool-3');
    });

    it('is idempotent: calling twice never duplicates or resets existing rows', async () => {
      const { manager } = makeManager({ panes: 2 });
      await manager.ensureStarted();

      const bound = manager.leaseStore.acquire(manager.poolId, 'conv-x', {
        poolAgentId: 'peggy',
        panes: 2,
        maxPanes: 2,
        growth: 'fixed',
        idleEvictMs: 1_800_000,
      });
      expect(bound.kind).toBe('bound');

      await manager.ensureStarted();

      const rows = manager.leaseStore.list(manager.poolId);
      expect(rows).toHaveLength(2);
      const claimed = rows.find((r) => r.conversation_id === 'conv-x');
      expect(claimed?.state).toBe('launching');
    });
  });

  describe('resolveRoute', () => {
    it('reuse: returns the existing lease agent id without launching', async () => {
      const { manager, paneLauncher } = makeManager({ panes: 2 });
      await manager.ensureStarted();
      const bound = manager.leaseStore.acquire(manager.poolId, 'conv-1', {
        poolAgentId: 'peggy',
        panes: 2,
        maxPanes: 2,
        growth: 'fixed',
        idleEvictMs: 1_800_000,
      });
      if (bound.kind !== 'bound') throw new Error(`expected bound, got ${bound.kind}`);
      manager.leaseStore.confirmReady(manager.poolId, bound.lease.pane_id);

      const result = await manager.resolveRoute('conv-1', { contact_id: 'alice', channel: 'telegram' });

      expect(result).toBe(bound.lease.agent_id);
      expect(paneLauncher.launch).not.toHaveBeenCalled();
    });

    it('bound (new conversation, no prior session): launches fresh with a generated session id and persists it', async () => {
      const { manager, paneLauncher, cfg } = makeManager({ panes: 2 });
      await manager.ensureStarted();

      const result = await manager.resolveRoute('conv-new', { contact_id: 'alice', channel: 'telegram' });

      expect(paneLauncher.launch).toHaveBeenCalledTimes(1);
      const launchArgs = paneLauncher.launch.mock.calls[0]![0];
      expect(launchArgs.resume).toBe(false);
      expect(launchArgs.sessionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(launchArgs.paneAgentId).toBe('peggy-pool-1');
      expect(launchArgs.paneId).toBe('peggy-pool:1');
      expect(launchArgs.promptContext).toEqual({ contact_id: 'alice', channel: 'telegram' });
      expect(launchArgs.ensureWindow).toEqual({ cwd: cfg.working_dir, env: cfg.pane_env });

      expect(result).toBe('agent:peggy-pool-1');

      const lease = manager.leaseStore.findByConversation(manager.poolId, 'conv-new');
      expect(lease?.state).toBe('leased');
      expect(lease?.claude_session_id).toBe(launchArgs.sessionId);
    });

    it('bound (conversation with a prior sessions.claude_session_id): resumes with that same session id', async () => {
      const { manager, paneLauncher, db } = makeManager({ panes: 2 });
      await manager.ensureStarted();

      const priorClaudeId = 'prior-claude-session-id';
      const sessionRowId = 'sess-fixture-1';
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO sessions (id, conversation_id, channel, contact_id, started_at, last_activity, message_count, claude_session_id)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
      ).run(sessionRowId, 'conv-resume', 'telegram', 'alice', now, now, priorClaudeId);

      const result = await manager.resolveRoute('conv-resume', { contact_id: 'alice', channel: 'telegram' });

      const launchArgs = paneLauncher.launch.mock.calls[0]![0];
      expect(launchArgs.resume).toBe(true);
      expect(launchArgs.sessionId).toBe(priorClaudeId);
      expect(result).toBe('agent:peggy-pool-1');

      const updated = db.prepare(`SELECT claude_session_id FROM sessions WHERE id = ?`).get(sessionRowId) as {
        claude_session_id: string;
      };
      expect(updated.claude_session_id).toBe(priorClaudeId);
    });

    it('exhausted: returns the parked id and never touches the launcher', async () => {
      const { manager, paneLauncher } = makeManager({ panes: 1, growth: 'fixed' });
      await manager.ensureStarted();
      const first = await manager.resolveRoute('conv-1', { contact_id: 'alice', channel: 'telegram' });
      expect(first).toBe('agent:peggy-pool-1');
      paneLauncher.launch.mockClear();
      paneLauncher.release.mockClear();

      const second = await manager.resolveRoute('conv-2', { contact_id: 'bob', channel: 'telegram' });

      expect(second).toBe(manager.parkedRecipientId());
      expect(paneLauncher.launch).not.toHaveBeenCalled();
      expect(paneLauncher.release).not.toHaveBeenCalled();
    });

    it('evict: releases the displaced pane before launching the new conversation, and fully replaces the lease', async () => {
      const db = makeDb();
      const cfg = makeCfg({ panes: 1 });
      const callOrder: string[] = [];
      const paneLauncher: PaneLauncher = {
        launch: vi.fn(async (_params: LaunchParams) => {
          callOrder.push('launch');
        }),
        release: vi.fn(async (_paneId: string, _onEvict: 'clear' | 'kill') => {
          callOrder.push('release');
        }),
      };
      const manager = new PoolManager({ cfg, db, busBaseUrl: 'http://127.0.0.1:3000', paneLauncher });
      await manager.ensureStarted();

      const first = await manager.resolveRoute('conv-old', { contact_id: 'alice', channel: 'telegram' });
      expect(first).toBe('agent:peggy-pool-1');
      const pane = manager.leaseStore.findByConversation(manager.poolId, 'conv-old');
      // Force this pane's last_activity_at into the distant past so it becomes evict-eligible
      // deterministically, without depending on real wall-clock time elapsing.
      manager.leaseStore.touch(manager.poolId, pane!.pane_id, new Date('2000-01-01T00:00:00.000Z'));
      callOrder.length = 0;
      (paneLauncher.launch as ReturnType<typeof vi.fn>).mockClear();
      (paneLauncher.release as ReturnType<typeof vi.fn>).mockClear();

      const second = await manager.resolveRoute('conv-new', { contact_id: 'bob', channel: 'telegram' });

      expect(second).toBe('agent:peggy-pool-1');
      expect(callOrder).toEqual(['release', 'launch']);
      expect(paneLauncher.release).toHaveBeenCalledWith(pane!.pane_id, 'clear');

      expect(manager.leaseStore.findByConversation(manager.poolId, 'conv-old')).toBeNull();
      const newLease = manager.leaseStore.findByConversation(manager.poolId, 'conv-new');
      expect(newLease?.pane_id).toBe(pane!.pane_id);
      expect(newLease?.state).toBe('leased');
    });

    it('evict: a failed release on the displaced pane does not block seating the new conversation', async () => {
      const { manager, paneLauncher } = makeManager({ panes: 1 });
      await manager.ensureStarted();
      await manager.resolveRoute('conv-old', { contact_id: 'alice', channel: 'telegram' });
      const pane = manager.leaseStore.findByConversation(manager.poolId, 'conv-old');
      manager.leaseStore.touch(manager.poolId, pane!.pane_id, new Date('2000-01-01T00:00:00.000Z'));
      paneLauncher.release.mockRejectedValueOnce(new Error('tmux is on fire'));
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await manager.resolveRoute('conv-new', { contact_id: 'bob', channel: 'telegram' });

      expect(result).toBe('agent:peggy-pool-1');
      const newLease = manager.leaseStore.findByConversation(manager.poolId, 'conv-new');
      expect(newLease?.state).toBe('leased');
      expect(errSpy).toHaveBeenCalled();

      errSpy.mockRestore();
    });

    it('launch failure: marks the pane dead, returns the parked id, and does not reject', async () => {
      const { manager, paneLauncher } = makeManager({ panes: 1 });
      await manager.ensureStarted();
      paneLauncher.launch.mockRejectedValueOnce(new Error('boom'));
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(
        manager.resolveRoute('conv-1', { contact_id: 'alice', channel: 'telegram' }),
      ).resolves.toBe(manager.parkedRecipientId());

      const lease = manager.leaseStore.list(manager.poolId)[0];
      expect(lease?.state).toBe('dead');

      errSpy.mockRestore();
    });
  });

  describe('journalingRunner', () => {
    it('resolves to { skipped: true }', async () => {
      const { manager } = makeManager();
      await expect(manager.journalingRunner('some-conversation-id')).resolves.toEqual({ skipped: true });
    });
  });

  describe('createPoolManagers', () => {
    it('returns one PoolManager per configured cc-pool instance, keyed by prefixed agent id', () => {
      const db = makeDb();
      const config = {
        adapters: {
          'cc-pool': {
            peggy: makeAdapterEntry({ agent_id: 'peggy', tmux_session: 'peggy-pool' }),
            jarvis: makeAdapterEntry({ agent_id: 'jarvis', tmux_session: 'jarvis-pool' }),
          },
        },
      } as unknown as AppConfig;

      const managers = createPoolManagers(config, db, 'http://127.0.0.1:3000');

      expect(managers.size).toBe(2);
      expect(managers.has('agent:peggy')).toBe(true);
      expect(managers.has('agent:jarvis')).toBe(true);
      expect(managers.get('agent:peggy')?.poolId).toBe('peggy');
      expect(managers.get('agent:jarvis')?.poolId).toBe('jarvis');
    });
  });
});

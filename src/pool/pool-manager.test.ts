import { describe, it, expect, vi, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';
import { PoolManager, createPoolManagers, findPoolManagerForAgent, type PaneLauncher } from './pool-manager.js';
import type { LaunchParams } from './pane.js';
import type { AppConfig, CcPoolAdapterConfig, CcPoolInstanceConfig } from '../config/schema.js';
import { MessageQueue } from '../core/queue.js';
import type { MessageEnvelope } from '../types/envelope.js';

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

/** A TmuxController-shaped fake — only paneAlive/capturePane are exercised by
 *  reconcileLiveness(), the rest exist so the object structurally satisfies
 *  PoolManagerDeps.tmux. No explicit return-type annotation, matching
 *  makeFakeLauncher()'s own rationale above (keeps `.mock` accessible). */
function makeFakeTmux() {
  return {
    ensureSession: vi.fn(async (_session: string, _cwd: string) => {}),
    listWindows: vi.fn(async (_session: string) => []),
    createWindow: vi.fn(async (_session: string, name: string, _cwd: string, _env?: Record<string, string>) =>
      `${_session}:${name}`,
    ),
    killWindow: vi.fn(async (_target: string) => {}),
    sendKeys: vi.fn(async (_target: string, _keys: string) => {}),
    sendCommand: vi.fn(async (_target: string, _line: string) => {}),
    paneAlive: vi.fn(async (_target: string) => true),
    paneCommand: vi.fn(async (_target: string) => null as string | null),
    capturePane: vi.fn(async (_target: string, _lines?: number) => ''),
  };
}

/** A fake fetch — mirrors pane.test.ts's own loosely-typed Response fake.
 *  notifySystem() never inspects the resolved value, so `{ ok: true }` is
 *  enough. Cast at the injection site with `as unknown as typeof fetch`,
 *  matching pane.test.ts's exact convention. */
function makeFakeFetch() {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({ ok: true }) as unknown as Response);
}

/** A minimal MessageEnvelope parked (or about to be parked) under some pool's
 *  parkedRecipientId(). Callers override `recipient`/`metadata` as needed. */
function parkEnvelope(conversationId: string): MessageEnvelope {
  return {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    channel: 'telegram',
    topic: 'general',
    sender: 'contact:bob',
    recipient: '',
    reply_to: null,
    priority: 'normal',
    payload: { type: 'text', body: 'hello' },
    metadata: { conversation_id: conversationId },
  };
}

/** Peeks at still-pending rows for a recipient via raw SQL — deliberately
 *  NOT queue.dequeue(), which would mark them 'processing' and make them
 *  unavailable to the drainParked() call a test wants to run next. */
function readPendingByRecipient(
  db: Database.Database,
  recipient: string,
): Array<{ id: string; metadata: Record<string, unknown> }> {
  const rows = db
    .prepare(`SELECT id, metadata FROM message_queue WHERE recipient = ? AND status = 'pending'`)
    .all(recipient) as Array<{ id: string; metadata: string }>;
  return rows.map((r) => ({ id: r.id, metadata: JSON.parse(r.metadata) as Record<string, unknown> }));
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

    it('bound: posts a "One moment" placeholder tool-status line before launching', async () => {
      const db = makeDb();
      const cfg = makeCfg({ panes: 2 });
      const paneLauncher = makeFakeLauncher();
      const fetchFn = makeFakeFetch();
      const manager = new PoolManager({
        cfg,
        db,
        busBaseUrl: 'http://127.0.0.1:3000',
        paneLauncher,
        fetchFn: fetchFn as unknown as typeof fetch,
      });
      await manager.ensureStarted();

      await manager.resolveRoute('conv-new', { contact_id: 'alice', channel: 'telegram', topic: 'thread:abc' });

      const placeholderCalls = fetchFn.mock.calls.filter(([url]) => String(url).endsWith('/tool-status'));
      expect(placeholderCalls).toHaveLength(1);
      const [url, init] = placeholderCalls[0]! as [string, { body: string }];
      expect(url).toBe('http://127.0.0.1:3000/api/v1/adapters/telegram/tool-status');
      expect(JSON.parse(init.body)).toEqual({
        contact_id: 'alice',
        text: 'One moment…',
        topic: 'thread:abc',
        placeholder: true,
      });
    });

    it('reuse: never posts the cold-start placeholder — there is no launch to cover', async () => {
      const db = makeDb();
      const cfg = makeCfg({ panes: 2 });
      const paneLauncher = makeFakeLauncher();
      const fetchFn = makeFakeFetch();
      const manager = new PoolManager({
        cfg,
        db,
        busBaseUrl: 'http://127.0.0.1:3000',
        paneLauncher,
        fetchFn: fetchFn as unknown as typeof fetch,
      });
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
      fetchFn.mockClear();

      await manager.resolveRoute('conv-1', { contact_id: 'alice', channel: 'telegram' });

      expect(fetchFn).not.toHaveBeenCalled();
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

  describe('reconcileLiveness', () => {
    function makeManagerWithTmux(cfgOverrides: Partial<CcPoolInstanceConfig> = {}) {
      const db = makeDb();
      const cfg = makeCfg({ panes: 2, ...cfgOverrides });
      const paneLauncher = makeFakeLauncher();
      const tmux = makeFakeTmux();
      const fetchFn = makeFakeFetch();
      const manager = new PoolManager({
        cfg,
        db,
        busBaseUrl: 'http://127.0.0.1:3000',
        paneLauncher,
        tmux,
        fetchFn: fetchFn as unknown as typeof fetch,
      });
      return { manager, paneLauncher, tmux, fetchFn, db, cfg };
    }

    it('leased row, paneAlive() true: left completely untouched', async () => {
      const { manager, tmux, fetchFn } = makeManagerWithTmux();
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
      tmux.paneAlive.mockResolvedValue(true);

      await manager.reconcileLiveness();

      expect(tmux.paneAlive).toHaveBeenCalledWith(bound.lease.pane_id);
      expect(tmux.capturePane).not.toHaveBeenCalled();
      const row = manager.leaseStore.findByConversation(manager.poolId, 'conv-1');
      expect(row?.state).toBe('leased');
      expect(row?.conversation_id).toBe('conv-1');
      expect(fetchFn).not.toHaveBeenCalled();
    });

    it('leased row, paneAlive() false: released (state free, conversation_id null), notifySystem fired once', async () => {
      const { manager, tmux, fetchFn } = makeManagerWithTmux();
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
      tmux.paneAlive.mockResolvedValue(false);
      tmux.capturePane.mockResolvedValue('some prior pane output');

      await manager.reconcileLiveness();

      // release() clears conversation_id, so it's no longer findable by the old conversation id.
      expect(manager.leaseStore.findByConversation(manager.poolId, 'conv-1')).toBeNull();
      const freed = manager.leaseStore.list(manager.poolId).find((r) => r.pane_id === bound.lease.pane_id);
      expect(freed?.state).toBe('free');
      expect(freed?.conversation_id).toBeNull();
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('free row: tmux.paneAlive() is never called', async () => {
      const { manager, tmux } = makeManagerWithTmux();
      await manager.ensureStarted(); // both seeded panes remain 'free'

      await manager.reconcileLiveness();

      expect(tmux.paneAlive).not.toHaveBeenCalled();
    });

    it('dead row: revived — killWindow attempted, released back to free, WITHOUT ever calling paneAlive on it', async () => {
      const { manager, tmux } = makeManagerWithTmux();
      await manager.ensureStarted();
      const bound = manager.leaseStore.acquire(manager.poolId, 'conv-1', {
        poolAgentId: 'peggy',
        panes: 2,
        maxPanes: 2,
        growth: 'fixed',
        idleEvictMs: 1_800_000,
      });
      if (bound.kind !== 'bound') throw new Error(`expected bound, got ${bound.kind}`);
      manager.leaseStore.markDead(manager.poolId, bound.lease.pane_id);

      await manager.reconcileLiveness();

      expect(tmux.paneAlive).not.toHaveBeenCalledWith(bound.lease.pane_id);
      expect(tmux.killWindow).toHaveBeenCalledWith(bound.lease.pane_id);
      const revived = manager.leaseStore.list(manager.poolId).find((r) => r.pane_id === bound.lease.pane_id);
      expect(revived?.state).toBe('free');
      expect(revived?.conversation_id).toBeNull();
    });

    it('dead row: a killWindow rejection does not prevent the row from being released', async () => {
      const { manager, tmux } = makeManagerWithTmux();
      await manager.ensureStarted();
      const bound = manager.leaseStore.acquire(manager.poolId, 'conv-1', {
        poolAgentId: 'peggy',
        panes: 2,
        maxPanes: 2,
        growth: 'fixed',
        idleEvictMs: 1_800_000,
      });
      if (bound.kind !== 'bound') throw new Error(`expected bound, got ${bound.kind}`);
      manager.leaseStore.markDead(manager.poolId, bound.lease.pane_id);
      tmux.killWindow.mockRejectedValueOnce(new Error('no such window'));

      await manager.reconcileLiveness();

      const revived = manager.leaseStore.list(manager.poolId).find((r) => r.pane_id === bound.lease.pane_id);
      expect(revived?.state).toBe('free');
    });

    it('a dead row and a separate live leased row are both handled correctly in one pass', async () => {
      const { manager, tmux } = makeManagerWithTmux();
      await manager.ensureStarted();
      const deadBind = manager.leaseStore.acquire(manager.poolId, 'conv-dead', {
        poolAgentId: 'peggy',
        panes: 2,
        maxPanes: 2,
        growth: 'fixed',
        idleEvictMs: 1_800_000,
      });
      if (deadBind.kind !== 'bound') throw new Error(`expected bound, got ${deadBind.kind}`);
      manager.leaseStore.markDead(manager.poolId, deadBind.lease.pane_id);

      const liveBind = manager.leaseStore.acquire(manager.poolId, 'conv-live', {
        poolAgentId: 'peggy',
        panes: 2,
        maxPanes: 2,
        growth: 'fixed',
        idleEvictMs: 1_800_000,
      });
      if (liveBind.kind !== 'bound') throw new Error(`expected bound, got ${liveBind.kind}`);
      manager.leaseStore.confirmReady(manager.poolId, liveBind.lease.pane_id);
      tmux.paneAlive.mockResolvedValue(true);

      await manager.reconcileLiveness();

      const rows = manager.leaseStore.list(manager.poolId);
      expect(rows.find((r) => r.pane_id === deadBind.lease.pane_id)?.state).toBe('free');
      expect(rows.find((r) => r.pane_id === liveBind.lease.pane_id)?.state).toBe('leased');
    });
  });

  describe('sweepHardIdle', () => {
    it('leased row idle past hard_idle_ms: paneLauncher.release called with pane_id + cfg.on_evict, then freed', async () => {
      const { manager, paneLauncher } = makeManager({
        panes: 1,
        on_evict: 'kill',
        lease: { idle_evict_ms: 1_800_000, hard_idle_ms: 5_000, park_timeout_ms: 300_000 },
      });
      await manager.ensureStarted();
      await manager.resolveRoute('conv-1', { contact_id: 'alice', channel: 'telegram' });
      const pane = manager.leaseStore.findByConversation(manager.poolId, 'conv-1')!;
      manager.leaseStore.touch(manager.poolId, pane.pane_id, new Date(Date.now() - 10_000));
      paneLauncher.release.mockClear();

      await manager.sweepHardIdle();

      expect(paneLauncher.release).toHaveBeenCalledWith(pane.pane_id, 'kill');
      const row = manager.leaseStore.list(manager.poolId).find((r) => r.pane_id === pane.pane_id);
      expect(row?.state).toBe('free');
      expect(row?.conversation_id).toBeNull();
    });

    it('leased row NOT yet past hard_idle_ms: untouched, release never called', async () => {
      const { manager, paneLauncher } = makeManager({
        panes: 1,
        lease: { idle_evict_ms: 1_800_000, hard_idle_ms: 3_600_000, park_timeout_ms: 300_000 },
      });
      await manager.ensureStarted();
      await manager.resolveRoute('conv-1', { contact_id: 'alice', channel: 'telegram' });
      paneLauncher.release.mockClear();

      await manager.sweepHardIdle();

      expect(paneLauncher.release).not.toHaveBeenCalled();
      const row = manager.leaseStore.findByConversation(manager.poolId, 'conv-1');
      expect(row?.state).toBe('leased');
    });

    it('a release() rejection for one idle row does not stop a second idle row from also being processed', async () => {
      const { manager, paneLauncher } = makeManager({
        panes: 2,
        lease: { idle_evict_ms: 1_800_000, hard_idle_ms: 5_000, park_timeout_ms: 300_000 },
      });
      await manager.ensureStarted();
      await manager.resolveRoute('conv-1', { contact_id: 'alice', channel: 'telegram' });
      await manager.resolveRoute('conv-2', { contact_id: 'bob', channel: 'telegram' });
      const pane1 = manager.leaseStore.findByConversation(manager.poolId, 'conv-1')!;
      const pane2 = manager.leaseStore.findByConversation(manager.poolId, 'conv-2')!;
      manager.leaseStore.touch(manager.poolId, pane1.pane_id, new Date(Date.now() - 10_000));
      manager.leaseStore.touch(manager.poolId, pane2.pane_id, new Date(Date.now() - 10_000));
      paneLauncher.release.mockClear();
      paneLauncher.release.mockRejectedValueOnce(new Error('tmux is on fire'));
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await manager.sweepHardIdle();

      expect(paneLauncher.release).toHaveBeenCalledTimes(2);
      const row1 = manager.leaseStore.list(manager.poolId).find((r) => r.pane_id === pane1.pane_id);
      const row2 = manager.leaseStore.list(manager.poolId).find((r) => r.pane_id === pane2.pane_id);
      expect(row1?.state).toBe('free');
      expect(row2?.state).toBe('free');
      expect(errSpy).toHaveBeenCalled();

      errSpy.mockRestore();
    });
  });

  describe('drainParked', () => {
    function makeManagerWithQueue(cfgOverrides: Partial<CcPoolInstanceConfig> = {}) {
      const db = makeDb();
      const cfg = makeCfg({ panes: 1, ...cfgOverrides });
      const paneLauncher = makeFakeLauncher();
      const fetchFn = makeFakeFetch();
      const queue = new MessageQueue(db);
      const manager = new PoolManager({
        cfg,
        db,
        busBaseUrl: 'http://127.0.0.1:3000',
        paneLauncher,
        queue,
        fetchFn: fetchFn as unknown as typeof fetch,
      });
      return { manager, paneLauncher, db, cfg, queue, fetchFn };
    }

    it('resolved: old parked copy acked, a fresh copy enqueued under the newly-resolved recipient', async () => {
      const { manager, queue } = makeManagerWithQueue();
      await manager.ensureStarted();
      await manager.resolveRoute('conv-A', { contact_id: 'alice', channel: 'telegram' }); // occupies the only pane

      const parkedId = queue.enqueue({ ...parkEnvelope('conv-B'), recipient: manager.parkedRecipientId() });

      // Simulate a pane becoming available (e.g. conv-A's conversation ended).
      const paneA = manager.leaseStore.findByConversation(manager.poolId, 'conv-A')!;
      manager.leaseStore.release(manager.poolId, paneA.pane_id);

      await manager.drainParked();

      expect(queue.dequeue(manager.parkedRecipientId(), undefined, 10)).toHaveLength(0);

      const paneB = manager.leaseStore.findByConversation(manager.poolId, 'conv-B');
      expect(paneB?.state).toBe('leased');
      const delivered = queue.dequeue(paneB!.agent_id, undefined, 10);
      expect(delivered).toHaveLength(1);
      expect(delivered[0]?.messageId).not.toBe(parkedId);
      expect(delivered[0]?.envelope.metadata['conversation_id']).toBe('conv-B');
      expect(delivered[0]?.envelope.payload).toEqual({ type: 'text', body: 'hello' });
    });

    it('still exhausted, within park_timeout_ms: re-enqueued onto the same parked bucket, pool_parked_since preserved across retries', async () => {
      const { manager, queue, db } = makeManagerWithQueue({
        lease: { idle_evict_ms: 1_800_000, hard_idle_ms: 21_600_000, park_timeout_ms: 300_000 },
      });
      await manager.ensureStarted();
      await manager.resolveRoute('conv-A', { contact_id: 'alice', channel: 'telegram' }); // occupies the only pane, never freed

      queue.enqueue({ ...parkEnvelope('conv-B'), recipient: manager.parkedRecipientId() });

      await manager.drainParked();
      const afterFirst = readPendingByRecipient(db, manager.parkedRecipientId());
      expect(afterFirst).toHaveLength(1);
      const stamp1 = afterFirst[0]!.metadata['pool_parked_since'];
      expect(typeof stamp1).toBe('string');

      await manager.drainParked();
      const afterSecond = readPendingByRecipient(db, manager.parkedRecipientId());
      expect(afterSecond).toHaveLength(1);
      // The regression test that matters most: the timeout clock starts
      // once, not on every retry.
      expect(afterSecond[0]!.metadata['pool_parked_since']).toBe(stamp1);
    });

    it('past park_timeout_ms: dead-lettered, and notifySystem fires exactly once per conversation across multiple timed-out messages', async () => {
      const { manager, queue, db, fetchFn } = makeManagerWithQueue({
        lease: { idle_evict_ms: 1_800_000, hard_idle_ms: 21_600_000, park_timeout_ms: 1_000 },
      });
      await manager.ensureStarted();
      await manager.resolveRoute('conv-A', { contact_id: 'alice', channel: 'telegram' }); // occupies the only pane

      const longAgo = new Date(Date.now() - 999_999_999).toISOString();
      const id1 = queue.enqueue({
        ...parkEnvelope('conv-B'),
        recipient: manager.parkedRecipientId(),
        metadata: { conversation_id: 'conv-B', pool_parked_since: longAgo },
      });
      const id2 = queue.enqueue({
        ...parkEnvelope('conv-B'),
        recipient: manager.parkedRecipientId(),
        metadata: { conversation_id: 'conv-B', pool_parked_since: longAgo },
      });

      await manager.drainParked();

      // deadLetter() deletes from message_queue and inserts into dead_letter
      // — queue.counts() (grouped by message_queue.status) can never show a
      // 'dead_letter' key, since a dead-lettered row no longer exists there.
      // The dead_letter table itself is the only correct place to assert this.
      const dl = db
        .prepare(`SELECT COUNT(*) as n FROM dead_letter WHERE original_message_id IN (?, ?)`)
        .get(id1, id2) as { n: number };
      expect(dl.n).toBe(2);
      expect(queue.dequeue(manager.parkedRecipientId(), undefined, 10)).toHaveLength(0);
      // fetchFn is shared with resolveRoute()'s cold-start placeholder POST
      // (the setup call above occupies the pool's only pane), so filter to
      // notifySystem's own endpoint rather than asserting total call count.
      const systemNoticeCalls = fetchFn.mock.calls.filter(([url]) =>
        String(url).endsWith('/api/v1/inbound'),
      );
      expect(systemNoticeCalls).toHaveLength(1);
    });

    it('no queue injected: logs and no-ops rather than throwing', async () => {
      const { manager } = makeManager({ panes: 1 });
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(manager.drainParked()).resolves.toBeUndefined();

      expect(errSpy).toHaveBeenCalled();
      errSpy.mockRestore();
    });
  });

  describe('parkedStatus', () => {
    /** Local to this describe block (the drainParked suite's own
     *  makeManagerWithQueue is scoped to that describe, not accessible here) —
     *  same construction pattern, trimmed to what these tests need. */
    function makeManagerWithQueue(cfgOverrides: Partial<CcPoolInstanceConfig> = {}) {
      const db = makeDb();
      const cfg = makeCfg({ panes: 1, ...cfgOverrides });
      const paneLauncher = makeFakeLauncher();
      const queue = new MessageQueue(db);
      const manager = new PoolManager({ cfg, db, busBaseUrl: 'http://127.0.0.1:3000', paneLauncher, queue });
      return { manager, queue };
    }

    it('nothing parked: count 0, oldestParkedAt null', () => {
      const { manager } = makeManager({ panes: 1 });
      expect(manager.parkedStatus()).toEqual({ count: 0, oldestParkedAt: null });
    });

    it('reports count and the oldest created_at among parked rows, read-only (no dequeue side effect)', () => {
      const { manager, queue } = makeManagerWithQueue();
      queue.enqueue({ ...parkEnvelope('conv-A'), recipient: manager.parkedRecipientId() });
      queue.enqueue({ ...parkEnvelope('conv-B'), recipient: manager.parkedRecipientId() });

      const status = manager.parkedStatus();

      expect(status.count).toBe(2);
      expect(typeof status.oldestParkedAt).toBe('string');
      // Read-only: both rows are still pending and dequeue-able afterward —
      // parkedStatus() must not have flipped them to 'processing'.
      expect(queue.dequeue(manager.parkedRecipientId(), undefined, 10)).toHaveLength(2);
    });

    it('only counts this pool\'s own parked bucket, not another pool\'s', () => {
      const { manager, queue } = makeManagerWithQueue({ agent_id: 'poolone' });
      queue.enqueue({ ...parkEnvelope('conv-A'), recipient: 'agent:pooltwo__parked' });

      expect(manager.parkedStatus()).toEqual({ count: 0, oldestParkedAt: null });
    });
  });

  describe('start/stop', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('start() runs reconcileLiveness() once up front, then schedules recurring reconcileLiveness()+sweepHardIdle()+drainParked() ticks; stop() halts them', async () => {
      vi.useFakeTimers();
      const db = makeDb();
      const cfg = makeCfg({ panes: 1 });
      const paneLauncher = makeFakeLauncher();
      const manager = new PoolManager({
        cfg,
        db,
        busBaseUrl: 'http://127.0.0.1:3000',
        paneLauncher,
        sweepIntervalMs: 1_000,
      });
      const reconcileSpy = vi.spyOn(manager, 'reconcileLiveness').mockResolvedValue();
      const sweepSpy = vi.spyOn(manager, 'sweepHardIdle').mockResolvedValue();
      const drainSpy = vi.spyOn(manager, 'drainParked').mockResolvedValue();

      manager.start();
      await vi.advanceTimersByTimeAsync(0);
      // The up-front call from start() itself, before any tick has fired.
      expect(reconcileSpy).toHaveBeenCalledTimes(1);
      expect(sweepSpy).not.toHaveBeenCalled();
      expect(drainSpy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_000);
      // Every recurring tick re-checks liveness too (see reconcileLiveness()'s
      // own doc comment) — a crash between ticks must not go unnoticed until
      // the next full bus-core restart. So this is 2 (the up-front call plus
      // this tick's), not still 1.
      expect(reconcileSpy).toHaveBeenCalledTimes(2);
      expect(sweepSpy).toHaveBeenCalledTimes(1);
      expect(drainSpy).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(reconcileSpy).toHaveBeenCalledTimes(3);
      expect(sweepSpy).toHaveBeenCalledTimes(2);
      expect(drainSpy).toHaveBeenCalledTimes(2);

      manager.stop();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(reconcileSpy).toHaveBeenCalledTimes(3);
      expect(sweepSpy).toHaveBeenCalledTimes(2);
      expect(drainSpy).toHaveBeenCalledTimes(2);
    });

    it('a reconcileLiveness() rejection on one tick does not prevent that same tick\'s sweepHardIdle()/drainParked() from running', async () => {
      vi.useFakeTimers();
      const db = makeDb();
      const cfg = makeCfg({ panes: 1 });
      const paneLauncher = makeFakeLauncher();
      const manager = new PoolManager({
        cfg,
        db,
        busBaseUrl: 'http://127.0.0.1:3000',
        paneLauncher,
        sweepIntervalMs: 1_000,
      });
      vi.spyOn(manager, 'reconcileLiveness').mockRejectedValue(new Error('boom'));
      const sweepSpy = vi.spyOn(manager, 'sweepHardIdle').mockResolvedValue();
      const drainSpy = vi.spyOn(manager, 'drainParked').mockResolvedValue();
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      manager.start();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(sweepSpy).toHaveBeenCalledTimes(1);
      expect(drainSpy).toHaveBeenCalledTimes(1);

      manager.stop();
      errSpy.mockRestore();
    });

    it('calling start() twice does not create two overlapping intervals', async () => {
      vi.useFakeTimers();
      const db = makeDb();
      const cfg = makeCfg({ panes: 1 });
      const paneLauncher = makeFakeLauncher();
      const manager = new PoolManager({
        cfg,
        db,
        busBaseUrl: 'http://127.0.0.1:3000',
        paneLauncher,
        sweepIntervalMs: 1_000,
      });
      vi.spyOn(manager, 'reconcileLiveness').mockResolvedValue();
      const sweepSpy = vi.spyOn(manager, 'sweepHardIdle').mockResolvedValue();
      const drainSpy = vi.spyOn(manager, 'drainParked').mockResolvedValue();

      manager.start();
      manager.start(); // second call must be a no-op

      await vi.advanceTimersByTimeAsync(1_000);
      // Two overlapping intervals would make these 2 instead of 1.
      expect(sweepSpy).toHaveBeenCalledTimes(1);
      expect(drainSpy).toHaveBeenCalledTimes(1);

      manager.stop();
    });
  });
});

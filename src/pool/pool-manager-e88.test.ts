/**
 * E88 — PoolManager: orphaned pool tmux server detection (S88.4) and
 * "a leased pane counts as dead unless claude is really running and
 * polling" (S88.5).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';
import { PoolManager } from './pool-manager.js';
import type { LaunchParams } from './pane.js';
import type { CcPoolInstanceConfig } from '../config/schema.js';
import type { ProcessInfo } from './orphan-detector.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

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
    launch_ack_pattern: 'loading development channels',
    pane_env: {},
    ...overrides,
  };
}

function makeFakeTmux(serverPid?: () => Promise<number | null>) {
  return {
    ensureSession: vi.fn(async (_s: string, _c: string) => {}),
    listWindows: vi.fn(async (_s: string) => []),
    createWindow: vi.fn(async (s: string, n: string, _c: string, _e?: Record<string, string>) => `${s}:${n}`),
    killWindow: vi.fn(async (_t: string) => {}),
    sendKeys: vi.fn(async (_t: string, _k: string) => {}),
    sendCommand: vi.fn(async (_t: string, _l: string) => {}),
    paneAlive: vi.fn(async (_t: string) => true),
    paneCommand: vi.fn(async (_t: string) => null as string | null),
    capturePane: vi.fn(async (_t: string, _l?: number) => ''),
    ...(serverPid ? { serverPid: vi.fn(serverPid) } : {}),
  };
}

function fakeFetch() {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({ ok: true }) as unknown as Response);
}

/** Bodies of the `channel: 'system'` notices a manager posted. */
function notices(fetchFn: ReturnType<typeof fakeFetch>): string[] {
  return fetchFn.mock.calls
    .filter((c) => String(c[0]).endsWith('/api/v1/inbound'))
    .map((c) => (JSON.parse(String(c[1]!.body)) as { payload: { body: string } }).payload.body);
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

// ── S88.4 ───────────────────────────────────────────────────────────────────

describe('S88.4 — orphaned pool tmux server detection', () => {
  /** The Oct 31 picture: live server 92327, orphan 2088 holding hidden claude sessions. */
  const processes: ProcessInfo[] = [
    { pid: 92327, ppid: 1, command: 'tmux new-session -d -s peggy-pool -c /work/dir TERM=xterm' },
    { pid: 2088, ppid: 1, command: 'tmux new-session -d -s peggy-pool -c /work/dir' },
    // orphan's pane: zsh -> claude -> npx -> node cc.js (all of the MCP chain carries the id)
    { pid: 3000, ppid: 2088, command: '-zsh' },
    { pid: 3001, ppid: 3000, command: 'claude --resume x' },
    { pid: 3002, ppid: 3001, command: 'npm exec tsx src/adapters/cc.js AGENTBUS_AGENT_ID=peggy-pool-2 AGENTBUS_CONFIG=/c.yaml' },
    { pid: 3003, ppid: 3002, command: 'node tsx src/adapters/cc.js AGENTBUS_AGENT_ID=peggy-pool-2' },
    // a live pane under the reachable server: never an orphan
    { pid: 4000, ppid: 92327, command: '-zsh' },
    { pid: 4001, ppid: 4000, command: 'claude' },
    { pid: 4002, ppid: 4001, command: 'npm exec tsx cc.js AGENTBUS_AGENT_ID=peggy-pool-1' },
    // another pool's agent and server: not this pool's business
    { pid: 5000, ppid: 1, command: 'tmux new-session -d -s pokeclaude-pool' },
    { pid: 5001, ppid: 1, command: 'node cc.js AGENTBUS_AGENT_ID=pokeclaude-pool-1' },
    // a session name that only starts with ours
    { pid: 6000, ppid: 1, command: 'tmux new-session -d -s peggy-pool-old' },
  ];

  function makeOrphanManager(cfg: Partial<CcPoolInstanceConfig> = {}, procs: ProcessInfo[] = processes) {
    const fetchFn = fakeFetch();
    const killProcess = vi.fn((_pid: number, _sig: NodeJS.Signals) => {});
    const listProcesses = vi.fn(async () => procs);
    const tmux = makeFakeTmux(async () => 92327);
    const manager = new PoolManager({
      cfg: makeCfg(cfg), db: makeDb(), busBaseUrl: 'http://bus', tmux,
      paneLauncher: { launch: vi.fn(async (_p: LaunchParams) => {}), release: vi.fn(async () => {}) },
      fetchFn: fetchFn as unknown as typeof fetch, listProcesses, killProcess, transcriptExists: () => true,
    });
    return { manager, fetchFn, killProcess, listProcesses, tmux };
  }

  it('logs "orphan tmux server pid=<n>" for the extra server, names the agents it holds, and sends one notice', async () => {
    const { manager, fetchFn, killProcess } = makeOrphanManager();
    const warn = vi.mocked(console.warn);

    const scan = await manager.orphanDetector!.check();

    expect(scan!.servers.map((s) => s.pid)).toEqual([2088]);
    expect(scan!.servers[0]!.agentIds).toEqual(['peggy-pool-2']);
    expect(scan!.agents).toEqual([]);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('orphan tmux server pid=2088'))).toBe(true);
    const sent = notices(fetchFn);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('orphan tmux server pid=2088');
    expect(sent[0]).toContain('peggy-pool-2');
    expect(killProcess).not.toHaveBeenCalled(); // kill_orphan_servers defaults to false
  });

  it('notifies once per pid across ticks', async () => {
    const { manager, fetchFn } = makeOrphanManager();
    await manager.orphanDetector!.check();
    await manager.orphanDetector!.check();
    expect(notices(fetchFn)).toHaveLength(1);
  });

  it('runs at start() and on each sweep tick', async () => {
    vi.useFakeTimers();
    try {
      const { manager, listProcesses } = makeOrphanManager();
      manager.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(listProcesses).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(listProcesses).toHaveBeenCalledTimes(2);
      manager.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a stray pool-agent process outside any tmux server is reported too', async () => {
    const { manager, fetchFn } = makeOrphanManager({}, [
      { pid: 92327, ppid: 1, command: 'tmux new-session -d -s peggy-pool' },
      { pid: 7000, ppid: 1, command: 'node cc.js AGENTBUS_AGENT_ID=peggy-pool-3' },
    ]);
    const scan = await manager.orphanDetector!.check();
    expect(scan!.servers).toEqual([]);
    expect(scan!.agents.map((a) => [a.pid, a.agentId])).toEqual([[7000, 'peggy-pool-3']]);
    expect(notices(fetchFn)[0]).toContain('orphan pool agent pid=7000 polling as peggy-pool-3');
  });

  it('with no reachable server (socket lost), every matching server is an orphan', async () => {
    const fetchFn = fakeFetch();
    const manager = new PoolManager({
      cfg: makeCfg(), db: makeDb(), busBaseUrl: 'http://bus', tmux: makeFakeTmux(async () => null),
      paneLauncher: { launch: vi.fn(async () => {}), release: vi.fn(async () => {}) },
      fetchFn: fetchFn as unknown as typeof fetch, listProcesses: async () => processes.slice(0, 2),
    });
    const scan = await manager.orphanDetector!.check();
    expect(scan!.servers.map((s) => s.pid).sort()).toEqual([2088, 92327]);
  });

  it('kill_orphan_servers: true sends SIGTERM to each orphan (and never to the live server)', async () => {
    const { manager, killProcess, fetchFn } = makeOrphanManager({ kill_orphan_servers: true });
    await manager.orphanDetector!.check();
    expect(killProcess.mock.calls).toEqual([[2088, 'SIGTERM']]);
    expect(notices(fetchFn)[0]).toContain('sent SIGTERM to 2088');
  });

  it('is off when the tmux controller cannot report its server pid (test fakes), or when disabled', () => {
    const base = { cfg: makeCfg(), db: makeDb(), busBaseUrl: 'http://bus', paneLauncher: { launch: vi.fn(async () => {}), release: vi.fn(async () => {}) } };
    expect(new PoolManager({ ...base, tmux: makeFakeTmux() }).orphanDetector).toBeNull();
    expect(new PoolManager({ ...base, tmux: makeFakeTmux(async () => 1), orphanDetector: null }).orphanDetector).toBeNull();
  });

  it('a failing process listing is logged, never thrown', async () => {
    const fetchFn = fakeFetch();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const manager = new PoolManager({
      cfg: makeCfg(), db: makeDb(), busBaseUrl: 'http://bus', tmux: makeFakeTmux(async () => 1),
      paneLauncher: { launch: vi.fn(async () => {}), release: vi.fn(async () => {}) },
      fetchFn: fetchFn as unknown as typeof fetch, listProcesses: async () => { throw new Error('ps failed'); },
    });
    await expect(manager.orphanDetector!.check()).resolves.toBeNull();
    expect(err).toHaveBeenCalled();
    expect(notices(fetchFn)).toEqual([]);
  });
});

// ── S88.5 ───────────────────────────────────────────────────────────────────

describe('S88.5 — a leased pane is dead unless claude is running and polling', () => {
  const DEV_CHANNELS_SCREEN = 'WARNING: Loading development channels\n\n❯ 1. I am using this for local development\n  2. Exit';

  function setup(opts: {
    command: string | null;
    screen?: string;
    /** The bus's last poll for the pane, given the current clock (ms). */
    lastPoll?: (nowMs: number) => { lastPollAt: string; lastLaunchId: string | null } | null;
    registered?: string | null;
    startedAgoMs?: number;
  }) {
    const db = makeDb();
    const fetchFn = fakeFetch();
    const tmux = makeFakeTmux();
    tmux.paneAlive.mockResolvedValue(true);
    tmux.paneCommand.mockResolvedValue(opts.command);
    tmux.capturePane.mockResolvedValue(opts.screen ?? '');
    let now = 1_000_000;
    const launch = vi.fn(async (_p: LaunchParams) => {});
    const manager = new PoolManager({
      cfg: makeCfg(), db, busBaseUrl: 'http://bus', tmux,
      paneLauncher: { launch, release: vi.fn(async () => {}) },
      fetchFn: fetchFn as unknown as typeof fetch, transcriptExists: () => true,
      lastPoll: () => (opts.lastPoll ? opts.lastPoll(now) : null),
      registeredLaunch: () => opts.registered ?? null,
      nowMs: () => now,
    });
    now += opts.startedAgoMs ?? 10 * 60_000;
    return { manager, tmux, fetchFn, launch };
  }

  async function leasePane(manager: PoolManager, conversationId = 'conv-1') {
    await manager.ensureStarted();
    const bound = manager.leaseStore.acquire(manager.poolId, conversationId, {
      poolAgentId: 'peggy', panes: 2, maxPanes: 2, growth: 'fixed', idleEvictMs: 1_800_000,
    });
    if (bound.kind !== 'bound') throw new Error(`expected bound, got ${bound.kind}`);
    manager.leaseStore.confirmReady(manager.poolId, bound.lease.pane_id);
    return bound.lease;
  }

  it('paneAlive=true but the foreground is "zsh" → released, with a notice', async () => {
    const { manager, fetchFn, tmux } = setup({ command: 'zsh', screen: 'Error: Invalid MCP configuration: MCP config file not found\n% ' });
    const lease = await leasePane(manager);

    await manager.reconcileLiveness();

    const row = manager.leaseStore.findByPane(manager.poolId, lease.pane_id);
    expect(row?.state).toBe('free');
    expect(row?.conversation_id).toBeNull();
    const sent = notices(fetchFn);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('bare "zsh" prompt');
    expect(sent[0]).toContain('MCP config file not found');
    expect(tmux.killWindow).not.toHaveBeenCalled(); // the shell is reused by the next launch
  });

  it('foreground is claude and it polls fresh (own launch) → adopted untouched', async () => {
    const { manager, fetchFn } = setup({ command: 'claude', registered: 'L1', lastPoll: (n) => ({ lastPollAt: new Date(n - 1000).toISOString(), lastLaunchId: 'L1' }) });
    const lease = await leasePane(manager);

    await manager.reconcileLiveness();

    expect(manager.leaseStore.findByPane(manager.poolId, lease.pane_id)?.state).toBe('leased');
    expect(notices(fetchFn)).toEqual([]);
  });

  it('foreground claude stuck on the dev-channels screen with a stale poll → released and its window killed', async () => {
    const { manager, fetchFn, tmux } = setup({ command: 'claude', screen: DEV_CHANNELS_SCREEN, lastPoll: (n) => ({ lastPollAt: new Date(n - 5 * 60_000).toISOString(), lastLaunchId: null }) });
    const lease = await leasePane(manager);

    await manager.reconcileLiveness();

    expect(manager.leaseStore.findByPane(manager.poolId, lease.pane_id)?.state).toBe('free');
    expect(tmux.killWindow).toHaveBeenCalledWith(lease.pane_id);
    expect(notices(fetchFn)[0]).toContain('stuck at the "loading development channels" prompt');
  });

  it('stuck on the dev-channels screen and never polled, once the bus has been up past the threshold → released', async () => {
    const { manager, fetchFn } = setup({ command: 'claude', screen: DEV_CHANNELS_SCREEN, lastPoll: () => null });
    const lease = await leasePane(manager);
    await manager.reconcileLiveness();
    expect(manager.leaseStore.findByPane(manager.poolId, lease.pane_id)?.state).toBe('free');
    expect(notices(fetchFn)[0]).toContain('no poll from its current launch');
  });

  it('right after a bus restart (no poll seen yet) a pane is not judged stale', async () => {
    const { manager, fetchFn } = setup({ command: 'claude', screen: DEV_CHANNELS_SCREEN, lastPoll: () => null, startedAgoMs: 1000 });
    const lease = await leasePane(manager);
    await manager.reconcileLiveness();
    expect(manager.leaseStore.findByPane(manager.poolId, lease.pane_id)?.state).toBe('leased');
    expect(notices(fetchFn)).toEqual([]);
  });

  it('a fresh poll from a different launch than the registered one does not count', async () => {
    const { manager } = setup({ command: 'claude', screen: DEV_CHANNELS_SCREEN, registered: 'L-current', lastPoll: (n) => ({ lastPollAt: new Date(n).toISOString(), lastLaunchId: 'L-orphan' }) });
    const lease = await leasePane(manager);
    await manager.reconcileLiveness();
    expect(manager.leaseStore.findByPane(manager.poolId, lease.pane_id)?.state).toBe('free');
  });

  it('a stale poll without a blocking prompt (e.g. a permission dialog) is left alone', async () => {
    const { manager, fetchFn } = setup({ command: 'claude', screen: 'Allow Bash? Esc to cancel', lastPoll: (n) => ({ lastPollAt: new Date(n - 5 * 60_000).toISOString(), lastLaunchId: null }) });
    const lease = await leasePane(manager);
    await manager.reconcileLiveness();
    expect(manager.leaseStore.findByPane(manager.poolId, lease.pane_id)?.state).toBe('leased');
    expect(notices(fetchFn)).toEqual([]);
  });

  it('reuse path: a message for a pane at a shell prompt releases it and relaunches the conversation', async () => {
    const { manager, fetchFn, launch, tmux } = setup({ command: 'zsh' });
    const lease = await leasePane(manager);
    // After the release the relaunch goes through paneLauncher.launch(); the pane then runs claude.
    launch.mockImplementation(async () => {
      tmux.paneCommand.mockResolvedValue('claude');
    });

    const recipient = await manager.resolveRoute('conv-1', { contact_id: 'alice', channel: 'telegram', background: true });

    expect(launch).toHaveBeenCalledTimes(1);
    const row = manager.leaseStore.findByConversation(manager.poolId, 'conv-1');
    expect(row?.state).toBe('leased');
    expect(recipient).toBe(row!.agent_id);
    expect(launch.mock.calls[0]![0].paneId).toBe(lease.pane_id);
    await new Promise((r) => setTimeout(r, 0));
    expect(notices(fetchFn).some((b) => b.includes('found dead when a new message arrived'))).toBe(true);
  });

  it('reuse path: a pane running claude is reused without a launch', async () => {
    const { manager, launch } = setup({ command: 'claude' });
    const lease = await leasePane(manager);
    const recipient = await manager.resolveRoute('conv-1', { contact_id: 'alice', channel: 'telegram' });
    expect(recipient).toBe(lease.agent_id);
    expect(launch).not.toHaveBeenCalled();
  });
});

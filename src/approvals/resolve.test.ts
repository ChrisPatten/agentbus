import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';
import { PoolManager } from '../pool/pool-manager.js';
import type { CcPoolInstanceConfig } from '../config/schema.js';
import { ApprovalStore } from './store.js';
import { resolveApproval } from './resolve.js';

const DIALOG = 'Do you want to overwrite?\n ❯ 1. Yes\n   2. No\nEsc to cancel · Tab to amend';

function makeCfg(): CcPoolInstanceConfig {
  return {
    name: null,
    agent_id: 'peggy',
    tmux_session: 'peggy-pool',
    panes: 1,
    growth: 'fixed',
    max_panes: 1,
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
  };
}

/** A pool with one pane leased to conv-a, a fake tmux showing `screen`, and one pending request against it. */
function setup(screen: string = DIALOG) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);

  const tmux = {
    ensureSession: vi.fn(async () => {}),
    listWindows: vi.fn(async () => []),
    createWindow: vi.fn(async () => ''),
    killWindow: vi.fn(async () => {}),
    sendKeys: vi.fn(async (_target: string, _keys: string) => {}),
    sendCommand: vi.fn(async () => {}),
    paneAlive: vi.fn(async () => true),
    paneCommand: vi.fn(async () => null as string | null),
    capturePane: vi.fn(async () => screen),
  };
  const manager = new PoolManager({
    cfg: makeCfg(),
    db,
    busBaseUrl: 'http://127.0.0.1:3000',
    paneLauncher: { launch: async () => {}, release: async () => {} },
    tmux,
  });
  manager.leaseStore.seedPanes('peggy', [{ paneId: 'peggy-pool:1', agentId: 'agent:peggy-pool-1' }]);
  const acquired = manager.leaseStore.acquire('peggy', 'conv-a', {
    poolAgentId: 'peggy',
    panes: 1,
    maxPanes: 1,
    growth: 'fixed',
    idleEvictMs: 1_800_000,
  });
  if (acquired.kind !== 'bound') throw new Error('test setup: expected "bound"');
  manager.leaseStore.confirmReady('peggy', acquired.lease.pane_id);

  const store = new ApprovalStore(db);
  const request = store.insert(
    {
      adapterId: 'cc-pool',
      agentId: 'peggy-pool-1',
      conversationId: 'conv-a',
      contactId: 'chris',
      toolName: 'Edit',
      summary: 'memory/daily.md',
    },
    900_000,
  );
  const deps = { store, poolManagers: new Map([['agent:peggy', manager]]) };
  return { db, tmux, manager, store, request, deps };
}

describe('resolveApproval', () => {
  it('approve sends Enter to the leased pane and marks the row approved', async () => {
    const { deps, tmux, store, request } = setup();

    const result = await resolveApproval(deps, request.id, 'approve', 'contact:chris');

    expect(result.outcome).toBe('approved');
    expect(tmux.sendKeys).toHaveBeenCalledExactlyOnceWith('peggy-pool:1', 'Enter');
    const row = store.getById(request.id)!;
    expect(row.status).toBe('approved');
    expect(row.resolved_by).toBe('contact:chris');
    expect(JSON.parse(row.raw_context!)).toMatchObject({ keys_sent: 'Enter' });
  });

  it('deny sends Escape and marks the row denied', async () => {
    const { deps, tmux, store, request } = setup();

    const result = await resolveApproval(deps, request.id, 'deny', 'contact:chris');

    expect(result.outcome).toBe('denied');
    expect(tmux.sendKeys).toHaveBeenCalledExactlyOnceWith('peggy-pool:1', 'Escape');
    expect(store.getById(request.id)!.status).toBe('denied');
  });

  it('sends no keystroke and marks the row stale when the pane is not showing a permission dialog', async () => {
    const { deps, tmux, store, request } = setup('❯ \nsome ordinary prompt');

    const result = await resolveApproval(deps, request.id, 'deny', 'contact:chris');

    expect(result.outcome).toBe('stale');
    expect(tmux.sendKeys).not.toHaveBeenCalled();
    const row = store.getById(request.id)!;
    expect(row.status).toBe('stale');
    expect(JSON.parse(row.raw_context!).stale_reason).toMatch(/no permission dialog/);
  });

  it('marks the row stale, sending nothing, when the pane now serves a different conversation', async () => {
    const { deps, tmux, manager, store, request } = setup();
    manager.leaseStore.release('peggy', 'peggy-pool:1');
    manager.leaseStore.acquire('peggy', 'conv-b', {
      poolAgentId: 'peggy',
      panes: 1,
      maxPanes: 1,
      growth: 'fixed',
      idleEvictMs: 1_800_000,
    });
    manager.leaseStore.confirmReady('peggy', 'peggy-pool:1');

    const result = await resolveApproval(deps, request.id, 'approve', 'contact:chris');

    expect(result.outcome).toBe('stale');
    expect(tmux.sendKeys).not.toHaveBeenCalled();
    expect(store.getById(request.id)!.status).toBe('stale');
  });

  it('is a no-op on an already-resolved request', async () => {
    const { deps, tmux, store, request } = setup();
    store.resolve(request.id, 'approved', 'contact:chris');

    const result = await resolveApproval(deps, request.id, 'deny', 'contact:chris');

    expect(result.outcome).toBe('already_resolved');
    expect(tmux.sendKeys).not.toHaveBeenCalled();
    expect(store.getById(request.id)!.status).toBe('approved');
  });

  it('expires, rather than answers, a request past expires_at that the sweep has not reached yet', async () => {
    const { deps, tmux, store, request } = setup();
    const later = new Date(new Date(request.expires_at).getTime() + 1000);

    const result = await resolveApproval(deps, request.id, 'approve', 'contact:chris', later);

    expect(result.outcome).toBe('expired');
    expect(tmux.sendKeys).not.toHaveBeenCalled();
    expect(store.getById(request.id)!.status).toBe('expired');
  });

  it('refuses a contact the request is not addressed to, leaving it pending', async () => {
    const { deps, tmux, store, request } = setup();

    const result = await resolveApproval(deps, request.id, 'approve', 'contact:mallory', undefined, 'mallory');

    expect(result.outcome).toBe('forbidden');
    expect(tmux.sendKeys).not.toHaveBeenCalled();
    expect(store.getById(request.id)!.status).toBe('pending');
  });

  it('accepts the addressed contact whether stored bare or prefixed', async () => {
    const { deps, request } = setup();

    const result = await resolveApproval(deps, request.id, 'approve', 'contact:chris', undefined, 'contact:chris');

    expect(result.outcome).toBe('approved');
  });

  it('sends the keystroke only once when two answers race', async () => {
    const { deps, tmux, request } = setup();

    const [a, b] = await Promise.all([
      resolveApproval(deps, request.id, 'approve', 'contact:chris'),
      resolveApproval(deps, request.id, 'approve', 'contact:chris'),
    ]);

    expect([a.outcome, b.outcome].sort()).toEqual(['already_resolved', 'approved']);
    expect(tmux.sendKeys).toHaveBeenCalledTimes(1);
  });

  it('returns not_found for an unknown id', async () => {
    const { deps } = setup();
    expect((await resolveApproval(deps, 'nope', 'approve', 'x')).outcome).toBe('not_found');
  });

  it('marks the row stale when no configured pool owns the agent', async () => {
    const { deps, request, store } = setup();

    const result = await resolveApproval({ ...deps, poolManagers: new Map() }, request.id, 'approve', 'x');

    expect(result.outcome).toBe('stale');
    expect(store.getById(request.id)!.status).toBe('stale');
  });
});

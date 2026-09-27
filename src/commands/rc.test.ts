import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';
import { createRcCommand } from './rc.js';
import { PoolManager } from '../pool/pool-manager.js';
import { computeConversationId } from '../pipeline/conversation-id.js';
import type { CcPoolInstanceConfig } from '../config/schema.js';
import type { SlashCommandContext } from './registry.js';
import type { TmuxExec } from '../pool/tmux.js';
import { createSafeDatabase } from '../db/safe-database.js';

function makeCfg(): CcPoolInstanceConfig {
  return {
    name: null, agent_id: 'peggy', tmux_session: 'custom-session', panes: 3, growth: 'fixed', max_panes: 3,
    claude_bin: '/usr/local/bin/claude', model: undefined, working_dir: '/work/dir', launch_args: [],
    poll_interval_ms: 1000, system_prompt: undefined,
    lease: { idle_evict_ms: 1_800_000, hard_idle_ms: 21_600_000, park_timeout_ms: 300_000 },
    on_evict: 'clear', launch_ack_delay_ms: 500, launch_ack_max_attempts: 3, launch_ack_pattern: 'experimental', pane_env: {},
  };
}

function setup(opts: { bind?: boolean; failExec?: boolean } = {}) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const manager = new PoolManager({
    cfg: makeCfg(), db, busBaseUrl: 'http://127.0.0.1:3000',
    paneLauncher: { launch: async () => {}, release: async () => {} },
  });
  manager.leaseStore.seedPanes('peggy', [
    { paneId: 'custom-session:1', agentId: 'agent:peggy-pool-1' },
    { paneId: 'custom-session:2', agentId: 'agent:peggy-pool-2' },
  ]);
  let bound: string | null = null;
  if (opts.bind !== false) {
    const a = manager.leaseStore.acquire('peggy', computeConversationId('chris', 'telegram', 'general'), {
      poolAgentId: 'peggy', panes: 2, maxPanes: 2, growth: 'fixed', idleEvictMs: 1_800_000,
    });
    if (a.kind !== 'bound') throw new Error('setup');
    manager.leaseStore.confirmReady('peggy', a.lease.pane_id);
    bound = a.lease.pane_id;
  }
  const exec = vi.fn(async () => {
    if (opts.failExec) throw new Error("tmux send-keys failed: can't find window: x");
    return '';
  }) as unknown as TmuxExec & ReturnType<typeof vi.fn>;
  const cmd = createRcCommand({ poolManagers: new Map([['agent:peggy', manager]]), tmuxExec: exec });
  const ctx = {
    channel: 'telegram', sender: 'contact:chris', adapterId: 'telegram', argsRaw: '',
    envelope: { id: 'x', timestamp: '', channel: 'telegram', topic: 'general', sender: 'contact:chris', recipient: 'agent:claude', reply_to: null, priority: 'normal', payload: { type: 'text', body: '/rc' }, metadata: {} },
    db: createSafeDatabase(db), config: {},
  } as unknown as SlashCommandContext;
  return { cmd, ctx, exec, manager, bound };
}

describe('/rc', () => {
  it('types /remote-control and Enter into the pane leased to the caller', async () => {
    const { cmd, ctx, exec, bound } = setup();
    const result = await cmd.handler([], ctx);
    expect(exec.mock.calls.map((c) => c[0])).toEqual([
      ['send-keys', '-t', bound, '-l', '--', '/remote-control'],
      ['send-keys', '-t', bound, 'Enter'],
    ]);
    expect(result.body).toBe(`Sent /remote-control to ${bound}.`);
  });

  it('with no lease and no arg, sends nothing and says so', async () => {
    const { cmd, ctx, exec } = setup({ bind: false });
    const result = await cmd.handler([], ctx);
    expect(exec).not.toHaveBeenCalled();
    expect(result.body).toContain('No pane is leased to this conversation');
  });

  it('/rc <n> targets that pane, including a free one', async () => {
    const { cmd, ctx, exec } = setup({ bind: false });
    const result = await cmd.handler(['2'], ctx);
    expect(exec.mock.calls[0]![0]).toEqual(['send-keys', '-t', 'custom-session:2', '-l', '--', '/remote-control']);
    expect(result.body).toBe('Sent /remote-control to custom-session:2.');
  });

  it('refuses a pane that is not bound or free', async () => {
    const { cmd, ctx, exec, manager } = setup({ bind: false });
    manager.leaseStore.markDead('peggy', 'custom-session:2');
    const result = await cmd.handler(['2'], ctx);
    expect(exec).not.toHaveBeenCalled();
    expect(result.body).toBe('custom-session:2 is dead; not sending keys.');
  });

  it('rejects an unknown index and a bad argument', async () => {
    const { cmd, ctx, exec } = setup();
    expect((await cmd.handler(['9'], ctx)).body).toBe('No pane with index 9. Try /pool to list panes.');
    expect((await cmd.handler(['x'], ctx)).body).toBe('Usage: /rc [n]');
    expect(exec).not.toHaveBeenCalled();
  });

  it('turns a tmux failure into a short error', async () => {
    const { cmd, ctx } = setup({ failExec: true });
    const result = await cmd.handler([], ctx);
    expect(result.body).toContain('could not send keys');
  });

  it('reports no instances configured when there are no pools', async () => {
    const { ctx } = setup();
    const cmd = createRcCommand({ poolManagers: new Map() });
    expect((await cmd.handler([], ctx)).body).toBe('No cc-pool instances configured.');
  });
});

import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';
import { createKeysCommand, parseKeys, MAX_KEYS } from './keys.js';
import { PoolManager } from '../pool/pool-manager.js';
import { computeConversationId } from '../pipeline/conversation-id.js';
import type { CcPoolInstanceConfig } from '../config/schema.js';
import type { SlashCommandContext } from './registry.js';
import type { TmuxExec } from '../pool/tmux.js';
import { createSafeDatabase } from '../db/safe-database.js';

function makeCfg(): CcPoolInstanceConfig {
  return {
    name: null, agent_id: 'peggy', tmux_session: 'peggy-pool', panes: 2, growth: 'fixed', max_panes: 2,
    claude_bin: '/usr/local/bin/claude', model: undefined, working_dir: '/work/dir', launch_args: [],
    poll_interval_ms: 1000, system_prompt: undefined,
    lease: { idle_evict_ms: 1_800_000, hard_idle_ms: 21_600_000, park_timeout_ms: 300_000 },
    on_evict: 'clear', launch_ack_delay_ms: 500, launch_ack_max_attempts: 3, launch_ack_pattern: 'experimental', pane_env: {},
  };
}

function setup(opts: { bind?: boolean; confirm?: boolean; failExec?: boolean; noPools?: boolean } = {}) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const manager = new PoolManager({
    cfg: makeCfg(), db, busBaseUrl: 'http://127.0.0.1:3000',
    paneLauncher: { launch: async () => {}, release: async () => {} },
  });
  manager.leaseStore.seedPanes('peggy', [
    { paneId: 'peggy-pool:1', agentId: 'agent:peggy-pool-1' },
    { paneId: 'peggy-pool:2', agentId: 'agent:peggy-pool-2' },
  ]);
  let bound: string | null = null;
  if (opts.bind !== false) {
    const a = manager.leaseStore.acquire('peggy', computeConversationId('chris', 'telegram', 'general'), {
      poolAgentId: 'peggy', panes: 2, maxPanes: 2, growth: 'fixed', idleEvictMs: 1_800_000,
    });
    if (a.kind !== 'bound') throw new Error('setup');
    if (opts.confirm !== false) manager.leaseStore.confirmReady('peggy', a.lease.pane_id);
    bound = a.lease.pane_id;
  }
  const exec = vi.fn(async () => {
    if (opts.failExec) throw new Error("can't find window: x");
    return '';
  }) as unknown as TmuxExec & ReturnType<typeof vi.fn>;
  const execRaw = vi.fn(async (args: string[]) => (args[0] === 'list-panes' ? '20\t3\n' : 'screen\n\n\n')) as unknown as TmuxExec;
  const cmd = createKeysCommand({
    poolManagers: opts.noPools ? new Map() : new Map([['agent:peggy', manager]]),
    tmuxExec: exec, tmuxExecRaw: execRaw, sleep: async () => {},
  });
  const run = (argsRaw: string) =>
    cmd.handler(argsRaw.split(/\s+/).filter(Boolean), {
      channel: 'telegram', sender: 'contact:chris', adapterId: 'telegram', argsRaw,
      envelope: { id: 'x', timestamp: '', channel: 'telegram', topic: 'general', sender: 'contact:chris', recipient: 'agent:claude', reply_to: null, priority: 'normal', payload: { type: 'text', body: `/keys ${argsRaw}` }, metadata: {} },
      db: createSafeDatabase(db), config: {},
    } as unknown as SlashCommandContext);
  return { run, exec, bound };
}

describe('parseKeys', () => {
  it('splits on whitespace and keeps a quoted run as one key', () => {
    expect(parseKeys('Down  Enter')).toEqual(['Down', 'Enter']);
    expect(parseKeys('"yes please" Enter')).toEqual(['yes please', 'Enter']);
    expect(parseKeys('')).toEqual([]);
  });
});

describe('/keys', () => {
  it("sends the keys to the caller's leased pane and replies with a snapshot", async () => {
    const { run, exec, bound } = setup();
    const result = await run('Down Enter');
    expect(exec.mock.calls.map((c) => c[0])).toEqual([['send-keys', '-t', bound, '--', 'Down', 'Enter']]);
    expect(result.images![0]!.caption).toBe(`Sent Down Enter to ${bound}`);
  });

  it('targets pane @n, including a digit key that is not a pane index', async () => {
    const { run, exec } = setup();
    await run('@2 1');
    expect(exec.mock.calls[0]![0]).toEqual(['send-keys', '-t', 'peggy-pool:2', '--', '1']);
  });

  it("reaches the caller's pane while it is still launching", async () => {
    const { run, exec, bound } = setup({ confirm: false });
    await run('Enter');
    expect(exec.mock.calls[0]![0]).toEqual(['send-keys', '-t', bound, '--', 'Enter']);
  });

  it('sends nothing without keys, with too many, or with control characters', async () => {
    const { run, exec } = setup();
    expect((await run('')).body).toContain('Usage: /keys');
    expect((await run('@1')).body).toContain('Usage: /keys');
    expect((await run(Array(MAX_KEYS + 1).fill('a').join(' '))).body).toContain('Too many keys');
    expect((await run('"a\tb"')).body).toContain('control characters');
    expect(exec).not.toHaveBeenCalled();
  });

  it('sends nothing when no pane is leased to the conversation', async () => {
    const { run, exec } = setup({ bind: false });
    expect((await run('Enter')).body).toBe('No pane is leased to this conversation. Use /keys @<n> <key> (see /pool).');
    expect(exec).not.toHaveBeenCalled();
  });

  it('reports an unknown pane index', async () => {
    const { run } = setup();
    expect((await run('@9 Enter')).body).toBe('No pane with index 9. Try /pool to list panes.');
  });

  it('says so when no provider runs in tmux', async () => {
    const { run } = setup({ noPools: true });
    expect((await run('Enter')).body).toContain('No cc-pool instances configured');
  });

  it('reports a tmux failure', async () => {
    const { run, bound } = setup({ failExec: true });
    expect((await run('Enter')).body).toBe(`${bound}: could not send keys (tmux window not found or unreachable).`);
  });
});

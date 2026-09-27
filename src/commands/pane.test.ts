import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';
import { createPaneCommand } from './pane.js';
import { PoolManager } from '../pool/pool-manager.js';
import { computeConversationId } from '../pipeline/conversation-id.js';
import type { CcPoolInstanceConfig } from '../config/schema.js';
import type { SlashCommandContext } from './registry.js';
import type { MessageEnvelope } from '../types/envelope.js';
import type { TmuxExec } from '../pool/tmux.js';
import { createSafeDatabase } from '../db/safe-database.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const NOW = new Date('2026-09-26T12:00:00.000Z');

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
    tmux_session: 'custom-session',
    panes: 3,
    growth: 'fixed',
    max_panes: 3,
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

function makeCtx(db: Database.Database, cfg: CcPoolInstanceConfig, sender = 'contact:chris'): SlashCommandContext {
  const envelope: MessageEnvelope = {
    id: 'test-id',
    timestamp: NOW.toISOString(),
    channel: 'telegram',
    topic: 'general',
    sender,
    recipient: 'agent:claude',
    reply_to: null,
    priority: 'normal',
    payload: { type: 'text', body: '/pane' },
    metadata: {},
  };
  return {
    channel: 'telegram',
    sender,
    adapterId: 'telegram',
    argsRaw: '',
    envelope,
    db: createSafeDatabase(db),
    config: { adapters: { 'cc-pool': cfg } } as unknown as SlashCommandContext['config'],
  };
}

/** Fake tmux: every pane is 80x24 and shows its own target name; `broken` targets reject as missing. */
function makeExec(broken: string[] = []): TmuxExec & ReturnType<typeof vi.fn> {
  return vi.fn(async (args: string[]) => {
    const target = args[args.indexOf('-t') + 1]!;
    if (broken.includes(target)) throw new Error(`tmux ${args.join(' ')} failed: can't find window: ${target}`);
    if (args[0] === 'list-panes') return '80\t24\n';
    if (args[0] === 'capture-pane') return `\x1b[1mscreen of ${target}\x1b[0m\n`;
    throw new Error(`unexpected tmux call: ${args.join(' ')}`);
  }) as TmuxExec & ReturnType<typeof vi.fn>;
}

function setup(opts: { bind?: boolean; broken?: string[]; sender?: string } = {}) {
  const db = makeDb();
  const cfg = makeCfg();
  const manager = new PoolManager({
    cfg,
    db,
    busBaseUrl: 'http://127.0.0.1:3000',
    paneLauncher: { launch: async () => {}, release: async () => {} },
  });
  manager.leaseStore.seedPanes('peggy', [
    { paneId: 'custom-session:1', agentId: 'agent:peggy-pool-1' },
    { paneId: 'custom-session:2', agentId: 'agent:peggy-pool-2' },
    { paneId: 'custom-session:3', agentId: 'agent:peggy-pool-3' },
  ]);
  let boundPane: string | null = null;
  if (opts.bind !== false) {
    const acquired = manager.leaseStore.acquire('peggy', computeConversationId('chris', 'telegram', 'general'), {
      poolAgentId: 'peggy', panes: 3, maxPanes: 3, growth: 'fixed', idleEvictMs: 1_800_000,
    });
    if (acquired.kind !== 'bound') throw new Error(`test setup: got ${acquired.kind}`);
    manager.leaseStore.confirmReady('peggy', acquired.lease.pane_id);
    boundPane = acquired.lease.pane_id;
  }
  const exec = makeExec(opts.broken);
  const cmd = createPaneCommand({ poolManagers: new Map([['agent:peggy', manager]]), tmuxExec: exec, now: () => NOW });
  return { db, cfg, manager, exec, cmd, ctx: makeCtx(db, cfg, opts.sender), boundPane };
}

const capturedTargets = (exec: ReturnType<typeof vi.fn>): string[] =>
  exec.mock.calls.filter(([a]) => a[0] === 'capture-pane').map(([a]) => a[a.indexOf('-t') + 1]);

describe('/pane', () => {
  it('reports no instances configured when poolManagers is empty', async () => {
    const db = makeDb();
    const cmd = createPaneCommand({ poolManagers: new Map() });
    const result = await cmd.handler([], makeCtx(db, makeCfg()));
    expect(result.body).toBe('No cc-pool instances configured.');
    expect(result.images).toBeUndefined();
  });

  it('with no args, snapshots only the pane leased to the invoking conversation', async () => {
    const { cmd, ctx, exec, boundPane } = setup();
    const result = await cmd.handler([], ctx);
    expect(capturedTargets(exec)).toEqual([boundPane]);
    expect(result.images).toHaveLength(1);
    expect(result.images![0]!.png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
  });

  it('captures with ANSI colors, using the pane_id from the lease (not a hardcoded session)', async () => {
    const { cmd, ctx, exec } = setup();
    await cmd.handler([], ctx);
    const call = exec.mock.calls.find(([a]) => a[0] === 'capture-pane')![0];
    expect(call).toEqual(['capture-pane', '-t', expect.stringMatching(/^custom-session:\d$/), '-p', '-e']);
  });

  it('caption carries pane id, state, conversation/topic, model, and capture timestamp', async () => {
    const { cmd, ctx, boundPane } = setup();
    const { images } = await cmd.handler([], ctx);
    const caption = images![0]!.caption;
    expect(caption).toContain(boundPane!);
    expect(caption).toContain('bound');
    expect(caption).toContain(`conv=${computeConversationId('chris', 'telegram', 'general').slice(0, 8)} (general)`);
    expect(caption).toContain('model=default');
    expect(caption).toContain('2026-09-26T12:00:00.000Z');
  });

  it('with no args and no lease for the caller, snapshots every pane', async () => {
    const { cmd, ctx, exec } = setup({ bind: false });
    const result = await cmd.handler([], ctx);
    expect(capturedTargets(exec)).toEqual(['custom-session:1', 'custom-session:2', 'custom-session:3']);
    expect(result.images).toHaveLength(3);
    expect(result.images!.every((i) => i.caption.includes('free'))).toBe(true);
  });

  it('/pane <n> snapshots the pane with that index', async () => {
    const { cmd, ctx, exec } = setup();
    const result = await cmd.handler(['2'], ctx);
    expect(capturedTargets(exec)).toEqual(['custom-session:2']);
    expect(result.images).toHaveLength(1);
  });

  it('/pane all snapshots every pane, one image each', async () => {
    const { cmd, ctx, exec } = setup();
    const result = await cmd.handler(['all'], ctx);
    expect(capturedTargets(exec)).toEqual(['custom-session:1', 'custom-session:2', 'custom-session:3']);
    expect(result.images).toHaveLength(3);
  });

  it('caps a reply at 8 images', async () => {
    const { cmd, ctx, manager } = setup();
    manager.leaseStore.seedPanes(
      'peggy',
      Array.from({ length: 10 }, (_, i) => ({ paneId: `custom-session:${i + 10}`, agentId: `agent:peggy-pool-${i + 10}` })),
    );
    const result = await cmd.handler(['all'], ctx);
    expect(result.images).toHaveLength(8);
  });

  it('fallback text is the plain screen in a code block, with no escape codes', async () => {
    const { cmd, ctx } = setup();
    const { images } = await cmd.handler(['1'], ctx);
    expect(images![0]!.fallbackText).toContain('```\nscreen of custom-session:1\n```');
    expect(images![0]!.fallbackText).not.toContain('\x1b');
  });

  it('replies with a short error for an unknown pane index', async () => {
    const { cmd, ctx } = setup();
    const result = await cmd.handler(['9'], ctx);
    expect(result.body).toBe('No pane with index 9. Try /pool to list panes.');
    expect(result.images).toBeUndefined();
  });

  it('replies with usage for a bad argument', async () => {
    const { cmd, ctx } = setup();
    expect((await cmd.handler(['nope'], ctx)).body).toBe('Usage: /pane [n|all]');
  });

  it('a missing tmux session/window is a plain-text error, not a crash', async () => {
    const { cmd, ctx } = setup({ broken: ['custom-session:1', 'custom-session:2', 'custom-session:3'] });
    const result = await cmd.handler(['all'], ctx);
    expect(result.images).toBeUndefined();
    expect(result.body).toContain('custom-session:1: tmux session "custom-session" or window not found');
  });

  it('one dead pane does not block the others', async () => {
    const { cmd, ctx } = setup({ broken: ['custom-session:2'] });
    const result = await cmd.handler(['all'], ctx);
    expect(result.images).toHaveLength(2);
    expect(result.body).toContain('custom-session:2');
  });

  it('never logs the captured screen text', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    try {
      const { cmd, ctx } = setup();
      await cmd.handler(['all'], ctx);
      for (const spy of spies) {
        expect(spy.mock.calls.flat().join(' ')).not.toContain('screen of');
      }
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });
});

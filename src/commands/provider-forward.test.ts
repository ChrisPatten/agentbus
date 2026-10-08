import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';
import {
  createHeadlessForwarder,
  createPoolForwarder,
  providerCommandLine,
  PROVIDER_COMMAND_NAME_RE,
  type ProviderForwardRequest,
} from './provider-forward.js';
import { PoolManager } from '../pool/pool-manager.js';
import { computeConversationId } from '../pipeline/conversation-id.js';
import type { CcPoolInstanceConfig } from '../config/schema.js';
import type { SlashCommandContext } from './registry.js';
import type { TmuxExec } from '../pool/tmux.js';

function makeCfg(): CcPoolInstanceConfig {
  return {
    name: null, agent_id: 'peggy', tmux_session: 'peggy-pool', panes: 2, growth: 'fixed', max_panes: 2,
    claude_bin: '/usr/local/bin/claude', model: undefined, working_dir: '/work/dir', launch_args: [],
    poll_interval_ms: 1000, system_prompt: undefined,
    lease: { idle_evict_ms: 1_800_000, hard_idle_ms: 21_600_000, park_timeout_ms: 300_000 },
    on_evict: 'clear', launch_ack_delay_ms: 500, launch_ack_max_attempts: 3, launch_ack_pattern: 'experimental', pane_env: {},
  };
}

function req(recipientId: string, command = 'compact', argsRaw = ''): ProviderForwardRequest {
  return {
    route: { adapterId: 'cc-pool', recipientId },
    command,
    argsRaw,
    line: providerCommandLine(command, argsRaw),
    ctx: {} as SlashCommandContext,
  };
}

function setupPool(opts: { screen?: string; failSend?: boolean; failShot?: boolean } = {}) {
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
  const a = manager.leaseStore.acquire('peggy', computeConversationId('chris', 'telegram', 'general'), {
    poolAgentId: 'peggy', panes: 2, maxPanes: 2, growth: 'fixed', idleEvictMs: 1_800_000,
  });
  if (a.kind !== 'bound') throw new Error('setup');
  manager.leaseStore.confirmReady('peggy', a.lease.pane_id);

  const exec = vi.fn(async (args: string[]) => {
    if (args[0] === 'send-keys' && opts.failSend) throw new Error("can't find window: x");
    return args[0] === 'capture-pane' ? (opts.screen ?? '> ') : '';
  }) as unknown as TmuxExec & ReturnType<typeof vi.fn>;
  const execRaw = vi.fn(async (args: string[]) => {
    if (opts.failShot) throw new Error("can't find window: x");
    return args[0] === 'list-panes' ? '20\t3\n' : 'Compacted\n\n\n';
  }) as unknown as TmuxExec & ReturnType<typeof vi.fn>;
  const sleep = vi.fn(async () => {});
  const forwarder = createPoolForwarder({
    poolManagers: new Map([['agent:peggy', manager]]),
    tmuxExec: exec, tmuxExecRaw: execRaw, sleep, settleMs: 5,
  });
  const sentKeys = () => exec.mock.calls.map((c) => c[0] as string[]).filter((c) => c[0] === 'send-keys');
  return { forwarder, exec, sleep, sentKeys, leased: a.lease };
}

describe('provider command helpers', () => {
  it('builds the line the provider receives', () => {
    expect(providerCommandLine('compact', '')).toBe('/compact');
    expect(providerCommandLine('compact', 'keep the plan')).toBe('/compact keep the plan');
  });

  it('accepts command and plugin:skill names, rejects paths', () => {
    for (const ok of ['compact', 'code-review', 'finance:sox-testing', 'a_b2']) {
      expect(PROVIDER_COMMAND_NAME_RE.test(ok)).toBe(true);
    }
    for (const bad of ['Users/chris', 'a.b', '/x', '2fa', '']) {
      expect(PROVIDER_COMMAND_NAME_RE.test(bad)).toBe(false);
    }
  });
});

describe('cc-pool forwarder', () => {
  it('types the line into the leased pane and replies with a snapshot', async () => {
    const { forwarder, sentKeys, sleep, leased } = setupPool();
    const result = await forwarder.forward(req(leased.agent_id, 'compact', 'keep the plan'));

    expect(sentKeys()).toEqual([
      ['send-keys', '-t', leased.pane_id, '-l', '--', '/compact keep the plan'],
      ['send-keys', '-t', leased.pane_id, 'Enter'],
    ]);
    expect(sleep).toHaveBeenCalledWith(5);
    if (result.kind !== 'reply') throw new Error(`expected reply, got ${result.kind}`);
    const image = result.response.images![0]!;
    expect(image.caption).toBe(`Sent /compact keep the plan to ${leased.pane_id}`);
    expect(image.png.subarray(1, 4).toString()).toBe('PNG');
    expect(image.fallbackText).toContain('Compacted');
  });

  it('sends nothing when the route resolved to no pane (parked)', async () => {
    const { forwarder, exec } = setupPool();
    const result = await forwarder.forward(req('agent:peggy__parked'));
    expect(result).toMatchObject({ kind: 'unsupported' });
    expect(exec).not.toHaveBeenCalled();
  });

  it('sends nothing to a pane that is not leased', async () => {
    const { forwarder, exec } = setupPool();
    const result = await forwarder.forward(req('agent:peggy-pool-2'));
    expect(result).toEqual({ kind: 'unsupported', reason: 'peggy-pool:2 is free; /compact was not sent.' });
    expect(exec).not.toHaveBeenCalled();
  });

  it('sends nothing when the pane is at a permission dialog', async () => {
    const { forwarder, sentKeys, leased } = setupPool({ screen: 'Do you want to proceed?\n Esc to cancel · Tab to amend' });
    const result = await forwarder.forward(req(leased.agent_id));
    expect(result).toMatchObject({ kind: 'unsupported' });
    expect(sentKeys()).toEqual([]);
  });

  it('refuses a multi-line command', async () => {
    const { forwarder, exec, leased } = setupPool();
    const result = await forwarder.forward(req(leased.agent_id, 'compact', 'a\nb'));
    expect(result).toEqual({ kind: 'unsupported', reason: 'A forwarded command must be a single line.' });
    expect(exec).not.toHaveBeenCalled();
  });

  it('reports a tmux failure as unsupported', async () => {
    const { forwarder, leased } = setupPool({ failSend: true });
    expect(await forwarder.forward(req(leased.agent_id))).toMatchObject({ kind: 'unsupported' });
  });

  it('still confirms the send when only the snapshot fails', async () => {
    const { forwarder, leased } = setupPool({ failShot: true });
    expect(await forwarder.forward(req(leased.agent_id))).toEqual({
      kind: 'reply',
      response: { body: `Sent /compact to ${leased.pane_id}.` },
    });
  });
});

describe('cc-headless forwarder', () => {
  const control = (names: string[] | null | undefined) => ({
    journalResumeId: new Map(),
    stopTurn: new Map(),
    slashCommands: new Map(names === undefined ? [] : [['agent:peggy', () => names]]),
  });
  const headlessReq = (command: string): ProviderForwardRequest => ({
    ...req('agent:peggy', command),
    route: { adapterId: 'cc-headless', recipientId: 'agent:peggy' },
  });

  it('enqueues a command the instance listed', async () => {
    const f = createHeadlessForwarder({ headlessControl: control(['compact', 'context']) });
    expect(await f.forward(headlessReq('compact'))).toEqual({ kind: 'enqueue' });
  });

  it('refuses a command the instance did not list', async () => {
    const f = createHeadlessForwarder({ headlessControl: control(['compact']) });
    expect(await f.forward(headlessReq('remote-control'))).toEqual({
      kind: 'unsupported',
      reason: 'The provider has no /remote-control command in headless mode.',
    });
  });

  it('lets a command through before the first turn, when the list is unknown', async () => {
    const f = createHeadlessForwarder({ headlessControl: control(null) });
    expect(await f.forward(headlessReq('anything'))).toEqual({ kind: 'enqueue' });
  });

  it('refuses when no instance runs for the agent', async () => {
    const f = createHeadlessForwarder({ headlessControl: control(undefined) });
    expect(await f.forward(headlessReq('compact'))).toMatchObject({ kind: 'unsupported' });
  });
});

import { describe, it, expect, vi, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { agentIdFromCommand, findOrphans, isPoolServerCommand, OrphanDetector, realListProcesses } from './orphan-detector.js';
import { createTmuxController, type TmuxExec } from './tmux.js';

describe('isPoolServerCommand', () => {
  it('matches tmux new-session for the exact session name, with or without -L / extra flags', () => {
    expect(isPoolServerCommand('tmux new-session -d -s peggy-pool', 'peggy-pool')).toBe(true);
    expect(isPoolServerCommand('/opt/homebrew/bin/tmux new-session -d -s peggy-pool -c /x', 'peggy-pool')).toBe(true);
    expect(isPoolServerCommand('tmux -L test new-session -d -s peggy-pool', 'peggy-pool')).toBe(true);
    expect(isPoolServerCommand('tmux new -d -s peggy-pool', 'peggy-pool')).toBe(true);
  });

  it('does not match other sessions, other commands, or clients', () => {
    expect(isPoolServerCommand('tmux new-session -d -s peggy-pool-2', 'peggy-pool')).toBe(false);
    expect(isPoolServerCommand('tmux attach -t peggy-pool', 'peggy-pool')).toBe(false);
    expect(isPoolServerCommand('grep tmux new-session -d -s peggy-pool', 'peggy-pool')).toBe(false);
    expect(isPoolServerCommand('', 'peggy-pool')).toBe(false);
  });
});

describe('agentIdFromCommand', () => {
  it('reads AGENTBUS_AGENT_ID from the environment part of a ps -e line', () => {
    expect(agentIdFromCommand('node cc.js HOME=/u AGENTBUS_AGENT_ID=peggy-pool-2 X=1')).toBe('peggy-pool-2');
    expect(agentIdFromCommand('node cc.js MY_AGENTBUS_AGENT_ID=nope')).toBeNull();
    expect(agentIdFromCommand('zsh')).toBeNull();
  });
});

describe('findOrphans', () => {
  const isPool = (id: string) => /^peggy-pool-\d+$/.test(id);

  it('reports only the top of each agent chain, and nothing under the live server', () => {
    const scan = findOrphans(
      [
        { pid: 10, ppid: 1, command: 'tmux new-session -d -s peggy-pool' },
        { pid: 11, ppid: 10, command: 'zsh' },
        { pid: 12, ppid: 11, command: 'npx AGENTBUS_AGENT_ID=peggy-pool-1' },
        { pid: 13, ppid: 12, command: 'node AGENTBUS_AGENT_ID=peggy-pool-1' },
        { pid: 20, ppid: 1, command: 'npx AGENTBUS_AGENT_ID=peggy-pool-4' },
        { pid: 21, ppid: 20, command: 'node AGENTBUS_AGENT_ID=peggy-pool-4' },
      ],
      { session: 'peggy-pool', liveServerPid: 10, isPoolAgentId: isPool },
    );
    expect(scan.servers).toEqual([]);
    expect(scan.agents.map((a) => a.pid)).toEqual([20]);
  });

  it('never reports its own process', () => {
    const scan = findOrphans([{ pid: 99, ppid: 1, command: 'node AGENTBUS_AGENT_ID=peggy-pool-1' }], {
      session: 'peggy-pool', liveServerPid: 10, isPoolAgentId: isPool, selfPid: 99,
    });
    expect(scan.agents).toEqual([]);
  });

  it('survives a ppid cycle', () => {
    const scan = findOrphans(
      [
        { pid: 5, ppid: 6, command: 'node AGENTBUS_AGENT_ID=peggy-pool-1' },
        { pid: 6, ppid: 5, command: 'sh' },
      ],
      { session: 'peggy-pool', liveServerPid: 10, isPoolAgentId: isPool },
    );
    expect(scan.agents.map((a) => a.pid)).toEqual([5]);
  });
});

describe('TmuxController.serverPid', () => {
  it('returns the pid of the server the controller reaches', async () => {
    const exec = vi.fn(async () => '92327\n92327');
    await expect(createTmuxController(exec as unknown as TmuxExec).serverPid!()).resolves.toBe(92327);
    expect(exec).toHaveBeenCalledWith(['list-sessions', '-F', '#{pid}']);
  });

  it('null when no server runs or the socket is gone', async () => {
    for (const msg of ['no server running on /private/tmp/tmux-501/default', 'error connecting to /private/tmp/tmux-501/default (No such file or directory)']) {
      const t = createTmuxController((async () => { throw new Error(msg); }) as TmuxExec);
      await expect(t.serverPid!()).resolves.toBeNull();
    }
  });

  it('rethrows other errors', async () => {
    const t = createTmuxController((async () => { throw new Error('tmux: command not found'); }) as TmuxExec);
    await expect(t.serverPid!()).rejects.toThrow(/not found/);
  });
});

// ── Real tmux (opt-in: AGENTBUS_TMUX_IT=1) ─────────────────────────────────
//
// S88.4 acceptance with real processes. Uses a unique session name and two
// private sockets (-L), so it can never match or touch a real pool's
// servers; the only processes it signals are the ones it started.

const tmuxAvailable = spawnSync('tmux', ['-V']).status === 0;
const runIt = process.env['AGENTBUS_TMUX_IT'] === '1' && tmuxAvailable;

describe.skipIf(!runIt)('S88.4 acceptance with real tmux servers', () => {
  const session = `agentbus-e88-it-${randomUUID().slice(0, 8)}`;
  const liveSock = `${session}-live`;
  const orphanSock = `${session}-orphan`;

  function tmuxOn(sock: string, args: string[]): string {
    return execFileSync('tmux', ['-L', sock, ...args], { encoding: 'utf-8' }).trim();
  }

  afterAll(() => {
    for (const sock of [liveSock, orphanSock]) spawnSync('tmux', ['-L', sock, 'kill-server']);
  });

  it('logs "orphan tmux server pid=<n>", sends one notice, and with kill_orphan_servers the process is gone after the tick', async () => {
    tmuxOn(liveSock, ['new-session', '-d', '-s', session]);
    tmuxOn(orphanSock, ['new-session', '-d', '-s', session]);
    const livePid = Number(tmuxOn(liveSock, ['display-message', '-p', '-t', session, '#{pid}']));
    const orphanPid = Number(tmuxOn(orphanSock, ['display-message', '-p', '-t', session, '#{pid}']));
    const live = createTmuxController((args) => Promise.resolve(tmuxOn(liveSock, args)));
    expect(await live.serverPid!()).toBe(livePid);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const notify = vi.fn(async (_b: string) => {});
    const detector = new OrphanDetector({
      poolId: 'it', session, liveServerPid: () => live.serverPid!(), isPoolAgentId: () => false, notify,
      listProcesses: realListProcesses,
    });
    const scan = await detector.check();
    expect(scan!.servers.map((s) => s.pid)).toEqual([orphanPid]);
    expect(warn.mock.calls.some((c) => String(c[0]).includes(`orphan tmux server pid=${orphanPid}`))).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1);

    const killer = new OrphanDetector({
      poolId: 'it', session, liveServerPid: () => live.serverPid!(), isPoolAgentId: () => false, notify,
      listProcesses: realListProcesses, killOrphans: true,
      // Belt and braces: only ever signal the server this test started.
      killFn: (pid, sig) => {
        if (pid !== orphanPid) throw new Error(`refusing to signal ${pid}`);
        process.kill(pid, sig);
      },
    });
    await killer.check();
    for (let i = 0; i < 50; i++) {
      try {
        process.kill(orphanPid, 0);
        await new Promise((r) => setTimeout(r, 50));
      } catch {
        break;
      }
    }
    expect(() => process.kill(orphanPid, 0)).toThrow();
    expect(() => process.kill(livePid, 0)).not.toThrow();
    warn.mockRestore();
  });
});

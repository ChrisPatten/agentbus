/**
 * E88 (S88.4) — orphaned pool tmux server detection.
 *
 * On Oct 31, 2026 a tmux server still running `peggy-pool` had lost its
 * socket (`/private/tmp/tmux-501/default` was recreated Oct 29), so `tmux`
 * reached only the new server the pool had started since. The old one kept
 * five hidden `claude` sessions alive, polling the bus as `peggy-pool-1..4`
 * and `pokeclaude-pool-1`. The launch fence (S88.1/S88.2) makes such
 * processes harmless; this module makes them visible.
 *
 * A check lists the user's processes once (`ps -axEww`, which on macOS
 * appends each process's environment to its command line) and finds:
 *
 * - **orphan servers**: every `tmux … new-session … -s <session>` process
 *   other than the server the pool's own `tmux` reaches;
 * - **orphan agents**: every process whose environment has
 *   `AGENTBUS_AGENT_ID=<one of this pool's pane agent ids>` and that does not
 *   descend from the live server. Only the topmost process of a chain is
 *   reported (npx -> sh -> node all carry the variable).
 *
 * Each orphan pid is logged and reported to the admin channel once.
 * `kill_orphan_servers: true` also sends SIGTERM to each; off by default.
 * `ps` only shows the bus user's own processes, which is where pool panes
 * run.
 */
import { execFile } from 'node:child_process';
import { basename } from 'node:path';

export interface ProcessInfo {
  pid: number;
  ppid: number;
  /** Command line; on macOS with `ps -e`, followed by the environment. */
  command: string;
}

export interface OrphanServer {
  pid: number;
  command: string;
  /** Pool agent ids held by processes under this server. */
  agentIds: string[];
}

export interface OrphanAgent {
  pid: number;
  agentId: string;
  command: string;
}

export interface OrphanScan {
  liveServerPid: number | null;
  servers: OrphanServer[];
  /** Pool-agent processes outside the live server and outside every orphan server. */
  agents: OrphanAgent[];
}

const AGENT_ID_ENV_RE = /(?:^|\s)AGENTBUS_AGENT_ID=(\S+)/;

/** True when `command` is a tmux invocation that creates `session` (`tmux [-L x] new-session … -s <session>`). */
export function isPoolServerCommand(command: string, session: string): boolean {
  const tokens = command.trim().split(/\s+/);
  if (tokens.length === 0 || basename(tokens[0]!) !== 'tmux') return false;
  const sub = tokens.findIndex((t) => t === 'new-session' || t === 'new');
  if (sub === -1) return false;
  for (let i = sub + 1; i < tokens.length - 1; i++) {
    if (tokens[i] === '-s' && tokens[i + 1] === session) return true;
  }
  return false;
}

/** `AGENTBUS_AGENT_ID` from a `ps -e` command line, or null. */
export function agentIdFromCommand(command: string): string | null {
  return AGENT_ID_ENV_RE.exec(command)?.[1] ?? null;
}

/** Pure classification of a process list — see the module doc. */
export function findOrphans(
  processes: readonly ProcessInfo[],
  opts: { session: string; liveServerPid: number | null; isPoolAgentId: (agentId: string) => boolean; selfPid?: number },
): OrphanScan {
  const byPid = new Map<number, ProcessInfo>();
  for (const p of processes) byPid.set(p.pid, p);

  const servers = new Map<number, OrphanServer>();
  for (const p of processes) {
    if (p.pid === opts.liveServerPid || p.pid === opts.selfPid) continue;
    if (isPoolServerCommand(p.command, opts.session)) servers.set(p.pid, { pid: p.pid, command: p.command, agentIds: [] });
  }

  const ancestors = (pid: number): number[] => {
    const out: number[] = [];
    const seen = new Set<number>();
    let cur = byPid.get(pid);
    while (cur && cur.ppid > 1 && !seen.has(cur.ppid)) {
      seen.add(cur.ppid);
      out.push(cur.ppid);
      cur = byPid.get(cur.ppid);
    }
    return out;
  };

  const agents: OrphanAgent[] = [];
  for (const p of processes) {
    if (p.pid === opts.selfPid) continue;
    const agentId = agentIdFromCommand(p.command);
    if (!agentId || !opts.isPoolAgentId(agentId)) continue;
    const parent = byPid.get(p.ppid);
    if (parent && agentIdFromCommand(parent.command) === agentId) continue; // not the top of its chain
    const chain = ancestors(p.pid);
    if (opts.liveServerPid !== null && chain.includes(opts.liveServerPid)) continue; // a live pane's
    const server = chain.map((pid) => servers.get(pid)).find((s) => s !== undefined);
    if (server) {
      if (!server.agentIds.includes(agentId)) server.agentIds.push(agentId);
    } else {
      agents.push({ pid: p.pid, agentId, command: p.command });
    }
  }

  return { liveServerPid: opts.liveServerPid, servers: [...servers.values()], agents };
}

/** Lists the user's processes with their environment (`ps -axEww -o pid=,ppid=,command=`). */
export function realListProcesses(): Promise<ProcessInfo[]> {
  return new Promise((resolve, reject) => {
    execFile('ps', ['-axEww', '-o', 'pid=,ppid=,command='], { maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        reject(err);
        return;
      }
      const out: ProcessInfo[] = [];
      for (const line of stdout.toString().split('\n')) {
        const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
        if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3]! });
      }
      resolve(out);
    });
  });
}

export interface OrphanDetectorDeps {
  poolId: string;
  session: string;
  /** Pid of the tmux server the pool's own `tmux` reaches, or null when none is running. */
  liveServerPid: () => Promise<number | null>;
  isPoolAgentId: (agentId: string) => boolean;
  listProcesses?: () => Promise<ProcessInfo[]>;
  /** Admin notice (the pool's `channel: 'system'` notice). */
  notify: (body: string) => Promise<void>;
  /** `kill_orphan_servers`: SIGTERM each orphan. Default false. */
  killOrphans?: boolean;
  killFn?: (pid: number, signal: NodeJS.Signals) => void;
  selfPid?: number;
}

export class OrphanDetector {
  private readonly deps: OrphanDetectorDeps;
  private readonly notified = new Set<number>();
  private running = false;

  constructor(deps: OrphanDetectorDeps) {
    this.deps = deps;
  }

  /** One check. Never throws; returns the scan (or null when it could not run). */
  async check(): Promise<OrphanScan | null> {
    if (this.running) return null;
    this.running = true;
    const tag = `[pool:${this.deps.poolId}]`;
    try {
      const liveServerPid = await this.deps.liveServerPid();
      const processes = await (this.deps.listProcesses ?? realListProcesses)();
      const scan = findOrphans(processes, {
        session: this.deps.session,
        liveServerPid,
        isPoolAgentId: this.deps.isPoolAgentId,
        selfPid: this.deps.selfPid ?? process.pid,
      });

      const fresh: string[] = [];
      for (const s of scan.servers) {
        const held = s.agentIds.length > 0 ? ` holding ${s.agentIds.join(', ')}` : '';
        const line = `orphan tmux server pid=${s.pid} for session "${this.deps.session}"${held} (live server pid=${liveServerPid ?? 'none'})`;
        if (!this.notified.has(s.pid)) {
          console.warn(`${tag} ${line}`);
          this.notified.add(s.pid);
          fresh.push(`- ${line}`);
        }
      }
      for (const a of scan.agents) {
        const line = `orphan pool agent pid=${a.pid} polling as ${a.agentId}, outside the live tmux server (pid=${liveServerPid ?? 'none'})`;
        if (!this.notified.has(a.pid)) {
          console.warn(`${tag} ${line}`);
          this.notified.add(a.pid);
          fresh.push(`- ${line}`);
        }
      }

      const killed: number[] = [];
      if (this.deps.killOrphans) {
        const kill = this.deps.killFn ?? ((pid: number, sig: NodeJS.Signals) => process.kill(pid, sig));
        for (const pid of [...scan.servers.map((s) => s.pid), ...scan.agents.map((a) => a.pid)]) {
          try {
            kill(pid, 'SIGTERM');
            killed.push(pid);
            console.warn(`${tag} kill_orphan_servers: sent SIGTERM to orphan pid=${pid}`);
          } catch (err) {
            console.error(`${tag} kill_orphan_servers: SIGTERM to pid=${pid} failed:`, err);
          }
        }
      }

      if (fresh.length > 0) {
        const action = this.deps.killOrphans
          ? `kill_orphan_servers is on: sent SIGTERM to ${killed.length > 0 ? killed.join(', ') : 'none (all failed)'}.`
          : `They are fenced off from this pool's messages, but still running. Check them with \`ps -o pid,lstart,command -p <pid>\` ` +
            `and stop them with \`kill <pid>\`, or set kill_orphan_servers: true. See docs/CC_POOL_ADAPTER.md "Orphaned tmux servers".`;
        await this.deps.notify(`${tag} Found processes from an orphaned pool tmux server:\n${fresh.join('\n')}\n\n${action}`);
      }
      return scan;
    } catch (err) {
      console.error(`${tag} orphan tmux server check failed:`, err);
      return null;
    } finally {
      this.running = false;
    }
  }
}

/**
 * Child processes for journalers (E66 S66.6, S66.7).
 *
 * Journalers that spawn work (`claude -p`, a user script) run it as the
 * leader of its own process group (`detached: true`), so a timeout or an
 * abort can stop everything it started: SIGTERM to the group, then SIGKILL
 * after a grace period. No shell is involved; `command` and `args` are
 * passed to the OS as-is.
 */
import { spawn, type ChildProcess } from 'node:child_process';

/** Wait between SIGTERM and SIGKILL. */
export const DEFAULT_KILL_GRACE_MS = 5_000;
/** How long to wait for the pipes to close after the process itself exited. */
const CLOSE_AFTER_EXIT_MS = 2_000;
/** Default caps on captured output. stdout keeps its start, stderr its end. */
const DEFAULT_MAX_STDOUT = 256 * 1024;
const DEFAULT_MAX_STDERR = 16 * 1024;

/**
 * Signal the process group `child` leads; falls back to the child alone when
 * it has no pid (it never started) or the group is already gone.
 */
export function killProcessGroup(child: Pick<ChildProcess, 'pid' | 'kill'>, signal: NodeJS.Signals): void {
  if (typeof child.pid === 'number') {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Group gone (ESRCH) or not a group leader: try the child itself.
    }
  }
  try { child.kill(signal); } catch { /* already exited */ }
}

/**
 * SIGTERM the group now and SIGKILL it after `graceMs` unless `exited()`
 * reports the child is gone by then. Returns a cancel function.
 */
export function terminateProcessGroup(
  child: Pick<ChildProcess, 'pid' | 'kill'>,
  graceMs: number = DEFAULT_KILL_GRACE_MS,
): () => void {
  killProcessGroup(child, 'SIGTERM');
  const timer = setTimeout(() => killProcessGroup(child, 'SIGKILL'), graceMs);
  timer.unref?.();
  return () => clearTimeout(timer);
}

export interface RunProcessOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  /** The complete environment. Nothing is inherited from the bus. */
  env: Record<string, string>;
  stdin?: string;
  timeoutMs: number;
  killGraceMs?: number;
  signal?: AbortSignal;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
}

export interface RunProcessResult {
  /** Exit code, or null when the process was killed by a signal or never started. */
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  /** Set when the process could not be started (ENOENT, EACCES, …). */
  spawnError: string | null;
  durationMs: number;
}

/** Spawn without a shell, in its own process group, and collect the result. Never rejects. */
export function runProcess(opts: RunProcessOptions): Promise<RunProcessResult> {
  const started = Date.now();
  const maxOut = opts.maxStdoutBytes ?? DEFAULT_MAX_STDOUT;
  const maxErr = opts.maxStderrBytes ?? DEFAULT_MAX_STDERR;

  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(opts.command, [...opts.args], {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
        shell: false,
      });
    } catch (err) {
      resolve({
        code: null, signal: null, stdout: '', stderr: '', timedOut: false, aborted: false,
        spawnError: err instanceof Error ? err.message : String(err), durationMs: Date.now() - started,
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let spawnError: string | null = null;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let settled = false;
    let cancelKill: (() => void) | null = null;
    let afterExit: ReturnType<typeof setTimeout> | null = null;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (afterExit) clearTimeout(afterExit);
      // A pending SIGKILL (after a timeout or abort) still fires: it sweeps
      // up anything in the group that ignored SIGTERM.
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({
        code: exitCode, signal: exitSignal, stdout, stderr, timedOut, aborted, spawnError,
        durationMs: Date.now() - started,
      });
    };

    const stop = () => {
      if (!cancelKill) cancelKill = terminateProcessGroup(child, opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
    };

    const timer = setTimeout(() => { timedOut = true; stop(); }, Math.max(1, opts.timeoutMs));
    timer.unref?.();
    const onAbort = () => { aborted = true; stop(); };
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < maxOut) stdout += chunk.toString().slice(0, maxOut - stdout.length);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > maxErr) stderr = stderr.slice(-maxErr);
    });
    child.stdin?.on('error', () => { /* the process exited without reading stdin */ });

    child.on('error', (err) => {
      spawnError = err.message;
      finish();
    });
    child.on('exit', (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      // Something the process left behind may keep the pipes open. Give them
      // a moment, then stop the rest of the group and report.
      afterExit = setTimeout(() => { killProcessGroup(child, 'SIGKILL'); finish(); }, CLOSE_AFTER_EXIT_MS);
      afterExit.unref?.();
    });
    child.on('close', (code, signal) => {
      if (exitCode === null && exitSignal === null) {
        exitCode = code;
        exitSignal = signal;
      }
      finish();
    });

    if (child.stdin) {
      if (opts.stdin !== undefined) child.stdin.end(opts.stdin);
      else child.stdin.end();
    }
  });
}

/** The tail of `text`, at most `max` characters, marked when cut. */
export function tail(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `…${trimmed.slice(-(max - 1))}` : trimmed;
}

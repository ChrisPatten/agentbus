/**
 * S48.1 — tmux control layer for the interactive Claude Code session pool (E48).
 *
 * A small, fully-testable wrapper around the `tmux` CLI. All tmux invocation
 * goes through an injected TmuxExec function, so createTmuxController() can
 * be unit-tested with a fake exec — no real tmux process is ever spawned in
 * tests. Only realTmuxExec(), below, touches node:child_process; the
 * controller itself never does.
 *
 * Prior art (read-only reference, lives outside this repo): a hand-rolled
 * single-session version of this already runs on this machine at
 * ~/workspace/peggy-claude-code/start.sh and
 * ~/workspace/peggy-claude-code/scripts/agentbus_session_watchdog.sh. This
 * module's argument shapes match what those scripts already demonstrate
 * works (new-session -d -s -c -e KEY=VALUE, send-keys ... Enter,
 * capture-pane -p), since a later story migrates that exact logic here.
 */
import { execFile } from 'node:child_process';

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Injected shell-exec function, e.g. a thin wrapper around node:child_process
 * execFile. Implementations run `tmux <args>` and resolve with stdout
 * (trimmed), or reject with an Error whose message includes stderr on
 * non-zero exit.
 */
export interface TmuxExec {
  (args: string[]): Promise<string>;
}

export interface TmuxController {
  ensureSession(session: string, cwd: string): Promise<void>;
  listWindows(session: string): Promise<Array<{ index: number; name: string; active: boolean }>>;
  /** Creates a window and returns its pane target, e.g. "session:name". */
  createWindow(session: string, name: string, cwd: string, env?: Record<string, string>): Promise<string>;
  killWindow(target: string): Promise<void>;
  /** Sends a raw key name, e.g. "Enter", "C-c" — NOT typed text. */
  sendKeys(target: string, keys: string): Promise<void>;
  /** Types `line` literally then presses Enter. */
  sendCommand(target: string, line: string): Promise<void>;
  paneAlive(target: string): Promise<boolean>;
  /** The running foreground process name in that pane, or null if pane/session doesn't exist. */
  paneCommand(target: string): Promise<string | null>;
  /** tmux capture-pane -p, optionally tailed to the last N lines. */
  capturePane(target: string, lines?: number): Promise<string>;
}

// ── Error matching ────────────────────────────────────────────────────────────

/**
 * Matches tmux's "can't find window: X" / "can't find session: X" /
 * "can't find pane: X" error text (verified against tmux 3.5a on this
 * machine) — i.e. the target simply doesn't exist, as opposed to some other
 * failure (bad flag, tmux not installed, etc).
 */
const MISSING_TARGET_RE = /can't find (window|session|pane)/i;

function isMissingTargetError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return MISSING_TARGET_RE.test(message);
}

/** Disallows \n, \r, and any other C0 control character or DEL in a command line. */
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

// ── Controller ────────────────────────────────────────────────────────────────

/**
 * Builds a TmuxController backed by the given exec function. Never touches
 * node:child_process directly — that seam is realTmuxExec(), below — so
 * tests can inject a fake exec with no real tmux process spawned.
 */
export function createTmuxController(exec: TmuxExec): TmuxController {
  async function hasSession(session: string): Promise<boolean> {
    try {
      await exec(['has-session', '-t', session]);
      return true;
    } catch {
      return false;
    }
  }

  async function ensureSession(session: string, cwd: string): Promise<void> {
    // `new-session -A -d` is NOT a safe no-op when the session already
    // exists in this exec context — see the discrepancy note in this
    // story's report (it dispatches to attach-session, which fails with
    // "open terminal failed: not a terminal" when there's no controlling
    // TTY). Gate with has-session instead and only create when absent.
    if (await hasSession(session)) return;
    await exec(['new-session', '-d', '-s', session, '-c', cwd]);
  }

  async function listWindows(
    session: string,
  ): Promise<Array<{ index: number; name: string; active: boolean }>> {
    const out = await exec([
      'list-windows',
      '-t',
      session,
      '-F',
      '#{window_index}\t#{window_name}\t#{window_active}',
    ]);
    return out
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => {
        const [indexStr = '', name = '', activeStr = ''] = line.split('\t');
        return { index: Number(indexStr), name, active: activeStr === '1' };
      });
  }

  async function createWindow(
    session: string,
    name: string,
    cwd: string,
    env: Record<string, string> = {},
  ): Promise<string> {
    const args = ['new-window', '-t', session, '-n', name, '-c', cwd];
    for (const [key, value] of Object.entries(env)) {
      args.push('-e', `${key}=${value}`);
    }
    await exec(args);
    return `${session}:${name}`;
  }

  async function killWindow(target: string): Promise<void> {
    try {
      await exec(['kill-window', '-t', target]);
    } catch (err) {
      // Already gone — treat as success, not a failure.
      if (isMissingTargetError(err)) return;
      throw err;
    }
  }

  async function sendKeys(target: string, keys: string): Promise<void> {
    // No `-l`, no extra quoting: argv passes `keys` (e.g. "Enter", "C-c") as
    // a single element, so tmux sees exactly the key name it expects rather
    // than literal characters.
    await exec(['send-keys', '-t', target, keys]);
  }

  async function sendCommand(target: string, line: string): Promise<void> {
    if (CONTROL_CHAR_RE.test(line)) {
      throw new Error(
        `sendCommand: refusing to send a line containing a newline or control character to tmux target "${target}"`,
      );
    }
    // Invoked via argv (execFile), never a shell string, so `line` reaches
    // tmux as a single literal argument — most shell-injection concerns
    // don't apply here. `-l` sends it as literal text instead of tmux
    // key-name interpretation; `--` stops tmux from reading a `line` that
    // happens to start with `-` as a flag.
    await exec(['send-keys', '-t', target, '-l', '--', line]);
    await sendKeys(target, 'Enter');
  }

  async function paneAlive(target: string): Promise<boolean> {
    try {
      await exec(['list-panes', '-t', target]);
      return true;
    } catch {
      return false;
    }
  }

  async function paneCommand(target: string): Promise<string | null> {
    // Deliberately list-panes, not display-message: display-message -p was
    // found (see report) to silently fall back to an unrelated pane, or
    // print nothing, instead of erroring for a missing target. list-panes
    // reliably rejects for a target that doesn't exist.
    try {
      const out = await exec(['list-panes', '-t', target, '-F', '#{pane_current_command}']);
      const first = (out.split('\n')[0] ?? '').trim();
      return first.length > 0 ? first : null;
    } catch {
      return null;
    }
  }

  async function capturePane(target: string, lines?: number): Promise<string> {
    // Full capture, then slice in JS to the tail N lines (chosen over tmux's
    // own `-S -<N>` history-offset option — see report for why).
    const out = await exec(['capture-pane', '-t', target, '-p']);
    if (lines === undefined) return out;
    const rows = out.split('\n');
    return rows.slice(Math.max(0, rows.length - lines)).join('\n');
  }

  return {
    ensureSession,
    listWindows,
    createWindow,
    killWindow,
    sendKeys,
    sendCommand,
    paneAlive,
    paneCommand,
    capturePane,
  };
}

// ── Real exec ─────────────────────────────────────────────────────────────────

/** A real TmuxExec backed by node:child_process, for production use (tests never use this). */
export function realTmuxExec(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('tmux', args, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const stderrText = stderr?.toString().trim();
        reject(new Error(stderrText ? `tmux ${args.join(' ')} failed: ${stderrText}` : error.message));
        return;
      }
      resolve(stdout.toString().trim());
    });
  });
}

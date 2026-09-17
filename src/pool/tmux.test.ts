import { describe, it, expect, vi } from 'vitest';
import { createTmuxController } from './tmux.js';
import type { TmuxExec } from './tmux.js';

// ── ensureSession ────────────────────────────────────────────────────────────

describe('ensureSession', () => {
  it('is idempotent — a second call does not re-create an existing session', async () => {
    const existing = new Set<string>();
    const exec = vi.fn(async (args: string[]): Promise<string> => {
      if (args[0] === 'has-session') {
        const session = args[2] as string;
        if (existing.has(session)) return '';
        throw new Error(`can't find session: ${session}`);
      }
      if (args[0] === 'new-session') {
        const session = args[3] as string; // ['new-session', '-d', '-s', session, '-c', cwd]
        existing.add(session);
        return '';
      }
      throw new Error(`unexpected tmux invocation: ${args.join(' ')}`);
    });
    const tmux = createTmuxController(exec as unknown as TmuxExec);

    await expect(tmux.ensureSession('mysession', '/tmp/proj')).resolves.toBeUndefined();
    await expect(tmux.ensureSession('mysession', '/tmp/proj')).resolves.toBeUndefined();

    const newSessionCalls = exec.mock.calls.filter((call) => call[0][0] === 'new-session');
    const hasSessionCalls = exec.mock.calls.filter((call) => call[0][0] === 'has-session');
    expect(newSessionCalls).toHaveLength(1);
    expect(hasSessionCalls).toHaveLength(2);
  });

  it('creates the session on first use with the expected argv', async () => {
    const exec = vi.fn(async (args: string[]): Promise<string> => {
      if (args[0] === 'has-session') throw new Error("can't find session: fresh");
      return '';
    });
    const tmux = createTmuxController(exec as unknown as TmuxExec);

    await tmux.ensureSession('fresh', '/tmp/proj');

    expect(exec).toHaveBeenCalledWith(['new-session', '-d', '-s', 'fresh', '-c', '/tmp/proj']);
  });
});

// ── listWindows ───────────────────────────────────────────────────────────────

describe('listWindows', () => {
  it('parses a realistic multi-window tmux list-windows output', async () => {
    const raw = '0\tclaude\t0\n1\tshell\t1\n2\twatch\t0\n';
    const exec = vi.fn(async () => raw);
    const tmux = createTmuxController(exec as unknown as TmuxExec);

    const windows = await tmux.listWindows('mysession');

    expect(windows).toEqual([
      { index: 0, name: 'claude', active: false },
      { index: 1, name: 'shell', active: true },
      { index: 2, name: 'watch', active: false },
    ]);
    expect(exec).toHaveBeenCalledWith([
      'list-windows',
      '-t',
      'mysession',
      '-F',
      '#{window_index}\t#{window_name}\t#{window_active}',
    ]);
  });

  it('returns an empty array for a session with no parseable output', async () => {
    const exec = vi.fn(async () => '');
    const tmux = createTmuxController(exec as unknown as TmuxExec);

    await expect(tmux.listWindows('mysession')).resolves.toEqual([]);
  });
});

// ── createWindow ──────────────────────────────────────────────────────────────

describe('createWindow', () => {
  it('emits one -e per env entry and returns the session:name target', async () => {
    const exec = vi.fn(async () => '');
    const tmux = createTmuxController(exec as unknown as TmuxExec);

    const target = await tmux.createWindow('mysession', 'peggy', '/tmp/proj', {
      AGENTBUS_AGENT_ID: 'agent:peggy',
      TERM: 'xterm-256color',
    });

    expect(target).toBe('mysession:peggy');
    expect(exec).toHaveBeenCalledWith([
      'new-window',
      '-t',
      'mysession',
      '-n',
      'peggy',
      '-c',
      '/tmp/proj',
      '-e',
      'AGENTBUS_AGENT_ID=agent:peggy',
      '-e',
      'TERM=xterm-256color',
    ]);
  });

  it('omits -e flags entirely when no env is given', async () => {
    const exec = vi.fn(async () => '');
    const tmux = createTmuxController(exec as unknown as TmuxExec);

    const target = await tmux.createWindow('mysession', 'plain', '/tmp/proj');

    expect(target).toBe('mysession:plain');
    expect(exec).toHaveBeenCalledWith(['new-window', '-t', 'mysession', '-n', 'plain', '-c', '/tmp/proj']);
  });
});

// ── killWindow ────────────────────────────────────────────────────────────────

describe('killWindow', () => {
  it('swallows a "can\'t find window" error instead of throwing', async () => {
    const exec = vi.fn(async () => {
      throw new Error("can't find window: peggy");
    });
    const tmux = createTmuxController(exec as unknown as TmuxExec);

    await expect(tmux.killWindow('mysession:peggy')).resolves.toBeUndefined();
  });

  it('rethrows an unrelated error', async () => {
    const exec = vi.fn(async () => {
      throw new Error('tmux: some other failure');
    });
    const tmux = createTmuxController(exec as unknown as TmuxExec);

    await expect(tmux.killWindow('mysession:peggy')).rejects.toThrow(/some other failure/);
  });
});

// ── sendKeys ──────────────────────────────────────────────────────────────────

describe('sendKeys', () => {
  it('sends the key name as a single argv element with no extra quoting', async () => {
    const exec = vi.fn(async () => '');
    const tmux = createTmuxController(exec as unknown as TmuxExec);

    await tmux.sendKeys('mysession:peggy', 'C-c');

    expect(exec).toHaveBeenCalledWith(['send-keys', '-t', 'mysession:peggy', 'C-c']);
  });
});

// ── sendCommand ───────────────────────────────────────────────────────────────

describe('sendCommand', () => {
  it('rejects a line containing a newline, without calling exec', async () => {
    const exec = vi.fn(async () => '');
    const tmux = createTmuxController(exec as unknown as TmuxExec);

    await expect(tmux.sendCommand('mysession:peggy', 'echo hi\nrm -rf /')).rejects.toThrow();
    expect(exec).not.toHaveBeenCalled();
  });

  it('rejects a line containing a carriage return, without calling exec', async () => {
    const exec = vi.fn(async () => '');
    const tmux = createTmuxController(exec as unknown as TmuxExec);

    await expect(tmux.sendCommand('mysession:peggy', 'echo hi\r')).rejects.toThrow();
    expect(exec).not.toHaveBeenCalled();
  });

  it('rejects a line containing another control character, without calling exec', async () => {
    const exec = vi.fn(async () => '');
    const tmux = createTmuxController(exec as unknown as TmuxExec);

    await expect(tmux.sendCommand('mysession:peggy', 'echo\x07hi')).rejects.toThrow();
    expect(exec).not.toHaveBeenCalled();
  });

  it('sends literal text then a separate Enter key-send, in order', async () => {
    const exec = vi.fn(async () => '');
    const tmux = createTmuxController(exec as unknown as TmuxExec);

    await tmux.sendCommand('mysession:peggy', 'echo "hello world"');

    expect(exec.mock.calls).toEqual([
      [['send-keys', '-t', 'mysession:peggy', '-l', '--', 'echo "hello world"']],
      [['send-keys', '-t', 'mysession:peggy', 'Enter']],
    ]);
  });
});

// ── paneAlive ─────────────────────────────────────────────────────────────────

describe('paneAlive', () => {
  it('returns false (not a thrown error) when exec rejects simulating "no such session"', async () => {
    const exec = vi.fn(async () => {
      throw new Error("can't find session: mysession");
    });
    const tmux = createTmuxController(exec as unknown as TmuxExec);

    await expect(tmux.paneAlive('mysession:peggy')).resolves.toBe(false);
  });

  it('returns true when list-panes succeeds', async () => {
    const exec = vi.fn(async () => '%3');
    const tmux = createTmuxController(exec as unknown as TmuxExec);

    await expect(tmux.paneAlive('mysession:peggy')).resolves.toBe(true);
  });
});

// ── paneCommand ───────────────────────────────────────────────────────────────

describe('paneCommand', () => {
  it('returns null for a missing pane', async () => {
    const exec = vi.fn(async () => {
      throw new Error("can't find window: peggy");
    });
    const tmux = createTmuxController(exec as unknown as TmuxExec);

    await expect(tmux.paneCommand('mysession:peggy')).resolves.toBeNull();
  });

  it('returns the foreground process name for a live pane', async () => {
    const exec = vi.fn(async () => 'claude');
    const tmux = createTmuxController(exec as unknown as TmuxExec);

    await expect(tmux.paneCommand('mysession:peggy')).resolves.toBe('claude');
  });
});

// ── capturePane ───────────────────────────────────────────────────────────────

describe('capturePane', () => {
  it('tails to the last N lines when `lines` is given', async () => {
    const raw = ['line1', 'line2', 'line3', 'line4', 'line5'].join('\n');
    const exec = vi.fn(async () => raw);
    const tmux = createTmuxController(exec as unknown as TmuxExec);

    await expect(tmux.capturePane('mysession:peggy', 2)).resolves.toBe('line4\nline5');
  });

  it('returns the full capture when `lines` is omitted', async () => {
    const raw = ['line1', 'line2'].join('\n');
    const exec = vi.fn(async () => raw);
    const tmux = createTmuxController(exec as unknown as TmuxExec);

    await expect(tmux.capturePane('mysession:peggy')).resolves.toBe(raw);
  });
});

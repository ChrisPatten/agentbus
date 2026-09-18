import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TmuxController } from './tmux.js';
import type { CcPoolInstanceConfig } from '../config/schema.js';
import { writePaneMcpConfig, cleanupPaneMcpConfig } from './mcp-config.js';
import { PaneLifecycle, PaneLaunchError, LAUNCH_READY_TIMEOUT_MS, type LaunchParams } from './pane.js';

// writePaneMcpConfig/cleanupPaneMcpConfig are mocked wholesale (rather than
// exercising the real fs-touching module) — pane.ts's own responsibility is
// calling them at the right times with the right args, not what they do
// internally (that's mcp-config.test.ts's job). The rendered system-prompt
// file, by contrast, is written directly by pane.ts via node:fs, so those
// tests use a real scratch directory and check the real filesystem.
vi.mock('./mcp-config.js', () => ({
  writePaneMcpConfig: vi.fn(),
  cleanupPaneMcpConfig: vi.fn(),
}));

const mockWritePaneMcpConfig = vi.mocked(writePaneMcpConfig);
const mockCleanupPaneMcpConfig = vi.mocked(cleanupPaneMcpConfig);
const FAKE_MCP_CONFIG_PATH = '/scratch/pool-mcp-fake.json';

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** Mirrors pane.ts's own private shellQuoteArg — used to build expected
 * substrings for flag-presence assertions. The escaping algorithm itself is
 * verified independently by the hand-written literal in the "shell quoting"
 * test below, so this duplication doesn't hide a shared bug. */
function q(s: string): string {
  return `'${s.split("'").join("'\\''")}'`;
}

function jsonResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as unknown as Response;
}

/** A capturePane fake whose output never contains the default 'experimental' ack pattern — ack succeeds on the first Enter. */
function makeNoAckCapture() {
  return vi.fn(async () => 'Welcome to Claude Code!\n> ');
}

/** A fetchFn fake that reports readiness (a fresh lastPollAt) on every call. */
function makeReadyFetch() {
  return vi.fn(async () => jsonResponse({ lastPollAt: new Date().toISOString() }));
}

// No explicit return-type annotation: letting TS infer the literal type (each
// property a concrete vi.fn() Mock) keeps `.mock` accessible on every
// property in tests below — annotating this as `TmuxController` would
// collapse every property back to the interface's plain (non-Mock) function
// type. `overrides` is deliberately `any`-valued: any narrower type (e.g.
// `Partial<TmuxController>` or a Mock-typed Record) forms a
// `SpecificMock | Override` union on every merged property (each override key
// is optional), and that union then fails TmuxController's specific method
// signatures when constructing a PaneLifecycle below — a test only ever
// overrides a method with a matching vi.fn(), so the extra precision isn't
// worth the friction.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeTmux(overrides: Record<string, any> = {}) {
  return {
    // Every default declares TmuxController's real parameter list (even
    // though the body ignores them) so `.mock.calls[n]` infers the right
    // tuple type — a zero-arg `vi.fn(async () => {})` would type `calls[0]`
    // as an empty tuple even though it's invoked with real arguments.
    ensureSession: vi.fn(async (_session: string, _cwd: string) => {}),
    listWindows: vi.fn(async (_session: string) => []),
    createWindow: vi.fn(async (session: string, name: string, _cwd: string, _env?: Record<string, string>) => `${session}:${name}`),
    killWindow: vi.fn(async (_target: string) => {}),
    sendKeys: vi.fn(async (_target: string, _keys: string) => {}),
    sendCommand: vi.fn(async (_target: string, _line: string) => {}),
    paneAlive: vi.fn(async (_target: string) => false),
    paneCommand: vi.fn(async (_target: string) => null),
    capturePane: vi.fn(async (_target: string, _lines?: number) => ''),
    ...overrides,
  };
}

function makeCfg(overrides: Partial<CcPoolInstanceConfig> = {}): CcPoolInstanceConfig {
  return {
    name: null,
    agent_id: 'peggy',
    tmux_session: 'peggy-pool',
    panes: 2,
    growth: 'fixed',
    max_panes: 2,
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

function makeLaunchParams(overrides: Partial<LaunchParams> = {}): LaunchParams {
  return {
    paneId: 'peggy-pool:1',
    paneAgentId: 'peggy-pool-1',
    sessionId: '11111111-1111-1111-1111-111111111111',
    resume: false,
    ensureWindow: { cwd: '/work/dir' },
    ...overrides,
  };
}

let scratchDir: string;

beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), 'agentbus-pane-test-'));
  vi.useFakeTimers();
  mockWritePaneMcpConfig.mockReturnValue(FAKE_MCP_CONFIG_PATH);
  mockCleanupPaneMcpConfig.mockReturnValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  rmSync(scratchDir, { recursive: true, force: true });
});

// ── launch(): fresh vs resume ────────────────────────────────────────────────

describe('PaneLifecycle.launch — fresh vs resume', () => {
  it('fresh launch (window absent) creates the window before sending the command, and uses --session-id', async () => {
    const tmux = makeTmux({ paneAlive: vi.fn(async () => false), capturePane: makeNoAckCapture() });
    const fetchFn = makeReadyFetch();
    const pl = new PaneLifecycle({ tmux, busBaseUrl: 'http://127.0.0.1:3000', cfg: makeCfg(), scratchDir, fetchFn });

    const launchPromise = pl.launch(
      makeLaunchParams({ ensureWindow: { cwd: '/work/dir', env: { FOO: 'bar' } } }),
    );
    await vi.advanceTimersByTimeAsync(600);
    await launchPromise;

    expect(tmux.ensureSession).toHaveBeenCalledWith('peggy-pool', '/work/dir');
    expect(tmux.createWindow).toHaveBeenCalledWith('peggy-pool', '1', '/work/dir', {
      FOO: 'bar',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    });

    const createOrder = tmux.createWindow.mock.invocationCallOrder[0]!;
    const sendOrder = tmux.sendCommand.mock.invocationCallOrder[0]!;
    expect(createOrder).toBeLessThan(sendOrder);

    const line = tmux.sendCommand.mock.calls[0]![1] as string;
    expect(line.startsWith('unset TMUX; ')).toBe(true);
    expect(line).toContain(`${q('--session-id')} ${q('11111111-1111-1111-1111-111111111111')}`);
    expect(line).not.toContain(q('--resume'));
    expect(line).toContain(`${q('--mcp-config')} ${q(FAKE_MCP_CONFIG_PATH)} ${q('--strict-mcp-config')}`);
    expect(line).toContain(`${q('--dangerously-load-development-channels')} ${q('server:agentbus')}`);
  });

  it('resume launch (window already alive) skips window creation and uses --resume', async () => {
    const tmux = makeTmux({ paneAlive: vi.fn(async () => true), capturePane: makeNoAckCapture() });
    const fetchFn = makeReadyFetch();
    const pl = new PaneLifecycle({ tmux, busBaseUrl: 'http://127.0.0.1:3000', cfg: makeCfg(), scratchDir, fetchFn });

    const launchPromise = pl.launch(makeLaunchParams({ resume: true, sessionId: 'abc-resume-id' }));
    await vi.advanceTimersByTimeAsync(600);
    await launchPromise;

    expect(tmux.createWindow).not.toHaveBeenCalled();
    expect(tmux.ensureSession).not.toHaveBeenCalled();

    const line = tmux.sendCommand.mock.calls[0]![1] as string;
    expect(line).toContain(`${q('--resume')} ${q('abc-resume-id')}`);
    expect(line).not.toContain(q('--session-id'));
  });
});

// ── launch(): optional flags ─────────────────────────────────────────────────

describe('PaneLifecycle.launch — optional flags', () => {
  it('includes --model only when cfg.model is set', async () => {
    const tmuxWith = makeTmux({ capturePane: makeNoAckCapture() });
    const plWith = new PaneLifecycle({
      tmux: tmuxWith,
      busBaseUrl: 'http://x',
      cfg: makeCfg({ model: 'claude-sonnet-5' }),
      scratchDir,
      fetchFn: makeReadyFetch(),
    });
    const withPromise = plWith.launch(makeLaunchParams());
    await vi.advanceTimersByTimeAsync(600);
    await withPromise;
    expect(tmuxWith.sendCommand.mock.calls[0]![1] as string).toContain(`${q('--model')} ${q('claude-sonnet-5')}`);

    const tmuxWithout = makeTmux({ capturePane: makeNoAckCapture() });
    const plWithout = new PaneLifecycle({
      tmux: tmuxWithout,
      busBaseUrl: 'http://x',
      cfg: makeCfg({ model: undefined }),
      scratchDir,
      fetchFn: makeReadyFetch(),
    });
    const withoutPromise = plWithout.launch(makeLaunchParams());
    await vi.advanceTimersByTimeAsync(600);
    await withoutPromise;
    expect(tmuxWithout.sendCommand.mock.calls[0]![1] as string).not.toContain(q('--model'));
  });

  it('includes --append-system-prompt-file only when cfg.system_prompt is set', async () => {
    const tmuxWith = makeTmux({ capturePane: makeNoAckCapture() });
    const plWith = new PaneLifecycle({
      tmux: tmuxWith,
      busBaseUrl: 'http://x',
      cfg: makeCfg({ system_prompt: 'You are {{agent_id}}.' }),
      scratchDir,
      fetchFn: makeReadyFetch(),
    });
    const withPromise = plWith.launch(makeLaunchParams());
    await vi.advanceTimersByTimeAsync(600);
    await withPromise;
    const lineWith = tmuxWith.sendCommand.mock.calls[0]![1] as string;
    expect(lineWith).toContain(q('--append-system-prompt-file'));
    expect(lineWith).toContain(scratchDir); // rendered prompt file lives under scratchDir

    const tmuxWithout = makeTmux({ capturePane: makeNoAckCapture() });
    const plWithout = new PaneLifecycle({
      tmux: tmuxWithout,
      busBaseUrl: 'http://x',
      cfg: makeCfg({ system_prompt: undefined }),
      scratchDir,
      fetchFn: makeReadyFetch(),
    });
    const withoutPromise = plWithout.launch(makeLaunchParams());
    await vi.advanceTimersByTimeAsync(600);
    await withoutPromise;
    expect(tmuxWithout.sendCommand.mock.calls[0]![1] as string).not.toContain(q('--append-system-prompt-file'));
  });

  it('appends cfg.launch_args verbatim, each individually shell-quoted, after the dev-channels pair', async () => {
    const tmux = makeTmux({ capturePane: makeNoAckCapture() });
    const cfg = makeCfg({ launch_args: ['--add-dir', '/extra/dir', '--verbose'] });
    const pl = new PaneLifecycle({ tmux, busBaseUrl: 'http://x', cfg, scratchDir, fetchFn: makeReadyFetch() });

    const launchPromise = pl.launch(makeLaunchParams());
    await vi.advanceTimersByTimeAsync(600);
    await launchPromise;

    const line = tmux.sendCommand.mock.calls[0]![1] as string;
    for (const arg of cfg.launch_args) {
      expect(line).toContain(q(arg));
    }
    expect(line.trimEnd().endsWith(`${q('--add-dir')} ${q('/extra/dir')} ${q('--verbose')}`)).toBe(true);
  });

  it('shell-quotes an awkward launch_arg containing a single quote and spaces', async () => {
    const tmux = makeTmux({ capturePane: makeNoAckCapture() });
    const awkward = `it's a "weird" value with spaces`;
    const cfg = makeCfg({ launch_args: [awkward] });
    const pl = new PaneLifecycle({ tmux, busBaseUrl: 'http://x', cfg, scratchDir, fetchFn: makeReadyFetch() });

    const launchPromise = pl.launch(makeLaunchParams());
    await vi.advanceTimersByTimeAsync(600);
    await launchPromise;

    const line = tmux.sendCommand.mock.calls[0]![1] as string;
    // 'it's a "weird" value with spaces' -> 'it'\''s a "weird" value with spaces'
    expect(line).toContain(`'it'\\''s a "weird" value with spaces'`);
  });
});

// ── launch(): ack handshake ──────────────────────────────────────────────────

describe('PaneLifecycle.launch — ack handshake', () => {
  it('retries Enter until the ack pattern clears, then proceeds to readiness', async () => {
    const captures = ['Do you want to enable this experimental MCP channel?', 'Welcome! Ready.'];
    const capturePane = vi.fn(async () => captures.shift()!);
    const tmux = makeTmux({ capturePane });
    const pl = new PaneLifecycle({
      tmux,
      busBaseUrl: 'http://x',
      cfg: makeCfg(),
      scratchDir,
      fetchFn: makeReadyFetch(),
    });

    const launchPromise = pl.launch(makeLaunchParams());
    await vi.advanceTimersByTimeAsync(2000);
    await expect(launchPromise).resolves.toBeUndefined();

    expect(tmux.sendKeys).toHaveBeenCalledTimes(2);
    expect(tmux.sendKeys).toHaveBeenNthCalledWith(1, 'peggy-pool:1', 'Enter');
    expect(tmux.sendKeys).toHaveBeenNthCalledWith(2, 'peggy-pool:1', 'Enter');
  });

  it('throws PaneLaunchError when the ack pattern never clears, and never polls readiness', async () => {
    const capturePane = vi.fn(async () => 'still experimental, please confirm');
    const tmux = makeTmux({ capturePane });
    const fetchFn = vi.fn();
    const pl = new PaneLifecycle({
      tmux,
      busBaseUrl: 'http://x',
      cfg: makeCfg({ launch_ack_max_attempts: 3 }),
      scratchDir,
      fetchFn,
    });

    const launchPromise = pl.launch(makeLaunchParams());
    const assertion = expect(launchPromise).rejects.toThrow(PaneLaunchError);
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;

    expect(tmux.sendKeys).toHaveBeenCalledTimes(3);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

// ── launch(): readiness poll ─────────────────────────────────────────────────

describe('PaneLifecycle.launch — readiness poll', () => {
  it('retries while lastPollAt is null, then resolves once a fresh timestamp appears', async () => {
    const tmux = makeTmux({ capturePane: makeNoAckCapture() });
    const fetchFn = vi
      .fn()
      .mockImplementationOnce(async () => jsonResponse({ lastPollAt: null }))
      .mockImplementationOnce(async () => jsonResponse({ lastPollAt: null }))
      .mockImplementationOnce(async () => jsonResponse({ lastPollAt: new Date().toISOString() }));
    const pl = new PaneLifecycle({
      tmux,
      busBaseUrl: 'http://x',
      cfg: makeCfg(),
      scratchDir,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    const launchPromise = pl.launch(makeLaunchParams({ paneAgentId: 'peggy-pool-1' }));
    await vi.advanceTimersByTimeAsync(3000);
    await expect(launchPromise).resolves.toBeUndefined();

    expect(fetchFn.mock.calls.length).toBeGreaterThan(1);
    expect(fetchFn).toHaveBeenCalledWith('http://x/api/v1/agents/peggy-pool-1/last-poll');
  });

  it('treats a stale lastPollAt (older than this launch attempt) as not-ready', async () => {
    const tmux = makeTmux({ capturePane: makeNoAckCapture() });
    const beforeLaunch = Date.now();
    const staleIso = new Date(beforeLaunch - 60_000).toISOString(); // 60s before this launch even started

    const fetchFn = vi
      .fn()
      .mockImplementationOnce(async () => jsonResponse({ lastPollAt: staleIso }))
      .mockImplementationOnce(async () => jsonResponse({ lastPollAt: staleIso }))
      .mockImplementationOnce(async () => jsonResponse({ lastPollAt: new Date().toISOString() }));
    const pl = new PaneLifecycle({
      tmux,
      busBaseUrl: 'http://x',
      cfg: makeCfg(),
      scratchDir,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    const launchPromise = pl.launch(makeLaunchParams());
    await vi.advanceTimersByTimeAsync(3000);
    await expect(launchPromise).resolves.toBeUndefined();

    // Did NOT resolve on the stale reading — kept polling until the fresh one.
    expect(fetchFn.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('throws PaneLaunchError if readiness is never achieved within LAUNCH_READY_TIMEOUT_MS', async () => {
    const tmux = makeTmux({ capturePane: makeNoAckCapture() });
    const fetchFn = vi.fn(async () => jsonResponse({ lastPollAt: null }));
    const pl = new PaneLifecycle({ tmux, busBaseUrl: 'http://x', cfg: makeCfg(), scratchDir, fetchFn });

    const launchPromise = pl.launch(makeLaunchParams());
    const assertion = expect(launchPromise).rejects.toThrow(PaneLaunchError);
    await vi.advanceTimersByTimeAsync(LAUNCH_READY_TIMEOUT_MS + 5_000);
    await assertion;
  });
});

// ── launch(): temp file cleanup ──────────────────────────────────────────────

describe('PaneLifecycle.launch — temp file cleanup', () => {
  it('calls writePaneMcpConfig and cleanupPaneMcpConfig exactly once on a successful launch', async () => {
    const tmux = makeTmux({ capturePane: makeNoAckCapture() });
    const pl = new PaneLifecycle({
      tmux,
      busBaseUrl: 'http://x',
      cfg: makeCfg(),
      scratchDir,
      fetchFn: makeReadyFetch(),
    });

    const launchPromise = pl.launch(makeLaunchParams());
    await vi.advanceTimersByTimeAsync(600);
    await launchPromise;

    expect(mockWritePaneMcpConfig).toHaveBeenCalledTimes(1);
    expect(mockCleanupPaneMcpConfig).toHaveBeenCalledTimes(1);
    expect(mockCleanupPaneMcpConfig).toHaveBeenCalledWith(FAKE_MCP_CONFIG_PATH);
  });

  it('still cleans up when the ack handshake throws (partial-failure cleanup)', async () => {
    const capturePane = vi.fn(async () => 'still experimental');
    const tmux = makeTmux({ capturePane });
    const pl = new PaneLifecycle({
      tmux,
      busBaseUrl: 'http://x',
      cfg: makeCfg({ launch_ack_max_attempts: 2 }),
      scratchDir,
      fetchFn: vi.fn(),
    });

    const launchPromise = pl.launch(makeLaunchParams());
    const assertion = expect(launchPromise).rejects.toThrow(PaneLaunchError);
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;

    expect(mockWritePaneMcpConfig).toHaveBeenCalledTimes(1);
    expect(mockCleanupPaneMcpConfig).toHaveBeenCalledTimes(1);
  });

  it('still cleans up the rendered system-prompt file when the readiness poll times out', async () => {
    const tmux = makeTmux({ capturePane: makeNoAckCapture() });
    const fetchFn = vi.fn(async () => jsonResponse({ lastPollAt: null }));
    const pl = new PaneLifecycle({
      tmux,
      busBaseUrl: 'http://x',
      cfg: makeCfg({ system_prompt: 'Hello {{agent_id}}' }),
      scratchDir,
      fetchFn,
    });

    const launchPromise = pl.launch(makeLaunchParams());
    const assertion = expect(launchPromise).rejects.toThrow(PaneLaunchError);
    await vi.advanceTimersByTimeAsync(LAUNCH_READY_TIMEOUT_MS + 5_000);
    await assertion;

    expect(mockCleanupPaneMcpConfig).toHaveBeenCalledTimes(1);
    const leftoverPromptFiles = readdirSync(scratchDir).filter((f) => f.startsWith('pool-prompt-'));
    expect(leftoverPromptFiles).toEqual([]);
  });
});

// ── release() ─────────────────────────────────────────────────────────────────

describe('PaneLifecycle.release', () => {
  it("on_evict 'clear' sends /clear and never kills the window", async () => {
    const tmux = makeTmux();
    const pl = new PaneLifecycle({ tmux, busBaseUrl: 'http://x', cfg: makeCfg(), scratchDir });

    await pl.release('peggy-pool:1', 'clear');

    expect(tmux.sendCommand).toHaveBeenCalledWith('peggy-pool:1', '/clear');
    expect(tmux.killWindow).not.toHaveBeenCalled();
    expect(tmux.sendKeys).not.toHaveBeenCalled();
  });

  it("on_evict 'kill' sends C-c, pauses, then kills the window, in that order", async () => {
    const tmux = makeTmux();
    const sleepFn = vi.fn(async () => {});
    const pl = new PaneLifecycle({ tmux, busBaseUrl: 'http://x', cfg: makeCfg(), scratchDir, sleepFn });

    await pl.release('peggy-pool:1', 'kill');

    expect(tmux.sendKeys).toHaveBeenCalledWith('peggy-pool:1', 'C-c');
    expect(sleepFn).toHaveBeenCalledWith(300);
    expect(tmux.killWindow).toHaveBeenCalledWith('peggy-pool:1');
    expect(tmux.sendCommand).not.toHaveBeenCalled();

    const sendKeysOrder = tmux.sendKeys.mock.invocationCallOrder[0]!;
    const killOrder = tmux.killWindow.mock.invocationCallOrder[0]!;
    expect(sendKeysOrder).toBeLessThan(killOrder);
  });
});

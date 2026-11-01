import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, writeFileSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TmuxController } from './tmux.js';
import type { CcPoolInstanceConfig } from '../config/schema.js';
import { writePaneMcpConfig, cleanupPaneMcpConfig } from './mcp-config.js';
import { PaneLifecycle, PaneLaunchError, LAUNCH_READY_TIMEOUT_MS, INHERITED_CLAUDE_SESSION_VARS, dedupeDevChannelsArgs, isShellCommand, SHELL_PROBE_LINE_RE, SHELL_PROBE_MAX_MS, shellProbeMarker, type LaunchParams } from './pane.js';
import { getRegisteredLaunch, resetAgentLivenessForTests } from '../http/agent-liveness.js';

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

/** A capturePane fake whose output never contains makeCfg()'s 'experimental' ack pattern (a stand-in test value — see makeCfg below; the real schema default is 'loading development channels', src/config/schema.ts) — ack succeeds on the first Enter. */
function makeNoAckCapture() {
  return vi.fn(async () => 'Welcome to Claude Code!\n> ');
}

/**
 * A `/last-poll` body: `lastPollAt` as given, and (E88) the launch id
 * currently registered for `agent` as `lastLaunchId` — i.e. the poll came
 * from this launch's own claude. Read at call time, after `launch()` has
 * registered its id.
 */
function pollBody(lastPollAt: string | null, agent = 'peggy-pool-1') {
  return { lastPollAt, lastLaunchId: getRegisteredLaunch(agent) };
}

/** E88 — `sendCommand` calls that are not the shell-readiness probe (i.e. launch lines, `/clear`, ...). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function nonProbeCalls(tmux: { sendCommand: { mock: { calls: any[][] } } }): Array<[string, string]> {
  return tmux.sendCommand.mock.calls.filter((c) => !SHELL_PROBE_LINE_RE.test(String(c[1]))) as Array<[string, string]>;
}

/** The launch line typed by `launch()` (the first non-probe `sendCommand`). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function launchLine(tmux: { sendCommand: { mock: { calls: any[][] } } }): string {
  const call = nonProbeCalls(tmux)[0];
  if (!call) throw new Error('no launch line was typed');
  return call[1];
}

/** invocationCallOrder of the first non-probe `sendCommand` call. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function launchLineOrder(tmux: { sendCommand: { mock: { calls: any[][]; invocationCallOrder: number[] } } }): number {
  const idx = tmux.sendCommand.mock.calls.findIndex((c) => !SHELL_PROBE_LINE_RE.test(String(c[1])));
  return tmux.sendCommand.mock.invocationCallOrder[idx]!;
}

/** A fetchFn fake that reports readiness (a fresh lastPollAt) on every call. */
function makeReadyFetch() {
  return vi.fn(async () => jsonResponse(pollBody(new Date().toISOString())));
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
  // E88 — the fake pane plays a shell that answers the readiness probe: a
  // typed probe line makes the next capture show its marker. That capture is
  // answered here, without calling an overriding `capturePane`, so a test's
  // own capture fake sees exactly the calls it saw before the probe existed.
  // Pass `shellAnswersProbe: false` for a shell that never answers.
  const { shellAnswersProbe = true, ...rest } = overrides;
  const baseCapture = rest.capturePane ?? (async (_target: string, _lines?: number) => '');
  const baseSend = rest.sendCommand ?? (async (_target: string, _line: string) => {});
  let pendingMarker: string | null = null;
  delete rest.capturePane;
  delete rest.sendCommand;
  const base = {
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
    paneCommand: vi.fn(async (_target: string): Promise<string | null> => 'zsh'),
    capturePane: vi.fn(async (target: string, lines?: number): Promise<string> => {
      if (pendingMarker !== null) {
        const marker = pendingMarker;
        pendingMarker = null;
        return marker;
      }
      return baseCapture(target, lines);
    }),
    ...rest,
  };
  base.sendCommand = vi.fn(async (target: string, line: string) => {
    const probe = SHELL_PROBE_LINE_RE.exec(line);
    if (probe) {
      if (shellAnswersProbe) pendingMarker = shellProbeMarker(probe[1]!);
      return;
    }
    return baseSend(target, line);
  });
  return base;
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
  resetAgentLivenessForTests();
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
    await vi.advanceTimersByTimeAsync(2000);
    await launchPromise;

    expect(tmux.ensureSession).toHaveBeenCalledWith('peggy-pool', '/work/dir');
    expect(tmux.createWindow).toHaveBeenCalledWith('peggy-pool', '1', '/work/dir', {
      FOO: 'bar',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    });

    const createOrder = tmux.createWindow.mock.invocationCallOrder[0]!;
    const sendOrder = launchLineOrder(tmux);
    expect(createOrder).toBeLessThan(sendOrder);

    const line = launchLine(tmux);
    expect(line.startsWith(`unset TMUX ${INHERITED_CLAUDE_SESSION_VARS.join(' ')}; `)).toBe(true);
    expect(line).toContain('unset TMUX CLAUDECODE CLAUDE_CODE_CHILD_SESSION ');
    expect(line).toContain('export CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1; ');
    expect(line).toContain(`${q('--session-id')} ${q('11111111-1111-1111-1111-111111111111')}`);
    expect(line).not.toContain(q('--resume'));
    expect(line).toContain(`${q('--mcp-config')} ${q(FAKE_MCP_CONFIG_PATH)} ${q('--strict-mcp-config')}`);
    expect(line).toContain(`${q('--dangerously-load-development-channels')} ${q('server:agentbus')}`);
  });

  it('waits for a new window\'s shell output to settle before sending the launch line', async () => {
    const outputs = ['', 'direnv: loading', 'direnv: loading\n$ '];
    let i = 0;
    const capturePane = vi.fn(async () => outputs[Math.min(i++, outputs.length - 1)]!);
    const tmux = makeTmux({ paneAlive: vi.fn(async () => false), capturePane });
    const pl = new PaneLifecycle({ tmux, busBaseUrl: 'http://x', cfg: makeCfg(), scratchDir, fetchFn: makeReadyFetch() });

    const launchPromise = pl.launch(makeLaunchParams());
    await vi.advanceTimersByTimeAsync(500);
    expect(tmux.sendCommand).not.toHaveBeenCalled(); // still printing

    await vi.advanceTimersByTimeAsync(5000);
    await launchPromise;
    expect(nonProbeCalls(tmux)).toHaveLength(1);
  });

  it('resume launch (window already alive at a shell) skips window creation and uses --resume', async () => {
    const tmux = makeTmux({ paneAlive: vi.fn(async () => true), capturePane: makeNoAckCapture() });
    const fetchFn = makeReadyFetch();
    const pl = new PaneLifecycle({ tmux, busBaseUrl: 'http://127.0.0.1:3000', cfg: makeCfg(), scratchDir, fetchFn });

    const launchPromise = pl.launch(makeLaunchParams({ resume: true, sessionId: 'abc-resume-id' }));
    await vi.advanceTimersByTimeAsync(2000);
    await launchPromise;

    expect(tmux.createWindow).not.toHaveBeenCalled();
    expect(tmux.ensureSession).not.toHaveBeenCalled();
    expect(tmux.killWindow).not.toHaveBeenCalled();

    const line = launchLine(tmux);
    expect(line).toContain(`${q('--resume')} ${q('abc-resume-id')}`);
    expect(line).not.toContain(q('--session-id'));
  });

  it('treats a login shell ("-zsh") as a shell and reuses the window', async () => {
    const tmux = makeTmux({
      paneAlive: vi.fn(async () => true),
      paneCommand: vi.fn(async () => '-zsh'),
      capturePane: makeNoAckCapture(),
    });
    const pl = new PaneLifecycle({ tmux, busBaseUrl: 'http://127.0.0.1:3000', cfg: makeCfg(), scratchDir, fetchFn: makeReadyFetch() });

    const launchPromise = pl.launch(makeLaunchParams());
    await vi.advanceTimersByTimeAsync(2000);
    await launchPromise;

    expect(tmux.killWindow).not.toHaveBeenCalled();
    expect(tmux.createWindow).not.toHaveBeenCalled();
  });

  // The launch line typed into a running Claude TUI is submitted as a chat
  // message, so a live window is only reused when it sits at a shell.
  it.each(['claude', 'node', '2.1.274', null])(
    'recreates a live window whose foreground command is %s before sending the launch line',
    async (command) => {
      const tmux = makeTmux({
        paneAlive: vi.fn(async () => true),
        paneCommand: vi.fn(async () => command),
        capturePane: makeNoAckCapture(),
      });
      const pl = new PaneLifecycle({ tmux, busBaseUrl: 'http://127.0.0.1:3000', cfg: makeCfg(), scratchDir, fetchFn: makeReadyFetch() });

      const launchPromise = pl.launch(makeLaunchParams({ resume: true, sessionId: 'abc-resume-id' }));
      await vi.advanceTimersByTimeAsync(2000);
      await launchPromise;

      expect(tmux.killWindow).toHaveBeenCalledWith('peggy-pool:1');
      expect(tmux.createWindow).toHaveBeenCalledWith('peggy-pool', '1', '/work/dir', {
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
      });
      expect(nonProbeCalls(tmux)).toHaveLength(1);

      const killOrder = tmux.killWindow.mock.invocationCallOrder[0]!;
      const createOrder = tmux.createWindow.mock.invocationCallOrder[0]!;
      const sendOrder = launchLineOrder(tmux);
      expect(killOrder).toBeLessThan(createOrder);
      expect(createOrder).toBeLessThan(sendOrder);
    },
  );
});

// ── launch(): optional flags ─────────────────────────────────────────────────

describe('PaneLifecycle.launch — optional flags', () => {
  it('includes --model only when LaunchParams.model is set (E53: resolved by the caller, not read from cfg.model)', async () => {
    const tmuxWith = makeTmux({ capturePane: makeNoAckCapture() });
    const plWith = new PaneLifecycle({
      tmux: tmuxWith,
      busBaseUrl: 'http://x',
      cfg: makeCfg({ model: undefined }),
      scratchDir,
      fetchFn: makeReadyFetch(),
    });
    const withPromise = plWith.launch(makeLaunchParams({ model: 'claude-sonnet-5' }));
    await vi.advanceTimersByTimeAsync(2000);
    await withPromise;
    expect(launchLine(tmuxWith)).toContain(`${q('--model')} ${q('claude-sonnet-5')}`);

    const tmuxWithout = makeTmux({ capturePane: makeNoAckCapture() });
    const plWithout = new PaneLifecycle({
      tmux: tmuxWithout,
      busBaseUrl: 'http://x',
      cfg: makeCfg({ model: 'claude-sonnet-5' }),
      scratchDir,
      fetchFn: makeReadyFetch(),
    });
    const withoutPromise = plWithout.launch(makeLaunchParams({ model: undefined }));
    await vi.advanceTimersByTimeAsync(2000);
    await withoutPromise;
    // cfg.model is set here but LaunchParams.model is not — confirms
    // buildLaunchLine() no longer falls back to cfg.model directly; the
    // caller (PoolManager) is solely responsible for resolving it.
    expect(launchLine(tmuxWithout)).not.toContain(q('--model'));
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
    await vi.advanceTimersByTimeAsync(2000);
    await withPromise;
    const lineWith = launchLine(tmuxWith);
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
    await vi.advanceTimersByTimeAsync(2000);
    await withoutPromise;
    expect(launchLine(tmuxWithout)).not.toContain(q('--append-system-prompt-file'));
  });

  it('appends cfg.launch_args verbatim, each individually shell-quoted, after the dev-channels pair', async () => {
    const tmux = makeTmux({ capturePane: makeNoAckCapture() });
    const cfg = makeCfg({ launch_args: ['--add-dir', '/extra/dir', '--verbose'] });
    const pl = new PaneLifecycle({ tmux, busBaseUrl: 'http://x', cfg, scratchDir, fetchFn: makeReadyFetch() });

    const launchPromise = pl.launch(makeLaunchParams());
    await vi.advanceTimersByTimeAsync(2000);
    await launchPromise;

    const line = launchLine(tmux);
    for (const arg of cfg.launch_args) {
      expect(line).toContain(q(arg));
    }
    expect(line.trimEnd().endsWith(`${q('--add-dir')} ${q('/extra/dir')} ${q('--verbose')}`)).toBe(true);
  });

  it('does not repeat --dangerously-load-development-channels when launch_args already has it', async () => {
    const tmux = makeTmux({ capturePane: makeNoAckCapture() });
    const cfg = makeCfg({ launch_args: ['--dangerously-load-development-channels', '--verbose'] });
    const pl = new PaneLifecycle({ tmux, busBaseUrl: 'http://x', cfg, scratchDir, fetchFn: makeReadyFetch() });

    const launchPromise = pl.launch(makeLaunchParams());
    await vi.advanceTimersByTimeAsync(2000);
    await launchPromise;

    const line = launchLine(tmux);
    expect(line.split(q('--dangerously-load-development-channels')).length - 1).toBe(1);
    expect(line).toContain(`${q('--dangerously-load-development-channels')} ${q('server:agentbus')}`);
    expect(line.trimEnd().endsWith(q('--verbose'))).toBe(true);
  });

  it('native memory (E67): adds --settings autoMemoryDirectory and unsets CLAUDE_CODE_DISABLE_AUTO_MEMORY', async () => {
    const tmux = makeTmux({ capturePane: makeNoAckCapture() });
    const pl = new PaneLifecycle({ tmux, busBaseUrl: 'http://x', cfg: makeCfg(), scratchDir, fetchFn: makeReadyFetch(), autoMemoryDir: '/agents/peggy/memory' });
    const launchPromise = pl.launch(makeLaunchParams());
    await vi.advanceTimersByTimeAsync(2000);
    await launchPromise;
    const line = launchLine(tmux);
    expect(line).toContain(`${q('--settings')} ${q('{"autoMemoryDirectory":"/agents/peggy/memory"}')}`);
    expect(line.split(';')[0]).toContain('CLAUDE_CODE_DISABLE_AUTO_MEMORY');

    // An operator's own --settings in launch_args wins; no second one is added.
    const tmux2 = makeTmux({ capturePane: makeNoAckCapture() });
    const cfg2 = makeCfg({ launch_args: ['--settings', '/my/settings.json'] });
    const pl2 = new PaneLifecycle({ tmux: tmux2, busBaseUrl: 'http://x', cfg: cfg2, scratchDir, fetchFn: makeReadyFetch(), autoMemoryDir: '/m' });
    const p2 = pl2.launch(makeLaunchParams());
    await vi.advanceTimersByTimeAsync(2000);
    await p2;
    const line2 = launchLine(tmux2);
    expect(line2.split(q('--settings')).length - 1).toBe(1);
    expect(line2).not.toContain('autoMemoryDirectory');
  });

  it('without autoMemoryDir the launch line has no --settings', async () => {
    const tmux = makeTmux({ capturePane: makeNoAckCapture() });
    const pl = new PaneLifecycle({ tmux, busBaseUrl: 'http://x', cfg: makeCfg(), scratchDir, fetchFn: makeReadyFetch() });
    const launchPromise = pl.launch(makeLaunchParams());
    await vi.advanceTimersByTimeAsync(2000);
    await launchPromise;
    const line = launchLine(tmux);
    expect(line).not.toContain('--settings');
    expect(line).not.toContain('CLAUDE_CODE_DISABLE_AUTO_MEMORY');
  });

  it('dedupeDevChannelsArgs drops the flag and server:agentbus forms, keeps other channels', () => {
    expect(dedupeDevChannelsArgs(['--dangerously-load-development-channels'])).toEqual([]);
    expect(dedupeDevChannelsArgs(['--dangerously-load-development-channels', 'server:agentbus', '-v'])).toEqual(['-v']);
    expect(dedupeDevChannelsArgs(['--dangerously-load-development-channels=server:agentbus'])).toEqual([]);
    expect(dedupeDevChannelsArgs(['--dangerously-load-development-channels', 'server:other'])).toEqual([
      '--dangerously-load-development-channels', 'server:other',
    ]);
    expect(dedupeDevChannelsArgs(['--add-dir', '/x'])).toEqual(['--add-dir', '/x']);
  });

  it('shell-quotes an awkward launch_arg containing a single quote and spaces', async () => {
    const tmux = makeTmux({ capturePane: makeNoAckCapture() });
    const awkward = `it's a "weird" value with spaces`;
    const cfg = makeCfg({ launch_args: [awkward] });
    const pl = new PaneLifecycle({ tmux, busBaseUrl: 'http://x', cfg, scratchDir, fetchFn: makeReadyFetch() });

    const launchPromise = pl.launch(makeLaunchParams());
    await vi.advanceTimersByTimeAsync(2000);
    await launchPromise;

    const line = launchLine(tmux);
    // 'it's a "weird" value with spaces' -> 'it'\''s a "weird" value with spaces'
    expect(line).toContain(`'it'\\''s a "weird" value with spaces'`);
  });
});

// ── launch(): ack handshake ──────────────────────────────────────────────────

describe('PaneLifecycle.launch — ack handshake', () => {
  it('never presses Enter when the ack pattern never appears (nothing to dismiss)', async () => {
    // Regression coverage for the redesigned handshake's "no-op" path: a
    // prompt that never renders (e.g. a CLI/flag combination that skips the
    // warning) must not get a speculative Enter pressed into it.
    const capturePane = makeNoAckCapture();
    const tmux = makeTmux({ paneAlive: vi.fn(async () => true), capturePane });
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

    expect(tmux.sendKeys).not.toHaveBeenCalled();
  });

  it(
    'does NOT declare the prompt dismissed while it has merely not rendered yet — waits for it to ' +
      'actually appear before pressing Enter at all (regression: fix/pool-launch-ack-and-timeout, 3rd bug)',
    async () => {
      // Reproduces, with mocked capturePane responses standing in for the
      // real CLI's render lag, the exact defect found by end-to-end testing
      // against the real `claude` binary: the OLD ackHandshake sent a blind
      // Enter after a fixed delay and treated the ack pattern's ABSENCE from
      // capturePane as proof of dismissal — indistinguishable from "hasn't
      // rendered yet" when the delay is shorter than the CLI's actual render
      // time (measured ~1.0-1.6s against real tmux + real claude, v2.1.274-276
      // — see this story's report). That bug pressed exactly one premature
      // Enter into a still-loading pane, declared success, and then the real
      // prompt rendered moments later and was never dismissed by anything.
      //
      // Here, the first two capturePane checks simulate a still-loading pane
      // (no pattern — nothing rendered yet, NOT "already dismissed"); the
      // third simulates the prompt actually rendering. The handshake must
      // keep polling through the first two absences without pressing Enter,
      // only press it once the prompt is confirmed showing, and then confirm
      // dismissal.
      const captures = ['', 'unset TMUX; claude ...', 'confirm this experimental channel warning', 'Welcome! Ready.'];
      const capturePane = vi.fn(async () => captures.shift()!);
      const tmux = makeTmux({ paneAlive: vi.fn(async () => true), capturePane });
      const pl = new PaneLifecycle({
        tmux,
        busBaseUrl: 'http://x',
        cfg: makeCfg({ launch_ack_delay_ms: 2000 }),
        scratchDir,
        // Not polling the bus until the prompt has been dismissed.
        fetchFn: vi.fn(async () =>
          jsonResponse(pollBody(tmux.sendKeys.mock.calls.length > 0 ? new Date().toISOString() : null)),
        ),
      });

      const launchPromise = pl.launch(makeLaunchParams());
      await vi.advanceTimersByTimeAsync(3000);
      await expect(launchPromise).resolves.toBeUndefined();

      // Exactly one Enter — pressed only after the prompt was confirmed
      // showing (the 3rd capturePane call), not during either of the two
      // "not rendered yet" checks that preceded it.
      expect(tmux.sendKeys).toHaveBeenCalledTimes(1);
      expect(tmux.sendKeys).toHaveBeenCalledWith('peggy-pool:1', 'Enter');
      expect(capturePane).toHaveBeenCalledTimes(4);
    },
  );

  it('retries Enter if a dismiss attempt does not clear the prompt, then succeeds', async () => {
    // Prompt confirmed present immediately; first dismiss Enter doesn't
    // clear it (still showing); second dismiss Enter does.
    const captures = ['this experimental channel warning', 'this experimental channel warning', 'Welcome! Ready.'];
    const capturePane = vi.fn(async () => captures.shift()!);
    const tmux = makeTmux({ paneAlive: vi.fn(async () => true), capturePane });
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

  it('still dismisses a prompt that renders after launch_ack_delay_ms (slow start)', async () => {
    // 6s of "nothing yet" is past the old 5s-style window; the prompt must still be found.
    let captureCalls = 0;
    const capturePane = vi.fn(async () => {
      captureCalls++;
      if (captureCalls <= 12) return 'loading...';
      return captureCalls === 13 ? 'this experimental channel warning' : 'Welcome! Ready.';
    });
    const tmux = makeTmux({ paneAlive: vi.fn(async () => true), capturePane });
    const pl = new PaneLifecycle({
      tmux,
      busBaseUrl: 'http://x',
      cfg: makeCfg({ launch_ack_delay_ms: 500 }),
      scratchDir,
      fetchFn: vi.fn(async () =>
        jsonResponse(pollBody(tmux.sendKeys.mock.calls.length > 0 ? new Date().toISOString() : null)),
      ),
    });

    const launchPromise = pl.launch(makeLaunchParams());
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(launchPromise).resolves.toBeUndefined();

    expect(tmux.sendKeys).toHaveBeenCalledTimes(1);
  });

  it('throws PaneLaunchError when the ack pattern never clears, and never polls readiness', async () => {
    const capturePane = vi.fn(async () => 'still experimental, please confirm');
    const tmux = makeTmux({ paneAlive: vi.fn(async () => true), capturePane });
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
      .mockImplementationOnce(async () => jsonResponse(pollBody(null)))
      .mockImplementationOnce(async () => jsonResponse(pollBody(null)))
      .mockImplementation(async () => jsonResponse(pollBody(new Date().toISOString())));
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
      .mockImplementationOnce(async () => jsonResponse(pollBody(staleIso)))
      .mockImplementationOnce(async () => jsonResponse(pollBody(staleIso)))
      .mockImplementation(async () => jsonResponse(pollBody(new Date().toISOString())));
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
    const fetchFn = vi.fn(async () => jsonResponse(pollBody(null)));
    const pl = new PaneLifecycle({ tmux, busBaseUrl: 'http://x', cfg: makeCfg(), scratchDir, fetchFn });

    const launchPromise = pl.launch(makeLaunchParams());
    const assertion = expect(launchPromise).rejects.toThrow(PaneLaunchError);
    await vi.advanceTimersByTimeAsync(LAUNCH_READY_TIMEOUT_MS + 5_000);
    await assertion;
  });

  it('throws PaneLaunchError within LAUNCH_READY_TIMEOUT_MS even when an individual isReady() fetch call never settles', async () => {
    // Regression test for the real production defect (fix/pool-launch-ack-
    // and-timeout): the old `pollReadiness` implementation only re-checked
    // `elapsedSince(launchStartedAt) >= LAUNCH_READY_TIMEOUT_MS` BETWEEN loop
    // iterations — it unconditionally `await`ed `isReady()` (and therefore
    // this `fetchFn`) first. A `fetchFn` whose promise never resolves or
    // rejects (a stalled `/last-poll` request against bus-core's own HTTP
    // server — this loop is calling back into the same process that's
    // running it) meant control never returned to the top of the loop to
    // re-evaluate the deadline at all, so `launch()` itself never returned —
    // no timeout, no `PaneLaunchError`, nothing downstream (not
    // `markDead()`, not the caller) ever ran. Advancing fake timers past the
    // deadline proves nothing about THIS bug unless something is actually
    // racing the stalled call against the clock — which is exactly what the
    // fix adds.
    const tmux = makeTmux({ capturePane: makeNoAckCapture() });
    const fetchFn = vi.fn(() => new Promise<Response>(() => {})); // never settles
    const pl = new PaneLifecycle({
      tmux,
      busBaseUrl: 'http://x',
      cfg: makeCfg(),
      scratchDir,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    const launchPromise = pl.launch(makeLaunchParams());
    const assertion = expect(launchPromise).rejects.toThrow(PaneLaunchError);
    await vi.advanceTimersByTimeAsync(LAUNCH_READY_TIMEOUT_MS + 5_000);
    await assertion;

    // The loop kept re-polling on the normal cadence (racing each stalled
    // call against the poll interval) rather than blocking on the first
    // hung call forever.
    expect(fetchFn.mock.calls.length).toBeGreaterThan(1);
  });

  it('throws PaneLaunchError during the ack handshake if it alone would exceed LAUNCH_READY_TIMEOUT_MS', async () => {
    // The class doc comment claims LAUNCH_READY_TIMEOUT_MS "encompass[es]
    // BOTH the ack handshake and the readiness poll — not a separate budget
    // for each phase." A large operator-configured launch_ack_max_attempts
    // makes that untrue unless ackHandshake itself checks the same deadline.
    const capturePane = vi.fn(async () => 'still experimental'); // pattern never clears
    const tmux = makeTmux({ paneAlive: vi.fn(async () => true), capturePane });
    const pl = new PaneLifecycle({
      tmux,
      busBaseUrl: 'http://x',
      cfg: makeCfg({ launch_ack_max_attempts: 1000, launch_ack_delay_ms: 500 }),
      scratchDir,
      fetchFn: makeReadyFetch(),
    });

    const launchPromise = pl.launch(makeLaunchParams());
    const assertion = expect(launchPromise).rejects.toThrow(PaneLaunchError);
    await vi.advanceTimersByTimeAsync(LAUNCH_READY_TIMEOUT_MS + 5_000);
    await assertion;

    // Bounded by the launch deadline, not by grinding through all 1000
    // configured attempts (500ms delay + 999 * 500ms backoff would be ~8.5
    // minutes).
    expect(capturePane.mock.calls.length).toBeLessThan(70);
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
    await vi.advanceTimersByTimeAsync(2000);
    await launchPromise;

    expect(mockWritePaneMcpConfig).toHaveBeenCalledTimes(1);
    expect(mockCleanupPaneMcpConfig).toHaveBeenCalledTimes(1);
    expect(mockCleanupPaneMcpConfig).toHaveBeenCalledWith(FAKE_MCP_CONFIG_PATH);
  });

  it('keeps the scratch files when the ack handshake throws (the typed launch line may still run)', async () => {
    const capturePane = vi.fn(async () => 'still experimental');
    const tmux = makeTmux({ paneAlive: vi.fn(async () => true), capturePane });
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
    expect(mockCleanupPaneMcpConfig).not.toHaveBeenCalled();
  });

  it('keeps the rendered system-prompt file when the readiness poll times out', async () => {
    const tmux = makeTmux({ capturePane: makeNoAckCapture() });
    const fetchFn = vi.fn(async () => jsonResponse(pollBody(null)));
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

    expect(mockCleanupPaneMcpConfig).not.toHaveBeenCalled();
    const leftoverPromptFiles = readdirSync(scratchDir).filter((f) => f.startsWith('pool-prompt-'));
    expect(leftoverPromptFiles).toHaveLength(1);
  });

  it('prunes scratch files older than a day at the start of a launch, and keeps recent ones', async () => {
    const stale = join(scratchDir, 'pool-mcp-stale.json');
    const fresh = join(scratchDir, 'pool-mcp-fresh.json');
    const unrelated = join(scratchDir, 'notes.txt');
    for (const f of [stale, fresh, unrelated]) writeFileSync(f, '{}');
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    utimesSync(stale, old, old);
    utimesSync(unrelated, old, old);

    const tmux = makeTmux({ paneAlive: vi.fn(async () => true), capturePane: makeNoAckCapture() });
    const pl = new PaneLifecycle({ tmux, busBaseUrl: 'http://x', cfg: makeCfg(), scratchDir, fetchFn: makeReadyFetch() });
    const launchPromise = pl.launch(makeLaunchParams());
    await vi.advanceTimersByTimeAsync(2000);
    await launchPromise;

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
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

// ── reuse after on_evict: clear ──────────────────────────────────────────────

describe('PaneLifecycle.launch — pane still running claude (after on_evict: clear)', () => {
  it('stops the old claude and recreates the window instead of typing the launch line into it', async () => {
    let alive = true;
    const tmux = makeTmux({
      paneAlive: vi.fn(async () => alive),
      paneCommand: vi.fn(async () => 'claude'),
      killWindow: vi.fn(async () => { alive = false; }),
      capturePane: makeNoAckCapture(),
    });
    const pl = new PaneLifecycle({ tmux, busBaseUrl: 'http://x', cfg: makeCfg(), scratchDir, fetchFn: makeReadyFetch() });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await pl.release('peggy-pool:1', 'clear');
    const launchPromise = pl.launch(makeLaunchParams());
    await vi.advanceTimersByTimeAsync(2000);
    await launchPromise;

    expect(tmux.sendKeys).toHaveBeenCalledWith('peggy-pool:1', 'C-c');
    expect(tmux.killWindow).toHaveBeenCalledWith('peggy-pool:1');
    expect(tmux.createWindow).toHaveBeenCalledTimes(1);
    const launchLineCall = tmux.sendCommand.mock.calls.findIndex((c) => String(c[1]).includes(q('--session-id')));
    expect(tmux.killWindow.mock.invocationCallOrder[0]!).toBeLessThan(
      tmux.sendCommand.mock.invocationCallOrder[launchLineCall]!,
    );
  });

  it('launches straight into a live pane that is at a shell prompt', async () => {
    const tmux = makeTmux({
      paneAlive: vi.fn(async () => true),
      paneCommand: vi.fn(async () => 'zsh'),
      capturePane: makeNoAckCapture(),
    });
    const pl = new PaneLifecycle({ tmux, busBaseUrl: 'http://x', cfg: makeCfg(), scratchDir, fetchFn: makeReadyFetch() });

    const launchPromise = pl.launch(makeLaunchParams());
    await vi.advanceTimersByTimeAsync(2000);
    await launchPromise;

    expect(tmux.killWindow).not.toHaveBeenCalled();
    expect(tmux.createWindow).not.toHaveBeenCalled();
  });

  it('isShellCommand recognises shells, including login-shell names', () => {
    expect(isShellCommand('zsh')).toBe(true);
    expect(isShellCommand('-bash')).toBe(true);
    expect(isShellCommand('claude')).toBe(false);
    expect(isShellCommand('node')).toBe(false);
    expect(isShellCommand('/bin/zsh')).toBe(true);
    expect(isShellCommand(' bash ')).toBe(true);
    expect(isShellCommand(null)).toBe(false);
  });

  it('kills a window whose foreground command is unknown without sending C-c first', async () => {
    const tmux = makeTmux({
      paneAlive: vi.fn(async () => true),
      paneCommand: vi.fn(async () => null),
      capturePane: makeNoAckCapture(),
    });
    const pl = new PaneLifecycle({ tmux, busBaseUrl: 'http://x', cfg: makeCfg(), scratchDir, fetchFn: makeReadyFetch() });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const launchPromise = pl.launch(makeLaunchParams());
    await vi.advanceTimersByTimeAsync(2000);
    await launchPromise;

    expect(tmux.sendKeys).not.toHaveBeenCalledWith('peggy-pool:1', 'C-c');
    expect(tmux.killWindow).toHaveBeenCalledWith('peggy-pool:1');
    expect(tmux.createWindow).toHaveBeenCalledTimes(1);
  });
});

// ── poll_interval_ms ─────────────────────────────────────────────────────────

describe('PaneLifecycle — poll_interval_ms', () => {
  it("passes the pool's poll_interval_ms to the pane's MCP config", async () => {
    const tmux = makeTmux({ paneAlive: vi.fn(async () => false), capturePane: makeNoAckCapture() });
    const pl = new PaneLifecycle({
      tmux, busBaseUrl: 'http://127.0.0.1:3000', cfg: makeCfg({ poll_interval_ms: 250 }), scratchDir, fetchFn: makeReadyFetch(),
    });

    const launchPromise = pl.launch(makeLaunchParams());
    await vi.advanceTimersByTimeAsync(2000);
    await launchPromise;

    expect(mockWritePaneMcpConfig).toHaveBeenCalledWith(expect.objectContaining({ pollIntervalMs: 250 }));
  });
});

// ── bus.auth_token ───────────────────────────────────────────────────────────

describe('PaneLifecycle — bus.auth_token', () => {
  it('sends X-Bus-Token on the readiness poll and exports AGENTBUS_BUS_TOKEN into the new window', async () => {
    const tmux = makeTmux({ paneAlive: vi.fn(async () => false), capturePane: makeNoAckCapture() });
    const fetchFn = makeReadyFetch();
    const pl = new PaneLifecycle({
      tmux, busBaseUrl: 'http://127.0.0.1:3000', cfg: makeCfg(), scratchDir, fetchFn, busToken: 'tok-1',
    });

    const launchPromise = pl.launch(makeLaunchParams());
    await vi.advanceTimersByTimeAsync(2000);
    await launchPromise;

    expect(tmux.createWindow.mock.calls[0]![3]).toMatchObject({ AGENTBUS_BUS_TOKEN: 'tok-1' });
    const calls = fetchFn.mock.calls as unknown as Array<[string, RequestInit | undefined]>;
    expect(new Headers(calls[0]![1]?.headers).get('X-Bus-Token')).toBe('tok-1');
  });

  it('adds no token env or header when bus.auth_token is unset', async () => {
    const tmux = makeTmux({ paneAlive: vi.fn(async () => false), capturePane: makeNoAckCapture() });
    const fetchFn = makeReadyFetch();
    const pl = new PaneLifecycle({ tmux, busBaseUrl: 'http://127.0.0.1:3000', cfg: makeCfg(), scratchDir, fetchFn });

    const launchPromise = pl.launch(makeLaunchParams());
    await vi.advanceTimersByTimeAsync(2000);
    await launchPromise;

    expect(tmux.createWindow.mock.calls[0]![3]).not.toHaveProperty('AGENTBUS_BUS_TOKEN');
    const calls = fetchFn.mock.calls as unknown as Array<[string, RequestInit | undefined]>;
    expect(calls[0]![1]).toBeUndefined();
  });
});

// ── E54: "Switch model?" prompt ──────────────────────────────────────────────

/** Real capture from a live pane (Oct 28, 2026) after typing `/model opus` mid-conversation. */
const MODEL_PROMPT = [
  'Switch model?',
  'Your next response will be slower and use more tokens',
  'This conversation is cached for the current model. Switching to Opus 5.5',
  'means the full history gets re-read.',
  '❯ 1. Yes, switch to Opus 5.5',
  '  2. No, go back',
].join('\n');

const IDLE_PANE = '  Some earlier output\n\n╭──────────────╮\n│ ❯            │\n╰──────────────╯\n  ? for shortcuts';

/** Looks similar but is a different prompt: must never be answered. */
const SIMILAR_PROMPTS = [
  'Switch model?\n  1. Maybe later\n  2. Never', // right header, wrong option 1
  'Switch branch?\n❯ 1. Yes, switch to main\n  2. No, go back', // right option shape, wrong header
  'Trust this folder?\n❯ 1. Yes, proceed\n  2. No, exit',
  'I switched the model for you. Switch model? is what it asks.', // no numbered option
];

function sleeper() {
  return async () => {};
}

describe('PaneLifecycle.confirmModelPrompt (E54)', () => {
  it('sends only "1" via tmux when the real prompt is on screen, then reports confirmed once it clears', async () => {
    let cleared = false;
    const sendKeys = vi.fn(async (_t: string, _k: string) => {
      cleared = true;
    });
    const tmux = makeTmux({ capturePane: vi.fn(async () => (cleared ? IDLE_PANE : MODEL_PROMPT)), sendKeys });
    const pl = new PaneLifecycle({ tmux, busBaseUrl: 'http://x', cfg: makeCfg(), scratchDir, sleepFn: sleeper() });

    await expect(pl.confirmModelPrompt('peggy-pool:1')).resolves.toEqual({ status: 'confirmed', attempts: 1 });
    expect(sendKeys.mock.calls).toEqual([['peggy-pool:1', '1']]);
  });

  it('sends no key for no prompt, or for a similar but different prompt', async () => {
    for (const capture of [IDLE_PANE, ...SIMILAR_PROMPTS]) {
      const tmux = makeTmux({ capturePane: vi.fn(async () => capture) });
      const pl = new PaneLifecycle({ tmux, busBaseUrl: 'http://x', cfg: makeCfg(), scratchDir, sleepFn: sleeper() });
      await expect(pl.confirmModelPrompt('peggy-pool:1')).resolves.toEqual({ status: 'absent' });
      expect(tmux.sendKeys).not.toHaveBeenCalled();
    }
  });

  it('reports failure after launch_ack_max_attempts presses of "1" when the prompt will not clear, never sending "2"', async () => {
    const tmux = makeTmux({ capturePane: vi.fn(async () => MODEL_PROMPT) });
    const pl = new PaneLifecycle({ tmux, busBaseUrl: 'http://x', cfg: makeCfg({ launch_ack_max_attempts: 2 }), scratchDir, sleepFn: sleeper() });
    const result = await pl.confirmModelPrompt('peggy-pool:1');
    expect(result.status).toBe('failed');
    expect(result.status === 'failed' && result.reason).toContain('still showing after 2 attempt(s)');
    expect(tmux.sendKeys.mock.calls).toEqual([
      ['peggy-pool:1', '1'],
      ['peggy-pool:1', '1'],
    ]);
  });

  it('honours model_confirm_pattern but still requires the numbered "1. Yes, switch to" option; an invalid pattern sends nothing', async () => {
    const custom = makeTmux({ capturePane: vi.fn(async () => MODEL_PROMPT.replace('Switch model?', 'Change model?')) });
    custom.sendKeys.mockImplementation(async () => {
      custom.capturePane.mockImplementation(async () => IDLE_PANE);
    });
    const withPattern = new PaneLifecycle({ tmux: custom, busBaseUrl: 'http://x', cfg: makeCfg({ model_confirm_pattern: 'change model\\?' }), scratchDir, sleepFn: sleeper() });
    await expect(withPattern.confirmModelPrompt('p:1')).resolves.toEqual({ status: 'confirmed', attempts: 1 });

    const bad = makeTmux({ capturePane: vi.fn(async () => MODEL_PROMPT) });
    const invalid = new PaneLifecycle({ tmux: bad, busBaseUrl: 'http://x', cfg: makeCfg({ model_confirm_pattern: '(' }), scratchDir, sleepFn: sleeper() });
    await expect(invalid.confirmModelPrompt('p:1')).resolves.toEqual({ status: 'absent' });
    expect(bad.sendKeys).not.toHaveBeenCalled();
  });
});

describe('PaneLifecycle.switchModelInPane (E54)', () => {
  /** A pane that shows the prompt after `/model` is typed and returns to idle once "1" is pressed. */
  function livePane(opts: { promptAppears?: boolean; clears?: boolean; idleReturns?: boolean } = {}) {
    const { promptAppears = true, clears = true, idleReturns = true } = opts;
    let state: 'idle' | 'prompt' | 'answered' = 'idle';
    const sendCommand = vi.fn(async (_t: string, _l: string) => {
      if (promptAppears) state = 'prompt';
    });
    const sendKeys = vi.fn(async (_t: string, k: string) => {
      if (k === '1' && clears) state = 'answered';
    });
    const capturePane = vi.fn(async () => (state === 'prompt' ? MODEL_PROMPT : state === 'answered' && !idleReturns ? 'working...' : IDLE_PANE));
    return { tmux: makeTmux({ paneCommand: vi.fn(async () => 'claude'), sendCommand, sendKeys, capturePane }), sendCommand, sendKeys };
  }
  const mk = (tmux: ReturnType<typeof makeTmux>) => new PaneLifecycle({ tmux, busBaseUrl: 'http://x', cfg: makeCfg(), scratchDir, sleepFn: sleeper() });

  it('types /model, waits for the prompt, sends "1", and verifies the idle composer', async () => {
    const { tmux, sendCommand, sendKeys } = livePane();
    await expect(mk(tmux).switchModelInPane('peggy-pool:1', 'claude-opus-5-5')).resolves.toEqual({ status: 'switched' });
    expect(sendCommand).toHaveBeenCalledWith('peggy-pool:1', '/model claude-opus-5-5');
    expect(sendKeys.mock.calls).toEqual([['peggy-pool:1', '1']]);
    expect(sendCommand.mock.invocationCallOrder[0]!).toBeLessThan(sendKeys.mock.invocationCallOrder[0]!);
  });

  it('fails plainly, sending no key, when the prompt never appears', async () => {
    const { tmux, sendKeys } = livePane({ promptAppears: false });
    const r = await mk(tmux).switchModelInPane('peggy-pool:1', 'claude-opus-5-5');
    expect(r).toMatchObject({ status: 'failed' });
    expect(r.status === 'failed' && r.reason).toContain('did not appear');
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it('fails plainly when the prompt will not clear, and when the composer does not return', async () => {
    const stuck = livePane({ clears: false });
    const r1 = await mk(stuck.tmux).switchModelInPane('peggy-pool:1', 'claude-opus-5-5');
    expect(r1.status === 'failed' && r1.reason).toContain('still showing');
    expect(stuck.sendKeys.mock.calls.every((c) => c[1] === '1')).toBe(true);

    const busy = livePane({ idleReturns: false });
    const r2 = await mk(busy.tmux).switchModelInPane('peggy-pool:1', 'claude-opus-5-5');
    expect(r2.status === 'failed' && r2.reason).toContain('idle composer');
  });

  it('types nothing into a shell pane, a pane already showing the prompt, or for a suspicious model id', async () => {
    const shell = makeTmux({ paneCommand: vi.fn(async () => 'zsh') });
    expect((await mk(shell).switchModelInPane('p:1', 'claude-opus-5-5')).status).toBe('failed');
    expect(shell.sendCommand).not.toHaveBeenCalled();

    const showing = makeTmux({ paneCommand: vi.fn(async () => 'claude'), capturePane: vi.fn(async () => MODEL_PROMPT) });
    expect((await mk(showing).switchModelInPane('p:1', 'claude-opus-5-5')).status).toBe('failed');
    expect(showing.sendCommand).not.toHaveBeenCalled();
    expect(showing.sendKeys).not.toHaveBeenCalled();

    const ok = livePane();
    expect((await mk(ok.tmux).switchModelInPane('p:1', 'x; rm -rf')).status).toBe('failed');
    expect(ok.sendCommand).not.toHaveBeenCalled();
  });
});

describe('PaneLifecycle.launch — model confirmation safety net (E54)', () => {
  it('a --model launch that stops at the prompt answers it with "1" before readiness', async () => {
    let confirmed = false;
    const sendKeys = vi.fn(async (_t: string, k: string) => {
      if (k === '1') confirmed = true;
    });
    const fetchFn = vi.fn(async () => jsonResponse(pollBody(confirmed ? new Date(Date.now() + 1000).toISOString() : null)));
    const tmux = makeTmux({ paneAlive: vi.fn(async () => true), capturePane: vi.fn(async () => (confirmed ? IDLE_PANE : MODEL_PROMPT)), sendKeys });
    const pl = new PaneLifecycle({ tmux, busBaseUrl: 'http://x', cfg: makeCfg(), scratchDir, fetchFn });

    const p = pl.launch(makeLaunchParams({ resume: true, model: 'claude-opus-5-5' }));
    await vi.advanceTimersByTimeAsync(5000);
    await p;
    expect(sendKeys.mock.calls.filter((c) => c[1] !== 'Enter')).toEqual([['peggy-pool:1', '1']]);
  });

  it('fails the launch plainly when the prompt will not clear', async () => {
    const tmux = makeTmux({ paneAlive: vi.fn(async () => true), capturePane: vi.fn(async () => MODEL_PROMPT) });
    const pl = new PaneLifecycle({ tmux, busBaseUrl: 'http://x', cfg: makeCfg(), scratchDir, fetchFn: vi.fn(async () => jsonResponse(pollBody(null))) });
    const p = pl.launch(makeLaunchParams({ resume: true, model: 'claude-opus-5-5' }));
    const assertion = expect(p).rejects.toThrow(/model confirmation prompt .* still showing/);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
  });

  it('a launch without --model, or with a similar prompt on screen, sends no "1"', async () => {
    const plain = makeTmux({ paneAlive: vi.fn(async () => true), capturePane: vi.fn(async () => SIMILAR_PROMPTS[1]!) });
    const pl = new PaneLifecycle({ tmux: plain, busBaseUrl: 'http://x', cfg: makeCfg({ launch_ack_pattern: 'zzz-never' }), scratchDir, fetchFn: makeReadyFetch() });
    const p = pl.launch(makeLaunchParams({ resume: true }));
    await vi.advanceTimersByTimeAsync(3000);
    await p;
    expect(plain.sendKeys).not.toHaveBeenCalledWith(expect.anything(), '1');

    const withModel = makeTmux({ paneAlive: vi.fn(async () => true), capturePane: vi.fn(async () => SIMILAR_PROMPTS[1]!) });
    const pl2 = new PaneLifecycle({ tmux: withModel, busBaseUrl: 'http://x', cfg: makeCfg({ launch_ack_pattern: 'zzz-never' }), scratchDir, fetchFn: makeReadyFetch() });
    const p2 = pl2.launch(makeLaunchParams({ resume: true, model: 'claude-opus-5-5' }));
    await vi.advanceTimersByTimeAsync(3000);
    await p2;
    expect(withModel.sendKeys).not.toHaveBeenCalledWith(expect.anything(), '1');
  });
});

// ── E88: launch fencing, shell-ready typing, scratch cleanup ─────────────────

describe('PaneLifecycle.launch — E88 launch token (S88.1)', () => {
  it('writes a launch id into the MCP config and registers that same id before typing the launch line', async () => {
    const tmux = makeTmux({ capturePane: makeNoAckCapture() });
    const registerLaunch = vi.fn((_agent: string, _id: string) => {});
    const fetchFn = vi.fn(async () => jsonResponse({ lastPollAt: new Date().toISOString(), lastLaunchId: registerLaunch.mock.calls[0]?.[1] ?? null }));
    const pl = new PaneLifecycle({ tmux, busBaseUrl: 'http://x', cfg: makeCfg(), scratchDir, fetchFn, registerLaunch });
    const p = pl.launch(makeLaunchParams({ paneAgentId: 'peggy-pool-2', paneId: 'peggy-pool:2' }));
    await vi.advanceTimersByTimeAsync(3000);
    await p;

    const launchId = mockWritePaneMcpConfig.mock.calls[0]![0].launchId;
    expect(launchId).toMatch(/^[0-9a-f-]{36}$/);
    expect(registerLaunch).toHaveBeenCalledWith('peggy-pool-2', launchId);
    expect(registerLaunch.mock.invocationCallOrder[0]!).toBeLessThan(launchLineOrder(tmux));
  });

  it('uses LaunchParams.launchId when given', async () => {
    const tmux = makeTmux({ capturePane: makeNoAckCapture() });
    const pl = new PaneLifecycle({ tmux, busBaseUrl: 'http://x', cfg: makeCfg(), scratchDir, fetchFn: makeReadyFetch() });
    const p = pl.launch(makeLaunchParams({ launchId: 'fixed-launch' }));
    await vi.advanceTimersByTimeAsync(3000);
    await p;
    expect(mockWritePaneMcpConfig.mock.calls[0]![0].launchId).toBe('fixed-launch');
    expect(getRegisteredLaunch('peggy-pool-1')).toBe('fixed-launch');
  });

  it('a fresh /last-poll with a DIFFERENT launch id is not ready; the matching id is', async () => {
    // Exit criterion 1: another process (an orphan) polls as peggy-pool-2
    // every second with its own launch id. Readiness must wait for ours.
    const tmux = makeTmux({ capturePane: makeNoAckCapture() });
    let ownClaudeStarted = false;
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        lastPollAt: new Date(Date.now() + 1).toISOString(),
        lastLaunchId: ownClaudeStarted ? getRegisteredLaunch('peggy-pool-2') : 'orphan-launch',
      }),
    );
    const pl = new PaneLifecycle({ tmux, busBaseUrl: 'http://x', cfg: makeCfg(), scratchDir, fetchFn });
    let settled = false;
    const p = pl.launch(makeLaunchParams({ paneAgentId: 'peggy-pool-2', paneId: 'peggy-pool:2' })).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(settled).toBe(false); // the orphan's fresh polls did not count
    expect(fetchFn.mock.calls.length).toBeGreaterThan(3);

    ownClaudeStarted = true;
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toBeUndefined();
  });

  it('times out when only a different launch id ever polls', async () => {
    const tmux = makeTmux({ capturePane: makeNoAckCapture() });
    const fetchFn = vi.fn(async () => jsonResponse({ lastPollAt: new Date(Date.now() + 1).toISOString(), lastLaunchId: 'someone-else' }));
    const pl = new PaneLifecycle({ tmux, busBaseUrl: 'http://x', cfg: makeCfg(), scratchDir, fetchFn });
    const p = pl.launch(makeLaunchParams());
    const assertion = expect(p).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(LAUNCH_READY_TIMEOUT_MS + 5_000);
    await assertion;
  });
});

describe('PaneLifecycle.launch — E88 shell-ready typing (S88.3)', () => {
  /**
   * A fake zsh that takes `startupMs` to start. Anything typed before then
   * loses its first character and prints nothing (what zsh did on Oct 31:
   * "zsh: command not found: nset"); after it, a probe line prints its
   * marker. Every typed line is recorded as the shell received it.
   */
  function slowShell(startupMs: number, paneAlive: boolean) {
    const tmux = makeTmux({ paneAlive: vi.fn(async () => paneAlive), shellAnswersProbe: false });
    const startedAt = Date.now();
    const received: Array<{ at: number; line: string }> = [];
    let screen = '% ';
    tmux.sendCommand.mockImplementation(async (_t: string, line: string) => {
      const ready = Date.now() - startedAt >= startupMs;
      const got = ready ? line : line.slice(1);
      received.push({ at: Date.now() - startedAt, line: got });
      const probe = SHELL_PROBE_LINE_RE.exec(got);
      if (probe) screen += `${got}\n${shellProbeMarker(probe[1]!)}\n% `;
      else if (!ready) screen += `${got}\nzsh: command not found: ${got.trim().split(' ')[0]}\n% `;
    });
    tmux.capturePane.mockImplementation(async () => screen);
    return { tmux, received };
  }

  for (const reused of [false, true]) {
    it(`a shell with a 3s startup gets the launch line whole, after it is ready (${reused ? 'reused window' : 'new window'})`, async () => {
      const { tmux, received } = slowShell(3000, reused);
      const pl = new PaneLifecycle({ tmux, busBaseUrl: 'http://x', cfg: makeCfg(), scratchDir, fetchFn: makeReadyFetch() });
      const p = pl.launch(makeLaunchParams({ resume: reused }));
      await vi.advanceTimersByTimeAsync(10_000);
      await p;

      const launch = received.filter((r) => !SHELL_PROBE_LINE_RE.test(r.line) && r.line.includes('claude'));
      expect(launch).toHaveLength(1);
      expect(launch[0]!.at).toBeGreaterThanOrEqual(3000);
      expect(launch[0]!.line).toBe(launchLine(tmux)); // nothing dropped
      expect(launch[0]!.line.startsWith('unset TMUX ')).toBe(true);
      // The first probe(s) were mangled; a retry cleared the line first.
      expect(tmux.sendKeys).toHaveBeenCalledWith('peggy-pool:1', 'C-u');
    });
  }

  it('probes the reused shell before typing (the path that skipped every check before E88)', async () => {
    const tmux = makeTmux({ paneAlive: vi.fn(async () => true), capturePane: makeNoAckCapture() });
    const pl = new PaneLifecycle({ tmux, busBaseUrl: 'http://x', cfg: makeCfg(), scratchDir, fetchFn: makeReadyFetch() });
    const p = pl.launch(makeLaunchParams({ resume: true }));
    await vi.advanceTimersByTimeAsync(3000);
    await p;
    const calls = tmux.sendCommand.mock.calls.map((c) => String(c[1]));
    expect(SHELL_PROBE_LINE_RE.test(calls[0]!)).toBe(true);
    expect(calls[1]!.startsWith('unset TMUX ')).toBe(true);
    // The typed probe never contains its own marker, so the echo can't pass for output.
    const nonce = SHELL_PROBE_LINE_RE.exec(calls[0]!)![1]!;
    expect(calls[0]!).not.toContain(shellProbeMarker(nonce));
  });

  it('never types the launch line into a shell that never answers the probe', async () => {
    const tmux = makeTmux({ paneAlive: vi.fn(async () => true), shellAnswersProbe: false });
    const pl = new PaneLifecycle({ tmux, busBaseUrl: 'http://x', cfg: makeCfg(), scratchDir, fetchFn: makeReadyFetch() });
    const p = pl.launch(makeLaunchParams());
    const assertion = expect(p).rejects.toThrow(/did not answer the readiness probe/);
    await vi.advanceTimersByTimeAsync(SHELL_PROBE_MAX_MS + 1000);
    await assertion;
    expect(nonProbeCalls(tmux)).toHaveLength(0);
    expect(mockWritePaneMcpConfig).not.toHaveBeenCalled();
  });
});

describe('PaneLifecycle.launch — E88 scratch cleanup only after a real start (S88.3)', () => {
  async function useRealMcpConfig() {
    const actual = await vi.importActual<typeof import('./mcp-config.js')>('./mcp-config.js');
    mockWritePaneMcpConfig.mockImplementation(actual.writePaneMcpConfig);
    mockCleanupPaneMcpConfig.mockImplementation(actual.cleanupPaneMcpConfig);
  }

  it('keeps the MCP config on disk after a readiness timeout (even with an orphan polling fresh), removes it after a matched pass', async () => {
    await useRealMcpConfig();
    const orphanOnly = vi.fn(async () => jsonResponse({ lastPollAt: new Date(Date.now() + 1).toISOString(), lastLaunchId: 'orphan' }));
    const failed = new PaneLifecycle({ tmux: makeTmux({ capturePane: makeNoAckCapture() }), busBaseUrl: 'http://x', cfg: makeCfg(), scratchDir, fetchFn: orphanOnly });
    const p1 = failed.launch(makeLaunchParams({ ensureWindow: { cwd: scratchDir } }));
    const assertion = expect(p1).rejects.toThrow(PaneLaunchError);
    await vi.advanceTimersByTimeAsync(LAUNCH_READY_TIMEOUT_MS + 5_000);
    await assertion;
    const failedPath = mockWritePaneMcpConfig.mock.results[0]!.value as string;
    expect(existsSync(failedPath)).toBe(true);

    const ok = new PaneLifecycle({ tmux: makeTmux({ capturePane: makeNoAckCapture() }), busBaseUrl: 'http://x', cfg: makeCfg(), scratchDir, fetchFn: makeReadyFetch() });
    const p2 = ok.launch(makeLaunchParams({ ensureWindow: { cwd: scratchDir } }));
    await vi.advanceTimersByTimeAsync(3000);
    await p2;
    const okPath = mockWritePaneMcpConfig.mock.results[1]!.value as string;
    expect(existsSync(okPath)).toBe(false);
    expect(existsSync(failedPath)).toBe(true); // a later launch doesn't touch it either (24 h prune only)
  });
});

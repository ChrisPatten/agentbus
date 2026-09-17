/**
 * S48.4 — pane lifecycle: launch (fresh or resumed), ack handshake, readiness
 * poll, and release for one tmux pane in a cc-pool (E48).
 *
 * This module puts a specific Claude session into a specific tmux pane and
 * confirms it is actually live — its cc.ts is polling the bus — before
 * handing control back to the caller. It does NOT decide which pane to use
 * (that's `LeaseStore`, S48.3) or wire this into message delivery (a later
 * story); given a pane target and a session id, it just executes the
 * launch/resume and tells the caller when it's safe to hand off a message.
 *
 * Prior art (read-only reference, lives outside this repo):
 * ~/workspace/peggy-claude-code/start.sh (fresh-launch argv:
 * `claude --permission-mode auto --dangerously-load-development-channels
 * server:agentbus`) and
 * ~/workspace/peggy-claude-code/scripts/agentbus_session_watchdog.sh (resume
 * argv: `unset TMUX; command claude --resume <id>`).
 *
 * `claude --help` (v2.1.274 on this machine) does not document
 * `--dangerously-load-development-channels` at all — it's an undocumented/
 * hidden flag — and does not list `--append-system-prompt-file` or
 * `--system-prompt-file` as top-level entries either (they only appear
 * inside `--bare`'s own description: "via: --system-prompt[-file],
 * --append-system-prompt[-file], ...", which confirms both are real flags
 * without documenting their required position). Where `--help` can't settle
 * an ordering question, this module follows start.sh's proven adjacency —
 * `--dangerously-load-development-channels server:agentbus` as an
 * inseparable pair, the positional immediately after the flag it selects
 * for — rather than inventing an order `--help` never confirmed. See this
 * story's report for the full flag-by-flag verification.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { TmuxController } from './tmux.js';
import type { CcPoolInstanceConfig } from '../config/schema.js';
import { writePaneMcpConfig, cleanupPaneMcpConfig } from './mcp-config.js';
import { renderSystemPrompt, expandFileReferences, type PromptContext } from '../adapters/prompt-renderer.js';

/**
 * Overall bound (ms) on one `launch()` call, measured from `launchStartedAt`
 * (captured at the very top of `launch()`) and encompassing BOTH the ack
 * handshake and the readiness poll — not a separate budget for each phase.
 * Not yet exposed via config — there is no matching field on
 * `CcPoolAdapterSchema` today.
 */
export const LAUNCH_READY_TIMEOUT_MS = 30_000;

/** Backoff between repeated ack-check `Enter` presses (after the first, which waits `cfg.launch_ack_delay_ms`). */
const ACK_RETRY_BACKOFF_MS = 500;

/** Poll interval for the post-ack readiness check against `/last-poll`. */
const READINESS_POLL_INTERVAL_MS = 500;

/** Pause between `C-c` and killing the window on a 'kill' release, so the interrupt has a moment to land. */
const RELEASE_KILL_PAUSE_MS = 300;

export interface PaneLifecycleDeps {
  tmux: TmuxController;
  /** Base URL of bus-core's HTTP API, e.g. "http://127.0.0.1:3000" — used only for the readiness poll. */
  busBaseUrl: string;
  cfg: CcPoolInstanceConfig;
  /** Scratch directory for per-launch temp files (per-pane mcp config, optional rendered system-prompt file). Created if missing. */
  scratchDir: string;
  /** Injectable fetch for tests — defaults to global fetch. */
  fetchFn?: typeof fetch;
  /**
   * Injectable delay for tests (ack-handshake waits, the readiness poll
   * interval, and the kill-release pause in `release()`) — defaults to a
   * real `setTimeout`-based wait. Not shown in this story's illustrative
   * interface sketch, but required by the ack-handshake/release behavior the
   * story itself specifies, so it's a real constructor dep rather than a
   * hidden module-level default — tests drive it with fake timers.
   */
  sleepFn?: (ms: number) => Promise<void>;
}

export interface LaunchParams {
  /** tmux target, e.g. "peggy-pool:3". */
  paneId: string;
  /** This pane's own BARE agent id, e.g. "peggy-pool-3" — becomes AGENTBUS_AGENT_ID. */
  paneAgentId: string;
  /**
   * The conversation this launch is for (used only to populate the rendered
   * system prompt's {{contact_id}}/{{channel}} when the caller has them —
   * pass through what's available, defaults are fine otherwise).
   */
  promptContext?: { contact_id?: string; channel?: string };
  /**
   * The Claude session UUID to use. Always required — the caller (a later
   * story) is responsible for generating a fresh one when there's nothing to
   * resume, or supplying the prior one when there is.
   */
  sessionId: string;
  /** true = `--resume <sessionId>`. false = `--session-id <sessionId>` (fresh). */
  resume: boolean;
  /**
   * If the target window doesn't exist yet, create it with this cwd/env
   * before launching (covers both a pool's initial panes on first-ever
   * launch and a `growth: dynamic` pane that has no window at all). When the
   * target window already exists (the common case — a pre-seeded pane being
   * (re)launched), this is skipped automatically (checked via
   * `tmux.paneAlive`).
   */
  ensureWindow: { cwd: string; env?: Record<string, string> };
}

export class PaneLaunchError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'PaneLaunchError';
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/** Best-effort delete — matches the `cleanTmp` precedent in `src/adapters/cc-headless.ts`: never throws. */
function cleanTmpFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* best-effort */
  }
}

/**
 * Wrap `s` as one safe shell word: single-quoted, with any embedded single
 * quote escaped as `'\''`. Applied to every argument of the launch line,
 * including ones that are only ever bus-generated (UUIDs, temp file paths)
 * — this is the one place a full line of text gets typed into a live shell
 * inside a tmux pane (see `sendCommand` in tmux.ts), so every argument is
 * treated as untrusted-shape even though today it never actually contains
 * shell metacharacters. Kept module-private; exercised indirectly via the
 * end-to-end command-line assertions in pane.test.ts (including one
 * deliberately awkward value), per this story's "your call" on exporting it.
 */
function shellQuoteArg(s: string): string {
  return `'${s.split("'").join("'\\''")}'`;
}

/** "session:window" -> ["session", "window"]. */
function splitPaneTarget(paneId: string): [session: string, window: string] {
  const idx = paneId.indexOf(':');
  if (idx === -1) {
    throw new PaneLaunchError(`Invalid pane target "${paneId}" — expected "<session>:<window>"`);
  }
  return [paneId.slice(0, idx), paneId.slice(idx + 1)];
}

export class PaneLifecycle {
  private readonly tmux: TmuxController;
  private readonly busBaseUrl: string;
  private readonly cfg: CcPoolInstanceConfig;
  private readonly scratchDir: string;
  private readonly fetchFn: typeof fetch;
  private readonly sleepFn: (ms: number) => Promise<void>;
  /** Resolved once, mirroring cc-headless.ts's module-level `configPath`: same env var, same fallback. */
  private readonly agentbusConfigPath: string;

  constructor(deps: PaneLifecycleDeps) {
    this.tmux = deps.tmux;
    this.busBaseUrl = deps.busBaseUrl;
    this.cfg = deps.cfg;
    this.scratchDir = deps.scratchDir;
    this.fetchFn = deps.fetchFn ?? fetch;
    this.sleepFn = deps.sleepFn ?? defaultSleep;
    this.agentbusConfigPath = process.env['AGENTBUS_CONFIG'] ?? resolve(process.cwd(), 'config.yaml');
  }

  /**
   * Full sequence: ensure window exists -> write per-pane mcp config (+
   * optional rendered system-prompt file if `cfg.system_prompt` is set) ->
   * build and send the launch/resume command line -> ack handshake -> poll
   * readiness -> clean up temp files. Throws `PaneLaunchError` on any
   * failure (window creation failure, ack never confirmed after
   * `cfg.launch_ack_max_attempts`, or readiness not achieved within
   * `LAUNCH_READY_TIMEOUT_MS`). Temp files are always cleaned up in a
   * `finally` — success or failure — matching the `cleanTmp` precedent in
   * `src/adapters/cc-headless.ts`.
   */
  async launch(params: LaunchParams): Promise<void> {
    const launchStartedAt = new Date();

    let mcpConfigPath: string | null = null;
    let systemPromptPath: string | null = null;

    try {
      await this.ensureWindowExists(params);

      mcpConfigPath = writePaneMcpConfig({
        paneAgentId: params.paneAgentId,
        agentbusConfigPath: this.agentbusConfigPath,
        workingDir: params.ensureWindow.cwd,
        outDir: this.scratchDir,
      });

      if (this.cfg.system_prompt) {
        systemPromptPath = this.renderAndWriteSystemPrompt(this.cfg.system_prompt, params);
      }

      const line = this.buildLaunchLine(params, mcpConfigPath, systemPromptPath);
      await this.tmux.sendCommand(params.paneId, line);

      await this.ackHandshake(params.paneId);
      await this.pollReadiness(params.paneAgentId, launchStartedAt);
    } catch (err) {
      if (err instanceof PaneLaunchError) throw err;
      throw new PaneLaunchError(`Pane launch failed for ${params.paneId}: ${String(err)}`, err);
    } finally {
      if (mcpConfigPath) cleanupPaneMcpConfig(mcpConfigPath);
      if (systemPromptPath) cleanTmpFile(systemPromptPath);
    }
  }

  /**
   * `on_evict: 'clear'` clears the pane's Claude context via the `/clear`
   * slash command. `on_evict: 'kill'` interrupts the running session and
   * kills the window outright — the next `launch()` recreates it.
   */
  async release(paneId: string, onEvict: 'clear' | 'kill'): Promise<void> {
    if (onEvict === 'clear') {
      await this.tmux.sendCommand(paneId, '/clear');
      return;
    }
    await this.tmux.sendKeys(paneId, 'C-c');
    await this.sleepFn(RELEASE_KILL_PAUSE_MS);
    await this.tmux.killWindow(paneId);
  }

  // ── Launch steps ──────────────────────────────────────────────────────────

  private async ensureWindowExists(params: LaunchParams): Promise<void> {
    const alreadyAlive = await this.tmux.paneAlive(params.paneId);
    if (alreadyAlive) return;

    const [session, windowName] = splitPaneTarget(params.paneId);
    const env = this.buildWindowEnv(params.ensureWindow.env);
    // Covers the very first pane of a brand-new pool, where the tmux session
    // itself doesn't exist yet, not just the window — ensureSession is a
    // cheap no-op otherwise.
    await this.tmux.ensureSession(session, params.ensureWindow.cwd);
    await this.tmux.createWindow(session, windowName, params.ensureWindow.cwd, env);
  }

  /**
   * Merge order: `cfg.pane_env` (operator config) < the caller's own
   * `ensureWindow.env` < TERM/COLORTERM, which win unconditionally. Per
   * `CcPoolAdapterSchema.pane_env`'s own doc comment ("TERM/COLORTERM are
   * added unconditionally by later launch code, not defaulted here") — this
   * is that later code. E48's "Prior Art" gotcha 2: these are load-bearing
   * for the TUI and must be set at window-creation time, since tmux env
   * can't be changed on an existing window. Values match start.sh's proven
   * literals exactly.
   */
  private buildWindowEnv(callerEnv?: Record<string, string>): Record<string, string> {
    return {
      ...this.cfg.pane_env,
      ...callerEnv,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    };
  }

  private renderAndWriteSystemPrompt(template: string, params: LaunchParams): string {
    const ctx: PromptContext = {
      contact_id: params.promptContext?.contact_id ?? '',
      channel: params.promptContext?.channel ?? '',
      date: new Date().toISOString().slice(0, 10),
      // Pool sessions rely on native CLAUDE.md auto-loading, not per-turn
      // injection — unlike cc-headless, which assembles {{memories}} /
      // {{session_summary}} from the DB/agent files on every turn. Deliberate
      // difference for interactive pool sessions, not an oversight.
      memories: '',
      session_summary: '',
      agent_id: params.paneAgentId,
    };
    const workingDir = this.cfg.working_dir ?? process.cwd();
    // Same order as cc-headless.ts's runClaudeTurn(): render {{vars}} first,
    // then expand @path file references over the result.
    const rendered = expandFileReferences(renderSystemPrompt(template, ctx), workingDir);

    mkdirSync(this.scratchDir, { recursive: true });
    const outPath = join(this.scratchDir, `pool-prompt-${randomUUID()}.txt`);
    writeFileSync(outPath, rendered, 'utf-8');
    return outPath;
  }

  /**
   * See the module doc for the flag-order rationale. `--dangerously-load-
   * development-channels server:agentbus` is kept as an inseparable pair,
   * matching start.sh's proven adjacency; `cfg.launch_args` is appended
   * verbatim, last.
   */
  private buildLaunchLine(params: LaunchParams, mcpConfigPath: string, systemPromptPath: string | null): string {
    const args: string[] = [this.cfg.claude_bin];

    if (params.resume) {
      args.push('--resume', params.sessionId);
    } else {
      args.push('--session-id', params.sessionId);
    }

    args.push('--permission-mode', 'auto');
    args.push('--mcp-config', mcpConfigPath);
    args.push('--strict-mcp-config');

    if (this.cfg.model) {
      args.push('--model', this.cfg.model);
    }
    if (systemPromptPath) {
      args.push('--append-system-prompt-file', systemPromptPath);
    }

    args.push('--dangerously-load-development-channels', 'server:agentbus');

    for (const extra of this.cfg.launch_args) {
      args.push(extra);
    }

    const quoted = args.map(shellQuoteArg).join(' ');
    return `unset TMUX; ${quoted}`;
  }

  private async ackHandshake(paneId: string): Promise<void> {
    const maxAttempts = this.cfg.launch_ack_max_attempts;
    const pattern = this.cfg.launch_ack_pattern.toLowerCase();

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await this.sleepFn(attempt === 1 ? this.cfg.launch_ack_delay_ms : ACK_RETRY_BACKOFF_MS);
      await this.tmux.sendKeys(paneId, 'Enter');
      const captured = await this.tmux.capturePane(paneId, 30);
      if (!captured.toLowerCase().includes(pattern)) {
        return; // ack confirmed
      }
    }

    throw new PaneLaunchError(
      `Pane ${paneId}: launch-ack pattern "${this.cfg.launch_ack_pattern}" still present after ${maxAttempts} attempt(s)`,
    );
  }

  private async pollReadiness(paneAgentId: string, launchStartedAt: Date): Promise<void> {
    for (;;) {
      if (this.elapsedSince(launchStartedAt) >= LAUNCH_READY_TIMEOUT_MS) {
        throw new PaneLaunchError(
          `Pane launch timed out waiting for "${paneAgentId}" readiness after ${LAUNCH_READY_TIMEOUT_MS}ms`,
        );
      }

      if (await this.isReady(paneAgentId, launchStartedAt)) return;

      await this.sleepFn(READINESS_POLL_INTERVAL_MS);
    }
  }

  /**
   * Ready once `/last-poll` reports a `lastPollAt` that is both non-null and
   * `>= launchStartedAt` — the `>=` guard is what makes a relaunch of a
   * previously-used pane agent id safe: a stale timestamp from a PRIOR
   * launch of this same agent id must not satisfy readiness for THIS one.
   */
  private async isReady(paneAgentId: string, launchStartedAt: Date): Promise<boolean> {
    const res = await this.fetchFn(`${this.busBaseUrl}/api/v1/agents/${paneAgentId}/last-poll`);
    if (!res.ok) return false;
    const data = (await res.json()) as { lastPollAt?: string | null };
    if (!data.lastPollAt) return false;
    const seenAt = new Date(data.lastPollAt).getTime();
    return !Number.isNaN(seenAt) && seenAt >= launchStartedAt.getTime();
  }

  private elapsedSince(start: Date): number {
    return new Date().getTime() - start.getTime();
  }
}

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

/**
 * Poll interval (ms) used by the ack handshake for two distinct purposes:
 * (1) while waiting for the launch-ack prompt to actually render, between
 * successive `capturePane` checks, and (2) as the backoff between repeated
 * dismiss `Enter` presses once the prompt is confirmed showing but a prior
 * `Enter` didn't clear it. Kept as one constant (rather than two) because
 * both are "how often do we recheck the pane" at the same cadence, and a
 * real captured prompt-render time (~1.0-1.6s on this machine, v2.1.274-276)
 * varies enough run to run that a single fixed value here matters far less
 * than never treating "not observed yet" as "already dismissed" — see
 * `ackHandshake`'s doc comment.
 */
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
   * The model to pass as `--model`, already resolved by the caller (E53:
   * schedule model -> agent override -> global override -> `cfg.model` ->
   * nothing). `undefined` omits the flag entirely (CLI default via
   * `~/.claude/settings.json`). Replaces the old direct read of
   * `this.cfg.model` in `buildLaunchLine()` — every caller is now
   * responsible for resolving the value (`cfg.model` is only the last
   * fallback inside that resolution, not read here anymore).
   */
  model?: string;
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

      await this.ackHandshake(params.paneId, launchStartedAt);
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

    if (params.model) {
      args.push('--model', params.model);
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

  /**
   * `launchStartedAt` is threaded through here (not just used by
   * `pollReadiness`) so the class doc comment's claim that
   * `LAUNCH_READY_TIMEOUT_MS` "encompass[es] BOTH the ack handshake and the
   * readiness poll — not a separate budget for each phase" is actually true.
   * Without this check, `launch_ack_max_attempts` /
   * `launch_ack_delay_ms` are an entirely separate, unbounded-by-
   * `LAUNCH_READY_TIMEOUT_MS` budget — a large operator-configured attempt
   * count could blow well past the documented 30s bound before
   * `pollReadiness` ever got a chance to run.
   *
   * Two-phase design (fix/pool-launch-ack-and-timeout, 3rd bug found during
   * real-CLI verification of the first two fixes on this branch): the
   * PREVIOUS version of this method sent a blind `Enter` after a fixed
   * `cfg.launch_ack_delay_ms` delay and then treated the ack pattern's
   * ABSENCE from `capturePane` as proof the prompt had been dismissed. That
   * conflates two completely different states — "the prompt rendered and
   * was just dismissed" and "the prompt hasn't rendered yet" — and both look
   * identical to a `capturePane` check: no pattern present either way.
   * Measured against the real CLI (v2.1.274-276), the confirmation prompt
   * for `--dangerously-load-development-channels` first renders roughly
   * 1.0-1.6s after the launch line is sent — reliably AFTER the old
   * default `launch_ack_delay_ms` of 500ms. So the old loop's very first
   * check (at t≈500ms) almost always saw "absent" for the right reason
   * (nothing had rendered yet), declared the ack confirmed, and returned —
   * sending exactly one premature `Enter` into a still-loading terminal and
   * NEVER sending another one. The real prompt then rendered ~0.5-1s later
   * and sat there forever: nothing left in the loop to dismiss it, so
   * `pollReadiness` always timed out at 30s with the prompt still showing.
   * Confirmed by direct reproduction (real tmux + real `claude`, no mocks):
   * replaying the old loop's exact single-attempt behavior left the pane
   * stuck at the prompt for 20+ seconds straight with zero further input;
   * whereas polling `capturePane` for the pattern to actually appear FIRST,
   * then sending exactly one `Enter`, dismissed it within 300ms on every
   * trial run.
   *
   * The fix: never send a dismiss `Enter` until `capturePane` has actually
   * shown the prompt. Phase 1 (`waitForAckPrompt`) polls for the pattern to
   * appear, on a `ACK_RETRY_BACKOFF_MS` cadence, up to `cfg.launch_ack_delay_ms`
   * total (that field's meaning changes here — see its doc comment in
   * schema.ts). If it never appears in that window, there is nothing to
   * dismiss (e.g. a CLI/flag combination that skips the warning) and the
   * method returns without pressing anything. Phase 2 only runs once the
   * prompt is confirmed present: press `Enter`, recheck, and retry up to
   * `cfg.launch_ack_max_attempts` times (backing off `ACK_RETRY_BACKOFF_MS`
   * between retries) if a press doesn't clear it.
   */
  private async ackHandshake(paneId: string, launchStartedAt: Date): Promise<void> {
    const pattern = this.cfg.launch_ack_pattern.toLowerCase();

    const promptShowing = await this.waitForAckPrompt(paneId, pattern, launchStartedAt);
    if (!promptShowing) return; // never rendered within the budget -- nothing to dismiss

    const maxAttempts = this.cfg.launch_ack_max_attempts;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (this.elapsedSince(launchStartedAt) >= LAUNCH_READY_TIMEOUT_MS) {
        throw new PaneLaunchError(
          `Pane launch timed out during ack handshake for ${paneId} after ${LAUNCH_READY_TIMEOUT_MS}ms`,
        );
      }

      await this.tmux.sendKeys(paneId, 'Enter');
      const captured = await this.tmux.capturePane(paneId, 30);
      if (!captured.toLowerCase().includes(pattern)) {
        return; // ack confirmed -- prompt is gone
      }

      if (attempt < maxAttempts) {
        await this.sleepFn(ACK_RETRY_BACKOFF_MS);
      }
    }

    throw new PaneLaunchError(
      `Pane ${paneId}: launch-ack pattern "${this.cfg.launch_ack_pattern}" still present after ${maxAttempts} attempt(s)`,
    );
  }

  /**
   * Polls `capturePane` for `pattern` to appear, checking immediately and
   * then every `ACK_RETRY_BACKOFF_MS` until either it shows up (returns
   * `true`) or `cfg.launch_ack_delay_ms` of budget elapses without ever
   * seeing it (returns `false` — nothing to dismiss). Also bounded by the
   * shared `LAUNCH_READY_TIMEOUT_MS` deadline like the rest of `launch()`.
   */
  private async waitForAckPrompt(paneId: string, pattern: string, launchStartedAt: Date): Promise<boolean> {
    const budgetMs = this.cfg.launch_ack_delay_ms;
    const waitStartedAt = Date.now();

    for (;;) {
      const captured = await this.tmux.capturePane(paneId, 30);
      if (captured.toLowerCase().includes(pattern)) return true;

      if (Date.now() - waitStartedAt >= budgetMs) return false;

      if (this.elapsedSince(launchStartedAt) >= LAUNCH_READY_TIMEOUT_MS) {
        throw new PaneLaunchError(
          `Pane launch timed out waiting for the ack prompt to appear for ${paneId} after ${LAUNCH_READY_TIMEOUT_MS}ms`,
        );
      }

      await this.sleepFn(ACK_RETRY_BACKOFF_MS);
    }
  }

  /**
   * Bounded by `LAUNCH_READY_TIMEOUT_MS` from `launchStartedAt` — but the
   * deadline check below only runs between loop iterations, so it can only
   * actually bound the loop if nothing INSIDE one iteration can block longer
   * than `READINESS_POLL_INTERVAL_MS`. `isReady()`'s `fetchFn` call has no
   * per-call timeout, so a single slow/stalled `/last-poll` request (e.g.
   * bus-core's own HTTP server under load — this loop is calling back into
   * the same process that's driving it) could otherwise block
   * `await this.isReady(...)` indefinitely, and control would never return
   * to the top of the loop to re-evaluate the deadline at all.
   *
   * Each iteration races `isReady()` against `pacingSleep` (one single
   * `sleepFn(READINESS_POLL_INTERVAL_MS)` call, reused for both purposes) so
   * a stalled `isReady()` can't block past one poll interval. Critically,
   * `pacingSleep` is awaited AGAIN, unconditionally, after the race — so
   * every iteration takes at least a full poll interval no matter which side
   * of the race won. An EARLIER version of this fix raced `isReady()`
   * against a FRESH per-iteration sleep and returned to the top of the loop
   * as soon as either settled, with no unconditional wait — when `isReady()`
   * resolves fast (the normal case: every mocked test, and any real
   * same-process call that completes before the poll interval), it wins the
   * race instantly every time, so the loop never actually waits on anything
   * and re-enters in a tight microtask cycle. That starves the macrotask
   * queue — the very `setTimeout` callbacks the race depends on to ever
   * "lose" never get a turn to run — so `Date.now()` never advances either,
   * and the loop spins until the process runs out of memory. Confirmed
   * empirically (both under Vitest fake timers AND real timers via a
   * standalone script) before landing this corrected version.
   */
  private async pollReadiness(paneAgentId: string, launchStartedAt: Date): Promise<void> {
    for (;;) {
      if (this.elapsedSince(launchStartedAt) >= LAUNCH_READY_TIMEOUT_MS) {
        throw new PaneLaunchError(
          `Pane launch timed out waiting for "${paneAgentId}" readiness after ${LAUNCH_READY_TIMEOUT_MS}ms`,
        );
      }

      const isReadyPromise = this.isReady(paneAgentId, launchStartedAt);
      // Prevent an unhandled-rejection warning if this promise loses the
      // race below (pacingSleep wins) and only rejects afterward — this
      // dummy subscriber doesn't affect the race's own, separate
      // subscription to the same promise.
      isReadyPromise.catch(() => {});

      const pacingSleep = this.sleepFn(READINESS_POLL_INTERVAL_MS);
      const ready = await Promise.race([isReadyPromise, pacingSleep.then(() => false as const)]);
      if (ready) return;

      // Unconditional — guarantees this loop can never iterate faster than
      // once per READINESS_POLL_INTERVAL_MS, regardless of how fast
      // isReady() resolves. Cheap/instant if pacingSleep already won the
      // race above; otherwise waits out whatever's left of it.
      await pacingSleep;
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

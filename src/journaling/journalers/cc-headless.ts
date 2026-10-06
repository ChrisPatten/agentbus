/**
 * cc-headless journaler (E66 S66.6): resume the session's Claude transcript
 * with `claude -p --resume <claude_session_id>` and journal there, with the
 * whole conversation in context (`full-session` fidelity).
 *
 * Two ways to run, by the session's runtime:
 *   - cc-headless: through the instance's own handle (`journalSession`), so
 *     the turn uses the agent's system prompt and MCP config and is
 *     serialized with live turns on the same Claude session. Delivery tools
 *     are disallowed for the turn.
 *   - cc-pool: a direct `claude -p --resume <id> --fork-session` in the
 *     pool's working dir. Forking leaves the pane's own transcript untouched
 *     (the pane may still be live). No MCP servers are loaded, so the turn
 *     cannot message anyone; edits are accepted (`--permission-mode
 *     acceptEdits`) so it can write memory files.
 *
 * Both honor the journaler `model` (`--model`), the job timeout, and the
 * runner's abort signal: either kills the `claude -p` process group.
 * `canJournal` checks the Claude transcript is still on disk (Claude Code's
 * `cleanupPeriodDays` deletes old ones). Cost and tokens come from the CLI
 * result event.
 *
 * The agent may end its reply with `NOTHING_TO_RECORD` to report that the
 * window held nothing worth keeping (`nothing-to-do`).
 *
 * E68 S68.1 — consolidation jobs run a fresh `claude -p` (no `--resume`)
 * in the agent's working dir: through the instance handle on cc-headless
 * (system prompt, MCP tools), directly on cc-pool (with the agentbus tools
 * server when `toolsMcpConfig` is wired, so `propose_change` works).
 * E68 S68.4 — every turn denies edits to the job's protected paths.
 */
import { DISABLE_AUTO_MEMORY_ENV, autoMemorySettings } from '../../memory/native.js';
import type { ConsolidationTurnRequest, JournalSessionRequest, JournalSessionResult } from '../../adapters/cc-headless.js';
import type { RuntimeResolver } from '../../core/runtime-resolver.js';
import { INHERITED_CLAUDE_SESSION_VARS } from '../../pool/pane.js';
import { runProcess as defaultRunProcess, tail, type RunProcessOptions, type RunProcessResult } from '../process.js';
import { promptWithJobContext } from '../prompt.js';
import type { Journaler, JournalAvailability, JournalJob, JournalRunContext, JournalRunResult } from '../types.js';

export interface HeadlessJournalHandle {
  journalSession(opts: JournalSessionRequest): Promise<JournalSessionResult>;
  /** E68 — absent on handles that predate consolidation (tests). */
  consolidate?(opts: ConsolidationTurnRequest): Promise<JournalSessionResult>;
}

/** Marker the agent ends its reply with when there was nothing to record. */
export const NOTHING_TO_RECORD = 'NOTHING_TO_RECORD';

const PROMPT_SUFFIX =
  `When you are done, reply with one short line saying what you recorded. If nothing in this window was worth keeping, ` +
  `reply with exactly ${NOTHING_TO_RECORD}.`;

const ERROR_TAIL = 400;

/** Delivery tools a fresh consolidation run with the agentbus tools may never call. */
const JOURNAL_DELIVERY_TOOLS = 'mcp__agentbus__reply,mcp__agentbus__send_message,mcp__agentbus__send_email';

export interface CcHeadlessJournalerDeps {
  resolver: Pick<RuntimeResolver, 'checkLive' | 'resolve'>;
  /** Injectable for tests. */
  runProcess?: (opts: RunProcessOptions) => Promise<RunProcessResult>;
  /** Base environment for direct (cc-pool) runs. Default: the bus's own environment. */
  env?: () => Record<string, string | undefined>;
  /**
   * E68 — MCP config (agentbus tools only) for fresh cc-pool consolidation
   * runs, keyed by the bare agent id. Without it they run with no MCP servers.
   */
  toolsMcpConfig?: (bareAgentId: string) => unknown;
}

/**
 * E68 S68.4 — `--disallowedTools` rules that deny edits to protected paths.
 * Absolute paths use Claude Code's `//` prefix; directories (ending in `/`)
 * get a `**` glob. Both `Edit` and `Write` are listed.
 */
export function protectedPathDenyRules(paths: readonly string[] | undefined): string[] {
  const rules: string[] = [];
  for (const p of paths ?? []) {
    const glob = p.endsWith('/') ? `${p}**` : p;
    const spec = glob.startsWith('/') ? `/${glob}` : glob;
    rules.push(`Edit(${spec})`, `Write(${spec})`);
  }
  return rules;
}

/** Parse the `--output-format json` result object (the last JSON object on stdout). */
export function parseClaudeJsonResult(stdout: string): {
  isError: boolean;
  result: string | null;
  sessionId: string | null;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
} | null {
  const text = stdout.trim();
  if (!text) return null;
  const candidates = [text, ...text.split('\n').reverse()];
  for (const candidate of candidates) {
    try {
      const v = JSON.parse(candidate) as Record<string, unknown>;
      if (!v || typeof v !== 'object' || (v['type'] !== undefined && v['type'] !== 'result')) continue;
      const usage = (v['usage'] ?? {}) as Record<string, unknown>;
      const num = (x: unknown) => (typeof x === 'number' ? x : null);
      const input = num(usage['input_tokens']);
      const cacheCreate = num(usage['cache_creation_input_tokens']) ?? 0;
      const cacheRead = num(usage['cache_read_input_tokens']) ?? 0;
      return {
        isError: v['is_error'] === true,
        result: typeof v['result'] === 'string' ? v['result'] : null,
        sessionId: typeof v['session_id'] === 'string' ? v['session_id'] : null,
        costUsd: num(v['total_cost_usd']),
        inputTokens: input === null ? null : input + cacheCreate + cacheRead,
        outputTokens: num(usage['output_tokens']),
      };
    } catch {
      // not this line
    }
  }
  return null;
}

const saidNothing = (text: string | null | undefined) => !!text && text.trim().endsWith(NOTHING_TO_RECORD);

export class CcHeadlessJournaler implements Journaler {
  readonly id = 'cc-headless' as const;
  readonly requires = ['sessionResume'] as const;
  readonly supportsKinds = ['session', 'consolidate'] as const;

  /** Keyed by prefixed agent id, as `startHeadless()` returns them. */
  private readonly handles = new Map<string, HeadlessJournalHandle>();
  private readonly run_: (opts: RunProcessOptions) => Promise<RunProcessResult>;

  constructor(private readonly deps: CcHeadlessJournalerDeps) {
    this.run_ = deps.runProcess ?? defaultRunProcess;
  }

  addHandle(agentId: string, handle: HeadlessJournalHandle): void {
    this.handles.set(agentId, handle);
  }

  canJournal(job: JournalJob): JournalAvailability {
    if (job.kind === 'consolidate') return this.canConsolidate(job);
    if (job.runtime !== 'cc-headless' && job.runtime !== 'cc-pool') {
      return { ok: false, reason: `${job.runtime} sessions have no resumable Claude transcript` };
    }
    if (!job.claudeSessionId) return { ok: false, reason: 'session has no Claude session to resume yet' };
    if (job.runtime === 'cc-headless' && !this.handles.has(job.agentId)) {
      return { ok: false, reason: `cc-headless instance ${job.agentId} is not running` };
    }
    if (job.runtime === 'cc-pool' && !job.workingDir) return { ok: false, reason: 'pool has no working directory' };
    const live = this.deps.resolver.checkLive('sessionResume', { agentId: job.sessionAgentId, claudeSessionId: job.claudeSessionId });
    return live.ok ? { ok: true } : { ok: false, reason: live.reason };
  }

  private canConsolidate(job: JournalJob): JournalAvailability {
    if (job.runtime === 'cc-headless') {
      return this.handles.get(job.agentId)?.consolidate ? { ok: true } : { ok: false, reason: `cc-headless instance ${job.agentId} is not running` };
    }
    if (job.runtime === 'cc-pool') return job.workingDir ? { ok: true } : { ok: false, reason: 'pool has no working directory' };
    return { ok: false, reason: `${job.runtime} agents can't run a fresh claude -p` };
  }

  private prompt(job: JournalJob): string {
    if (job.kind === 'consolidate') return `${job.prompt.trim()}\n\n${PROMPT_SUFFIX}`;
    return `${promptWithJobContext(job.settings.journalers['cc-headless'].prompt, job)}\n\n${PROMPT_SUFFIX}`;
  }

  async run(job: JournalJob, ctx?: JournalRunContext): Promise<JournalRunResult> {
    if (job.kind === 'consolidate') return job.runtime === 'cc-headless' ? this.consolidateViaHandle(job, ctx) : this.runDirect(job, ctx);
    if (!job.claudeSessionId) return { outcome: 'unavailable', error: 'no Claude session to resume' };
    return job.runtime === 'cc-headless' ? this.runViaHandle(job, ctx) : this.runDirect(job, ctx);
  }

  private async runViaHandle(job: JournalJob, ctx?: JournalRunContext): Promise<JournalRunResult> {
    const handle = this.handles.get(job.agentId);
    if (!handle) return { outcome: 'unavailable', error: `cc-headless instance ${job.agentId} is not running` };
    const result = await handle.journalSession({
      conversationId: job.conversationId,
      claudeSessionId: job.claudeSessionId!,
      contactId: job.contactId,
      channel: job.channel,
      prompt: this.prompt(job),
      model: job.settings.journalers['cc-headless'].model,
      timeoutMs: job.timeoutMs,
      denyTools: protectedPathDenyRules(job.protectedPaths),
      ...(ctx?.signal ? { signal: ctx.signal } : {}),
    });
    return this.handleResult(result);
  }

  private async consolidateViaHandle(job: JournalJob, ctx?: JournalRunContext): Promise<JournalRunResult> {
    const handle = this.handles.get(job.agentId);
    if (!handle?.consolidate) return { outcome: 'unavailable', error: `cc-headless instance ${job.agentId} is not running` };
    const result = await handle.consolidate({
      prompt: this.prompt(job),
      model: job.settings.journalers['cc-headless'].model,
      timeoutMs: job.timeoutMs,
      denyTools: protectedPathDenyRules(job.protectedPaths),
      ...(ctx?.signal ? { signal: ctx.signal } : {}),
    });
    return this.handleResult(result);
  }

  private handleResult(result: JournalSessionResult): JournalRunResult {
    const cost = { costUsd: result.costUsd, inputTokens: result.inputTokens, outputTokens: result.outputTokens };
    if (result.error) {
      const beforeStart = !result.timedOut && result.error.startsWith('spawn failed');
      return { outcome: beforeStart ? 'failed-before-start' : 'failed-after-start', error: result.error, fidelity: 'full-session', ...cost };
    }
    return {
      outcome: saidNothing(result.resultText) ? 'nothing-to-do' : 'done',
      fidelity: 'full-session',
      ...(result.resultText ? { notes: tail(result.resultText, 500) } : {}),
      ...cost,
    };
  }

  private async runDirect(job: JournalJob, ctx?: JournalRunContext): Promise<JournalRunResult> {
    const runtime = this.deps.resolver.resolve(job.sessionAgentId);
    if (!runtime || runtime.kind !== 'cc-pool') return { outcome: 'unavailable', error: `no cc-pool runtime for ${job.sessionAgentId}` };
    const model = job.settings.journalers['cc-headless'].model;
    const consolidate = job.kind === 'consolidate';
    const bareAgent = job.agentId.startsWith('agent:') ? job.agentId.slice('agent:'.length) : job.agentId;
    const mcpConfig = consolidate && this.deps.toolsMcpConfig ? JSON.stringify(this.deps.toolsMcpConfig(bareAgent)) : '{"mcpServers":{}}';
    const deny = [...(consolidate ? [JOURNAL_DELIVERY_TOOLS] : []), ...protectedPathDenyRules(job.protectedPaths)];
    const args = [
      '-p', this.prompt(job),
      // Session jobs fork the pane's transcript; consolidation starts fresh.
      ...(consolidate ? [] : ['--resume', job.claudeSessionId!, '--fork-session']),
      '--output-format', 'json',
      '--permission-mode', 'acceptEdits',
      '--mcp-config', mcpConfig,
      '--strict-mcp-config',
      ...(deny.length > 0 ? ['--disallowedTools', deny.join(',')] : []),
      ...(model ? ['--model', model] : []),
      // E67 — the fork sees the pool's memory the way its panes do.
      ...(job.nativeMemory && job.memoryDir ? ['--settings', autoMemorySettings(job.memoryDir)] : []),
    ];
    const base = this.deps.env?.() ?? process.env;
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries({ ...base, ...runtime.pool.pane_env })) {
      if (typeof v === 'string' && !(INHERITED_CLAUDE_SESSION_VARS as readonly string[]).includes(k) && k !== 'TMUX') env[k] = v;
    }
    if (job.nativeMemory) delete env[DISABLE_AUTO_MEMORY_ENV];
    const proc = await this.run_({
      command: runtime.pool.claude_bin,
      args,
      cwd: runtime.workingDir,
      env,
      timeoutMs: job.timeoutMs,
      ...(ctx?.signal ? { signal: ctx.signal } : {}),
    });
    const parsed = parseClaudeJsonResult(proc.stdout);
    const cost = { costUsd: parsed?.costUsd ?? null, inputTokens: parsed?.inputTokens ?? null, outputTokens: parsed?.outputTokens ?? null };
    if (proc.spawnError) return { outcome: 'failed-before-start', error: `spawn failed: ${proc.spawnError}` };
    if (proc.timedOut || proc.aborted) {
      return {
        outcome: 'failed-after-start', fidelity: 'full-session', ...cost,
        error: proc.aborted ? 'journaling turn aborted; process group killed' : `journaling turn timed out after ${job.timeoutMs} ms; process group killed`,
      };
    }
    if (proc.code !== 0 || !parsed || parsed.isError) {
      const detail = parsed?.isError ? parsed.result ?? 'claude reported an error' : tail(proc.stderr, ERROR_TAIL) || `exit code ${proc.code}`;
      return { outcome: 'failed-after-start', error: detail, fidelity: 'full-session', ...cost };
    }
    return {
      outcome: saidNothing(parsed.result) ? 'nothing-to-do' : 'done',
      fidelity: 'full-session',
      ...(parsed.result ? { notes: tail(parsed.result, 500) } : {}),
      ...cost,
    };
  }
}

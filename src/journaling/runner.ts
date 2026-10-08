/**
 * Chain runner (E66 S66.5): walk an agent's journaler chain for one job.
 *
 * For each journaler the runtime can statically support, in chain order:
 *   1. not registered, wrong job kind, or `canJournal` says no → `unavailable`;
 *   2. otherwise `run(job)` (a throw is `failed-after-start`);
 *   3. one `journal_runs` row per attempt (statically incompatible entries
 *      are skipped without a row: they never run on this runtime);
 *   4. `done` / `nothing-to-do` stop the chain; anything else moves on.
 *
 * Afterwards:
 *   - success: advance the cursor to `job.window.advanceTo`, clear the
 *     pending trigger and attempt counter, mark snapshots consumed, reset
 *     the agent's exhaustion streak, resolve the exhaustion advisory;
 *   - exhausted: the cursor stays; count the attempt for this window and
 *     the agent's streak; raise `journaling:chain-exhausted` (warning, or
 *     critical after 3 consecutive exhaustions or 24 h of backlog).
 * Consolidation jobs (E68) skip the cursor bookkeeping: success resolves
 * `journaling:consolidation-exhausted`, exhaustion raises it (warning).
 * Partial writes from a failed attempt are not rolled back (out of scope).
 */
import { missingCapabilities, type RuntimeCapabilities } from '../core/runtime-capabilities.js';
import {
  raiseChainExhausted,
  raiseConsolidationExhausted,
  resolveChainExhausted,
  resolveConsolidationExhausted,
  type JournalAdvisories,
} from './advisories.js';
import { JOURNALER_REQUIREMENTS } from './config.js';
import type { JournalerRegistry } from './registry.js';
import type { JournalStore } from './store.js';
import {
  isSuccess,
  type JournalJob,
  type JournalOutcome,
  type JournalRunResult,
  type JournalerId,
} from './types.js';

/**
 * Safety net for a journaler that never settles: after this multiple of the
 * job timeout the attempt's abort signal fires (the journaler kills its
 * process group), the attempt is recorded as `failed-after-start` and the
 * agent's lane is released. Journalers enforce their own timeouts first.
 */
export const SETTLE_TIMEOUT_FACTOR = 3;

export interface ChainAttempt {
  journaler: JournalerId;
  chainPosition: number;
  outcome: JournalOutcome;
  error: string | null;
  durationMs: number;
  result: JournalRunResult | null;
}

export interface ChainRunSummary {
  runId: string;
  outcome: 'done' | 'nothing-to-do' | 'exhausted';
  /** The journaler that succeeded, if any. */
  journaler: JournalerId | null;
  attempts: ChainAttempt[];
  cursorAdvanced: boolean;
  /** Severity of the exhaustion advisory, when one was raised. */
  advisory: 'warning' | 'critical' | null;
}

/**
 * E68 S68.4 — wraps every run, whatever the journaler: `begin` before the
 * first attempt, `end` after the outcome is known (the protected-path
 * monitor hashes protected files around the run). Errors are logged.
 */
export interface RunGuard<T = unknown> {
  begin(job: JournalJob): T;
  end(job: JournalJob, token: T, summary: ChainRunSummary): unknown;
}

export interface ChainRunnerDeps {
  store: JournalStore;
  registry: JournalerRegistry;
  advisories?: JournalAdvisories;
  guard?: RunGuard<any>;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface ChainRunContext {
  /** The configured chain (unfiltered). */
  chain: readonly JournalerId[];
  /** Static capabilities of the agent's runtime. */
  capabilities: Readonly<RuntimeCapabilities>;
  /** When the unjournaled content became eligible (backlog age), or null. */
  backlogSince: string | null;
}

/**
 * Run `start(signal)`, rejecting after `ms`. On timeout the signal aborts
 * first, so the journaler can kill what it started (its `claude -p` or
 * script process group) instead of leaving it running after the lane moves on.
 */
function withSettleTimeout<T>(start: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort(new Error('settle timeout'));
      reject(new Error(`journaler did not settle within ${ms} ms; its work was stopped`));
    }, ms);
    timer.unref?.();
    let promise: Promise<T>;
    try {
      promise = start(controller.signal);
    } catch (err) {
      clearTimeout(timer);
      reject(err);
      return;
    }
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e: unknown) => { clearTimeout(timer); reject(e); },
    );
  });
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export async function runChain(job: JournalJob, ctx: ChainRunContext, deps: ChainRunnerDeps): Promise<ChainRunSummary> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((line: string) => console.log(line));
  const runStarted = now();
  let guardToken: unknown = null;
  let guarded = false;
  if (deps.guard) {
    try {
      guardToken = deps.guard.begin(job);
      guarded = true;
    } catch (err) {
      log(`[journaling] run guard failed before run ${job.runId.slice(0, 8)}: ${errText(err)}`);
    }
  }
  const attempts: ChainAttempt[] = [];
  let winner: ChainAttempt | null = null;
  let previous: JournalerId | null = null;

  for (const [position, id] of ctx.chain.entries()) {
    if (missingCapabilities(ctx.capabilities, JOURNALER_REQUIREMENTS[id]).length > 0) continue;

    const startedAt = now();
    let outcome: JournalOutcome;
    let error: string | null = null;
    let result: JournalRunResult | null = null;
    const journaler = deps.registry.get(id);

    if (!journaler) {
      outcome = 'unavailable';
      error = `journaler ${id} is not registered`;
    } else if (!journaler.supportsKinds.includes(job.kind)) {
      outcome = 'unavailable';
      error = `journaler ${id} does not support ${job.kind} jobs`;
    } else {
      let available: { ok: boolean; reason?: string };
      try {
        available = await journaler.canJournal(job);
      } catch (err) {
        available = { ok: false, reason: `canJournal threw: ${errText(err)}` };
      }
      if (!available.ok) {
        outcome = 'unavailable';
        error = available.reason ?? 'unavailable';
      } else {
        try {
          result = await withSettleTimeout((signal) => journaler.run(job, { signal }), Math.max(1, job.timeoutMs) * SETTLE_TIMEOUT_FACTOR);
          outcome = result.outcome;
          error = result.error ?? null;
        } catch (err) {
          outcome = 'failed-after-start';
          error = errText(err);
        }
      }
    }

    const durationMs = now().getTime() - startedAt.getTime();
    const attempt: ChainAttempt = { journaler: id, chainPosition: position, outcome, error, durationMs, result };
    attempts.push(attempt);
    deps.store.insertRun({
      runId: job.runId,
      agentId: job.agentId,
      sessionId: job.sessionId || null,
      conversationId: job.conversationId || null,
      kind: job.kind,
      trigger: job.trigger,
      journaler: id,
      chainPosition: position,
      fallbackFrom: previous,
      outcome,
      error,
      fidelity: result?.fidelity ?? null,
      windowFrom: job.window.from,
      windowTo: job.window.to,
      messageCount: job.messages.length,
      startedAt: startedAt.toISOString(),
      durationMs,
      filesChanged: result?.filesChanged ?? null,
      notes: result?.notes ?? null,
      costUsd: result?.costUsd ?? null,
      inputTokens: result?.inputTokens ?? null,
      outputTokens: result?.outputTokens ?? null,
    });
    previous = id;
    if (isSuccess(outcome)) {
      winner = attempt;
      break;
    }
  }

  let summary: ChainRunSummary;
  if (job.kind === 'consolidate') {
    // E68: consolidation has no session cursor or window; its health is its own advisory.
    if (winner) {
      resolveConsolidationExhausted(deps.advisories, job.agentId);
      summary = { runId: job.runId, outcome: winner.outcome as 'done' | 'nothing-to-do', journaler: winner.journaler, attempts, cursorAdvanced: false, advisory: null };
    } else {
      raiseConsolidationExhausted(deps.advisories, {
        agentId: job.agentId,
        attempts: attempts.map((a) => ({ journaler: a.journaler, outcome: a.outcome, error: a.error })),
      });
      summary = { runId: job.runId, outcome: 'exhausted', journaler: null, attempts, cursorAdvanced: false, advisory: 'warning' };
    }
  } else if (winner) {
    const success = winner.outcome as 'done' | 'nothing-to-do';
    deps.store.advanceCursor(job.sessionId, job.window.advanceTo);
    deps.store.recordSuccess(job.sessionId, success);
    deps.store.consumeSnapshots(job.snapshots.map((s) => s.id), job.runId);
    const failed = attempts.filter((a) => a !== winner && a.outcome !== 'unavailable');
    if (failed.length > 0) {
      deps.store.recordAgentFailure(job.agentId, `${failed[failed.length - 1]!.journaler}: ${failed[failed.length - 1]!.error ?? failed[failed.length - 1]!.outcome}`);
    }
    deps.store.recordAgentSuccess(job.agentId);
    resolveChainExhausted(deps.advisories, job.agentId);
    summary = { runId: job.runId, outcome: success, journaler: winner.journaler, attempts, cursorAdvanced: true, advisory: null };
  } else {
    deps.store.recordExhausted(job.sessionId, job.window.advanceTo);
    const last = attempts[attempts.length - 1];
    const consecutive = deps.store.recordAgentExhausted(
      job.agentId,
      last ? `${last.journaler}: ${last.error ?? last.outcome}` : 'no runnable journaler',
    );
    const backlogMs = ctx.backlogSince ? now().getTime() - new Date(ctx.backlogSince).getTime() : null;
    const severity = raiseChainExhausted(deps.advisories, {
      agentId: job.agentId,
      consecutive,
      backlogMs,
      attempts: attempts.map((a) => ({ journaler: a.journaler, outcome: a.outcome, error: a.error })),
    });
    summary = { runId: job.runId, outcome: 'exhausted', journaler: null, attempts, cursorAdvanced: false, advisory: severity };
  }

  if (guarded) {
    try {
      deps.guard!.end(job, guardToken, summary);
    } catch (err) {
      log(`[journaling] run guard failed after run ${job.runId.slice(0, 8)}: ${errText(err)}`);
    }
  }

  // One structured line per run (S66.10 reads the same fields from journal_runs).
  log(`[journaling] ${JSON.stringify({
    run_id: job.runId,
    kind: job.kind,
    agent: job.agentId,
    session: job.sessionId,
    conversation: job.conversationId,
    trigger: job.trigger,
    outcome: summary.outcome,
    journaler: summary.journaler,
    attempts: attempts.map((a) => `${a.journaler}:${a.outcome}`),
    window: [job.window.from, job.window.to],
    messages: job.messages.length,
    human: job.humanMessageCount,
    snapshots: job.snapshots.length,
    duration_ms: now().getTime() - runStarted.getTime(),
    fidelity: winner?.result?.fidelity ?? null,
    files_changed: winner?.result?.filesChanged?.length ?? 0,
    cost_usd: attempts.reduce<number | null>((sum, a) => (a.result?.costUsd == null ? sum : (sum ?? 0) + a.result.costUsd), null),
    ...(summary.advisory ? { advisory: summary.advisory } : {}),
  })}`);

  return summary;
}

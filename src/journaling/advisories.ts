/**
 * Journaling advisories (E66): the conditions journaling raises through the
 * E65 advisory service, and the text for each. See docs/JOURNALING.md.
 *
 *   journaling:chain-can-exhaust   info      startup check: the chain's last runnable
 *                                            journaler is not `script` (S66.1)
 *   journaling:chain-exhausted     warning   a journal run tried every journaler and
 *                                  critical  none succeeded; critical after 3
 *                                            consecutive exhaustions or 24 h of
 *                                            unjournaled eligible content (S66.5)
 *   journaling:hook-stopped:<evt>  warning   a hook that used to report <evt> has gone
 *                                            quiet for an active session (S66.4)
 *   journaling:consolidation-exhausted
 *                                  warning   a consolidation pass tried every journaler
 *                                            and none succeeded (E68 S68.1)
 */
import type { AdvisoryService } from '../advisories/service.js';
import type { AgentRuntime } from '../core/runtime-resolver.js';
import { CHAIN_RISK_CONDITION, chainExhaustionRisk, type JournalingSettings } from './config.js';

export { CHAIN_RISK_CONDITION };
export const CHAIN_EXHAUSTED_CONDITION = 'journaling:chain-exhausted';
export const CONSOLIDATION_EXHAUSTED_CONDITION = 'journaling:consolidation-exhausted';
export const hookStoppedCondition = (event: string) => `journaling:hook-stopped:${event}`;

/** Consecutive exhausted runs before the exhaustion advisory turns critical. */
export const CRITICAL_AFTER_EXHAUSTIONS = 3;
/** Age of unjournaled eligible content before the exhaustion advisory turns critical. */
export const CRITICAL_BACKLOG_MS = 24 * 60 * 60 * 1000;

export type JournalAdvisories = Pick<AdvisoryService, 'raise' | 'resolve'>;

/**
 * Startup check (S66.1): raise `journaling:chain-can-exhaust` for agents
 * whose chain can run out of options, and resolve it for those whose chain
 * no longer can. Returns the agents it raised for.
 */
export function reviewChains(
  settings: Iterable<JournalingSettings>,
  resolver: { resolve(agentId: string): AgentRuntime | undefined },
  advisories: JournalAdvisories | undefined,
  log: (msg: string) => void = (m) => console.warn(m),
): string[] {
  const raised: string[] = [];
  for (const s of settings) {
    const runtime = resolver.resolve(s.agentId);
    const risk = runtime ? chainExhaustionRisk(s, runtime) : null;
    if (!risk) {
      advisories?.resolve(s.agentId, CHAIN_RISK_CONDITION);
      continue;
    }
    raised.push(s.agentId);
    log(`[journaling] ${s.agentId}: ${risk}`);
    advisories?.raise({
      agentId: s.agentId,
      conditionKey: CHAIN_RISK_CONDITION,
      severity: 'info',
      title: 'Journaling can run out of options',
      body: risk,
      remediation:
        `End agents.${s.agentId}.journaling.chain with "script" and set journaling.script.command ` +
        '(for example scripts/journalers/claude-p-journal.sh). The script journaler only needs the bus transcript, so it can always run.',
      source: 'journaling',
    });
  }
  return raised;
}

/** Raise or escalate the exhaustion advisory after a run where every journaler failed. */
export function raiseChainExhausted(
  advisories: JournalAdvisories | undefined,
  input: {
    agentId: string;
    consecutive: number;
    backlogMs: number | null;
    attempts: Array<{ journaler: string; outcome: string; error?: string | null }>;
  },
): 'warning' | 'critical' {
  const critical =
    input.consecutive >= CRITICAL_AFTER_EXHAUSTIONS || (input.backlogMs !== null && input.backlogMs >= CRITICAL_BACKLOG_MS);
  const severity = critical ? 'critical' : 'warning';
  const tried = input.attempts.length > 0
    ? input.attempts.map((a) => `${a.journaler}: ${a.outcome}${a.error ? ` (${a.error})` : ''}`).join('; ')
    : 'no journaler was runnable';
  const backlogH = input.backlogMs !== null ? Math.floor(input.backlogMs / 3_600_000) : null;
  advisories?.raise({
    agentId: input.agentId,
    conditionKey: CHAIN_EXHAUSTED_CONDITION,
    severity,
    title: critical ? 'Journaling keeps failing' : 'A journal run failed',
    body:
      `Every journaler in the chain failed (${tried}). ` +
      `${input.consecutive} consecutive failed run${input.consecutive === 1 ? '' : 's'}` +
      (backlogH !== null && backlogH > 0 ? `; the oldest unjournaled conversation content is ${backlogH} h old.` : '.') +
      ' The bus retries on the next trigger; nothing is lost yet.',
    remediation:
      'Check the bus log for "[journaling]" lines. Make sure the last journaler in the chain can always run ' +
      '(a configured script journaler is the safe last resort).',
    source: 'journaling',
  });
  return severity;
}

export function resolveChainExhausted(advisories: JournalAdvisories | undefined, agentId: string): void {
  advisories?.resolve(agentId, CHAIN_EXHAUSTED_CONDITION);
}

/** E68 — every journaler failed a consolidation pass. */
export function raiseConsolidationExhausted(
  advisories: JournalAdvisories | undefined,
  input: { agentId: string; attempts: Array<{ journaler: string; outcome: string; error?: string | null }> },
): void {
  const tried = input.attempts.length > 0
    ? input.attempts.map((a) => `${a.journaler}: ${a.outcome}${a.error ? ` (${a.error})` : ''}`).join('; ')
    : 'no journaler that supports consolidation was runnable';
  advisories?.raise({
    agentId: input.agentId,
    conditionKey: CONSOLIDATION_EXHAUSTED_CONDITION,
    severity: 'warning',
    title: 'Memory consolidation failed',
    body: `The consolidation pass could not run with any journaler (${tried}). Journals are still recorded; they are just not being consolidated.`,
    remediation:
      'Check the bus log for "[journaling]" lines, then run /journal consolidate. A script journaler that handles ' +
      '`kind: "consolidate"` payloads, or cc-headless on cc-headless/cc-pool agents, can always run.',
    source: 'journaling',
  });
}

export function resolveConsolidationExhausted(advisories: JournalAdvisories | undefined, agentId: string): void {
  advisories?.resolve(agentId, CONSOLIDATION_EXHAUSTED_CONDITION);
}

/**
 * Bus advisory types (E65). See docs/ADVISORIES.md.
 */

export const ADVISORY_SEVERITIES = ['info', 'warning', 'critical'] as const;
export type AdvisorySeverity = (typeof ADVISORY_SEVERITIES)[number];

export const ADVISORY_STATES = ['open', 'delivered', 'acknowledged', 'resolved'] as const;
export type AdvisoryState = (typeof ADVISORY_STATES)[number];

/** How an advisory reached its owners. */
export type AdvisoryDeliveryPath = 'injection' | 'system-turn' | 'direct';

/** Severity order: info < warning < critical. */
export const SEVERITY_RANK: Readonly<Record<AdvisorySeverity, number>> = { info: 0, warning: 1, critical: 2 };

/** One row of the `advisories` table. */
export interface Advisory {
  id: string;
  agent_id: string;
  condition_key: string;
  severity: AdvisorySeverity;
  title: string;
  body: string;
  remediation: string;
  source: string | null;
  state: AdvisoryState;
  raised_at: string;
  updated_at: string;
  last_raised_at: string;
  raise_count: number;
  delivered_at: string | null;
  delivered_via: AdvisoryDeliveryPath | null;
  delivery_attempts: number;
  last_attempt_at: string | null;
  last_error: string | null;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  resolved_at: string | null;
}

/** What a producer passes to `raise()`. */
export interface AdvisoryInput {
  /** Agent the advisory is about, bare or prefixed. Pane ids are mapped to their pool by the service. */
  agentId: string;
  /** Stable key for the condition, e.g. "journaling:chain-exhausted". One active advisory per key per agent. */
  conditionKey: string;
  severity: AdvisorySeverity;
  /** One line, shown first. */
  title: string;
  /** What happened. */
  body: string;
  /** What the owner can do about it. Required: every advisory carries a remediation hint. */
  remediation: string;
  /** Producer name, e.g. "journaling". */
  source?: string;
}

/**
 * What `raise()` did:
 *   - created:   no active advisory for the condition; a new one was opened
 *   - escalated: severity went up; the advisory is open again for redelivery
 *   - updated:   text changed, same or lower severity; delivery state kept
 *   - unchanged: identical raise; only `last_raised_at` / `raise_count` moved
 */
export type RaiseOutcome = 'created' | 'escalated' | 'updated' | 'unchanged';

export interface RaiseResult {
  advisory: Advisory;
  outcome: RaiseOutcome;
}

export type AckResult =
  | { ok: true; advisory: Advisory; alreadyAcknowledged: boolean }
  | { ok: false; reason: 'not_found' | 'wrong_agent' | 'resolved'; advisory?: Advisory };

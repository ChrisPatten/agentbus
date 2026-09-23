/**
 * S51.4 — resolves a pending approval request with a human's decision (E51).
 *
 * One entry point shared by every way an answer can arrive — the
 * `POST /api/v1/approvals/:id/resolve` route and the Telegram
 * `callback_query` handler — so the staleness/expiry/idempotency rules live
 * in exactly one place.
 *
 * The backend-specific half (turning a decision into keystrokes for a
 * `cc-pool` pane) stays behind `PoolManager.resolveApproval()`; a future
 * backend adds its own branch in `deliverDecision()`, same seam as
 * `resolve-target.ts`.
 */
import { findPoolManagerForAgent, type PoolManager } from '../pool/pool-manager.js';
import type { ApprovalStore } from './store.js';
import type { ApprovalDecision, ApprovalRequest } from './types.js';

export interface ResolveApprovalDeps {
  store: ApprovalStore;
  poolManagers: Map<string, PoolManager>;
}

export type ResolveApprovalOutcome =
  | { outcome: 'not_found' }
  /** `onlyContactId` was given and the request is addressed to a different contact — nothing was sent. */
  | { outcome: 'forbidden' }
  /** Row was already terminal (answered at the terminal, expired, or tapped twice) — nothing was sent. */
  | { outcome: 'already_resolved'; request: ApprovalRequest }
  /** Row was terminal-ized as `expired`/`stale` by THIS call; no keystroke was sent. */
  | { outcome: 'stale' | 'expired'; request: ApprovalRequest; reason: string }
  | { outcome: 'approved' | 'denied'; request: ApprovalRequest };

/** Request ids with a keystroke currently in flight, so a double-tap can't send the key twice. */
const inFlight = new Set<string>();

export async function resolveApproval(
  deps: ResolveApprovalDeps,
  id: string,
  decision: ApprovalDecision,
  resolvedBy: string,
  now: Date = new Date(),
  onlyContactId?: string,
): Promise<ResolveApprovalOutcome> {
  const row = deps.store.getById(id);
  if (!row) return { outcome: 'not_found' };
  if (onlyContactId && bareContact(row.contact_id) !== bareContact(onlyContactId)) return { outcome: 'forbidden' };
  if (row.status !== 'pending' || inFlight.has(id)) return { outcome: 'already_resolved', request: row };

  // Never inject a keystroke for a request the sweep simply hasn't reached yet.
  if (row.expires_at < now.toISOString()) {
    deps.store.resolve(id, 'expired', 'timeout', now);
    return { outcome: 'expired', request: deps.store.getById(id)!, reason: 'request timed out' };
  }

  inFlight.add(id);
  try {
    const delivery = await deliverDecision(deps, row, decision);
    if (delivery.result === 'stale') {
      deps.store.markStale(id, delivery.reason, now);
      return { outcome: 'stale', request: deps.store.getById(id)!, reason: delivery.reason };
    }

    const status = decision === 'approve' ? 'approved' : 'denied';
    deps.store.resolve(id, status, resolvedBy, now, { keys_sent: delivery.key });
    console.log(`[approvals] ${id} ${status} by ${resolvedBy} — sent "${delivery.key}" (${row.summary})`);
    return { outcome: status, request: deps.store.getById(id)! };
  } finally {
    inFlight.delete(id);
  }
}

function bareContact(id: string): string {
  return id.replace(/^contact:/, '');
}

async function deliverDecision(
  deps: ResolveApprovalDeps,
  row: ApprovalRequest,
  decision: ApprovalDecision,
): Promise<{ result: 'resolved'; key: string } | { result: 'stale'; reason: string }> {
  if (row.adapter_id === 'cc-pool') {
    const manager = findPoolManagerForAgent(deps.poolManagers, row.agent_id);
    if (!manager) return { result: 'stale', reason: `no configured pool owns agent "${row.agent_id}"` };
    return manager.resolveApproval(row.agent_id, row.conversation_id, decision);
  }
  return { result: 'stale', reason: `no resolver for backend "${row.adapter_id}"` };
}

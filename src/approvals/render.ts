/**
 * Plain-text rendering of an approval notification (E51), shared by every
 * adapter that implements `notifyApproval`/`finalizeApproval` so the pending
 * and resolved forms of the same message read consistently. Plain text on
 * purpose — a tool's summary is arbitrary content (shell commands, paths) and
 * must never be parsed as Markdown/HTML by the notifying platform.
 */
import type { ApprovalRequest } from './types.js';

const OUTCOME_LABEL: Record<Exclude<ApprovalRequest['status'], 'pending'>, string> = {
  approved: '✅ Approved',
  denied: '🚫 Denied',
  expired: '⌛ Expired — no answer in time',
  stale: '⚠️ No longer applicable',
};

export function renderApprovalPending(request: ApprovalRequest): string {
  const expires = new Date(request.expires_at).toISOString().slice(11, 16);
  return `🔐 Approval needed\n${request.tool_name}: ${request.summary}\n\nAgent: ${request.agent_id} · answer by ${expires} UTC`;
}

/** Terminal-state text: the outcome, then what it was about. */
export function renderApprovalOutcome(request: ApprovalRequest): string {
  const label = request.status === 'pending' ? '⏳ Pending' : OUTCOME_LABEL[request.status];
  const by = request.resolved_by && !['system', 'timeout'].includes(request.resolved_by) ? ` by ${request.resolved_by}` : '';
  return `${label}${by}\n${request.tool_name}: ${request.summary}`;
}

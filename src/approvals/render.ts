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

/** Max characters of `raw_context.details` in a notification (Telegram allows 4096 in all). */
const MAX_DETAILS = 3000;

/** `raw_context.details`: a body a backend wants shown (E68 proposals: rationale and diff). */
function detailsOf(request: ApprovalRequest): string | null {
  if (!request.raw_context) return null;
  try {
    const v = JSON.parse(request.raw_context) as { details?: unknown };
    if (typeof v.details !== 'string' || v.details.trim() === '') return null;
    return v.details.length > MAX_DETAILS ? `${v.details.slice(0, MAX_DETAILS)}\n…` : v.details;
  } catch {
    return null;
  }
}

export function renderApprovalPending(request: ApprovalRequest): string {
  const expiresAt = new Date(request.expires_at);
  // Same-day requests show the time; long-lived ones (E68 proposals, 7 days) the date too.
  const longLived = expiresAt.getTime() - new Date(request.requested_at).getTime() > 24 * 60 * 60 * 1000;
  const expires = longLived ? expiresAt.toISOString().slice(0, 16).replace('T', ' ') : expiresAt.toISOString().slice(11, 16);
  const details = detailsOf(request);
  if (request.adapter_id === 'self-edit') {
    return `📝 Proposed change\n${details ?? request.summary}\n\nAgent: ${request.agent_id} · answer by ${expires} UTC`;
  }
  return `🔐 Approval needed\n${request.tool_name}: ${request.summary}${details ? `\n\n${details}` : ''}\n\nAgent: ${request.agent_id} · answer by ${expires} UTC`;
}

/** Terminal-state text: the outcome, then what it was about. */
export function renderApprovalOutcome(request: ApprovalRequest): string {
  const label = request.status === 'pending' ? '⏳ Pending' : OUTCOME_LABEL[request.status];
  const by = request.resolved_by && !['system', 'timeout'].includes(request.resolved_by) ? ` by ${request.resolved_by}` : '';
  return `${label}${by}\n${request.tool_name}: ${request.summary}`;
}

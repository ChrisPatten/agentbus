/**
 * S51.1 — resolves WHO to ask and WHERE to notify them, from a backend's
 * `{ adapterId, agentId }` pair alone (E51).
 *
 * For `cc-pool`: the pane's lease (`pool_leases`, keyed by its PREFIXED
 * agent id) carries the `conversation_id` it's currently serving; `sessions`
 * (keyed by that `conversation_id`) carries the `contact_id` and `channel`
 * that conversation was addressed through. Chaining those two lookups is
 * "the same lease-lookup pool-manager.ts already exposes for
 * GET /api/v1/pool" the epic points at — `LeaseStore.findByAgentAnyPool()`,
 * already used this same way by src/http/api.ts's outbound stale-sender
 * guard (E48 S48.6).
 *
 * A future backend (`cc-headless`, `codex-headless`) implements its own
 * resolution here — this module is intentionally the one seam a new
 * `adapterId` needs to extend, mirroring the per-backend seam
 * `notifyApproval`/`resolveApproval` give the notification/resolution sides.
 */
import type Database from 'better-sqlite3';
import { LeaseStore } from '../pool/lease-store.js';
import { toPrefixedAgentId } from '../pool/types.js';

export interface ApprovalTarget {
  contactId: string;
  /** The channel string (e.g. "telegram", "telegram:peggy:group:-100...") the conversation was addressed through — used to pick a notifying adapter, not persisted directly on the row. */
  channel: string;
  /** The conversation this request is scoped to, when known — persisted as `approval_requests.conversation_id`. */
  conversationId: string | null;
}

/**
 * Resolves `{ contactId, channel, conversationId }` for a `POST
 * /api/v1/approvals` request, or `null` if no target could be determined
 * (unknown backend, no live lease, or no session row yet for the
 * conversation — every case is logged by the caller and surfaces as a 422,
 * never a silent drop).
 */
export function resolveApprovalTarget(
  db: Database.Database,
  adapterId: string,
  agentId: string,
  conversationIdHint?: string | null,
): ApprovalTarget | null {
  if (adapterId === 'cc-pool') {
    return resolveCcPoolTarget(db, agentId, conversationIdHint);
  }
  // Unknown backend — nothing else registered yet (E51 v1 is cc-pool only;
  // see the epic's Non-Goals). A future backend adds its own branch here.
  return null;
}

function resolveCcPoolTarget(
  db: Database.Database,
  agentId: string,
  conversationIdHint?: string | null,
): ApprovalTarget | null {
  const leaseStore = new LeaseStore(db);
  const leaseRow = leaseStore.findByAgentAnyPool(toPrefixedAgentId(agentId));
  const conversationId = leaseRow?.conversation_id ?? conversationIdHint ?? null;
  if (!conversationId) return null;

  const session = db
    .prepare(
      `SELECT contact_id, channel FROM sessions WHERE conversation_id = ? ORDER BY started_at DESC LIMIT 1`,
    )
    .get(conversationId) as { contact_id: string; channel: string } | undefined;
  if (!session) return null;

  return { contactId: session.contact_id, channel: session.channel, conversationId };
}

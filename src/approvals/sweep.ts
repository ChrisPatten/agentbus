/**
 * S51.6 — expiry sweep + message-state cleanup (E51).
 *
 * Two jobs, run together on every tick (piggybacked onto bus-core's existing
 * maintenance interval in src/index.ts — no second timer):
 *   1. Any `pending` row past its `expires_at` becomes `expired`. The
 *      underlying prompt is left exactly as Claude Code's own default
 *      behavior already handles an unattended prompt — this sweep never
 *      sends any keystroke; it only marks the row so it stops showing as
 *      pending and its Telegram message gets cleaned up below.
 *   2. Any row in a terminal state (approved/denied/expired/stale) that
 *      still has a live `notify_message_id` gets its notification message
 *      edited (via the owning adapter's `finalizeApproval`) to remove the
 *      buttons and show the outcome, then `notify_message_id` is cleared so
 *      the same row is never re-processed.
 *
 * The interactive button-tap path (Telegram's callback_query handler) never
 * goes through this module — it already has the chat/message id in hand
 * from the callback payload itself and edits the message directly, so a
 * resolution by tap is instant rather than waiting for the next sweep tick.
 * This sweep exists for the cases nothing taps: expiry, and any other
 * terminal transition (e.g. a future non-Telegram resolve path) that never
 * touched the message.
 */
import type Database from 'better-sqlite3';
import type { AdapterRegistry } from '../core/registry.js';
import { ApprovalStore } from './store.js';
import type { ApprovalRequest } from './types.js';

export interface SweepApprovalsDeps {
  registry: AdapterRegistry;
  store: ApprovalStore;
}

export interface SweepApprovalsResult {
  expired: number;
  messagesFinalized: number;
}

export async function sweepApprovals(
  deps: SweepApprovalsDeps,
  nowIso: string = new Date().toISOString(),
): Promise<SweepApprovalsResult> {
  const expired = deps.store.expireDue(nowIso);

  const needingCleanup = deps.store.listNeedingMessageCleanup();
  let messagesFinalized = 0;
  for (const request of needingCleanup) {
    const ok = await finalizeOne(deps, request);
    if (ok) messagesFinalized++;
  }

  return { expired: expired.length, messagesFinalized };
}

async function finalizeOne(deps: SweepApprovalsDeps, request: ApprovalRequest): Promise<boolean> {
  if (!request.notify_channel) {
    // Shouldn't happen — listNeedingMessageCleanup() only returns rows with
    // notify_message_id set, and that's only ever written alongside
    // notify_channel by ApprovalStore.updateNotify(). Defensive: clear it
    // anyway so a malformed row doesn't get retried forever.
    deps.store.clearNotifyMessageId(request.id);
    return false;
  }

  const adapter = deps.registry.lookupPrimaryByChannel(request.notify_channel);
  if (!adapter?.finalizeApproval) {
    console.error(
      `[approvals] sweep: no adapter with finalizeApproval for channel "${request.notify_channel}" ` +
        `(approval ${request.id}) — leaving notify_message_id set for a future retry`,
    );
    return false;
  }

  try {
    await adapter.finalizeApproval(request);
    deps.store.clearNotifyMessageId(request.id);
    return true;
  } catch (err) {
    console.error(`[approvals] sweep: finalizeApproval failed for ${request.id}: ${String(err)}`);
    return false;
  }
}

/** Convenience constructor mirroring dispatch.ts's deps shape, for index.ts wiring. */
export function createSweepApprovalsDeps(db: Database.Database, registry: AdapterRegistry): SweepApprovalsDeps {
  return { registry, store: new ApprovalStore(db) };
}

/**
 * S51.2 — dispatch service: given a freshly-inserted `pending` approval
 * request and the channel its conversation was addressed through, finds an
 * adapter that can put it in front of a human and calls it (E51).
 *
 * Deliberately thin: it owns no state of its own beyond the `ApprovalStore`
 * it's handed, and every adapter-specific concern (how the notification
 * looks, how the answer comes back) lives behind the
 * `AdapterCapabilities.interactiveApproval` + `AdapterInstance.notifyApproval`
 * seam in src/core/registry.ts. A future non-Telegram channel (email, Siri)
 * plugs in purely by implementing that seam — this module never changes.
 */
import type { AdapterRegistry } from '../core/registry.js';
import type { ApprovalRequest } from './types.js';
import type { ApprovalStore } from './store.js';

export interface DispatchApprovalDeps {
  registry: AdapterRegistry;
  store: ApprovalStore;
}

/**
 * Looks up the adapter serving `channel`, confirms it declares
 * `interactiveApproval`, and calls its `notifyApproval`. On success, stores
 * the returned channel/message id back onto the row. On any failure to find
 * a capable adapter, or a failure from the adapter itself, marks the row
 * `stale` with a clear reason in `raw_context` — no silent drop, per the
 * epic's S51.2 spec.
 */
export async function dispatchApproval(
  deps: DispatchApprovalDeps,
  request: ApprovalRequest,
  channel: string,
): Promise<void> {
  const adapter = deps.registry.lookupPrimaryByChannel(channel);

  if (!adapter) {
    deps.store.markStale(request.id, `no adapter registered for channel "${channel}"`);
    return;
  }
  if (!adapter.capabilities.interactiveApproval || !adapter.notifyApproval) {
    deps.store.markStale(
      request.id,
      `adapter "${adapter.id}" for channel "${channel}" does not support interactiveApproval`,
    );
    return;
  }

  try {
    const result = await adapter.notifyApproval(request);
    deps.store.updateNotify(request.id, result.channel, result.messageId);
  } catch (err) {
    deps.store.markStale(request.id, `notifyApproval failed: ${String(err)}`);
  }
}

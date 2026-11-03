// One path for every button (Event, slot, notice, conversation): POST /api/v1/surface/actions.
// Pure helpers plus a fetch wrapper with an injectable fetch so the flow is unit-tested.

export const newKey = (rand = () => globalThis.crypto.randomUUID()) => `tap-${rand()}`;

/** An action that sends something on Chris's behalf carries `confirm.draft`; it must be shown first (Approval view). */
export const needsConfirm = (action) => !!(action && action.confirm && typeof action.confirm.draft === 'string' && action.confirm.draft.length > 0);

/** Stable key for a button's local state (not the idempotency key, which is fresh per tap). */
export const btnKey = (object, actionId, messageId = '') => `${object}|${actionId}|${messageId || ''}`;

/** The request body. `draft` goes in only when the action has one, and then it is the exact shown text. */
export function buildRequest({ object, actionId, draft, messageId, key }) {
  const b = { object, action_id: String(actionId), idempotency_key: key };
  if (draft !== undefined && draft !== null) b.draft = draft;
  if (messageId) b.message_id = messageId;
  return b;
}

/** Reasons where tapping again cannot help: the button stays disabled showing the failure. */
const FINAL_REASONS = new Set(['invalid', 'forbidden', 'not_found', 'read_only', 'confirm_required', 'draft_mismatch', 'no_route']);

/**
 * Map an `action_result` to what the button shows.
 *   state: 'sent' | 'already' | 'expired' | 'failed'
 *   disabled: stays disabled (a done action; an expired one; a failure that cannot be retried)
 */
export function interpretResult(res) {
  const status = res && res.status;
  const reason = (res && res.reason) || '';
  if (status === 'done') return { state: 'sent', label: 'Sent', disabled: true, reason };
  if (status === 'already_done') return { state: 'already', label: 'Already sent', disabled: true, reason };
  if (status === 'expired') return { state: 'expired', label: 'Expired', disabled: true, reason };
  return { state: 'failed', label: 'Failed', disabled: FINAL_REASONS.has(reason.split(':')[0]), reason: reason || 'failed' };
}

/** Local state of every button: idle, sending, sent, already, expired, failed. A retryable failure reverts to idle after `failMs`. */
export class ButtonStates {
  constructor(failMs = 4000) { this.map = new Map(); this.failMs = failMs; }
  get(key, now = Date.now()) {
    const s = this.map.get(key);
    if (!s) return { state: 'idle', label: null, disabled: false };
    if (s.state === 'failed' && !s.disabled && now - s.at >= this.failMs) { this.map.delete(key); return { state: 'idle', label: null, disabled: false }; }
    return s;
  }
  begin(key, now = Date.now()) { this.map.set(key, { state: 'sending', label: 'Sending…', disabled: true, at: now }); }
  finish(key, interp, now = Date.now()) { this.map.set(key, { ...interp, at: now }); }
  isBusy(key) { const s = this.map.get(key); return !!s && s.state === 'sending'; }
  /** True when a tap may start (not already sending, not disabled by a final outcome). */
  canTap(key, now = Date.now()) { const s = this.get(key, now); return !s.disabled; }
}

/**
 * Fire one action. Never throws. Resolves `{ interp, result }`.
 * Refuses (no network) a confirm action without its exact draft: `confirm_required`, and a draft that differs
 * from the action's own `confirm.draft`: `draft_mismatch`.
 */
export async function submitAction({ fetchImpl = globalThis.fetch, url, token, object, actionId, action = null, draft, messageId, states, key = newKey(), now = Date.now }) {
  const bkey = btnKey(object, actionId, messageId);
  if (states && !states.canTap(bkey, now())) return { interp: states.get(bkey, now()), result: null, skipped: true };
  if (needsConfirm(action)) {
    if (draft === undefined || draft === null || draft === '') return fail(states, bkey, 'confirm_required');
    if (draft !== action.confirm.draft) return fail(states, bkey, 'draft_mismatch');
  }
  states?.begin(bkey, now());
  let result;
  try {
    const r = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(buildRequest({ object, actionId, draft: needsConfirm(action) ? draft : undefined, messageId, key })) });
    try { result = await r.json(); } catch { result = { status: 'failed', reason: `http_${r.status}` }; }
    if (!result || typeof result !== 'object') result = { status: 'failed', reason: `http_${r.status}` };
  } catch { result = { status: 'failed', reason: 'network' }; }
  const interp = interpretResult(result);
  states?.finish(bkey, interp, now());
  return { interp, result, key };
}

// A client-side refusal is not a button outcome: nothing is stored, so the button stays usable (through the Approval view).
function fail(states, bkey, reason) {
  return { interp: { state: 'failed', label: 'Failed', disabled: false, reason }, result: { status: 'failed', reason }, refused: true };
}

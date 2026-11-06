/**
 * E96 S96.7 — bus approvals (E51 `approval_requests`) as surface Approval objects.
 *
 * Every `pending`, unexpired approval addressed to the surface's contact becomes an
 * `events` item with `kind: 'approval'`, id `approval-<approval id>`, two one-shot actions
 * (`approve` primary, `deny` destructive) and `approval.detail` = exactly what is being
 * approved:
 *
 *   1. `raw_context.details` when a backend supplied a body (E68 self-edit proposals);
 *   2. else `raw_context.tool_input.command` (the full shell command for Bash);
 *   3. else the request's `summary` (the hook's one-line description: path, URL, ...).
 *
 * `detail` is cut to {@link BOUNDS.draft} characters, `body` to {@link BOUNDS.body}, `title`
 * to {@link BOUNDS.title}; a cut ends with `… [N more characters]` (title: `…`).
 *
 * Resolution goes through `resolveApproval()` — the same function the Telegram buttons and
 * `POST /api/v1/approvals/:id/resolve` use — so staleness, expiry, the in-flight guard, the
 * pane keystroke and `onResolved` hooks are identical; `resolved_by` is `device:<id>`. The
 * Telegram notification's buttons are removed by the existing approvals sweep
 * (`listNeedingMessageCleanup`), as for any non-Telegram resolution.
 *
 * E100: an Approval is a `decision` Moment (`weight: decision`, `state: open`, both buttons `kind: hold`).
 * When it stops being pending it is kept as a tombstone: `answered` (approved or denied), `expired`, or
 * `withdrawn` (stale, or gone from the table); `ended_at` is the resolution time when known.
 *
 * Change detection: approvals have no event bus. Call {@link syncApprovalEvents} on a timer
 * (the desk tick / maintenance sweep) and right after a resolve; it applies ops only when
 * the set changed.
 */
import type Database from 'better-sqlite3';
import { resolveApproval, type ResolveApprovalDeps } from '../approvals/resolve.js';
import type { ApprovalDecision, ApprovalRequest } from '../approvals/types.js';
import { conversationTitle } from '../intercom/desk.js';
import { diffItems } from './sessions.js';
import { BOUNDS, type ActionStatus, type EventState, type ResourceHub, type SurfaceEvent } from './types.js';
import { isTerminal, tombstone } from './lifecycle.js';

export const APPROVAL_EVENT_PREFIX = 'approval-';

export function approvalEventId(approvalId: string): string {
  return `${APPROVAL_EVENT_PREFIX}${approvalId}`;
}

/** `approval-<id>` or `events:approval-<id>` → the approval id; null for anything else. */
export function approvalIdFromEvent(ref: string): string | null {
  const id = ref.startsWith('events:') ? ref.slice('events:'.length) : ref;
  return id.startsWith(APPROVAL_EVENT_PREFIX) && id.length > APPROVAL_EVENT_PREFIX.length ? id.slice(APPROVAL_EVENT_PREFIX.length) : null;
}

function cut(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  for (let keep = max - 24; keep > 0; keep--) {
    const out = `${chars.slice(0, keep).join('')}… [${chars.length - keep} more characters]`;
    if (Array.from(out).length <= max) return out;
  }
  return chars.slice(0, max).join('');
}

const cutTitle = (text: string): string => {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim());
  return chars.length <= BOUNDS.title ? chars.join('') : `${chars.slice(0, BOUNDS.title - 1).join('')}…`;
};

/** The verbatim thing being approved (before bounding). */
export function approvalDetail(request: Pick<ApprovalRequest, 'raw_context' | 'summary'>): string {
  if (request.raw_context) {
    try {
      const ctx = JSON.parse(request.raw_context) as { details?: unknown; tool_input?: { command?: unknown } };
      if (typeof ctx.details === 'string' && ctx.details.trim()) return ctx.details;
      if (typeof ctx.tool_input?.command === 'string' && ctx.tool_input.command.trim()) return ctx.tool_input.command;
    } catch { /* fall through to the summary */ }
  }
  return request.summary;
}

export function approvalToEvent(request: ApprovalRequest, db?: Database.Database): SurfaceEvent {
  const agent = request.agent_id.replace(/^agent:/, '');
  const where = db && request.conversation_id ? conversationTitle(db, request.conversation_id, '').title : '';
  const title = request.adapter_id === 'self-edit' ? 'Proposed change' : `${request.tool_name}: ${request.summary}`;
  return {
    id: approvalEventId(request.id),
    kind: 'approval',
    title: cutTitle(title),
    body: cut(`Agent ${agent}${where ? ` · ${where}` : ''} asks to use ${request.tool_name}.`, BOUNDS.body),
    level: 'attention',
    weight: 'decision',
    state: 'open',
    expires_at: request.expires_at,
    actions: [
      { id: 'approve', label: 'Approve', style: 'primary', once: true, kind: 'hold' },
      { id: 'deny', label: 'Deny', style: 'destructive', once: true, kind: 'hold' },
    ],
    approval: { approval_id: request.id, tool: request.tool_name, detail: cut(approvalDetail(request), BOUNDS.draft) },
    source: 'bus',
    created_at: request.requested_at,
    updated_at: request.requested_at,
  };
}

/** Pending, unexpired approvals as Approval events, oldest first. `filter.contactId` limits to one addressee (bare or `contact:`). */
export function approvalEventsFor(db: Database.Database, now: Date | number = new Date(), filter: { contactId?: string } = {}): SurfaceEvent[] {
  const nowIso = (typeof now === 'number' ? new Date(now) : now).toISOString();
  let rows: ApprovalRequest[] = [];
  try {
    rows = db.prepare(`SELECT * FROM approval_requests WHERE status = 'pending' AND expires_at > ? ORDER BY requested_at, id`).all(nowIso) as ApprovalRequest[];
  } catch { return []; }
  const want = filter.contactId?.replace(/^contact:/, '');
  return rows
    .filter((r) => !want || r.contact_id.replace(/^contact:/, '') === want)
    .map((r) => approvalToEvent(r, db));
}

/** The tombstone state and end time of an approval that is no longer pending. */
function endOf(db: Database.Database, approvalId: string, nowIso: string): { state: Exclude<EventState, 'open'>; at: string } {
  let row: Pick<ApprovalRequest, 'status' | 'resolved_at' | 'expires_at'> | undefined;
  try { row = db.prepare(`SELECT status, resolved_at, expires_at FROM approval_requests WHERE id = ?`).get(approvalId) as typeof row; } catch { row = undefined; }
  if (!row) return { state: 'withdrawn', at: nowIso };
  if (row.status === 'approved' || row.status === 'denied') return { state: 'answered', at: row.resolved_at ?? nowIso };
  if (row.status === 'expired' || (row.status === 'pending' && row.expires_at <= nowIso)) return { state: 'expired', at: row.resolved_at ?? row.expires_at };
  return { state: 'withdrawn', at: row.resolved_at ?? nowIso };
}

/**
 * Bring the surface's `events` resource in line with the pending approvals: set new or
 * changed Approval events, turn ones no longer pending into tombstones (E100). Approval
 * tombstones and agent-published events are never touched (the hub's sweep purges old
 * tombstones). Returns the new rev, or null when nothing changed.
 */
export function syncApprovalEvents(
  hub: Pick<ResourceHub, 'snapshot' | 'apply'>,
  surfaceId: string,
  db: Database.Database,
  opts: { now?: Date | number; contactId?: string } = {},
): number | null {
  const now = opts.now ?? new Date();
  const nowIso = (typeof now === 'number' ? new Date(now) : now).toISOString();
  const current: Record<string, Record<string, unknown>> = {};
  for (const [id, item] of Object.entries(hub.snapshot(surfaceId, 'events').items)) {
    if (id.startsWith(APPROVAL_EVENT_PREFIX) && item['kind'] === 'approval' && !isTerminal(item)) current[id] = item;
  }
  const next: Record<string, Record<string, unknown>> = {};
  for (const e of approvalEventsFor(db, now, opts.contactId ? { contactId: opts.contactId } : {})) next[e.id] = { ...e };
  const ops = diffItems(current, next).map((op) => {
    if (op.op !== 'remove') return op;
    const end = endOf(db, approvalIdFromEvent(op.id) ?? '', nowIso);
    return { op: 'set' as const, id: op.id, value: tombstone(current[op.id]!, end.state, end.at, nowIso) };
  });
  return ops.length ? hub.apply(surfaceId, 'events', ops) : null;
}

export interface SurfaceApprovalResult {
  status: ActionStatus;
  /** For `failed`: `not_found`, `invalid`, `stale: <reason>`. For `expired`: the reason when known. */
  reason?: string;
  approval?: ApprovalRequest;
}

/**
 * Approve or deny from a device, through the existing approvals resolution path.
 * `contactId` (the surface's followed contact) restricts it to approvals addressed to that
 * contact; another contact's approval answers `not_found` (existence is not revealed).
 *
 *   approved/denied by this call → `done`
 *   already answered elsewhere   → `already_done` (`expired` when it had expired)
 *   past its expiry              → `expired`
 *   pane moved on / no backend   → `failed`, reason `stale: …`
 */
export async function resolveApprovalFromSurface(
  deps: ResolveApprovalDeps,
  input: { approvalId: string; decision: ApprovalDecision | string; deviceId: string; contactId?: string; now?: Date },
): Promise<SurfaceApprovalResult> {
  if (input.decision !== 'approve' && input.decision !== 'deny') return { status: 'failed', reason: 'invalid' };
  const out = await resolveApproval(deps, input.approvalId, input.decision, `device:${input.deviceId}`, input.now ?? new Date(), input.contactId);
  switch (out.outcome) {
    case 'not_found':
    case 'forbidden':
      return { status: 'failed', reason: 'not_found' };
    case 'already_resolved':
      return out.request.status === 'expired'
        ? { status: 'expired', approval: out.request }
        : { status: 'already_done', approval: out.request };
    case 'expired':
      return { status: 'expired', reason: out.reason, approval: out.request };
    case 'stale':
      return { status: 'failed', reason: `stale: ${out.reason}`, approval: out.request };
    case 'approved':
    case 'denied':
      return { status: 'done', approval: out.request };
  }
}

/**
 * Shared types for the approvals subsystem (E51).
 *
 * No I/O, no dependencies beyond stdlib — safe for src/core/registry.ts (the
 * AdapterInstance seam), src/http/api.ts (the reception/resolution routes),
 * and every adapter/module implementing notifyApproval/resolveApproval to
 * import without creating a dependency cycle. Mirrors src/pool/types.ts's
 * role for the cc-pool subsystem.
 */

/** Lifecycle state of one approval_requests row. */
export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'stale';

/** The human's answer, as carried in a resolve request/keystroke mapping. */
export type ApprovalDecision = 'approve' | 'deny';

/**
 * An `approval_requests` row. Snake_case to mirror the DB column names
 * directly (same convention as src/pool/types.ts's PoolLeaseRow).
 */
export interface ApprovalRequest {
  id: string;
  /** The backend that raised it, e.g. 'cc-pool'. */
  adapter_id: string;
  /**
   * Backend-specific target. For 'cc-pool' this is the pane's own BARE
   * agent id (e.g. "peggy-pool-1") — the same form `$AGENTBUS_AGENT_ID` is
   * set to in the pane's tmux environment (see src/pool/pane.ts). Callers
   * that need to match it against `pool_leases.agent_id` (which stores the
   * PREFIXED form) must convert via `toPrefixedAgentId()` themselves.
   */
  agent_id: string;
  conversation_id: string | null;
  contact_id: string;
  tool_name: string;
  summary: string;
  /** Opaque JSON blob (tool_input, cwd, a stale-dispatch reason, etc.) — never re-parsed by this subsystem. */
  raw_context: string | null;
  status: ApprovalStatus;
  requested_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  notify_channel: string | null;
  notify_message_id: string | null;
  expires_at: string;
}

/** Input to ApprovalStore.insert() — everything the caller supplies; id/timestamps are minted by the store. */
export interface ApprovalRequestInput {
  adapterId: string;
  agentId: string;
  conversationId?: string | null;
  contactId: string;
  toolName: string;
  summary: string;
  /** Arbitrary JSON-serializable context — stored verbatim as `raw_context`. */
  context?: unknown;
}

/**
 * How long a request stays answerable before the sweep expires it. Long
 * enough to see and tap on a phone, short enough that a pane isn't blocked
 * all day. Not yet configurable.
 */
export const APPROVAL_TIMEOUT_MS = 15 * 60 * 1000;

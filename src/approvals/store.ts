/**
 * S51.1 — SQLite-backed store for the `approval_requests` table (E51).
 *
 * Owns every state transition an approval request can go through. Mirrors
 * src/pool/lease-store.ts's role/shape for the cc-pool subsystem: a small,
 * synchronous (better-sqlite3) wrapper with no business logic of its own
 * beyond the state machine (`pending -> approved|denied|expired|stale`).
 */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ApprovalRequest, ApprovalRequestInput, ApprovalStatus } from './types.js';

export class ApprovalStore {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Creates a new `pending` row. `expires_at` is `requested_at + timeoutMs`.
   * `context`, when given, is JSON-stringified into `raw_context` verbatim.
   */
  insert(input: ApprovalRequestInput, timeoutMs: number, now: Date = new Date()): ApprovalRequest {
    const id = randomUUID();
    const requestedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + timeoutMs).toISOString();
    const rawContext = input.context !== undefined ? JSON.stringify(input.context) : null;

    this.db
      .prepare(
        `INSERT INTO approval_requests
           (id, adapter_id, agent_id, conversation_id, contact_id, tool_name, summary, raw_context, status, requested_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(
        id,
        input.adapterId,
        input.agentId,
        input.conversationId ?? null,
        input.contactId,
        input.toolName,
        input.summary,
        rawContext,
        requestedAt,
        expiresAt,
      );

    return this.getById(id)!;
  }

  getById(id: string): ApprovalRequest | null {
    const row = this.db.prepare(`SELECT * FROM approval_requests WHERE id = ?`).get(id) as
      | ApprovalRequest
      | undefined;
    return row ?? null;
  }

  /** All rows, optionally filtered by status, newest-first (for observability — GET /api/v1/approvals). */
  list(status?: ApprovalStatus): ApprovalRequest[] {
    if (status) {
      return this.db
        .prepare(`SELECT * FROM approval_requests WHERE status = ? ORDER BY requested_at DESC`)
        .all(status) as ApprovalRequest[];
    }
    return this.db.prepare(`SELECT * FROM approval_requests ORDER BY requested_at DESC`).all() as ApprovalRequest[];
  }

  /**
   * Records the outcome of a dispatch attempt (S51.2/S51.3): stores the
   * platform channel + message id so a later edit (S51.6) can find the
   * button message. No-op if the row is no longer `pending` (defensive —
   * dispatch always runs immediately after insert(), before any resolution
   * could plausibly have happened yet).
   */
  updateNotify(id: string, channel: string, messageId: string): void {
    this.db
      .prepare(`UPDATE approval_requests SET notify_channel = ?, notify_message_id = ? WHERE id = ? AND status = 'pending'`)
      .run(channel, messageId, id);
  }

  /**
   * `pending -> stale`, with a reason appended into `raw_context` (merged
   * into whatever JSON object was already there, best-effort — a
   * non-object/unparseable existing value is replaced rather than merged).
   * Used when no adapter can be found/capable to notify (S51.2), or when a
   * resolve attempt finds the pane's lease has moved on (S51.4).
   */
  markStale(id: string, reason: string, now: Date = new Date()): void {
    const row = this.getById(id);
    if (!row || row.status !== 'pending') return;
    const merged = mergeContext(row.raw_context, { stale_reason: reason });
    this.db
      .prepare(
        `UPDATE approval_requests
         SET status = 'stale', resolved_at = ?, resolved_by = 'system', raw_context = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(now.toISOString(), merged, id);
  }

  /**
   * `pending -> approved|denied` (or a caller-chosen terminal status —
   * S51.4 uses this for the 'stale' lease-moved-on case too). Idempotent:
   * a no-op (does not throw) if the row is already resolved/expired/stale —
   * this is what makes "Chris answered at the terminal directly" race-safe.
   */
  resolve(
    id: string,
    status: ApprovalStatus,
    resolvedBy: string,
    now: Date = new Date(),
    extraContext?: Record<string, unknown>,
  ): boolean {
    const row = extraContext ? this.getById(id) : null;
    const rawContext = row ? mergeContext(row.raw_context, extraContext!) : null;
    const result = this.db
      .prepare(
        `UPDATE approval_requests
         SET status = ?, resolved_at = ?, resolved_by = ?, raw_context = COALESCE(?, raw_context)
         WHERE id = ? AND status = 'pending'`,
      )
      .run(status, now.toISOString(), resolvedBy, rawContext, id);
    return result.changes > 0;
  }

  /**
   * The still-`pending` row for the same backend target and the same
   * tool/summary, if any — lets the reception endpoint collapse a repeated
   * hook firing for one unanswered prompt into one notification instead of
   * spamming the human's phone.
   */
  findPendingDuplicate(adapterId: string, agentId: string, toolName: string, summary: string): ApprovalRequest | null {
    const row = this.db
      .prepare(
        `SELECT * FROM approval_requests
         WHERE status = 'pending' AND adapter_id = ? AND agent_id = ? AND tool_name = ? AND summary = ?
         ORDER BY requested_at DESC LIMIT 1`,
      )
      .get(adapterId, agentId, toolName, summary) as ApprovalRequest | undefined;
    return row ?? null;
  }

  /**
   * `pending -> expired` for every row past its `expires_at`. Returns the
   * rows that were actually transitioned (for S51.6's message cleanup —
   * each needs its Telegram buttons removed). `nowIso` is injectable for
   * tests.
   */
  expireDue(nowIso: string = new Date().toISOString()): ApprovalRequest[] {
    const due = this.db
      .prepare(`SELECT * FROM approval_requests WHERE status = 'pending' AND expires_at < ?`)
      .all(nowIso) as ApprovalRequest[];
    if (due.length === 0) return [];

    const update = this.db.prepare(
      `UPDATE approval_requests SET status = 'expired', resolved_at = ?, resolved_by = 'timeout' WHERE id = ? AND status = 'pending'`,
    );
    const run = this.db.transaction((rows: ApprovalRequest[]) => {
      for (const row of rows) update.run(nowIso, row.id);
    });
    run(due);

    return due.map((row) => ({ ...row, status: 'expired' as const, resolved_at: nowIso, resolved_by: 'timeout' }));
  }

  /**
   * Rows in a terminal state that still have a live `notify_message_id` —
   * i.e. a Telegram (or future adapter) message whose buttons have not yet
   * been cleaned up. Used by S51.6's sweep.
   */
  listNeedingMessageCleanup(): ApprovalRequest[] {
    return this.db
      .prepare(
        `SELECT * FROM approval_requests
         WHERE status IN ('approved', 'denied', 'expired', 'stale') AND notify_message_id IS NOT NULL`,
      )
      .all() as ApprovalRequest[];
  }

  /** Clears `notify_message_id` — marks a row's notification message as already cleaned up (S51.6). */
  clearNotifyMessageId(id: string): void {
    this.db.prepare(`UPDATE approval_requests SET notify_message_id = NULL WHERE id = ?`).run(id);
  }
}

/** Merges `extra` into the JSON object stored in `existing`, tolerating a missing/non-object/unparseable value. */
function mergeContext(existing: string | null, extra: Record<string, unknown>): string {
  if (!existing) return JSON.stringify(extra);
  try {
    const parsed: unknown = JSON.parse(existing);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return JSON.stringify({ ...(parsed as Record<string, unknown>), ...extra });
    }
    return JSON.stringify({ previous: parsed, ...extra });
  } catch {
    return JSON.stringify({ previous_raw: existing, ...extra });
  }
}
